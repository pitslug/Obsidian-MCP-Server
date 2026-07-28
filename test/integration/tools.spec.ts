/**
 * The tools, through a real MCP client.
 *
 * The other integration tests stop below the protocol: they prove the reader
 * assembles notes and that the transport enforces a token, but nothing until
 * now had actually called a tool. A tool can be broken in ways none of those
 * catch — a schema that rejects valid arguments, a result shape the client
 * cannot parse, a handler that throws where it should explain — and all of
 * them present to the user as the assistant simply not being able to read
 * their notes.
 *
 * So this speaks the protocol, over stdio, against the server as it actually
 * starts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeWrite } from "../../src/vault-model/compose.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(here, "../../src/index.ts");
const SETTINGS = resolveSettings({ customChunkSize: 60 });

const NOTE = "# Today\n\n- [ ] a task\n\nSome body text.\n";
const BIG = "project body\n".repeat(400);

let couch: FakeCouch;
let replicaDir: string;
let client: Client;

/** Text of a tool result, joined. */
function textOf(result: unknown): string {
    return ((result as { content?: { type: string; text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
}

beforeAll(async () => {
    couch = await startFakeCouch();
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-tools-"));

    await couch.createDatabase("vault");
    await couch.seed("vault", [
        {
            _id: DOCID_MILESTONE,
            type: "milestoneinfo",
            created: 1,
            accepted_nodes: [],
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

    for (const [path, content] of [
        ["daily/2026-07-28.md", { kind: "text", text: NOTE }],
        ["projects/big.md", { kind: "text", text: BIG }],
        ["attachments/image.png", { kind: "binary", bytes: new Uint8Array(3000).fill(7) }],
        [
            "projects/house.md",
            {
                kind: "text",
                text:
                    "---\nstatus: active\npriority: 2\ntags: [home, finance]\n---\n\n" +
                    "Refinancing the mortgage. See [[daily/2026-07-28]] and [[nowhere]].\n",
            },
        ],
        [
            "projects/shed.md",
            {
                kind: "text",
                text: "---\nstatus: done\npriority: low\n---\n\nBuilt the shed. #home\n",
            },
        ],
    ] as [string, Parameters<typeof composeWrite>[1]][]) {
        const composed = await composeWrite(path, content, { settings: SETTINGS, now: 1_700_000_000_000 });
        await couch.seed("vault", [
            ...(composed.chunks as unknown as Record<string, unknown>[]),
            composed.entry as unknown as Record<string, unknown>,
        ]);
    }

    const transport = new StdioClientTransport({
        // `node --import tsx` rather than `npx tsx`: npx spawns a grandchild,
        // and killing npx leaves that child alive holding its connections
        // open, which hangs teardown rather than failing it.
        command: process.execPath,
        args: ["--import", "tsx", entrypoint],
        env: {
            ...(process.env as Record<string, string>),
            COUCHDB_URL: couch.url,
            COUCHDB_DATABASE: "vault",
            MCP_TRANSPORT: "stdio",
            REPLICA_PATH: join(replicaDir, "replica"),
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

describe("the tool surface", () => {
    it("advertises exactly the read tools, and no write tools", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual([
            "find_by_property",
            "find_by_tag",
            "list_notes",
            "note_links",
            "property_inventory",
            "read_note",
            "search_notes",
            "tag_inventory",
            "vault_health",
            "vault_status",
        ]);
        expect(names.some((name) => /write|create|append|delete|update|set_/.test(name))).toBe(false);
    });

    it("describes each tool well enough to be chosen correctly", async () => {
        const { tools } = await client.listTools();
        for (const tool of tools) {
            // A one-word description is how a model ends up calling the wrong
            // tool, or none at all.
            expect(tool.description?.length ?? 0).toBeGreaterThan(60);
        }
    });
});

describe("vault_status", () => {
    it("reports replication, staleness and that writes are off", async () => {
        const text = textOf(await client.callTool({ name: "vault_status", arguments: {} }));
        expect(text).toMatch(/Replication:/);
        expect(text).toMatch(/Staleness:/);
        expect(text).toMatch(/Writes: disabled \(read-only\)/);
        expect(text).toMatch(/Local replica: \d/);
    });
});

describe("list_notes", () => {
    it("lists every note with size and date, but no content", async () => {
        const text = textOf(await client.callTool({ name: "list_notes", arguments: {} }));
        expect(text).toContain("daily/2026-07-28.md");
        expect(text).toContain("projects/big.md");
        expect(text).toContain("attachments/image.png");
        // Content must not leak into a listing.
        expect(text).not.toContain("a task");
    });

    it("limits to a folder", async () => {
        const text = textOf(await client.callTool({ name: "list_notes", arguments: { folder: "daily" } }));
        expect(text).toContain("daily/2026-07-28.md");
        expect(text).not.toContain("projects/big.md");
    });

    it("says so plainly when a folder holds nothing", async () => {
        const text = textOf(await client.callTool({ name: "list_notes", arguments: { folder: "nope" } }));
        expect(text).toMatch(/No notes found under "nope"/);
    });

    it("marks a truncated listing rather than quietly dropping entries", async () => {
        const text = textOf(await client.callTool({ name: "list_notes", arguments: { limit: 1 } }));
        expect(text).toContain("truncated");
    });
});

describe("read_note", () => {
    it("returns the note's text with its metadata", async () => {
        const text = textOf(
            await client.callTool({ name: "read_note", arguments: { path: "daily/2026-07-28.md" } })
        );
        expect(text).toContain("Path: daily/2026-07-28.md");
        expect(text).toContain(NOTE.trim());
    });

    it("reassembles a note that spans many chunks", async () => {
        const text = textOf(
            await client.callTool({ name: "read_note", arguments: { path: "projects/big.md" } })
        );
        expect(text).toContain(BIG.trim());
    });

    it("explains a missing note and points at list_notes", async () => {
        const text = textOf(await client.callTool({ name: "read_note", arguments: { path: "nope.md" } }));
        expect(text).toMatch(/No note at "nope.md"/);
        expect(text).toContain("list_notes");
    });

    it("refuses a binary file rather than returning mojibake", async () => {
        const text = textOf(
            await client.callTool({ name: "read_note", arguments: { path: "attachments/image.png" } })
        );
        expect(text).toMatch(/binary file/);
        expect(text).toMatch(/not implemented yet/);
    });

    it("rejects arguments that do not match the schema", async () => {
        // The schema is the only thing stopping a malformed call reaching the
        // reader, so it is worth knowing it is enforced.
        await expect(client.callTool({ name: "read_note", arguments: { path: 42 } })).rejects.toThrow();
    });
});

describe("search and curation", () => {
    it("finds notes by full-text search, with an excerpt", async () => {
        const text = textOf(
            await client.callTool({ name: "search_notes", arguments: { query: "mortgage" } })
        );
        expect(text).toContain("projects/house.md");
        expect(text).toMatch(/«mortgage»/i);
    });

    it("explains a malformed query instead of throwing at the caller", async () => {
        const text = textOf(
            await client.callTool({ name: "search_notes", arguments: { query: 'unbalanced "quote' } })
        );
        expect(text).toMatch(/rejected/i);
        expect(text).toMatch(/quote/i);
    });

    it("says plainly when nothing matches", async () => {
        const text = textOf(
            await client.callTool({ name: "search_notes", arguments: { query: "zzzznotpresent" } })
        );
        expect(text).toMatch(/No notes match/);
    });

    it("inventories frontmatter properties and flags inconsistent types", async () => {
        const text = textOf(await client.callTool({ name: "property_inventory", arguments: {} }));
        expect(text).toContain("status");
        expect(text).toContain("priority");
        // priority is a number in one note and text in another, which is
        // exactly what the inventory exists to surface.
        expect(text).toMatch(/more than one value type/);
    });

    it("finds notes by property value", async () => {
        const text = textOf(
            await client.callTool({
                name: "find_by_property",
                arguments: { key: "status", value: "done" },
            })
        );
        expect(text).toContain("projects/shed.md");
        expect(text).not.toContain("projects/house.md");
    });

    it("inventories tags from frontmatter and inline alike", async () => {
        const text = textOf(await client.callTool({ name: "tag_inventory", arguments: {} }));
        expect(text).toContain("#home");
        expect(text).toContain("#finance");
    });

    it("finds notes by tag", async () => {
        const text = textOf(await client.callTool({ name: "find_by_tag", arguments: { tag: "home" } }));
        expect(text).toContain("projects/house.md");
        expect(text).toContain("projects/shed.md");
    });

    it("reports outgoing links and backlinks", async () => {
        const outgoing = textOf(
            await client.callTool({ name: "note_links", arguments: { path: "projects/house.md" } })
        );
        expect(outgoing).toContain("daily/2026-07-28.md");
        expect(outgoing).toContain("UNRESOLVED");

        const back = textOf(
            await client.callTool({
                name: "note_links",
                arguments: { path: "daily/2026-07-28.md", direction: "backlinks" },
            })
        );
        expect(back).toContain("projects/house.md");
    });

    it("reports broken links in the health check", async () => {
        const text = textOf(await client.callTool({ name: "vault_health", arguments: {} }));
        expect(text).toMatch(/Unresolved links \(\d+\)/);
        expect(text).toContain("nowhere");
    });
});
