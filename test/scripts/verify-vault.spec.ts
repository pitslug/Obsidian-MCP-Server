/**
 * The verification script, against a fake CouchDB.
 *
 * The script is the thing Chris points at a live vault, so the cost of a bug in
 * it is his time and his confidence - and, if it ever issued a write, his
 * notes. These tests stand up an HTTP server that speaks enough CouchDB to
 * exercise every path the script takes, and assert both that it reports
 * correctly and that it never issues a request other than GET.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { composeWrite } from "../../src/vault-model/compose.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { encodeDocumentId } from "../../scripts/verify-vault.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "../../scripts/verify-vault.ts");

const SETTINGS = resolveSettings({ customChunkSize: 60 });

/** Every request the fake server saw, so we can prove none of them wrote. */
let methodsSeen: string[] = [];
let docs: Map<string, Record<string, unknown>>;
let server: Server;
let port: number;

interface VaultShape {
    /** Additional generated text notes, to exceed one page of the walk. */
    extraNotes?: number;
    /** Binary files. They sort last, so a first-N sample would miss them. */
    binaries?: number;
}

/** Build a small vault the same way the plugin would. */
async function buildVault(tweaks: Record<string, unknown>, shape: VaultShape = {}) {
    const store = new Map<string, Record<string, unknown>>();

    store.set(DOCID_MILESTONE, {
        _id: DOCID_MILESTONE,
        type: "milestoneinfo",
        created: 1,
        accepted_nodes: [],
        node_info: {},
        locked: false,
        node_chunk_info: {},
        tweak_values: { deviceA: tweaks },
    });
    store.set(DOCID_VERSIONING, {
        _id: DOCID_VERSIONING,
        type: "versioninfo",
        version: SUPPORTED_DB_VERSION,
    });

    const notes: [string, string][] = [
        ["daily/2026-07-28.md", "# Today\n\n- [ ] a task\n\nSome body text.\n"],
        ["projects/big.md", "x".repeat(9000)],
        ["notes/unicode.md", "日本語 👋 café\n".repeat(200)],
        ["empty.md", ""],
    ];

    for (let i = 0; i < (shape.extraNotes ?? 0); i++) {
        notes.push([`generated/note-${String(i).padStart(3, "0")}.md`, `body ${i}\n`.repeat(40 + i)]);
    }

    const write = async (path: string, content: Parameters<typeof composeWrite>[1]) => {
        const composed = await composeWrite(path, content, {
            settings: SETTINGS,
            now: 1_700_000_000_000,
        });
        store.set(String(composed.entry._id), {
            ...composed.entry,
            _rev: "1-abc",
        } as unknown as Record<string, unknown>);
        for (const chunk of composed.chunks) {
            store.set(String(chunk._id), { ...chunk, _rev: "1-def" } as unknown as Record<string, unknown>);
        }
    };

    for (const [path, text] of notes) {
        await write(path, { kind: "text", text });
    }

    for (let i = 0; i < (shape.binaries ?? 0); i++) {
        const bytes = new Uint8Array(2000 + i * 500);
        for (let b = 0; b < bytes.length; b++) bytes[b] = (b * (i + 7)) & 0xff;
        await write(`zattachments/image-${i}.png`, { kind: "binary", bytes });
    }

    return store;
}

function startServer(): Promise<void> {
    return new Promise((done) => {
        server = createServer((req, res) => {
            methodsSeen.push(req.method ?? "");
            if (req.method !== "GET") {
                res.writeHead(405).end("method not allowed");
                return;
            }

            const url = new URL(req.url ?? "/", `http://localhost:${port}`);
            const segments = url.pathname.split("/").filter(Boolean);
            const json = (body: unknown, status = 200) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(body));
            };

            // /{db}
            if (segments.length === 1) {
                return json({ db_name: segments[0], doc_count: docs.size });
            }

            // /{db}/_all_docs
            if (segments[1] === "_all_docs") {
                const keysParam = url.searchParams.get("keys");
                if (keysParam) {
                    const keys = JSON.parse(keysParam) as string[];
                    return json({
                        rows: keys.map((id) =>
                            docs.has(id) ? { id, doc: docs.get(id) } : { key: id, error: "not_found" }
                        ),
                    });
                }
                const startkey = JSON.parse(url.searchParams.get("startkey") ?? '""') as string;
                const endkey = JSON.parse(url.searchParams.get("endkey") ?? '"￿"') as string;
                const limit = Number(url.searchParams.get("limit") ?? "100");
                const rows = [...docs.entries()]
                    .filter(([id]) => id >= startkey && id <= endkey)
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .slice(0, limit)
                    .map(([id, doc]) => ({ id, doc }));
                return json({ rows });
            }

            // /{db}/{docid}
            //
            // Strict about CouchDB's URL scheme, because a lenient mock hid a
            // real bug: `_local/x` encoded whole becomes `_local%2Fx`, which
            // CouchDB rejects with 400 (an underscore-prefixed ID that is not a
            // recognised prefix), not 404. Reject it here too.
            const raw = segments.slice(1);
            const first = decodeURIComponent(raw[0] ?? "");
            if (first.startsWith("_") && !["_local", "_design"].includes(first)) {
                return json({ error: "illegal_docid", reason: `Invalid document ID: ${first}` }, 400);
            }
            const id =
                first === "_local" || first === "_design"
                    ? `${first}/${raw.slice(1).map(decodeURIComponent).join("/")}`
                    : decodeURIComponent(raw.join("/"));
            const doc = docs.get(id);
            return doc ? json(doc) : json({ error: "not_found" }, 404);
        });
        server.listen(0, "127.0.0.1", () => {
            port = (server.address() as { port: number }).port;
            done();
        });
    });
}

