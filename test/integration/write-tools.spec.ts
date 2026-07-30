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
/** Everything the server wrote to stderr, for the tests that read its log. */
let stderr = "";

/**
 * Every tool that can change the vault.
 *
 * Written out here on purpose. This is the assertion, not a mirror of the
 * source: the server derives its own list from the registrations, and the point
 * of stating it independently is to notice when the two disagree.
 */
const MUTATING_TOOLS = [
    "create_note",
    "append_note",
    "append_daily",
    "edit_note",
    "set_properties",
    "delete_note",
    "move_file",
    "copy_file",
    "restore_note",
    "commit_plan",
];

/** Read the server's own instructions, which is what a client is told first. */
const instructions = () => client.getInstructions() ?? "";

function textOf(result: unknown): string {
    return ((result as { content?: { type: string; text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
}

const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }).then(textOf);

/**
 * Poll until something becomes true, for the cases that wait on the feed.
 *
 * Used only where the assertion genuinely depends on the changes feed having
 * been applied. Where the point of a test is that an answer is correct
 * *without* waiting, it asserts immediately and this is deliberately not used.
 */
async function until(predicate: () => Promise<boolean>, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error("Timed out waiting for the index to catch up.");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

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
        // The vault's own conventions, which the server passes to clients.
        ["CLAUDE.md", "# How this vault works\n\nTags are singular and lower case.\n"],
        // A tag in both of the places a tag can live, plus one nested under it,
        // one that merely starts the same way, and one inside a code fence.
        ["tags/one.md", "---\ntags: [work, idea]\n---\n\nSpoke to them about #work today.\n"],
        ["tags/two.md", "---\ntags:\n  - work/acme\n---\n\n#work/acme and #workshop\n"],
        ["tags/three.md", "No frontmatter here, just #work and #work/acme.\n"],
        ["tags/fenced.md", "```\n#work\n```\n\nNothing real here.\n"],
        // A small link graph, because a move is a question about links before
        // it is a question about files. The duplicate basename is the shape
        // the real vault has, and the one that makes a move dangerous.
        ["links/hub.md", "See [[filed]] and ![[filed#Detail]] and [[filed|the note]].\n"],
        ["links/filed.md", "# Filed\n\n## Detail\n\nSomething.\n"],
        ["links/lonely.md", "Nothing points at this one.\n"],
        ["dupes/report.md", "The one at the top.\n"],
        ["dupes/old/report.md", "The superseded one.\n"],
        ["dupes/pointer.md", "See [[report]].\n"],
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

    // An attachment, so there is something in the vault that is not a text
    // note for the tools to refuse. Deleting one would orphan a transcription,
    // which is the only thing in this system that cannot be recomputed.
    const attachment = await composeWrite(
        "attachments/scan.png",
        { kind: "binary", bytes: new Uint8Array(64).fill(9) },
        { settings: SETTINGS, now: 1_700_000_000_000 }
    );
    await couch.seed("vault", [
        ...(attachment.chunks as unknown as Record<string, unknown>[]),
        attachment.entry as unknown as Record<string, unknown>,
    ]);

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
            // Not "error": the startup warning naming what can change the vault
            // is logged at warn, and one of the tests below reads it.
            LOG_LEVEL: "warn",
        },
        stderr: "pipe",
    });

    client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await client.connect(transport);

    // Attached after connect, which is after the warning was emitted. Node
    // holds unread pipe output rather than discarding it, so the first listener
    // still receives everything written before it existed.
    transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
    });
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

        for (const name of [...MUTATING_TOOLS, "plan_set_properties", "discard_plan"]) {
            expect(names).toContain(name);
        }
    });

    it("names every one of them in vault_status", async () => {
        const out = await call("vault_status", {});

        expect(out).toContain("Writes: enabled");
        for (const name of MUTATING_TOOLS) expect(out).toContain(name);

        // The two that cannot write should not be listed as though they could.
        expect(out).not.toContain("discard_plan");
    });

    it("names every one of them in the startup warning too", async () => {
        // Both this and vault_status read one list built by the registrations.
        // They were two lists written by hand, and the warning spent a day
        // omitting delete_note: it said six tools when there were seven, in the
        // one line an operator reads to see what has been let through the door.
        await until(async () => stderr.includes("Writes are ENABLED"));
        const warning = stderr.split("\n").find((line) => line.includes("Writes are ENABLED")) ?? "";

        for (const name of MUTATING_TOOLS) expect(warning).toContain(name);
        expect(warning).not.toContain("discard_plan");
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

/**
 * Deleting, which is the one write whose mistake cannot be walked back here.
 *
 * Last in the file on purpose. This vault is shared across the whole spec in
 * order, so a test that removes a seeded note would change what the selector
 * tests above match. Each of these creates what it then deletes.
 */
describe("delete_note", () => {
    it("removes a note and leaves the tombstone that tells other devices to", async () => {
        await call("create_note", { path: "notes/doomed.md", content: "Not for long.\n" });
        expect(await inVault("notes/doomed.md")).toBe("Not for long.\n");

        const out = await call("delete_note", { path: "notes/doomed.md" });

        expect(out).toContain("Deleted");
        expect(out).toContain("bytes removed");
        expect(await inVault("notes/doomed.md")).toBeUndefined();

        // Soft rather than erased, and the difference is not cosmetic: the
        // tombstone is the only thing that makes a device which was offline
        // remove its copy instead of pushing the note back.
        const raw = (await couch.get("vault", "notes/doomed.md")) as { deleted?: boolean } | undefined;
        expect(raw?.deleted).toBe(true);
    });

    it("frees the path for a new note", async () => {
        await call("create_note", { path: "notes/reused.md", content: "first life\n" });
        await call("delete_note", { path: "notes/reused.md" });

        const out = await call("create_note", { path: "notes/reused.md", content: "second life\n" });

        expect(out).toContain("Created");
        expect(await inVault("notes/reused.md")).toBe("second life\n");
    });

    it("frees the path for an append, which creates the note again", async () => {
        await call("create_note", { path: "notes/reappended.md", content: "first life\n" });
        await call("delete_note", { path: "notes/reappended.md" });

        const out = await call("append_note", { path: "notes/reappended.md", content: "second life\n" });

        expect(out).toContain("Created");
        expect(await inVault("notes/reappended.md")).toBe("second life\n");
    });

    it("says there is nothing to delete rather than reporting a success", async () => {
        const out = await call("delete_note", { path: "notes/never-existed.md" });

        expect(out).toContain("nothing to delete");
        expect(out).not.toContain("Deleted");
    });

    it("does not delete the same note twice", async () => {
        await call("create_note", { path: "notes/twice.md", content: "once\n" });

        expect(await call("delete_note", { path: "notes/twice.md" })).toContain("Deleted");
        expect(await call("delete_note", { path: "notes/twice.md" })).toContain("nothing to delete");
    });

    it("refuses an attachment, which is not its to remove", async () => {
        const out = await call("delete_note", { path: "attachments/scan.png" });

        expect(out).toContain("attachment");
        expect(await couch.get("vault", "attachments/scan.png")).toBeTruthy();
    });
});

/**
 * The property that matters more than the delete tool itself.
 *
 * A deleted note must not come back as context for a question, and the search
 * index is a cache that can outlive one: the changes feed removes a deleted note
 * promptly, but it can fail, and search would then keep answering from a frozen
 * set of notes with nothing in the answer looking wrong. So the tools confirm
 * their results against the replica, and these tests assert the outcome
 * immediately after the delete rather than polling, because "eventually stops
 * appearing" is not the guarantee being claimed.
 */
describe("a deleted note stops being findable", () => {
    const path = "notes/confidential.md";
    const body = "---\nstatus: confidential\ntags: [private]\n---\n\nThe zygomorphic pretzel policy.\n";

    it("leaves search, the selectors and the link graph at once", async () => {
        await call("create_note", { path, content: `${body}\nSee [[structured]].\n` });
        await until(async () => (await call("search_notes", { query: "zygomorphic" })).includes(path));

        await call("delete_note", { path });

        // No polling. The replica has the tombstone by the time the delete
        // returns, and confirmation is what turns that into a correct answer
        // without waiting for the index to be told.
        expect(await call("search_notes", { query: "zygomorphic" })).not.toContain(path);
        expect(await call("find_by_property", { key: "status", value: "confidential" })).not.toContain(path);
        expect(await call("find_by_tag", { tag: "private" })).not.toContain(path);

        // Its links are its content, so the graph must not answer for it either.
        expect(await call("note_links", { path })).toContain("no note at");
    });

    it("and read_note refuses it, which is the authoritative answer", async () => {
        expect(await call("read_note", { path, fresh: true })).toMatch(/no note|not found/i);
    });

    it("stops being counted once the feed catches up", async () => {
        // The inventories aggregate over the index and return no paths to
        // confirm, so they are the one surface that still depends on the feed
        // having been applied. Worth stating plainly rather than implying the
        // guarantee above extends to them.
        await until(async () => !(await call("tag_inventory", {})).includes("private"));
        expect(await call("tag_inventory", {})).not.toContain("private");
    });
});

describe("moving and copying a file", () => {
    it("moves a file whose links do not care which folder it is in", async () => {
        const out = await call("move_file", { path: "links/filed.md", to: "links/archive/filed.md" });

        expect(out).toContain('Moved "links/filed.md" to "links/archive/filed.md"');
        // The claim the caller is relying on, said out loud rather than implied.
        expect(out).toContain("No link in the vault would break");

        expect(await inVault("links/archive/filed.md")).toContain("## Detail");
        expect(await inVault("links/filed.md")).toBeUndefined();

        // The links were basenames, so they still resolve, and the hub note was
        // never touched.
        expect(await inVault("links/hub.md")).toBe(
            "See [[filed]] and ![[filed#Detail]] and [[filed|the note]].\n"
        );
        await until(async () => {
            const links = await call("note_links", { path: "links/hub.md" });
            return links.includes("links/archive/filed.md");
        });
    }, 60_000);

    it("renames a file nothing links to, without ceremony", async () => {
        const out = await call("move_file", { path: "links/lonely.md", to: "links/renamed.md" });

        expect(out).toContain('Renamed "links/lonely.md" to "links/renamed.md"');
        expect(await inVault("links/renamed.md")).toBe("Nothing points at this one.\n");
    }, 60_000);

    it("refuses a rename that would break links, and names the notes", async () => {
        const out = await call("move_file", {
            path: "links/archive/filed.md",
            to: "links/archive/minutes.md",
        });

        expect(out).toContain("Nothing was written");
        expect(out).toContain("links/hub.md");
        expect(out).toContain("plan_move");
        // Refused means refused: nothing at the new path, and the old one intact.
        expect(await inVault("links/archive/minutes.md")).toBeUndefined();
        expect(await inVault("links/archive/filed.md")).toContain("## Detail");
    }, 60_000);

    it("refuses when something is already at the destination", async () => {
        const out = await call("move_file", { path: "dupes/report.md", to: "dupes/old/report.md" });

        expect(out).toContain("already exists");
        expect(await inVault("dupes/report.md")).toBe("The one at the top.\n");
        expect(await inVault("dupes/old/report.md")).toBe("The superseded one.\n");
    }, 60_000);

    it("refuses a move that would quietly re-point a link at a different file", async () => {
        // Nothing breaks and no note changes: `[[report]]` simply comes to mean
        // the superseded copy. This is the failure the check exists for, and
        // the only one that leaves the vault reading correctly and meaning
        // something else.
        const out = await call("move_file", { path: "dupes/report.md", to: "dupes/old/2026/report.md" });

        expect(out).toContain("quietly name a different file");
        expect(out).toContain("dupes/pointer.md");
        expect(await inVault("dupes/old/2026/report.md")).toBeUndefined();
    }, 60_000);

    it("refuses a copy that would take a link from the file it was copied from", async () => {
        const out = await call("copy_file", { path: "dupes/old/report.md", to: "report.md" });

        expect(out).toContain("away from the file they point at now");
        expect(await inVault("report.md")).toBeUndefined();
    }, 60_000);

    it("copies a file, leaving the original alone", async () => {
        const out = await call("copy_file", { path: "dupes/old/report.md", to: "dupes/old/report-copy.md" });

        expect(out).toContain('Copied "dupes/old/report.md" to "dupes/old/report-copy.md"');
        expect(await inVault("dupes/old/report.md")).toBe("The superseded one.\n");
        expect(await inVault("dupes/old/report-copy.md")).toBe("The superseded one.\n");
    }, 60_000);

    it("refuses to move an attachment onto a path outside the vault's reach", async () => {
        const out = await call("move_file", { path: "attachments/scan.png", to: "ix:themes/scan.png" });
        expect(out).toContain("internal containers");
    }, 60_000);

    it("takes an attachment's transcription with it, and it stays searchable", async () => {
        // A transcription is the only thing here that cannot be recomputed, and
        // filing an attachment into a folder is the most likely move in this
        // vault. Losing it would be silent: search would simply stop finding a
        // page that a model was once paid to read.
        await call("save_transcription", {
            path: "attachments/scan.png",
            text: "Handwritten: the Adelaide lease decision was deferred.",
            provenance: "test",
        });
        await until(async () => (await call("search_notes", { query: "Adelaide" })).includes("scan.png"));

        const out = await call("move_file", {
            path: "attachments/scan.png",
            to: "attachments/filed/scan.png",
        });
        expect(out).toContain("transcription");

        await until(async () =>
            (await call("search_notes", { query: "Adelaide" })).includes("attachments/filed/scan.png")
        );
        const untranscribed = await call("list_untranscribed", {});
        expect(untranscribed).not.toContain("attachments/scan.png");
    }, 60_000);
});

describe("planning a rename", () => {
    it("rewrites the links, keeping aliases, subpaths and embeds", async () => {
        const plan = await call("plan_move", {
            path: "links/archive/filed.md",
            to: "links/archive/minutes.md",
        });

        expect(plan).toContain("links/archive/filed.md -> links/archive/minutes.md");
        expect(plan).toContain("links/hub.md: rewrites 3 link(s)");
        // Nothing yet, which is the point of a plan.
        expect(await inVault("links/archive/minutes.md")).toBeUndefined();

        const id = /Plan ([0-9a-f-]{36})/.exec(plan)?.[1];
        expect(id).toBeTruthy();
        const committed = await call("commit_plan", { plan_id: id as string });
        // Two written and one removed, rather than three written: the old path
        // is a tombstone, not a note anybody wrote.
        expect(committed).toContain("2 note(s) written, 1 removed");
        expect(committed).toContain("links/archive/filed.md (removed)");

        expect(await inVault("links/archive/minutes.md")).toContain("## Detail");
        expect(await inVault("links/archive/filed.md")).toBeUndefined();
        // Only the targets changed. The alias, the subpath and the embed marker
        // are somebody's writing and are still exactly as they were.
        expect(await inVault("links/hub.md")).toBe(
            "See [[minutes]] and ![[minutes#Detail]] and [[minutes|the note]].\n"
        );
    }, 60_000);

    it("refuses to plan a move of something that is not there", async () => {
        const out = await call("plan_move", { path: "links/ghost.md", to: "links/elsewhere.md" });
        expect(out).toContain("There is nothing at");
    }, 60_000);
});

describe("what the server tells a client about itself", () => {
    it("does not claim to be read-only when it is not", async () => {
        // The bug this replaced: a hardcoded sentence saying the server was
        // read-only, sent to every client while every write tool sat
        // registered behind it. Nothing failed, because nothing checked.
        expect(instructions()).not.toContain("read-only");
        expect(instructions()).toContain("Writing is enabled");
    });

    it("says a plan is to be shown to somebody before it is committed", async () => {
        expect(instructions()).toContain("commit_plan");
        expect(instructions().toLowerCase()).toContain("shown to the person");
    });

    it("passes on the vault's own conventions note", async () => {
        expect(instructions()).toContain("CLAUDE.md");
        expect(instructions()).toContain("Tags are singular and lower case.");
    });

    it("says in vault_status that this client was told them", async () => {
        // Three states look identical from the outside: no conventions note, a
        // note that was passed on, and a note edited since this client
        // connected. Only the last is a problem, and only this line tells them
        // apart.
        expect(await call("vault_status", {})).toContain(
            'Conventions: "CLAUDE.md", passed to this client when it connected'
        );
    });

    it("notices when the conventions note has changed since the client connected", async () => {
        await call("append_note", { path: "CLAUDE.md", content: "Meetings go under Meetings/." });

        await until(async () => (await call("vault_status", {})).includes("CHANGED since"));
        const status = await call("vault_status", {});
        expect(status).toContain("reconnect");
    }, 30_000);
});

describe("renaming a tag across the vault", () => {
    it("plans both places a tag lives, and writes nothing yet", async () => {
        const plan = await call("plan_retag", { tag: "work", to: "client" });

        expect(plan).toContain("Renaming #work to #client");
        expect(plan).toContain("taking 1 nested tag(s) with it");
        expect(plan).toContain("tags/one.md: renames #work to #client: 1 in the body, 1 frontmatter");
        expect(plan).toContain("tags/three.md: renames #work to #client: 2 in the body");
        // Nothing has moved.
        expect(await inVault("tags/one.md")).toContain("#work");

        const id = /Plan ([0-9a-f-]{36})/.exec(plan)?.[1];
        await call("commit_plan", { plan_id: id as string });

        expect(await inVault("tags/one.md")).toBe(
            "---\ntags:\n  - client\n  - idea\n---\n\nSpoke to them about #client today.\n"
        );
        expect(await inVault("tags/three.md")).toBe("No frontmatter here, just #client and #client/acme.\n");
    }, 60_000);

    it("takes the nested tags with it and leaves the lookalike alone", async () => {
        expect(await inVault("tags/two.md")).toBe(
            "---\ntags:\n  - client/acme\n---\n\n#client/acme and #workshop\n"
        );
    }, 60_000);

    it("never touched the one inside a code fence", async () => {
        // The index never read it as a tag either, so editing it would be
        // rewriting an example to suit a rename.
        expect(await inVault("tags/fenced.md")).toBe("```\n#work\n```\n\nNothing real here.\n");
    }, 60_000);

    it("refuses to remove a tag that has nested tags under it", async () => {
        const out = await call("plan_retag", { tag: "client" });

        expect(out).toContain("nested under it");
        expect(out).toContain("#client/acme");
        expect(out).toContain("guessing is worse than asking");
    }, 60_000);

    it("removes a tag that has nothing under it", async () => {
        const plan = await call("plan_retag", { tag: "idea" });
        expect(plan).toContain("Removing #idea");

        const id = /Plan ([0-9a-f-]{36})/.exec(plan)?.[1];
        await call("commit_plan", { plan_id: id as string });

        expect(await inVault("tags/one.md")).toBe(
            "---\ntags:\n  - client\n---\n\nSpoke to them about #client today.\n"
        );
    }, 60_000);

    it("says so rather than planning nothing when the tag does not exist", async () => {
        const out = await call("plan_retag", { tag: "nonexistent", to: "other" });
        expect(out).toContain("No note carries #nonexistent");
        expect(out).toContain("tag_inventory");
    }, 60_000);
});

describe("bringing a deleted note back", () => {
    it("restores it byte for byte from the deletion record", async () => {
        const before = await inVault("notes/repeated.md");
        await call("delete_note", { path: "notes/repeated.md" });
        expect(await inVault("notes/repeated.md")).toBeUndefined();

        const out = await call("restore_note", { path: "notes/repeated.md" });

        expect(out).toContain('Restored "notes/repeated.md"');
        expect(out).toContain("byte-for-byte");
        expect(await inVault("notes/repeated.md")).toBe(before);
    }, 60_000);

    it("refuses when something is there, rather than replacing it", async () => {
        const out = await call("restore_note", { path: "notes/repeated.md" });
        expect(out).toContain("is not deleted");
    }, 60_000);

    it("says so when the path never held anything", async () => {
        const out = await call("restore_note", { path: "notes/never-existed.md" });
        expect(out).toContain("There is nothing at");
    }, 60_000);

    it("makes the restored note findable again", async () => {
        await call("delete_note", { path: "notes/repeated.md" });
        await until(async () => !(await call("search_notes", { query: "beta" })).includes("repeated.md"));

        await call("restore_note", { path: "notes/repeated.md" });
        await until(async () => (await call("search_notes", { query: "beta" })).includes("repeated.md"));
    }, 60_000);
});
