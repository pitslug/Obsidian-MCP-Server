/**
 * The tools, through a real MCP client.
 *
 * The other integration tests stop below the protocol: they prove the reader
 * assembles notes and that the transport enforces a token, but nothing until
 * now had actually called a tool. A tool can be broken in ways none of those
 * catch - a schema that rejects valid arguments, a result shape the client
 * cannot parse, a handler that throws where it should explain - and all of
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
import { pdfWithText, pdfWithoutText } from "../helpers/pdf.js";

const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = resolve(here, "../../src/index.ts");
const SETTINGS = resolveSettings({ customChunkSize: 60 });

const NOTE = "# Today\n\n- [ ] a task\n\nSome body text.\n";
const BIG = "project body\n".repeat(400);
/** A page of ink from a handwriting plugin: a real PDF with no text in it. */
const INK = "Ink/2026-07-20 board.pdf";

let couch: FakeCouch;
let replicaDir: string;
let client: Client;

/**
 * CouchDB id and revision of the handwritten PDF's entry, as seeded.
 *
 * Kept so that "the vault was not written to" can be asserted against the
 * server's own storage rather than against a reassuring sentence in a tool's
 * output.
 */
let inkDocId: string;
let inkDocRev: string | undefined;

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
        [INK, { kind: "binary", bytes: pdfWithoutText() }],
        // A PDF that does carry a text layer, so the tools can be shown to tell
        // the two apart rather than treating every PDF as needing a human.
        [
            "attachments/typed.pdf",
            {
                kind: "binary",
                bytes: pdfWithText([
                    "Quarterly summary for the Brisbane depot, prepared in advance.",
                    "Throughput rose; the forklift contract is up for renewal in March.",
                ]),
            },
        ],
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
        if (path === INK) {
            inkDocId = String((composed.entry as unknown as { _id: string })._id);
            inkDocRev = (await couch.get("vault", inkDocId))?._rev as string | undefined;
        }
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
            // Pinned into the temp directory, not left to their defaults. An
            // unpinned INDEX_PATH once had a run silently reuse a previous
            // run's index, which hid a bug for as long as it took to notice;
            // more immediately, defaults would have these tests writing to the
            // container path a deployment uses.
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