async function runScript(extra: string[] = []) {
    try {
        const { stdout, stderr } = await execFileAsync(
            "npx",
            [
                "tsx",
                scriptPath,
                "--url",
                `http://127.0.0.1:${port}`,
                "--db",
                "testdb",
                "--sample",
                "10",
                ...extra,
            ],
            { cwd: resolve(here, "../.."), timeout: 120_000 }
        );
        return { code: 0, out: stdout + stderr };
    } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
}

beforeAll(async () => {
    await startServer();
});

afterAll(() => {
    server?.close();
});

describe("verify-vault against a healthy vault", () => {
    let result: { code: number; out: string };

    beforeAll(async () => {
        docs = await buildVault({
            encrypt: false,
            usePathObfuscation: false,
            enableCompression: false,
            hashAlg: "xxhash64",
            chunkSplitterVersion: "v3-rabin-karp",
            handleFilenameCaseSensitive: false,
            minimumChunkSize: 20,
            customChunkSize: 60,
        });
        methodsSeen = [];
        result = await runScript();
    }, 180_000);

    it("exits successfully", () => {
        expect(result.out).toContain("No problems found");
        expect(result.code).toBe(0);
    });

    it("connects and reports the document count", () => {
        expect(result.out).toMatch(/Connected to "testdb"/);
    });

    it("reads the published settings", () => {
        expect(result.out).toContain("1 device(s) have published their settings");
        expect(result.out).toContain('hashAlg="xxhash64"');
    });

    it("recognises the schema version", () => {
        expect(result.out).toMatch(/schema version 12.*matches/s);
    });

    it("assembles every sampled file", () => {
        expect(result.out).toMatch(/(\d+)\/\1 files assembled/);
    });

    it("confirms chunk IDs match what the vault already holds", () => {
        expect(result.out).toMatch(/(\d+)\/\1 files re-chunk to byte-identical chunk IDs/);
    });

    it("issued only GET requests - nothing that could modify the vault", () => {
        expect(methodsSeen.length).toBeGreaterThan(5);
        expect([...new Set(methodsSeen)]).toEqual(["GET"]);
    });
});

describe("coverage over a larger vault", () => {
    let result: { code: number; out: string };

    beforeAll(async () => {
        // More files than one page of the walk, plus binaries, so pagination
        // and the text/binary split are both exercised.
        docs = await buildVault({ encrypt: false, hashAlg: "xxhash64" }, { extraNotes: 60, binaries: 4 });
        result = await runScript(["--all"]);
    }, 300_000);

    it("verifies every file rather than a sample", () => {
        expect(result.out).toContain("Enumerating every file in the vault");
        expect(result.out).toMatch(/Verifying all \d+/);
        expect(result.code).toBe(0);
    });

    it("paginates without dropping or repeating files", () => {
        // 4 fixed notes + 60 generated + 4 binaries.
        const match = result.out.match(/(\d+) live file document\(s\)/);
        expect(Number(match?.[1])).toBe(68);
    });

    it("reports binary coverage, so attachments cannot be silently skipped", () => {
        expect(result.out).toMatch(/\d+ text, 4 binary/);
        expect(result.out).not.toContain("attachments are unverified");
    });

    it("still matches every chunk ID", () => {
        expect(result.out).toMatch(/(\d+)\/\1 files re-chunk to byte-identical chunk IDs/);
    });
});

describe("sampling", () => {
    it("warns when a sample contains no binary files", async () => {
        docs = await buildVault({ encrypt: false }, { extraNotes: 20, binaries: 0 });
        const result = await runScript(["--sample", "5"]);
        expect(result.out).toContain("attachments are unverified");
        expect(result.code).toBe(0);
    }, 300_000);

    it("spreads the sample rather than taking the alphabetically first N", async () => {
        docs = await buildVault({ encrypt: false }, { extraNotes: 60, binaries: 2 });
        // Binaries sort last, under "z". Taking the first N would miss them.
        const result = await runScript(["--sample", "10"]);
        expect(result.out).toMatch(/Verifying 10, spread evenly/);
        expect(result.out).toMatch(/\d+ text, [12] binary/);
    }, 300_000);
});

