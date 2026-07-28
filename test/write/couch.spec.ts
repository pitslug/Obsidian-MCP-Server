/**
 * The write client, in isolation.
 *
 * The tests that matter here are negative ones. A read-only deployment must
 * not be able to reach CouchDB with a state-changing method at all, which is a
 * claim about what leaves the process rather than about what comes back, so it
 * is asserted against a fetch that records every request it is handed. And a
 * conflict must surface as a refusal carrying the winner, never as a retry.
 */

import { describe, expect, it } from "vitest";
import {
    CouchRequestError,
    CouchWriter,
    ReadOnlyError,
    RevisionConflictError,
} from "../../src/write/couch.js";
import type { CouchConfig } from "../../src/config.js";

const COUCH: CouchConfig = {
    url: "https://couch.example",
    database: "vault",
    username: "svc",
    password: "hunter2",
};

/** A fetch that records what it was asked to do and answers from a script. */
function recordingFetch(responses: (() => Response)[] = []) {
    const seen: { method: string; url: string; headers: Headers; body: string | undefined }[] = [];
    let next = 0;

    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
            method: init?.method ?? "GET",
            url: String(input),
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? init.body : undefined,
        });
        const responder = responses[next++] ?? (() => new Response("{}", { status: 200 }));
        return responder();
    }) as unknown as typeof fetch;

    return { impl, seen, methods: () => seen.map((r) => r.method) };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("read-only refusal", () => {
    it("refuses a put without issuing any request", async () => {
        const fetcher = recordingFetch();
        const writer = new CouchWriter({ couch: COUCH, readOnly: true, fetchImpl: fetcher.impl });

        await expect(writer.put({ _id: "note.md", type: "plain" })).rejects.toBeInstanceOf(ReadOnlyError);
        expect(fetcher.seen).toEqual([]);
    });

    it("refuses a bulk write without issuing any request", async () => {
        const fetcher = recordingFetch();
        const writer = new CouchWriter({ couch: COUCH, readOnly: true, fetchImpl: fetcher.impl });

        await expect(writer.bulkPut([{ _id: "h:abc", type: "leaf" }])).rejects.toBeInstanceOf(ReadOnlyError);
        expect(fetcher.seen).toEqual([]);
    });

    it("still reads, because read-only means read-only and not offline", async () => {
        const fetcher = recordingFetch([() => json({ _id: "note.md", _rev: "1-a" })]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: true, fetchImpl: fetcher.impl });

        expect(await writer.get("note.md")).toMatchObject({ _rev: "1-a" });
        expect(fetcher.methods()).toEqual(["GET"]);
    });
});

describe("conflicts", () => {
    it("refuses rather than retrying, and reports what it lost to", async () => {
        const fetcher = recordingFetch([
            () => json({ error: "conflict", reason: "Document update conflict." }, 409),
            () => json({ _id: "note.md", _rev: "4-newer" }),
        ]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });

        const error = await writer
            .put({ _id: "note.md", _rev: "3-mine" })
            .then(() => undefined)
            .catch((e: Error) => e);

        expect(error).toBeInstanceOf(RevisionConflictError);
        expect((error as RevisionConflictError).current).toMatchObject({ _rev: "4-newer" });
        expect(error?.message).toContain("3-mine");
        // One PUT, then a GET to see the winner. No second attempt.
        expect(fetcher.methods()).toEqual(["PUT", "GET"]);
    });

    it("treats a bulk conflict as a distinct, reportable outcome", async () => {
        const fetcher = recordingFetch([
            () =>
                json([
                    { id: "h:one", rev: "1-a", ok: true },
                    { id: "h:two", error: "conflict", reason: "Document update conflict." },
                    { id: "h:three", error: "forbidden", reason: "no" },
                ]),
        ]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });

        const results = await writer.bulkPut([{ _id: "h:one" }, { _id: "h:two" }, { _id: "h:three" }]);

        expect(results[0]).toMatchObject({ ok: true, conflict: false, rev: "1-a" });
        expect(results[1]).toMatchObject({ ok: false, conflict: true });
        expect(results[2]).toMatchObject({ ok: false, conflict: false });
        expect(results[2]?.error).toContain("forbidden");
    });
});

describe("requests", () => {
    it("sends credentials in a header, never in the URL", async () => {
        const fetcher = recordingFetch([() => json({ id: "note.md", rev: "1-a" })]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });

        await writer.put({ _id: "note.md" });

        const request = fetcher.seen[0];
        expect(request?.url).not.toContain("hunter2");
        expect(request?.url).not.toContain("svc");
        expect(request?.headers.get("authorization")).toBe(
            "Basic " + Buffer.from("svc:hunter2").toString("base64")
        );
    });

    it("keeps a password out of the error when a write fails", async () => {
        const fetcher = recordingFetch([
            () => json({ error: "unauthorized", reason: "Name or password is incorrect." }, 401),
        ]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });

        const error = await writer
            .put({ _id: "note.md" })
            .then(() => undefined)
            .catch((e: Error) => e);

        expect(error).toBeInstanceOf(CouchRequestError);
        expect(error?.message).not.toContain("hunter2");
        expect(error?.message).toContain("401");
    });

    it("encodes a slash in a document ID, but not the one after _local", async () => {
        const fetcher = recordingFetch([() => json({}), () => json({})]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });

        await writer.get("daily/2026-07-28.md");
        await writer.get("_local/obsydian_livesync_milestone");

        expect(fetcher.seen[0]?.url).toContain("/vault/daily%2F2026-07-28.md");
        expect(fetcher.seen[1]?.url).toContain("/vault/_local/obsydian_livesync_milestone");
    });

    it("reports a missing document as absent rather than an error", async () => {
        const fetcher = recordingFetch([() => json({ error: "not_found" }, 404)]);
        const writer = new CouchWriter({ couch: COUCH, readOnly: false, fetchImpl: fetcher.impl });
        expect(await writer.get("gone.md")).toBeUndefined();
    });
});
