/**
 * Transcriptions across a restart, and across an index rebuild.
 *
 * This is the property the whole transcription design exists to provide, and
 * the one nothing else tests. The tool-level tests prove that saving a
 * transcription makes it searchable *in that process*, because `save_transcription`
 * reindexes in place. That would keep passing if the transcript store were
 * write-only: the text is in the index's FTS table either way.
 *
 * What is being defended here is the branch in `IndexBuilder.indexOne` that
 * reads the store back. Delete it and every transcription silently vanishes on
 * the next start; the vault's handwritten pages drop out of search, and
 * `list_untranscribed` asks for the work to be done again. Nothing else in the
 * suite notices.
 *
 * So each test here throws the index away and starts a second server against
 * the same transcript store, which is exactly what a schema bump or a `docker
 * compose down -v` on the wrong volume would do.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { start, type RunningServer } from "../../src/server/index.js";
import { composeWrite } from "../../src/vault-model/compose.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";
import { pdfWithoutText } from "../helpers/pdf.js";
import type { Config } from "../../src/config.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TOKEN = "a-test-bearer-token-that-is-long-enough";
const INK = "Ink/2026-07-20 board.pdf";
const TRANSCRIPT =
    "Board meeting, 20 July. Deferred the Adelaide lease. Kingfisher trial extended by a fortnight.";

let couch: FakeCouch;
let workDir: string;
let running: RunningServer | undefined;
let client: Client | undefined;
let counter = 0;

function textOf(result: unknown): string {
    return ((result as { content?: { type: string; text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
}

async function freePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address() as { port: number };
            s.close(() => resolve(port));
        });
    });
}

/** Write a file into the vault as another device would, chunks and all. */
async function seedFile(db: string, path: string, bytes: Uint8Array): Promise<void> {
    const composed = await composeWrite(
        path,
        { kind: "binary", bytes },
        { settings: SETTINGS, now: 1_700_000_000_000 }
    );
    await couch.seed(db, [
        ...(composed.chunks as unknown as Record<string, unknown>[]),
        composed.entry as unknown as Record<string, unknown>,
    ]);
}

async function seedVault(db: string): Promise<void> {
    await couch.createDatabase(db);
    await couch.seed(db, [
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

    const composed = await composeWrite(
        "daily/2026-07-28.md",
        { kind: "text", text: "# Today\n\n- [ ] a task\n" },
        { settings: SETTINGS, now: 1_700_000_000_000 }
    );
    await couch.seed(db, [
        ...(composed.chunks as unknown as Record<string, unknown>[]),
        composed.entry as unknown as Record<string, unknown>,
    ]);

    await seedFile(db, INK, pdfWithoutText());
}

/**
 * Start a server and connect a client to it.
 *
 * `run` names the run rather than the database, so a second call can reuse the
 * same transcript store while getting a fresh index and replica: that split is
 * the whole point of these tests.
 */
async function startServer(db: string, run: string, transcriptStore: string): Promise<Client> {
    const port = await freePort();
    const config: Config = {
        couch: { url: couch.url, database: db, username: undefined, password: undefined },
        replicaPath: join(workDir, `replica-${run}`),
        indexPath: join(workDir, `index-${run}.sqlite`),
        transcriptPath: transcriptStore,
        formatOverrides: {},
        readOnly: true,
        attachmentSizeCap: 25 * 1024 * 1024,
        planCeiling: 500,
        dailyNotePath: undefined,
        timeZone: "Australia/Brisbane",
        transport: { kind: "http", host: "127.0.0.1", port, bearerToken: TOKEN },
        logLevel: "error",
    };

    running = await start(config);

    const connected = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await connected.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        })
    );
    client = connected;
    return connected;
}

async function stopServer(): Promise<void> {
    await client?.close().catch(() => undefined);
    client = undefined;
    await running?.stop().catch(() => undefined);
    running = undefined;
}

beforeAll(async () => {
    couch = await startFakeCouch();
    workDir = await mkdtemp(join(tmpdir(), "livesync-transcribe-"));
});

afterAll(async () => {
    await couch.stop();
    await rm(workDir, { recursive: true, force: true });
});

afterEach(stopServer);

describe("a transcription outlives the index", () => {
    it("is still searchable after a restart with the index thrown away", async () => {
        const db = `vault-${++counter}`;
        const store = join(workDir, `transcripts-${counter}.sqlite`);
        await seedVault(db);

        const first = await startServer(db, `${counter}a`, store);
        const saved = textOf(
            await first.callTool({
                name: "save_transcription",
                arguments: { path: INK, text: TRANSCRIPT, provenance: "claude-opus-5" },
            })
        );
        expect(saved).toMatch(/now searchable/i);
        await stopServer();

        // Second run, fresh index and fresh replica, same transcript store.
        // Everything derived is gone; only the thing that cannot be recomputed
        // is carried across.
        const second = await startServer(db, `${counter}b`, store);

        const found = textOf(
            await second.callTool({ name: "search_notes", arguments: { query: "Kingfisher" } })
        );
        expect(found).toContain(INK);

        const queue = textOf(await second.callTool({ name: "list_untranscribed", arguments: {} }));
        expect(queue).not.toContain(INK);

        const attachment = textOf(
            await second.callTool({ name: "get_attachment", arguments: { path: INK } })
        );
        expect(attachment).toContain("Adelaide lease");
        expect(attachment).toMatch(/Source: transcription \(claude-opus-5\)/);
    }, 180_000);

    it("marks the transcription stale when the page has been written on since", async () => {
        const db = `vault-${++counter}`;
        const store = join(workDir, `transcripts-${counter}.sqlite`);
        await seedVault(db);

        const first = await startServer(db, `${counter}a`, store);
        await first.callTool({
            name: "save_transcription",
            arguments: { path: INK, text: TRANSCRIPT },
        });
        await stopServer();

        // Another line of ink: same path, different bytes, so the stored
        // transcription now describes a page that no longer exists.
        await seedRevision(db, INK, pdfWithoutText(), "and one more line drawn later on");

        const second = await startServer(db, `${counter}b`, store);

        const queue = textOf(await second.callTool({ name: "list_untranscribed", arguments: {} }));
        expect(queue).toContain(INK);
        expect(queue).toContain("transcription out of date");

        const attachment = textOf(
            await second.callTool({ name: "get_attachment", arguments: { path: INK } })
        );
        // The old text is still served, because a stale reading beats none, but
        // it must not be served as though it were current.
        expect(attachment).toContain("Adelaide lease");
        expect(attachment).toMatch(/WARNING: the attachment has changed/);
    }, 180_000);
});

/**
 * Overwrite a file in the vault with different content, as another device would.
 *
 * Written by hand rather than through `seedFile`, because the entry needs the
 * existing revision to replace rather than conflict with it.
 */
async function seedRevision(db: string, path: string, base: Uint8Array, extra: string): Promise<void> {
    const bytes = new Uint8Array(base.length + extra.length);
    bytes.set(base);
    bytes.set(new TextEncoder().encode(extra), base.length);

    const composed = await composeWrite(
        path,
        { kind: "binary", bytes },
        { settings: SETTINGS, now: 1_800_000_000_000 }
    );
    const entry = composed.entry as unknown as Record<string, unknown>;
    const current = await couch.get(db, String(entry._id));
    if (current?._rev) entry._rev = current._rev;

    await couch.seed(db, [...(composed.chunks as unknown as Record<string, unknown>[]), entry]);
}