describe("the tool surface", () => {
    it("advertises exactly the read tools, and no tool that writes to the vault", async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual([
            "find_by_property",
            "find_by_tag",
            "get_attachment",
            "list_notes",
            "list_untranscribed",
            "note_links",
            "property_inventory",
            "read_note",
            "save_transcription",
            "search_notes",
            "tag_inventory",
            "vault_health",
            "vault_status",
        ]);
        expect(names.some((name) => /write|create|append|delete|update|set_/.test(name))).toBe(false);
    });

    it("registers save_transcription even though this server is read-only", async () => {
        // The one apparent exception to "read-only means no writes". The
        // read-only setting protects the *vault*, and a transcription goes to a
        // local database this server owns; nothing in that path can produce a
        // CouchDB document.
        //
        // That claim is proved by "leaves the vault itself untouched" further
        // down, which reads the attachment's revision back out of CouchDB after
        // a transcription is saved. Asserting it here against the tool's own
        // description would only be testing that the prose is reassuring.
        const status = textOf(await client.callTool({ name: "vault_status", arguments: {} }));
        expect(status).toMatch(/Writes: disabled \(read-only\)/);

        const { tools } = await client.listTools();
        expect(tools.some((tool) => tool.name === "save_transcription")).toBe(true);
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

    it("points at get_attachment rather than returning mojibake", async () => {
        const text = textOf(
            await client.callTool({ name: "read_note", arguments: { path: "attachments/image.png" } })
        );
        expect(text).toMatch(/attachment/);
        expect(text).toMatch(/get_attachment/);
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

describe("get_attachment", () => {
    it("returns an image as an image, for looking at", async () => {
        const result = (await client.callTool({
            name: "get_attachment",
            arguments: { path: "attachments/image.png" },
        })) as { content: { type: string; mimeType?: string }[] };

        const image = result.content.find((part) => part.type === "image");
        expect(image).toBeTruthy();
        expect(image?.mimeType).toBe("image/png");
    });

    it("redirects a text note to read_note", async () => {
        const text = textOf(
            await client.callTool({
                name: "get_attachment",
                arguments: { path: "daily/2026-07-28.md" },
            })
        );
        expect(text).toMatch(/read_note/);
    });

    it("explains a missing attachment", async () => {
        const text = textOf(
            await client.callTool({ name: "get_attachment", arguments: { path: "nope.pdf" } })
        );
        expect(text).toMatch(/No note at "nope.pdf"/);
    });
});

/**
 * Transcription, end to end.
 *
 * The vault this serves is full of handwritten PDFs exported by an Obsidian ink
 * plugin. Those files have no text layer at all, so extraction finds nothing and
 * they are invisible to search - which is the whole problem. The path being
 * tested is: find what cannot be searched, hand it to something that can read
 * ink, store what comes back, and have it searchable immediately.
 *
 * These run in order and share the one server, deliberately: the point is the
 * sequence, not the individual calls.
 */
describe("transcription", () => {
    const TRANSCRIPT =
        "Board meeting, 20 July. Deferred the Adelaide lease. " +
        "Kingfisher trial extended by a fortnight. Ask Priya about the depot roster.";

    it("hands over the PDF itself when there is no text layer to extract", async () => {
        // The step the whole feature turns on. Answering "this has no text
        // layer" in prose would leave a model told to read the file with no
        // way to read it, and list_untranscribed pointing at a dead end.
        const result = (await client.callTool({
            name: "get_attachment",
            arguments: { path: INK },
        })) as {
            content: {
                type: string;
                text?: string;
                resource?: { uri: string; mimeType?: string; blob?: string };
            }[];
        };

        const explanation = result.content.find((part) => part.type === "text");
        expect(explanation?.text).toMatch(/no text layer/i);
        expect(explanation?.text).toMatch(/save_transcription/);
        expect(explanation?.text).toMatch(/does not modify the vault/i);

        const resource = result.content.find((part) => part.type === "resource");
        expect(resource?.resource?.mimeType).toBe("application/pdf");
        expect(resource?.resource?.uri).toContain(INK);
        // The bytes must be the actual PDF, not a placeholder.
        const decoded = Buffer.from(resource?.resource?.blob ?? "", "base64");
        expect(decoded.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    it("returns a PDF that does have a text layer as text, not as bytes", async () => {
        const result = (await client.callTool({
            name: "get_attachment",
            arguments: { path: "attachments/typed.pdf" },
        })) as { content: { type: string; text?: string }[] };

        expect(result.content.every((part) => part.type === "text")).toBe(true);
        expect(textOf(result)).toContain("forklift contract");
    });

    it("lists everything with no searchable text, not only the PDFs", async () => {
        const text = textOf(await client.callTool({ name: "list_untranscribed", arguments: {} }));

        expect(text).toContain(INK);
        expect(text).toContain("no text layer");
        // The image belongs here too. Listing only the states someone thought
        // of is how an image, a file over the extraction cap, or one that
        // failed to parse gets reported as fine while matching nothing: all
        // three have no text, and all three can be read by a model.
        expect(text).toContain("attachments/image.png");

        // A PDF with a real text layer is already searchable; asking a model to
        // read it would be paying twice for what extraction did for free.
        expect(text).not.toContain("attachments/typed.pdf");
        expect(text).toMatch(/2 of 3 attachment\(s\) have no searchable text/);
        expect(text).toMatch(/save_transcription/);
    });

    it("refuses a transcription of a file that is not there", async () => {
        const text = textOf(
            await client.callTool({
                name: "save_transcription",
                arguments: { path: "Ink/imaginary.pdf", text: "..." },
            })
        );
        expect(text).toMatch(/No note at "Ink\/imaginary\.pdf"/);
        expect(text).toMatch(/must belong to a file that exists/);
    });

    it("refuses a transcription of a text note", async () => {
        // Accepting one would put a second, divergent copy of the note's text
        // into the search index, and the note is already searchable.
        const text = textOf(
            await client.callTool({
                name: "save_transcription",
                arguments: { path: "daily/2026-07-28.md", text: "..." },
            })
        );
        expect(text).toMatch(/text note/);
        expect(text).toMatch(/already searchable/);
    });

    it("stores a transcription and says the vault was not touched", async () => {
        const text = textOf(
            await client.callTool({
                name: "save_transcription",
                arguments: { path: INK, text: TRANSCRIPT, provenance: "claude-opus-5" },
            })
        );
        expect(text).toContain(INK);
        // The reassurance matters: a user told this server is read-only needs to
        // know a tool that writes something has not written to their vault.
        expect(text).toMatch(/vault file itself was not modified/i);
    });

    it("makes the handwriting searchable straight away, without a restart", async () => {
        const text = textOf(await client.callTool({ name: "search_notes", arguments: { query: "Kingfisher" } }));
        expect(text).toContain(INK);
        expect(text).toMatch(/«Kingfisher»/i);
    });

    it("stops listing it as needing transcription", async () => {
        const text = textOf(await client.callTool({ name: "list_untranscribed", arguments: {} }));
        expect(text).not.toContain(INK);
        // Asserted positively as well. A bare "does not contain" passes on an
        // error string, on an empty result, and on a false all-clear, none of
        // which is the behaviour being claimed.
        expect(text).toContain("attachments/image.png");
        expect(text).toMatch(/1 of 3 attachment\(s\) have no searchable text/);
    });

    it("serves the transcription afterwards, instead of the apology", async () => {
        // Once someone has paid to have the ink read, returning "no text could
        // be read" would be untrue and would invite the work being redone.
        const text = textOf(await client.callTool({ name: "get_attachment", arguments: { path: INK } }));
        expect(text).toContain("Kingfisher");
        expect(text).toMatch(/Source: transcription \(claude-opus-5\)/);
        expect(text).not.toMatch(/no text layer/i);
    });

    it("leaves the vault itself untouched", async () => {
        // Asserted against CouchDB, not against the tool's own reassurance.
        // A tool that says "the vault was not modified" while modifying it is
        // exactly the failure this project cannot afford, and the only witness
        // that settles it is the stored document's revision.
        const doc = await couch.get("vault", inkDocId);
        expect(doc).toBeTruthy();
        expect(doc?._rev).toBe(inkDocRev);
        expect(JSON.stringify(doc)).not.toContain("Kingfisher");

        const status = textOf(await client.callTool({ name: "vault_status", arguments: {} }));
        expect(status).toMatch(/Writes: disabled \(read-only\)/);
    });
});
