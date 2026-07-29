/**
 * The write tools, through a real MCP client.
 *
 * These run against a server started with `READ_ONLY=false`, which no other
 * test does. That alone is worth having: every other integration test proves
 * the vault cannot be touched, and this one has to prove the opposite works.
 *
 * The test that matters most is "reads the current note, not the replica's
 * copy". It is the difference between a tool that appends a line and a tool
 * that occasionally deletes somebody's paragraph, and it cannot be observed
 * from the tool's output: both versions report success.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    assembleFile,
    composeWrite,
    decodeDocument,
    resolveSettings,
    transformContextFor,
    type ChunkEntry,
    type ChunkedEntry,
} from "../../src/vault-model/index.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { CouchWriter } from "../../src/write/couch.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(here, "../../src/index.ts");
const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TRANSFORM = transformContextFor(SETTINGS, undefined);

let couch: FakeCouch;
let replicaDir: string;
let client: Client;

function textOf(result: unknown): string {
    return ((result as { content?: { type: string; text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
}

const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }).then(textOf);

/** Read a note out of CouchDB, through the vault model, as a device would. */
async function inVault(path: string): Promise<string | undefined> {
    const raw = await couch.get("vault", path);
    if (!raw) return undefined;
    const entry = (await decodeDocument(raw as never, TRANSFORM)) as unknown as ChunkedEntry;
    if (entry.deleted) return undefined;

    const chunks = new Map<string, ChunkEntry>();
    for (const child of entry.children ?? []) {
        const chunkRaw = await couch.get("vault", child);
        if (chunkRaw) {
            chunks.set(child, (await decodeDocument(chunkRaw as never, TRANSFORM)) as unknown as ChunkEntry);
        }
    }
    const file = assembleFile(entry, chunks);
    return file.kind === "text" ? file.text : undefined;
}

/**
 * Write a note straight to CouchDB, behind the server's back.
 *
 * Stands in for another device. Deliberately not routed through the running
 * server, so the replica it holds is genuinely behind afterwards.
 */
async function writeBehindItsBack(path: string, text: string): Promise<void> {
    const writer = new CouchWriter({
        couch: { url: couch.url, database: "vault", username: undefined, password: undefined },
        readOnly: false,
    });
    const existing = await writer.get(path);
    const composed = await composeWrite(
        path,
        { kind: "text", text },
        { settings: SETTINGS, now: 1_800_000_000_000 }
    );
    await writer.bulkPut(composed.chunks as unknown as Record<string, unknown>[]);
    await writer.put({
        ...(composed.entry as unknown as Record<string, unknown>),
        ...(existing?._rev ? { _rev: existing._rev } : {}),
    });
}

beforeAll(async () => {
    couch = await startFakeCouch();
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-writetools-"));

    await couch.createDatabase("vault");
    await couch.seed("vault", [
        {
            _id: DOCID_MILESTONE,
            type: "milestoneinfo",
            created: 1,
            accepted_nodes: ["deviceA"],
            node_info: {},
            locked: false,
            node_chunk_info: {},
            tweak_values: {
                deviceA: {
                    encrypt: false,
                    usePathObfuscation: false,
                    enableCompression: false,
                    hashAlg: "xxhash64",
                    chunkSplitterVersion: "v3-rabin-karp",
                    handleFilenameCaseSensitive: false,
                    minimumChunkSize: 20,
                    customChunkSize: 60,
                },
            },
        },
        { _id: DOCID_VERSIONING, type: "versioninfo", version: SUPPORTED_DB_VERSION },
    ]);

    for (const [path, text] of [
        ["daily/2026-07-28.md", "# Today\n\n- [ ] a task\n"],
        // A second dated note, because one filename is not a convention and
        // the daily note format is inferred from the vault rather than told.
        ["daily/2026-07-27.md", "# Yesterday\n\n## Log\n\n- got up\n\n## Notes\n\nnothing.\n"],
        ["notes/structured.md", "# Meeting\n\n## Actions\n\n- one\n\n## Attendees\n\n- Chris\n"],
        ["projects/house.md", "---\nstatus: active\npriority: 2\n---\n\nRefinancing the mortgage.\n"],
        ["projects/shed.md", "---\nstatus: active\n---\n\nThe shed.\n"],
        ["projects/fence.md", "---\ntags: [project]\n---\n\nThe fence.\n"],
        ["projects/broken.md", "---\nstatus: [unclosed\n---\n\nBad YAML on purpose.\n"],
        ["notes/repeated.md", "alpha\nbeta\nalpha\n"],
    ]) {
        const composed = await composeWrite(
            path as string,
            { kind: "text", text: text as string },
            { settings: SETTINGS, now: 1_700_000_000_000 }
        );
        await couch.seed("vault", [
            ...(composed.chunks as unknown as Record<string, unknown>[]),
            composed.entry as unknown as Record<string, unknown>,
        ]);
    }

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", entrypoint],
        env: {
            ...(process.env as Record<string, string>),
            COUCHDB_URL: couch.url,
            COUCHDB_DATABASE: "vault",
            MCP_TRANSPORT: "stdio",
            READ_ONLY: "false",
            REPLICA_PATH: join(replicaDir, "replica"),
            INDEX_PATH: join(replicaDir, "index.sqlite"),
            TRANSCRIPT_PATH: join(replicaDir, "transcripts.sqlite"),
            LOG_LEVEL: "error",
        },
        stderr: "pipe",
    });

    client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await client.connect(transport);
}, 180_000);

