#!/usr/bin/env node
/**
 * Read-only verification of the vault model against a real LiveSync database.
 *
 * This is step two of the acceptance gate in `docs/design.md`: prove that a
 * sample of real notes reconstructs correctly, and — more valuable — that the
 * chunk IDs this code *would* write are byte-identical to the ones the plugin
 * actually wrote. The second check is the one that matters, because it
 * validates the write path against the exact plugin version and settings in
 * use, which no amount of testing against a pinned library can do.
 *
 * SAFETY
 *
 * This script is incapable of modifying the database. Every request goes
 * through `get()`, which hard-codes the method and refuses anything else; there
 * is no code path here that issues a PUT, POST or DELETE. It is safe to point
 * at a live vault. Note content is read into memory to verify it and is never
 * printed, logged or written to disk unless `--capture` is passed explicitly.
 *
 * USAGE
 *
 *   npx tsx scripts/verify-vault.ts \
 *     --url https://user:password@couchdb.example.net \
 *     --db obsidiandb \
 *     [--sample 25 | --all] \
 *     [--passphrase '...'] \
 *     [--capture fixtures.json]
 *
 * The URL may embed credentials, or use --user/--pass. Prefer setting
 * COUCHDB_URL in the environment over passing a password on the command line,
 * where it lands in your shell history.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
    assembleFile,
    ChunkHasher,
    CHUNK_ID_RANGE_END,
    decodeDocument,
    DEFAULT_FORMAT_SETTINGS,
    DOCID_MILESTONE,
    DOCID_SYNC_PARAMETERS,
    DOCID_VERSIONING,
    decodePbkdf2Salt,
    isDeleted,
    isFileEntry,
    isLegacyNote,
    PREFIX_CHUNK,
    readTweakValues,
    resolveSettings,
    splitContent,
    SUPPORTED_DB_VERSION,
    transformContextFor,
    type ChunkEntry,
    type ChunkedEntry,
    type FileEntry,
    type MilestoneEntry,
    type VaultFormatSettings,
} from "../src/vault-model/index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Options {
    url: string;
    db: string;
    sample: number;
    passphrase: string | undefined;
    capture: string | undefined;
    verbose: boolean;
    all: boolean;
}

function parseArgs(argv: string[]): Options {
    const get = (name: string): string | undefined => {
        const at = argv.indexOf(`--${name}`);
        return at >= 0 ? argv[at + 1] : undefined;
    };

    let url = get("url") ?? process.env.COUCHDB_URL ?? "";
    const user = get("user") ?? process.env.COUCHDB_USER;
    const pass = get("pass") ?? process.env.COUCHDB_PASSWORD;
    let db = get("db") ?? process.env.COUCHDB_DB ?? "";

    if (!url) {
        fail(
            "No CouchDB URL. Pass --url https://host, or set COUCHDB_URL.\n" +
                "Credentials may be embedded in the URL, or given with --user/--pass."
        );
    }

    // Accept the LiveSync setup form: https://host/?db=name
    const parsed = new URL(url);
    if (!db && parsed.searchParams.has("db")) db = parsed.searchParams.get("db") as string;
    if (user) parsed.username = encodeURIComponent(user);
    if (pass) parsed.password = encodeURIComponent(pass);
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    url = parsed.toString().replace(/\/+$/, "");

    if (!db) fail("No database name. Pass --db <name>, or use a URL of the form https://host/?db=name.");

    return {
        url,
        db,
        sample: Number(get("sample") ?? 25),
        passphrase: get("passphrase") ?? process.env.LIVESYNC_PASSPHRASE,
        capture: get("capture"),
        verbose: argv.includes("--verbose"),
        all: argv.includes("--all"),
    };
}

function fail(message: string): never {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Transport — GET only, by construction
// ---------------------------------------------------------------------------

/**
 * Percent-encode a document ID for use in a URL path.
 *
 * The `_local/` and `_design/` prefixes are literal path segments in CouchDB's
 * URL scheme, so their slash must survive. Every other slash — and a vault path
 * is full of them, since the path *is* the document ID — must be encoded, or
 * CouchDB reads it as a further path segment.
 *
 * Encoding the whole ID uniformly yields `_local%2Fobsydian_livesync_milestone`,
 * which CouchDB rejects with a 400 rather than a 404, because an ID beginning
 * with an underscore that is not a recognised prefix is invalid.
 */
