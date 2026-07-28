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
 *     [--sample 25] \
 *     [--passphrase '...'] \
 *     [--capture fixtures.json]
 *
 * The URL may embed credentials, or use --user/--pass. Prefer setting
 * COUCHDB_URL in the environment over passing a password on the command line,
 * where it lands in your shell history.
 */

import { writeFile } from "node:fs/promises";
import {
    assembleFile,
    contentKind,
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
    };
}

function fail(message: string): never {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Transport — GET only, by construction
// ---------------------------------------------------------------------------

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
            throw new Error(`GET ${url.pathname} → ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as T;
    }

    dbInfo() {
        return this.get<{ doc_count: number; disk_size?: number; db_name: string }>("");
    }

    doc<T>(id: string) {
        return this.get<T>(`/${encodeURIComponent(id)}`);
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

    // --- Sample notes ------------------------------------------------------

    console.log(heading(`Reading a sample of up to ${options.sample} notes`));

    const candidates: FileEntry[] = [];
    // File documents live outside the `_*` and `h:*` ranges. Mirrors how the
    // plugin enumerates them.
    const ranges: [string, string][] = [
        ["", "_"],
        ["_\u{10ffff}", PREFIX_CHUNK],
        [CHUNK_ID_RANGE_END, "\u{10ffff}"],
    ];
    for (const [start, end] of ranges) {
        if (candidates.length >= options.sample) break;
        const page = await client.allDocs(start, end, options.sample * 4);
        for (const row of page?.rows ?? []) {
            if (candidates.length >= options.sample) break;
            const doc = row.doc as Record<string, unknown> | undefined;
            if (!doc || !isFileEntry(doc)) continue;
            if (isDeleted(doc as { deleted?: boolean; _deleted?: boolean })) continue;
            candidates.push(doc as unknown as FileEntry);
        }
    }

    if (candidates.length === 0) fail("Found no readable file documents in the sampled ranges.");
    console.log(ok(`Selected ${candidates.length} live file document(s)`));

    // --- Verify each -------------------------------------------------------

    const hasher = await ChunkHasher.create({
        hashAlg: settings.hashAlg,
        encrypt: settings.encrypt,
        passphrase: settings.passphrase,
    });

    let assembled = 0;
    let sizeChecked = 0;
    let chunkIdsMatched = 0;
    let chunkIdsCompared = 0;
    const captured: unknown[] = [];

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
            sizeChecked++;

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

    console.log(heading("Result"));
    console.log(
        (assembled === candidates.length ? ok : bad)(
            `${assembled}/${candidates.length} notes assembled and passed their size check`
        )
    );
    if (chunkIdsCompared > 0) {
        console.log(
            (chunkIdsMatched === chunkIdsCompared ? ok : bad)(
                `${chunkIdsMatched}/${chunkIdsCompared} notes re-chunk to byte-identical chunk IDs`
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

main().catch((error) => {
    console.error(`\n  ${(error as Error).stack ?? error}\n`);
    process.exit(1);
});
