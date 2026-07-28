/**
 * The plan and commit protocol.
 *
 * Two properties carry the weight. Planning must write nothing, which is
 * asserted against every HTTP method the client issued rather than against the
 * resulting documents: a plan that wrote and then tidied up after itself would
 * pass a content check. And commit must refuse in full when anything moved,
 * because "mostly what you reviewed" is not what a review is for.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Replicator } from "../../src/replicator/index.js";
import {
    assembleFile,
    decodeDocument,
    resolveSettings,
    transformContextFor,
    type ChunkEntry,
    type ChunkedEntry,
    type FileContent,
} from "../../src/vault-model/index.js";
import { CouchWriter, ReadOnlyError } from "../../src/write/couch.js";
import {
    DuplicatePlanTargetError,
    PlanAlreadyUsedError,
    PlanCeilingError,
    PlanCommitError,
    PlanExpiredError,
    PlanNotFoundError,
    PlanningWriteExecutor,
    PlanStaleError,
} from "../../src/write/plans.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TRANSFORM = transformContextFor(SETTINGS, undefined);

let couch: FakeCouch;
let replicaDir: string;
let replicator: Replicator | undefined;
let dbCounter = 0;

const nextDb = (label: string) => `${label}-${++dbCounter}`;
const text = (value: string) => ({ kind: "text" as const, text: value });

/** A write that reads the current revision first, as a tool layer must. */
async function put(executor: PlanningWriteExecutor, path: string, content: FileContent) {
    const existing = await executor.currentEntry(path);
    return executor.write({ path, content, expectedRev: existing?._rev ?? null });
}

beforeAll(async () => {
    couch = await startFakeCouch();
});

afterAll(async () => {
    await couch.stop();
});

beforeEach(async () => {
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-plan-"));
});

afterEach(async () => {
    await replicator?.stop().catch(() => undefined);
    replicator = undefined;
    await rm(replicaDir, { recursive: true, force: true });
});

interface Stack {
    executor: PlanningWriteExecutor;
    /** Every HTTP method the write client issued, in order. */
    methods: string[];
    /** Document IDs whose PUT should fail, to force a mid-commit failure. */
    failPutsFor: Set<string>;
    /** Advance or rewind the injected clock. */
    setClock: (value: number) => void;
    db: string;
}

async function stackFor(
    db: string,
    options: { readOnly?: boolean; planCeiling?: number; planTtlMs?: number } = {}
): Promise<Stack> {
    await couch.createDatabase(db);
    replicator = new Replicator({
        remoteUrl: `${couch.url}/${db}`,
        replicaPath: join(replicaDir, "replica"),
        transform: TRANSFORM,
    });
    await replicator.start();
    await replicator.waitForInitialSync(30_000);

    const methods: string[] = [];
    const failPutsFor = new Set<string>();
    let clock = 1_700_000_000_000;

    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "PUT") {
            const id = decodeURIComponent(String(input).split("/").pop() ?? "");
            if (failPutsFor.has(id)) {
                return new Response(JSON.stringify({ error: "internal", reason: "forced" }), {
                    status: 500,
                    headers: { "content-type": "application/json" },
                });
            }
        }
        return fetch(input, init);
    }) as unknown as typeof fetch;

    const executor = new PlanningWriteExecutor({
        couch: new CouchWriter({
            couch: { url: couch.url, database: db, username: undefined, password: undefined },
            readOnly: options.readOnly ?? false,
            fetchImpl,
        }),
        replicator,
        settings: SETTINGS,
        transform: TRANSFORM,
        readOnly: options.readOnly ?? false,
        planCeiling: options.planCeiling ?? 500,
        planTtlMs: options.planTtlMs,
        now: () => clock,
    });

    return { executor, methods, failPutsFor, setClock: (value) => (clock = value), db };
}

async function contentOf(db: string, id: string): Promise<string> {
    const raw = await couch.get(db, id);
    if (!raw) return "";
    const entry = (await decodeDocument(raw as never, TRANSFORM)) as unknown as ChunkedEntry;
    const chunks = new Map<string, ChunkEntry>();
    for (const child of entry.children ?? []) {
        const chunkRaw = await couch.get(db, child);
        if (chunkRaw) {
            chunks.set(child, (await decodeDocument(chunkRaw as never, TRANSFORM)) as unknown as ChunkEntry);
        }
    }
    const file = assembleFile(entry, chunks);
    return file.kind === "text" ? file.text : "";
}