afterAll(async () => {
    await client?.close().catch(() => undefined);
    await couch?.stop();
    await rm(replicaDir, { recursive: true, force: true });
});

describe("the write surface", () => {
    it("registers the write tools when writes are enabled", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);

        for (const name of [
            "create_note",
            "append_note",
            "append_daily",
            "edit_note",
            "set_properties",
            "plan_set_properties",
            "commit_plan",
            "discard_plan",
        ]) {
            expect(names).toContain(name);
        }
    });

    it("says so in vault_status", async () => {
        const out = await call("vault_status", {});
        expect(out).toContain("Writes: enabled");
        expect(out).toContain("create_note");
    });
});

describe("create_note", () => {
    it("creates a note that reads back through the vault model", async () => {
        const out = await call("create_note", {
            path: "ideas/kaizen.md",
            content: "# Kaizen\n\nSmall improvements, continuously.\n",
        });

        expect(out).toContain("Created");
        expect(await inVault("ideas/kaizen.md")).toBe("# Kaizen\n\nSmall improvements, continuously.\n");
    });

    it("writes frontmatter when properties are given", async () => {
        await call("create_note", {
            path: "ideas/with-properties.md",
            content: "Body text.\n",
            properties: { status: "draft", tags: ["idea", "later"] },
        });

        expect(await inVault("ideas/with-properties.md")).toBe(
            "---\nstatus: draft\ntags:\n  - idea\n  - later\n---\nBody text.\n"
        );
    });

    it("refuses to overwrite a note that already exists", async () => {
        const before = await inVault("daily/2026-07-28.md");
        const out = await call("create_note", {
            path: "daily/2026-07-28.md",
            content: "clobbered\n",
        });

        expect(out).toContain("already exists");
        expect(await inVault("daily/2026-07-28.md")).toBe(before);
    });

    it("refuses a path the plugin would never sync", async () => {
        const out = await call("create_note", { path: "notes/12:30 meeting.md", content: "x\n" });
        expect(out).toContain("colon");
    });
});

describe("append_note", () => {
    it("appends to an existing note without disturbing what is there", async () => {
        await call("append_note", { path: "daily/2026-07-28.md", content: "- [ ] another task" });

        expect(await inVault("daily/2026-07-28.md")).toBe("# Today\n\n- [ ] a task\n\n- [ ] another task");
    });

    it("creates the note when it does not exist", async () => {
        const out = await call("append_note", { path: "daily/2026-07-29.md", content: "First entry.\n" });

        expect(out).toContain("Created");
        expect(await inVault("daily/2026-07-29.md")).toBe("First entry.\n");
    });

    it("honours a custom separator", async () => {
        await call("append_note", { path: "daily/2026-07-29.md", content: "Second.", separator: "\n" });
        expect(await inVault("daily/2026-07-29.md")).toBe("First entry.\nSecond.");
    });

    /**
     * The one that justifies `fresh: true` on every read in the write path.
     *
     * Another device edits the note; the server's replica has not caught up.
     * If the tool composed from the replica it would write the old body plus
     * the new line, silently deleting the other device's edit, and would report
     * success either way.
     */
    it("appends to what the vault says now, not to the replica's copy", async () => {
        await writeBehindItsBack("notes/concurrent.md", "written by another device\n");

        await call("append_note", { path: "notes/concurrent.md", content: "appended by the tool" });

        expect(await inVault("notes/concurrent.md")).toBe(
            "written by another device\n\nappended by the tool"
        );
    });
});

