/**
 * Reading the vault.
 *
 * Sits between the replicator and the tool layer: takes a path, returns a note.
 * Reads are served from the local replica, so they are eventually consistent - * typically sub-second behind CouchDB. Every response carries the replication
 * lag, so staleness is visible rather than assumed away.
 *
 * Two escape hatches keep that safe. A read may ask to verify the note's
 * revision against CouchDB before answering, for cases where currency matters
 * more than latency. And when the replica is missing a chunk, the chunk is
 * fetched directly rather than the read failing - a note is unreadable only if
 * the chunk is missing from CouchDB too.
 */

import {
    assembleFile,
    entryPath,
    isDeleted,
    isFileEntry,
    isInternalPath,
    isLegacyNote,
    MissingChunkError,
    normalizePrefixedPath,
    pathToId,
    type AssembledFile,
    type ChunkEntry,
    type ChunkedEntry,
    type FileEntry,
    type VaultFormatSettings,
} from "../vault-model/index.js";
import type { Replicator } from "../replicator/index.js";
import { CHUNK_ID_RANGE_END, PREFIX_CHUNK } from "../vault-model/constants.js";

export class NoteNotFoundError extends Error {
    constructor(path: string) {
        super(`No note at "${path}".`);
        this.name = "NoteNotFoundError";
    }
}

export class StaleReadError extends Error {
    constructor(path: string) {
        super(
            `The local replica's copy of "${path}" is out of date and the current version could ` +
                `not be fetched. Refusing to return stale content for a read that asked for freshness.`
        );
        this.name = "StaleReadError";
    }
}

export interface ReadOptions {
    /** Verify the note's revision against CouchDB before answering. */
    fresh?: boolean;
}

export interface ReadResult {
    file: AssembledFile;
    /** How far behind the replica may be, in milliseconds. */
    lagMs: number;
    /** Whether the revision was confirmed against CouchDB for this read. */
    verified: boolean;
}

export interface ListedNote {
    path: string;
    id: string;
    kind: "text" | "binary";
    size: number;
    mtime: number;
    chunkCount: number;
}

/** The ID ranges that hold file documents, excluding `_*` and `h:*`. */
const FILE_RANGES: [string, string][] = [
    ["", "_"],
    ["_\u{10ffff}", PREFIX_CHUNK],
    [CHUNK_ID_RANGE_END, "\u{10ffff}"],
];

export interface VaultReaderOptions {
    replicator: Replicator;
    settings: VaultFormatSettings;
    /** Fetch a document straight from CouchDB. Read-only; supplied by the caller. */
    fetchRemote?: (id: string) => Promise<Record<string, unknown> | undefined>;
}

export class VaultReader {
    constructor(private readonly options: VaultReaderOptions) {}

    private get db() {
        return this.options.replicator.database;
    }

    /** The document ID a path maps to under this vault's settings. */
    async idFor(path: string): Promise<string> {
        const { settings } = this.options;
        return String(
            await pathToId(path, {
                obfuscatePassphrase: settings.usePathObfuscation ? settings.passphrase : false,
                caseInsensitive: !settings.handleFilenameCaseSensitive,
            })
        );
    }

    /**
     * Which of these paths the vault still holds, as one lookup.
     *
     * The search index is a cache, and a cache can be wrong in one direction
     * that matters: it can still hold a note the vault no longer has. The
     * changes feed removes a deleted note promptly, but "promptly" is not
     * "always", and the feed can die and log about it while search goes on
     * answering. So results that came from the index are confirmed here before
     * anyone sees them.
     *
     * Deliberately shallow. It reads the file documents and nothing else, no
     * chunks and no assembly, because the only question is whether each path
     * exists and is not a tombstone. One `allDocs` rather than a get per path,
     * so confirming a page of results costs one local round trip.
     */
    async live(paths: readonly string[]): Promise<Set<string>> {
        const alive = new Set<string>();
        if (paths.length === 0) return alive;

        const byId = new Map<string, string>();
        for (const path of paths) byId.set(await this.idFor(path), path);

        const result = (await this.db.allDocs({
            keys: [...byId.keys()],
            include_docs: true,
        })) as unknown as { rows: { id?: string; doc?: unknown }[] };

        for (const row of result.rows) {
            // A missing or deleted key comes back as a row with no document,
            // which is the answer rather than an error to handle.
            const path = row.id ? byId.get(row.id) : undefined;
            const doc = row.doc as FileEntry | undefined;
            if (!path || !doc) continue;
            if (!isFileEntry(doc) || isDeleted(doc)) continue;
            alive.add(path);
        }

        return alive;
    }