describe("planning", () => {
    it("writes nothing, and says so in the only way that counts", async () => {
        const stack = await stackFor(nextDb("dryrun"));
        await put(stack.executor, "a.md", text("original a"));
        await put(stack.executor, "b.md", text("original b"));

        stack.methods.length = 0;
        const plan = await stack.executor.plan([
            { kind: "write", path: "a.md", content: text("changed a") },
            { kind: "write", path: "b.md", content: text("changed b") },
            { kind: "write", path: "c.md", content: text("brand new c") },
        ]);

        expect([...new Set(stack.methods)]).toEqual(["GET"]);
        expect(await contentOf(stack.db, "a.md")).toBe("original a");
        expect(await contentOf(stack.db, "c.md")).toBe("");
        expect(plan.totals).toMatchObject({ creates: 1, updates: 2, deletes: 0 });
    }, 60_000);

    it("reports before and after for every path it would touch", async () => {
        const stack = await stackFor(nextDb("preview"));
        await put(stack.executor, "note.md", text("short"));

        const plan = await stack.executor.plan([
            { kind: "write", path: "note.md", content: text("a considerably longer body than before") },
            { kind: "delete", path: "note.md".replace("note", "missing") },
        ]);

        const update = plan.changes.find((c) => c.path === "note.md");
        expect(update).toMatchObject({ effect: "update", sizeBefore: 5, unchanged: false });
        expect(update?.sizeAfter).toBe(38);
        expect(update?.rev).toBeDefined();

        const absent = plan.changes.find((c) => c.path === "missing.md");
        expect(absent).toMatchObject({ effect: "delete", unchanged: true, rev: undefined });
    }, 60_000);

    it("refuses a plan larger than the ceiling", async () => {
        const stack = await stackFor(nextDb("ceiling"), { planCeiling: 3 });
        const operations = Array.from({ length: 4 }, (_unused, i) => ({
            kind: "write" as const,
            path: `note-${i}.md`,
            content: text(`body ${i}`),
        }));

        await expect(stack.executor.plan(operations)).rejects.toBeInstanceOf(PlanCeilingError);
    }, 60_000);

    it("refuses two operations on one note", async () => {
        const stack = await stackFor(nextDb("dupe"));
        await expect(
            stack.executor.plan([
                { kind: "write", path: "note.md", content: text("one") },
                { kind: "write", path: "note.md", content: text("two") },
            ])
        ).rejects.toBeInstanceOf(DuplicatePlanTargetError);
    }, 60_000);

    it("refuses to plan at all when read-only", async () => {
        const stack = await stackFor(nextDb("ro-plan"), { readOnly: true });
        await expect(
            stack.executor.plan([{ kind: "write", path: "note.md", content: text("x") }])
        ).rejects.toBeInstanceOf(ReadOnlyError);
    }, 60_000);
});