describe("edit_note", () => {
    it("replaces text that appears exactly once", async () => {
        await call("create_note", { path: "notes/edit-me.md", content: "one\ntwo\nthree\n" });
        const out = await call("edit_note", { path: "notes/edit-me.md", find: "two", replace: "TWO" });

        expect(out).toContain("Edited");
        expect(await inVault("notes/edit-me.md")).toBe("one\nTWO\nthree\n");
    });

    it("refuses an ambiguous edit rather than changing the first match", async () => {
        const before = await inVault("notes/repeated.md");
        const out = await call("edit_note", { path: "notes/repeated.md", find: "alpha", replace: "ALPHA" });

        expect(out).toContain("appears 2 times");
        expect(await inVault("notes/repeated.md")).toBe(before);
    });

    it("says so when the text is not there, and changes nothing", async () => {
        const before = await inVault("notes/repeated.md");
        const out = await call("edit_note", { path: "notes/repeated.md", find: "gamma", replace: "x" });

        expect(out).toContain("does not appear");
        expect(await inVault("notes/repeated.md")).toBe(before);
    });

    it("points at create_note when the note does not exist", async () => {
        const out = await call("edit_note", { path: "notes/absent.md", find: "a", replace: "b" });
        expect(out).toContain("create_note");
    });

    it("treats the replacement literally, not as a regular expression", async () => {
        // `$&` in a replacement string is a backreference to the match. A tool
        // that passed it straight to String.replace would write the match back
        // instead of what was asked for.
        await call("create_note", { path: "notes/dollar.md", content: "value: OLD\n" });
        await call("edit_note", { path: "notes/dollar.md", find: "OLD", replace: "$& and $1" });

        expect(await inVault("notes/dollar.md")).toBe("value: $& and $1\n");
    });
});

describe("set_properties", () => {
    it("adds and changes properties without touching the body", async () => {
        const out = await call("set_properties", {
            path: "projects/house.md",
            set: { status: "done", reviewed: "2026-07-28" },
        });

        expect(out).toContain("Updated properties");
        const text = await inVault("projects/house.md");
        expect(text).toContain("status: done");
        expect(text).toContain("reviewed: 2026-07-28");
        expect(text).toContain("priority: 2");
        expect(text?.endsWith("\nRefinancing the mortgage.\n")).toBe(true);
    });

    it("removes a property", async () => {
        await call("set_properties", { path: "projects/house.md", remove: ["priority"] });
        expect(await inVault("projects/house.md")).not.toContain("priority");
    });

    it("writes nothing when the properties already say that", async () => {
        const before = await inVault("projects/house.md");
        const out = await call("set_properties", { path: "projects/house.md", set: { status: "done" } });

        expect(out).toContain("Nothing was written");
        expect(await inVault("projects/house.md")).toBe(before);
    });

    it("refuses to rewrite frontmatter it cannot parse", async () => {
        await writeBehindItsBack("notes/broken-fm.md", "---\ntitle: [unclosed\n---\nBody.\n");
        const out = await call("set_properties", { path: "notes/broken-fm.md", set: { status: "draft" } });

        expect(out).toContain("cannot be edited");
        expect(await inVault("notes/broken-fm.md")).toBe("---\ntitle: [unclosed\n---\nBody.\n");
    });

    it("asks for something to do when given neither set nor remove", async () => {
        const out = await call("set_properties", { path: "projects/house.md" });
        expect(out).toContain("Nothing to do");
    });
});

describe("appending under a heading", () => {
    it("puts the text at the end of the named section", async () => {
        await call("append_note", {
            path: "notes/structured.md",
            heading: "Actions",
            content: "- two",
        });

        expect(await inVault("notes/structured.md")).toBe(
            "# Meeting\n\n## Actions\n\n- one\n\n- two\n\n## Attendees\n\n- Chris\n"
        );
    });

    it("creates the heading when the note does not have it, and says so", async () => {
        const out = await call("append_note", {
            path: "notes/structured.md",
            heading: "Decisions",
            content: "- ship it",
        });

        expect(out).toContain('There was no "Decisions" heading');
        expect(await inVault("notes/structured.md")).toContain("## Decisions\n\n- ship it\n");
    });

    it("refuses an ambiguous heading rather than picking a section", async () => {
        await writeBehindItsBack("notes/twice.md", "## Log\n\na\n\n## Log\n\nb\n");
        const out = await call("append_note", { path: "notes/twice.md", heading: "Log", content: "c" });

        expect(out).toContain("appears 2 times");
        expect(await inVault("notes/twice.md")).toBe("## Log\n\na\n\n## Log\n\nb\n");
    });
});