describe("census", () => {
    it("accounts for every document, and confirms the file ranges miss nothing", async () => {
        docs = await buildVault({ encrypt: false }, { extraNotes: 20, binaries: 3 });
        const result = await runScript(["--census"]);

        expect(result.out).toContain("Census: every document, by type");
        expect(result.out).toMatch(/leaf \(chunk documents, counted by ID\)/);
        expect(result.out).toContain("Every file document falls inside the ranges the verifier walks.");
        expect(result.out).toMatch(/\d+ live, \d+ deleted/);
        expect(result.code).toBe(0);
    }, 300_000);

    it("separates referenced chunks from orphans", async () => {
        docs = await buildVault({ encrypt: false }, { extraNotes: 5 });
        // An orphan, as a deleted note or a superseded revision leaves behind.
        docs.set("h:orphanchunk", { _id: "h:orphanchunk", type: "leaf", data: "x", _rev: "1-x" });

        const result = await runScript(["--census"]);
        expect(result.out).toMatch(/\d+ referenced by a file document/);
        expect(result.out).toMatch(/[1-9]\d* not referenced by any file document/);
    }, 300_000);

    it("counts hidden-file and customisation-sync documents separately from notes", async () => {
        docs = await buildVault({ encrypt: false });
        // `i:` documents are real files the plugin syncs, but they are not
        // vault notes; a census that lumps them together overstates the vault.
        docs.set("i:.obsidian/app.json", {
            _id: "i:.obsidian/app.json",
            path: "i:.obsidian/app.json",
            type: "plain",
            children: [],
            ctime: 1,
            mtime: 1,
            size: 0,
        });

        const result = await runScript(["--census"]);
        expect(result.out).toMatch(/i:\s+hidden file sync/);
        expect(result.code).toBe(0);
    }, 300_000);
});

describe("document ID encoding", () => {
    it("keeps the slash in _local and _design, encodes it everywhere else", () => {
        // Regression: encoding the whole ID gave `_local%2F…`, which CouchDB
        // answers with 400, aborting the run before it read any settings.
        expect(encodeDocumentId(DOCID_MILESTONE)).toBe("_local/obsydian_livesync_milestone");
        expect(encodeDocumentId("_design/foo")).toBe("_design/foo");
        expect(encodeDocumentId("daily/2026-07-28.md")).toBe("daily%2F2026-07-28.md");
        expect(encodeDocumentId("folder/note with spaces.md")).toBe("folder%2Fnote%20with%20spaces.md");
        expect(encodeDocumentId("h:+abc")).toBe("h%3A%2Babc");
    });
});

describe("verify-vault surfaces real problems", () => {
    it("reports a settings disagreement between devices", async () => {
        docs = await buildVault({ encrypt: false, hashAlg: "xxhash64" });
        const milestone = docs.get(DOCID_MILESTONE) as { tweak_values: Record<string, unknown> };
        milestone.tweak_values.deviceB = { encrypt: true, hashAlg: "xxhash64" };

        const result = await runScript();
        expect(result.out).toContain('Devices disagree on "encrypt"');
        expect(result.code).toBe(1);
    }, 180_000);

    it("refuses to proceed on an encrypted vault with no passphrase", async () => {
        docs = await buildVault({ encrypt: true, hashAlg: "xxhash64" });
        const result = await runScript();
        expect(result.out).toContain("--passphrase");
        expect(result.code).toBe(1);
    }, 180_000);

    it("warns when the schema version is not the one it was built against", async () => {
        docs = await buildVault({ encrypt: false });
        docs.set(DOCID_VERSIONING, { _id: DOCID_VERSIONING, type: "versioninfo", version: 99 });
        const result = await runScript();
        expect(result.out).toMatch(/schema version 99/);
        expect(result.code).toBe(1);
    }, 180_000);

    it("reports a note whose chunks are missing rather than truncating it", async () => {
        docs = await buildVault({ encrypt: false });
        // Drop one chunk, as a partial replication or a GC bug would.
        const aChunk = [...docs.keys()].find((id) => id.startsWith("h:"));
        docs.delete(aChunk as string);

        const result = await runScript();
        expect(result.out).toMatch(/missing from the supplied set|problem\(s\) found/);
        expect(result.code).toBe(1);
    }, 180_000);

    it("warns about useEden, which it cannot read", async () => {
        docs = await buildVault({ encrypt: false, useEden: true });
        const result = await runScript();
        expect(result.out).toContain("useEden is on");
    }, 180_000);
});