describe("committing", () => {
    it("applies every change in the plan", async () => {
        const stack = await stackFor(nextDb("commit"));
        await put(stack.executor, "a.md", text("original a"));

        const plan = await stack.executor.plan([
            { kind: "write", path: "a.md", content: text("changed a") },
            { kind: "write", path: "new.md", content: text("created by the plan") },
        ]);
        const result = await stack.executor.commit(plan.id);

        expect(result.applied).toHaveLength(2);
        expect(await contentOf(stack.db, "a.md")).toBe("changed a");
        expect(await contentOf(stack.db, "new.md")).toBe("created by the plan");
    }, 60_000);

    it("refuses in full when any target moved, and writes nothing", async () => {
        const stack = await stackFor(nextDb("stale"));
        await put(stack.executor, "a.md", text("original a"));
        await put(stack.executor, "b.md", text("original b"));

        const plan = await stack.executor.plan([
            { kind: "write", path: "a.md", content: text("planned a") },
            { kind: "write", path: "b.md", content: text("planned b") },
        ]);

        // Another device edits one of the two between plan and commit.
        await put(stack.executor, "b.md", text("edited elsewhere"));

        const error = await stack.executor
            .commit(plan.id)
            .then(() => undefined)
            .catch((e: Error) => e);

        expect(error).toBeInstanceOf(PlanStaleError);
        expect((error as PlanStaleError).paths).toEqual(["b.md"]);
        // The untouched target must be untouched: refusal is all or nothing.
        expect(await contentOf(stack.db, "a.md")).toBe("original a");
        expect(await contentOf(stack.db, "b.md")).toBe("edited elsewhere");
    }, 60_000);

    it("will not run the same plan twice", async () => {
        const stack = await stackFor(nextDb("once"));
        const plan = await stack.executor.plan([{ kind: "write", path: "a.md", content: text("body") }]);

        await stack.executor.commit(plan.id);
        await expect(stack.executor.commit(plan.id)).rejects.toBeInstanceOf(PlanAlreadyUsedError);
    }, 60_000);

    it("expires, so an old plan fails rather than runs", async () => {
        const stack = await stackFor(nextDb("expiry"), { planTtlMs: 15 * 60 * 1000 });
        const plan = await stack.executor.plan([{ kind: "write", path: "a.md", content: text("body") }]);

        stack.setClock(plan.createdAt + 15 * 60 * 1000 + 1);

        await expect(stack.executor.commit(plan.id)).rejects.toBeInstanceOf(PlanExpiredError);
        expect(await contentOf(stack.db, "a.md")).toBe("");
    }, 60_000);

    it("does not know a plan it never made", async () => {
        const stack = await stackFor(nextDb("unknown"));
        await expect(stack.executor.commit("not-a-plan")).rejects.toBeInstanceOf(PlanNotFoundError);
    }, 60_000);

    it("skips a note whose content is already exactly what was planned", async () => {
        const stack = await stackFor(nextDb("noop"));
        await put(stack.executor, "same.md", text("unchanged body"));
        await put(stack.executor, "other.md", text("before"));

        const plan = await stack.executor.plan([
            { kind: "write", path: "same.md", content: text("unchanged body") },
            { kind: "write", path: "other.md", content: text("after") },
        ]);
        expect(plan.totals.unchanged).toBe(1);

        const revBefore = (await couch.get(stack.db, "same.md"))?._rev;
        const result = await stack.executor.commit(plan.id);

        expect(result.applied).toHaveLength(1);
        expect((await couch.get(stack.db, "same.md"))?._rev).toBe(revBefore);
        expect(await contentOf(stack.db, "other.md")).toBe("after");
    }, 60_000);

    it("stops at the first failure and reports exactly what was written", async () => {
        const stack = await stackFor(nextDb("partial"));
        const plan = await stack.executor.plan([
            { kind: "write", path: "first.md", content: text("first body") },
            { kind: "write", path: "second.md", content: text("second body") },
            { kind: "write", path: "third.md", content: text("third body") },
        ]);

        stack.failPutsFor.add("second.md");

        const error = await stack.executor
            .commit(plan.id)
            .then(() => undefined)
            .catch((e: Error) => e);

        expect(error).toBeInstanceOf(PlanCommitError);
        const failure = error as PlanCommitError;
        expect(failure.applied.map((r) => r.path)).toEqual(["first.md"]);
        expect(failure.failedPath).toBe("second.md");
        expect(failure.remaining).toEqual(["third.md"]);

        expect(await contentOf(stack.db, "first.md")).toBe("first body");
        expect(await contentOf(stack.db, "third.md")).toBe("");
        // And the failed run cannot simply be repeated.
        await expect(stack.executor.commit(plan.id)).rejects.toBeInstanceOf(PlanAlreadyUsedError);
    }, 60_000);

    it("deletes through a plan, softly", async () => {
        const stack = await stackFor(nextDb("plandelete"));
        await put(stack.executor, "doomed.md", text("here today"));

        const plan = await stack.executor.plan([{ kind: "delete", path: "doomed.md" }]);
        expect(plan.totals.deletes).toBe(1);
        await stack.executor.commit(plan.id);

        const raw = await couch.get(stack.db, "doomed.md");
        expect(raw?.deleted).toBe(true);
        expect(raw?._deleted).toBeUndefined();
    }, 60_000);

    it("refuses to commit when read-only", async () => {
        const stack = await stackFor(nextDb("ro-commit"), { readOnly: true });
        await expect(stack.executor.commit("anything")).rejects.toBeInstanceOf(ReadOnlyError);
    }, 60_000);

    it("does not re-delete a note that is already deleted", async () => {
        const stack = await stackFor(nextDb("redelete"));
        await put(stack.executor, "doomed.md", text("here today"));
        const existing = await stack.executor.currentEntry("doomed.md");
        await stack.executor.remove({ path: "doomed.md", expectedRev: existing?._rev as string });
        const revAfterDelete = (await couch.get(stack.db, "doomed.md"))?._rev;

        const plan = await stack.executor.plan([{ kind: "delete", path: "doomed.md" }]);
        expect(plan.totals.deletes).toBe(0);
        expect(plan.totals.unchanged).toBe(1);

        const result = await stack.executor.commit(plan.id);

        // Re-tombstoning looks free and is not: it writes a revision that
        // replicates to every device, on a plan that previewed no deletions.
        expect(result.applied).toEqual([]);
        expect((await couch.get(stack.db, "doomed.md"))?._rev).toBe(revAfterDelete);
    }, 60_000);

    it("does not call a pre-chunking note unchanged just because it has no chunk list", async () => {
        const stack = await stackFor(nextDb("legacy-plan"));
        // A legacy note holds its content inline and has no `children`.
        // Comparing that to an empty chunk list would report "unchanged" for a
        // plan that blanks it, and commit would skip it while reporting
        // success.
        await couch.seed(stack.db, [
            {
                _id: "old.md",
                path: "old.md",
                type: "notes",
                data: "content from before chunking existed",
                ctime: 1_600_000_000_000,
                mtime: 1_600_000_000_000,
                size: 36,
            },
        ]);

        const plan = await stack.executor.plan([{ kind: "write", path: "old.md", content: text("") }]);

        expect(plan.changes[0]).toMatchObject({ effect: "update", unchanged: false });
        await stack.executor.commit(plan.id);
        expect(await contentOf(stack.db, "old.md")).toBe("");
    }, 60_000);
});