describe("append_daily", () => {
    it("works out where daily notes live and says how", async () => {
        const out = await call("append_daily", { content: "- a thought", date: "2026-07-27" });

        expect(out).toContain('Inferred the template "daily/YYYY-MM-DD.md"');
        expect(out).toContain('"daily/2026-07-27.md"');
        expect(await inVault("daily/2026-07-27.md")).toContain("nothing.\n\n- a thought");
    });

    it("files the text under a heading when given one", async () => {
        await call("append_daily", { content: "- got dressed", date: "2026-07-27", heading: "Log" });

        const text = await inVault("daily/2026-07-27.md");
        expect(text).toContain("- got up\n\n- got dressed\n\n## Notes");
    });

    it("creates the day's note when there is not one yet", async () => {
        const out = await call("append_daily", { content: "First thing.", date: "2026-06-01" });

        expect(out).toContain("Created");
        expect(await inVault("daily/2026-06-01.md")).toBe("First thing.");
    });

    it("defaults to today in the vault's time zone", async () => {
        const today = new Intl.DateTimeFormat("en-CA", {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }).format(new Date());

        const out = await call("append_daily", { content: "today's capture" });

        expect(out).toContain(`daily/${today}.md`);
    });

    it("refuses a date that is not a date", async () => {
        const out = await call("append_daily", { content: "x", date: "yesterday" });
        expect(out).toContain("is not a date");
    });
});

describe("plan_set_properties", () => {
    it("refuses a selection that would mean the whole vault", async () => {
        const out = await call("plan_set_properties", { set: { reviewed: true } });
        expect(out).toContain("No selection was given");
    });

    it("plans without writing, and names the notes it would change", async () => {
        const before = await inVault("projects/shed.md");
        const out = await call("plan_set_properties", {
            property_key: "status",
            property_value: "active",
            set: { reviewed: "2026-07-28" },
        });

        expect(out).toContain("Selection: notes where status =");
        expect(out).toContain("projects/shed.md: adds reviewed = 2026-07-28");
        expect(out).toContain("Nothing has been written.");
        expect(await inVault("projects/shed.md")).toBe(before);
    });

    it("separates overwrites from additions, and excludes what it cannot parse", async () => {
        const out = await call("plan_set_properties", {
            folder: "projects",
            set: { status: "archived" },
        });

        expect(out).toContain("Replaces or removes existing content");
        expect(out).toContain("projects/shed.md: overwrites status (to archived)");
        expect(out).toContain("projects/fence.md: adds status = archived");
        expect(out).toContain("Excluded (1):");
        expect(out).toContain("projects/broken.md");
    });

    it("does not cross a folder boundary that merely shares a prefix", async () => {
        const out = await call("plan_set_properties", { folder: "project", set: { x: 1 } });
        expect(out).toContain("No notes are under");
    });

    it("intersects selectors rather than combining them", async () => {
        const out = await call("plan_set_properties", {
            folder: "projects",
            property_key: "tags",
            set: { reviewed: true },
        });

        expect(out).toContain("projects/fence.md");
        expect(out).not.toContain("projects/shed.md");
    });

    it("commits a plan, and refuses to commit it twice", async () => {
        const planned = await call("plan_set_properties", {
            property_key: "tags",
            property_value: "project",
            set: { reviewed: "yes" },
        });
        const planId = /Plan ([0-9a-f-]{36})/.exec(planned)?.[1];
        expect(planId).toBeDefined();

        const committed = await call("commit_plan", { plan_id: planId as string });
        expect(committed).toContain("1 note(s) written");
        expect(await inVault("projects/fence.md")).toContain("reviewed: yes");

        const again = await call("commit_plan", { plan_id: planId as string });
        expect(again).toContain("already been committed");
    });

    it("refuses in full when a note moved after the plan was made", async () => {
        const planned = await call("plan_set_properties", {
            folder: "projects",
            property_key: "status",
            set: { phase: "planning" },
        });
        const planId = /Plan ([0-9a-f-]{36})/.exec(planned)?.[1] as string;

        await writeBehindItsBack("projects/shed.md", "---\nstatus: active\n---\n\nChanged elsewhere.\n");

        const out = await call("commit_plan", { plan_id: planId });
        expect(out).toContain("Nothing was written");
        expect(await inVault("projects/shed.md")).toContain("Changed elsewhere.");
        expect(await inVault("projects/shed.md")).not.toContain("phase");
    });

    it("discards a plan on request", async () => {
        const planned = await call("plan_set_properties", {
            property_key: "status",
            set: { discarded: true },
        });
        const planId = /Plan ([0-9a-f-]{36})/.exec(planned)?.[1] as string;

        expect(await call("discard_plan", { plan_id: planId })).toContain("discarded");
        expect(await call("commit_plan", { plan_id: planId })).toContain("No plan with ID");
    });
});