export function encodeDocumentId(id: string): string {
    for (const prefix of ["_local/", "_design/"]) {
        if (id.startsWith(prefix)) {
            return prefix + encodeURIComponent(id.slice(prefix.length));
        }
    }
    return encodeURIComponent(id);
}

class ReadOnlyClient {
    constructor(
        private readonly base: string,
        private readonly db: string
    ) {}

    /**
     * The only request method in this file. There is deliberately no `put`,
     * `post` or `delete`, so no caller can accidentally acquire one.
     */
    private async get<T>(path: string, params?: Record<string, string>): Promise<T | undefined> {
        const url = new URL(`${this.base}/${this.db}${path}`);
        for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);

        const auth = url.username
            ? "Basic " +
              Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString(
                  "base64"
              )
            : undefined;
        url.username = "";
        url.password = "";

        const response = await fetch(url, {
            method: "GET",
            headers: {
                Accept: "application/json",
                ...(auth ? { Authorization: auth } : {}),
            },
        });

        if (response.status === 404) return undefined;
        if (!response.ok) {
            // CouchDB puts a useful reason in the body; a bare status is not
            // enough to tell a bad path from a bad password.
            const body = await response.text().catch(() => "");
            throw new Error(
                `GET ${decodeURIComponent(url.pathname)} → ${response.status} ${response.statusText}` +
                    (body ? `\n    ${body.slice(0, 300)}` : "")
            );
        }
        return (await response.json()) as T;
    }

    dbInfo() {
        return this.get<{ doc_count: number; disk_size?: number; db_name: string }>("");
    }

    doc<T>(id: string) {
        return this.get<T>(`/${encodeDocumentId(id)}`);
    }

    /** A page of documents in an ID range, with bodies. */
    allDocs(startkey: string, endkey: string, limit: number) {
        return this.get<{ rows: { id: string; doc?: unknown }[] }>("/_all_docs", {
            include_docs: "true",
            startkey: JSON.stringify(startkey),
            endkey: JSON.stringify(endkey),
            limit: String(limit),
        });
    }

    /**
     * Every document in an ID range, a page at a time.
     *
     * Paginated by `startkey` rather than `skip`, which CouchDB implements by
     * walking and discarding — fine for one page, quadratic over a whole vault.
     */
    async *walk(startkey: string, endkey: string, pageSize = 500) {
        let from = startkey;
        for (;;) {
            // One extra row tells us whether there is a next page, and where it
            // starts, without a second request.
            const page = await this.allDocs(from, endkey, pageSize + 1);
            const rows = page?.rows ?? [];
            if (rows.length === 0) return;

            const hasMore = rows.length > pageSize;
            for (const row of hasMore ? rows.slice(0, pageSize) : rows) yield row;
            if (!hasMore) return;
            from = rows[pageSize]?.id as string;
        }
    }

    /** Specific documents by ID. Used to fetch a note's chunks. */
    async byKeys(keys: string[]) {
        const out = new Map<string, Record<string, unknown>>();
        // Chunked to keep URLs and responses a sane size.
        for (let i = 0; i < keys.length; i += 100) {
            const batch = keys.slice(i, i + 100);
            const page = await this.get<{ rows: { id: string; doc?: Record<string, unknown> }[] }>(
                "/_all_docs",
                { include_docs: "true", keys: JSON.stringify(batch) }
            );
            for (const row of page?.rows ?? []) {
                if (row.doc) out.set(row.id, row.doc);
            }
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ok = (s: string) => `  [32m✓[0m ${s}`;
const bad = (s: string) => `  [31m✗[0m ${s}`;
const warn = (s: string) => `  [33m![0m ${s}`;
const info = (s: string) => `    ${s}`;
const heading = (s: string) => `\n[1m${s}[0m`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const client = new ReadOnlyClient(options.url, options.db);
    let failures = 0;

    console.log(heading("Connection"));
    const dbInfo = await client.dbInfo();
    if (!dbInfo) fail(`Database "${options.db}" not found, or credentials rejected.`);
    console.log(ok(`Connected to "${dbInfo.db_name}" — ${dbInfo.doc_count.toLocaleString()} documents`));
    console.log(info("Every request this script makes is a GET. Nothing is written."));

    // --- Settings ----------------------------------------------------------

    console.log(heading("Vault settings"));
    const milestone = await client.doc<MilestoneEntry>(DOCID_MILESTONE);
    if (!milestone) {
        console.log(warn("No milestone document — no device has synced yet, or the ID differs."));
    }

    const { settings: published, conflicts, invalid, nodeCount } = readTweakValues(milestone);
    console.log(ok(`${nodeCount} device(s) have published their settings`));

    for (const [key, values] of Object.entries(conflicts)) {
        failures++;
        console.log(bad(`Devices disagree on "${key}": ${values.map((v) => JSON.stringify(v)).join(", ")}`));
        console.log(info("The plugin blocks sync on this. Resolve it in Obsidian before proceeding."));
    }
    for (const [key, value] of Object.entries(invalid)) {
        console.log(warn(`Unrecognised value for "${key}": ${JSON.stringify(value)} — ignoring it`));
    }

    const settings: VaultFormatSettings = resolveSettings({
        ...published,
        ...(options.passphrase ? { passphrase: options.passphrase } : {}),
    });

    const notable = (
        [
            "encrypt",
            "usePathObfuscation",
            "enableCompression",
            "hashAlg",
            "chunkSplitterVersion",
            "handleFilenameCaseSensitive",
            "minimumChunkSize",
            "customChunkSize",
            "useEden",
        ] as const
    )
        .map((key) => `${key}=${JSON.stringify(settings[key])}`)
        .join("  ");
    console.log(info(notable));

    if (settings.encrypt && !settings.passphrase) {
        fail("This vault is encrypted. Re-run with --passphrase, or set LIVESYNC_PASSPHRASE.");
    }
    if (settings.useEden) {
        console.log(warn("useEden is on. Notes with inline chunks are not readable by this model."));
    }
    if (settings.chunkSplitterVersion !== DEFAULT_FORMAT_SETTINGS.chunkSplitterVersion) {
        console.log(
            warn(
                `Splitter is "${settings.chunkSplitterVersion}", not the V3 default. ` +
                    `Chunk-ID comparison below will report mismatches; that is expected.`
            )
        );
    }

    // --- Schema version ----------------------------------------------------

    const version = await client.doc<{ version: number }>(DOCID_VERSIONING);
    if (version) {
        const same = version.version === SUPPORTED_DB_VERSION;
        console.log(
            (same ? ok : warn)(
                `Database schema version ${version.version} ` +
                    (same
                        ? "(matches what this understands)"
                        : `— this was built against ${SUPPORTED_DB_VERSION}`)
            )
        );
        if (!same) failures++;
    } else {
        console.log(warn("No version document found."));
    }

    // --- Crypto context ----------------------------------------------------

    const syncParams = await client.doc<{ pbkdf2salt?: string }>(DOCID_SYNC_PARAMETERS);
    let salt: Uint8Array<ArrayBuffer> | undefined;
    if (syncParams?.pbkdf2salt) {
        salt = decodePbkdf2Salt(syncParams.pbkdf2salt);
        console.log(ok(`PBKDF2 salt present (${salt.length} bytes)`));
    } else if (settings.encrypt) {
        fail("Vault is encrypted but has no PBKDF2 salt document. Cannot decrypt.");
    }

    const ctx = transformContextFor(settings, salt);

    // --- Choose which files to verify --------------------------------------

    console.log(
        heading(
            options.all ? "Enumerating every file in the vault" : `Sampling up to ${options.sample} files`
        )
    );

    // File documents live outside the `_*` and `h:*` ranges. Mirrors how the
    // plugin enumerates them.
    const ranges: [string, string][] = [
        ["", "_"],
        ["_\u{10ffff}", PREFIX_CHUNK],
        [CHUNK_ID_RANGE_END, "\u{10ffff}"],
    ];

    const all: FileEntry[] = [];
    let deleted = 0;
    let nonFile = 0;
    for (const [start, end] of ranges) {
        for await (const row of client.walk(start, end)) {
            const doc = row.doc as Record<string, unknown> | undefined;
            if (!doc) continue;
            if (!isFileEntry(doc)) {
                nonFile++;
                continue;
            }
            if (isDeleted(doc as { deleted?: boolean; _deleted?: boolean })) {
                deleted++;
                continue;
            }
            all.push(doc as unknown as FileEntry);
        }
    }

    if (all.length === 0) fail("Found no readable file documents outside the chunk and _local ranges.");
    console.log(ok(`${all.length} live file document(s), ${deleted} deleted, ${nonFile} non-file`));

    // Taking the first N walks the ID order, which is alphabetical by path —
    // a sample biased towards one corner of the vault, and likely to miss
    // attachments entirely. Spread the selection across the whole range instead.
    let candidates = all;
    if (!options.all && all.length > options.sample) {
        // Span both ends inclusively. A plain `i * n / sample` never reaches
        // the last element, and attachments sort last — so the obvious
        // arithmetic quietly excludes exactly the files most worth checking.
        const span = (all.length - 1) / Math.max(1, options.sample - 1);
        const picked = new Set(Array.from({ length: options.sample }, (_, i) => Math.round(i * span)));
        candidates = [...picked].map((i) => all[i] as FileEntry);
        console.log(info(`Verifying ${candidates.length}, spread evenly across that set.`));
    } else {
        console.log(info(`Verifying all ${candidates.length}.`));
    }

    // --- Verify each -------------------------------------------------------

    const hasher = await ChunkHasher.create({
        hashAlg: settings.hashAlg,
        encrypt: settings.encrypt,
        passphrase: settings.passphrase,
    });

    let assembled = 0;
    let chunkIdsMatched = 0;
    let chunkIdsCompared = 0;
    const captured: unknown[] = [];

    /** Coverage, so a green result cannot hide a whole class of file. */
    const stats = {
        text: 0,
        binary: 0,
        legacy: 0,
        bytes: 0,
        chunkRefs: 0,
        distinctChunks: new Set<string>(),
        largest: { path: "", size: 0 },
    };

    for (const raw of candidates) {
        let path = "<unknown>";
        try {
            const entry = await decodeDocument(raw, ctx);
            path = String((entry as { path?: string }).path ?? entry._id);

            const children = isLegacyNote(entry) ? [] : (entry as ChunkedEntry).children;
            const chunkDocs = children.length > 0 ? await client.byKeys(children) : new Map();

            const chunks = new Map<string, ChunkEntry>();
            for (const [id, doc] of chunkDocs) {
                chunks.set(id, (await decodeDocument(doc as never, ctx)) as unknown as ChunkEntry);
            }

            const file = assembleFile(entry, chunks);
            assembled++;

            stats[file.kind]++;
            if (isLegacyNote(entry)) stats.legacy++;
            stats.bytes += file.size;
            stats.chunkRefs += children.length;
            for (const id of children) stats.distinctChunks.add(id);
            if (file.size > stats.largest.size) stats.largest = { path, size: file.size };

            if (options.verbose) {
                console.log(ok(`${path} — ${file.kind}, ${file.size} bytes, ${children.length} chunk(s)`));
            }

            // The important check: would our writer produce the same chunks?
            if (!isLegacyNote(entry) && children.length > 0) {
                const content =
                    file.kind === "text"
                        ? ({ kind: "text", text: file.text } as const)
                        : ({ kind: "binary", bytes: file.bytes } as const);
                const pieces = splitContent(path, content, { settings });
                const computed = await hasher.computeChunkIds(pieces);
                chunkIdsCompared++;
                if (computed.length === children.length && computed.every((id, i) => id === children[i])) {
                    chunkIdsMatched++;
                } else {
                    failures++;
                    console.log(bad(`Chunk IDs differ for ${path}`));
                    console.log(
                        info(`plugin wrote ${children.length} chunk(s), this would write ${computed.length}`)
                    );
                    const firstDiff = computed.findIndex((id, i) => id !== children[i]);
                    if (firstDiff >= 0) {
                        console.log(info(`first difference at index ${firstDiff}:`));
                        console.log(info(`  plugin: ${children[firstDiff]}`));
                        console.log(info(`  ours:   ${computed[firstDiff]}`));
                    }
                }
            }

            if (options.capture) {
                captured.push({
                    entry: raw,
                    chunks: Object.fromEntries(chunkDocs),
                });
            }
        } catch (error) {
            failures++;
            console.log(bad(`${path}: ${(error as Error).message}`));
        }
    }

    // --- Summary -----------------------------------------------------------

    console.log(heading("Coverage"));
    console.log(
        info(
            `${stats.text} text, ${stats.binary} binary` +
                (stats.legacy > 0 ? `, ${stats.legacy} legacy (pre-chunking)` : "") +
                ` — ${(stats.bytes / 1024).toFixed(0)} KiB total`
        )
    );
    console.log(
        info(
            `${stats.chunkRefs} chunk reference(s) over ${stats.distinctChunks.size} distinct chunk(s)` +
                (stats.chunkRefs > 0
                    ? ` (${(100 - (stats.distinctChunks.size / stats.chunkRefs) * 100).toFixed(0)}% deduplicated)`
                    : "")
        )
    );
    if (stats.largest.path) {
        console.log(info(`largest: ${stats.largest.path} at ${(stats.largest.size / 1024).toFixed(1)} KiB`));
    }
    if (stats.binary === 0) {
        console.log(
            warn(
                "No binary files in this set — attachments are unverified. " +
                    "Re-run with --all, or a larger --sample."
            )
        );
    }

    console.log(heading("Result"));
    console.log(
        (assembled === candidates.length ? ok : bad)(
            `${assembled}/${candidates.length} files assembled and passed their size check`
        )
    );
    if (chunkIdsCompared > 0) {
        console.log(
            (chunkIdsMatched === chunkIdsCompared ? ok : bad)(
                `${chunkIdsMatched}/${chunkIdsCompared} files re-chunk to byte-identical chunk IDs`
            )
        );
        if (chunkIdsMatched === chunkIdsCompared) {
            console.log(
                info(
                    "This is the strong result: the write path would deduplicate against\n" +
                        "    existing chunks exactly as another device does."
                )
            );
        }
    }

    if (options.capture) {
        await writeFile(options.capture, JSON.stringify(captured, null, 2), "utf8");
        console.log(
            warn(
                `Wrote ${captured.length} document set(s) to ${options.capture}. ` +
                    `This file contains real note content — do not commit it.`
            )
        );
    }

    if (failures > 0) {
        console.log(bad(`${failures} problem(s) found. Do not enable writes yet.\n`));
        process.exit(1);
    }
    console.log(ok("No problems found.\n"));
}

/**
 * Only run when invoked directly. The tests import `encodeDocumentId` from
 * here, and without this guard that import would execute a full run — and call
 * `process.exit` inside the test worker.
 */
function isEntrypoint(): boolean {
    const invoked = process.argv[1];
    if (!invoked) return false;
    try {
        return resolvePath(invoked) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isEntrypoint()) {
    main().catch((error) => {
        const message = (error as Error).message ?? String(error);
        // An HTTP failure is an operational problem, not a crash; a stack trace
        // buries the one line that says what went wrong.
        const operational = /^GET /.test(message);
        console.error(`\n  ${operational ? message : ((error as Error).stack ?? message)}\n`);
        process.exit(1);
    });
}