    async read(path: string, options: ReadOptions = {}): Promise<ReadResult> {
        const id = await this.idFor(path);
        const status = this.options.replicator.status();

        let entry = await this.getDoc<FileEntry>(id);
        let verified = false;

        if (options.fresh) {
            const remote = await this.options.fetchRemote?.(id);
            if (!remote) {
                if (!entry) throw new NoteNotFoundError(path);
                throw new StaleReadError(path);
            }
            // Prefer the remote copy outright - it is by definition current,
            // and comparing revisions only to then re-fetch would be a wasted
            // round trip.
            entry = remote as unknown as FileEntry;
            verified = true;
        }

        if (!entry || !isFileEntry(entry) || isDeleted(entry)) throw new NoteNotFoundError(path);

        const file = await this.assemble(entry);
        return { file, lagMs: status.lagMs, verified };
    }

    /**
     * Assemble a file, fetching any chunk the replica lacks.
     *
     * A missing chunk usually means replication has not caught up with a note
     * that changed moments ago. Fetching it directly turns a transient failure
     * into a slightly slower read. If CouchDB does not have it either, the read
     * fails - a partially assembled note is never returned.
     */
    private async assemble(entry: FileEntry): Promise<AssembledFile> {
        const children = isLegacyNote(entry) ? [] : (entry as ChunkedEntry).children;
        const chunks = await this.getChunks(children);

        try {
            return assembleFile(entry, chunks);
        } catch (error) {
            if (!(error instanceof MissingChunkError) || !this.options.fetchRemote) throw error;

            for (const id of error.missing) {
                const remote = await this.options.fetchRemote(id);
                if (remote) chunks.set(id, remote as unknown as ChunkEntry);
            }
            // Any still missing will raise again, which is the correct outcome.
            return assembleFile(entry, chunks);
        }
    }

    private async getChunks(ids: readonly string[]): Promise<Map<string, ChunkEntry>> {
        const out = new Map<string, ChunkEntry>();
        if (ids.length === 0) return out;

        const unique = [...new Set(ids)];
        const result = await this.db.allDocs({ keys: unique, include_docs: true });
        for (const row of result.rows) {
            const doc = (row as { doc?: unknown }).doc;
            if (doc) out.set((row as { key: string }).key, doc as ChunkEntry);
        }
        return out;
    }

    private async getDoc<T>(id: string): Promise<T | undefined> {
        try {
            return (await this.db.get(id)) as unknown as T;
        } catch (error) {
            if ((error as { status?: number }).status === 404) return undefined;
            throw error;
        }
    }

    /**
     * List notes, optionally under a folder.
     *
     * Walks the replica rather than an index, which is fine at this vault's
     * size and honest about what exists: the index is not built yet, and
     * pretending otherwise would hide the cost.
     */
    async list(options: { folder?: string; includeInternal?: boolean; limit?: number } = {}): Promise<{
        notes: ListedNote[];
        lagMs: number;
        truncated: boolean;
    }> {
        const limit = options.limit ?? 1000;
        const folder = options.folder ? normalizePrefixedPath(options.folder).replace(/\/$/, "") : undefined;
        const notes: ListedNote[] = [];
        let truncated = false;

        for (const [startkey, endkey] of FILE_RANGES) {
            if (truncated) break;
            const page = await this.db.allDocs({ startkey, endkey, include_docs: true });
            for (const row of page.rows) {
                const doc = (row as { doc?: unknown }).doc as Record<string, unknown> | undefined;
                if (!doc || !isFileEntry(doc)) continue;
                if (isDeleted(doc as { deleted?: boolean; _deleted?: boolean })) continue;

                const path = String(entryPath(doc as never));
                if (!options.includeInternal && isInternalPath(path)) continue;
                if (folder && !(path === folder || path.startsWith(`${folder}/`))) continue;

                if (notes.length >= limit) {
                    truncated = true;
                    break;
                }

                const children = (doc.children as string[] | undefined) ?? [];
                notes.push({
                    path,
                    id: String(doc._id),
                    kind: pathKind(doc),
                    size: Number(doc.size ?? 0),
                    mtime: Number(doc.mtime ?? 0),
                    chunkCount: children.length,
                });
            }
        }

        notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { notes, lagMs: this.options.replicator.status().lagMs, truncated };
    }
}

function pathKind(doc: Record<string, unknown>): "text" | "binary" {
    return doc.type === "plain" ? "text" : "binary";
}
