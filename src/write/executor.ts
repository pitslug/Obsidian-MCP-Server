/**
 * The write executor.
 *
 * Composes documents through the vault model, reads current revisions from
 * CouchDB, writes, and patches the local replica with the result. It owns no
 * opinion about what a note should contain: content in, receipt out. Deciding
 * that an append means "the old text plus a line" belongs to the tool layer.
 *
 * Four decisions here are worth stating where the code is, rather than only in
 * the design document.
 *
 * **The current revision is read from CouchDB, never from the replica.** The
 * replica is eventually consistent by design. Composing a write against it
 * would mean the `409` is the only thing preventing a lost update, and a last
 * line of defence used as ordinary operation is not a defence.
 *
 * **Chunk reuse is limited to the chunks a live current revision already
 * references.** A chunk in the local replica is not proof that CouchDB still
 * holds it, because the plugin garbage-collects unreferenced chunks. Skipping a
 * chunk that turns out to be absent upstream writes a note document pointing at
 * nothing, which is unreadable and looks like corruption. Chunks referenced by
 * a live document are guaranteed present, and they are the ones an edit
 * actually reuses; a tombstone's and an eden document's are not, so those get
 * no reuse at all. See `reusableChunkIds`. Everything else is sent, and a chunk
 * that does exist comes back as a conflict, which for content-addressed
 * documents is a no-op.
 *
 * **Chunks go first, the note document last.** In that order the worst outcome
 * of a half-completed write is orphaned chunks, which cost disk and nothing
 * else. In the other order it is a note referencing chunks that were never
 * written, which is a broken note on every device.
 *
 * **A failure to patch the replica does not fail the write.** By that point
 * CouchDB has accepted it and every device will receive it. Reporting failure
 * would be a lie that invites a retry, and the retry would conflict.
 */

import {
    assertSyncablePath,
    composeDeletion,
    composeWrite,
    decodeDocument,
    encodeDocument,
    expandPathPrefix,
    isDeleted,
    isFileEntry,
    isKnownPathPrefix,
    normalizePrefixedPath,
    pathToId,
    type ChunkedEntry,
    type FileContent,
    type FileEntry,
    type TransformContext,
    type VaultFormatSettings,
} from "../vault-model/index.js";
import type { Replicator } from "../replicator/index.js";
import { CouchWriter, ReadOnlyError, RevisionConflictError } from "./couch.js";

export { ReadOnlyError, RevisionConflictError } from "./couch.js";

/**
 * A path this refuses to write, whatever the caller asks.
 *
 * The `i:`, `ix:` and `ps:` prefixes are the plugin's hidden-file and
 * customisation sync containers: Obsidian's own configuration, community plugin
 * code, themes. They are legitimately syncable, which is why the vault model
 * accepts them, and they are emphatically not something an assistant should be
 * able to rewrite. Ruling them out here rather than in the tool layer means it
 * holds for every future tool without anyone having to remember.
 */
export class UnwritablePathError extends Error {
    constructor(path: string) {
        super(
            `Refusing to write "${path}". Paths under the plugin's internal containers ` +
                `(i:, ix:, ps:) hold Obsidian's own configuration and plugin code, not vault notes.`
        );
        this.name = "UnwritablePathError";
    }
}

/**
 * A pre-chunking note cannot be deleted through here on an encrypted vault.
 *
 * See `assertTombstoneSafe`. The refusal is the point: quietly writing the
 * note's plaintext back to CouchDB in the course of deleting it would be a
 * permanent confidentiality break performed by a tidying-up operation.
 */
export class LegacyDeletionError extends Error {
    constructor(path: string) {
        super(
            `Refusing to delete "${path}". It is a pre-chunking note whose content is stored ` +
                `inline, and this vault is encrypted: writing the deletion would publish the note's ` +
                `plaintext to CouchDB. Delete it from Obsidian, or rewrite it first.`
        );
        this.name = "LegacyDeletionError";
    }
}

export class WriteTargetMissingError extends Error {
    constructor(path: string) {
        super(`There is no note at "${path}" to modify.`);
        this.name = "WriteTargetMissingError";
    }
}

export interface WriteRequest {
    path: string;
    content: FileContent;
    /**
     * The revision the content was derived from. `null` asserts the note does
     * not exist.
     *
     * Required, and deliberately so. Reading the current revision here and
     * writing against it would make every write succeed, including one whose
     * content was composed from a copy of the note that another device has
     * since changed. The `409` protects the document; only a revision supplied
     * by whoever read the content protects the content. A caller that genuinely
     * wants to overwrite whatever is there can read the revision immediately
     * beforehand and say so, which at least makes the intent visible.
     */
    expectedRev: string | null;
    /** Modification time to record. Defaults to now. */
    mtime?: number;
}

export interface DeleteRequest {
    path: string;
    /** The revision the caller read. Required, for the reason above. */
    expectedRev: string;
    /**
     * Remove the document entirely rather than marking it deleted.
     *
     * Off by default and deliberately hard to reach: a soft delete is what the
     * plugin does, is reversible, and leaves the record other devices reconcile
     * against. A hard delete removes that record.
     */
    hard?: boolean;
}

export interface WriteReceipt {
    path: string;
    id: string;
    rev: string;
    previousRev: string | undefined;
    /** True when nothing existed at this path before. */
    created: boolean;
    deleted: boolean;
    /** Chunk documents actually sent. */
    chunksWritten: number;
    /** Chunk documents skipped because the previous revision already had them. */
    chunksReused: number;
    /** Chunks the server already had, reported as conflicts and treated as present. */
    chunksAlreadyPresent: number;
    size: number;
    /** Set when CouchDB accepted the write but the local replica could not be patched. */
    replicaPatchError: string | undefined;
}

export interface WriteExecutorOptions {
    couch: CouchWriter;
    replicator: Replicator;
    settings: VaultFormatSettings;
    transform: TransformContext;
    readOnly: boolean;
    /** Called for a replica patch failure, which is a warning rather than an error. */
    onWarning?: (message: string) => void;
    /** Injectable clock, so plan expiry is testable without waiting. */
    now?: () => number;
}

export class WriteExecutor {
    constructor(protected readonly options: WriteExecutorOptions) {}

    protected get couch(): CouchWriter {
        return this.options.couch;
    }

    protected now(): number {
        return this.options.now?.() ?? Date.now();
    }

    get readOnly(): boolean {
        return this.options.readOnly || this.options.couch.readOnly;
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
     * Read the current document for a path straight from CouchDB, decoded.
     *
     * Returns undefined for a path with nothing at it, and for a soft-deleted
     * document the document itself is returned rather than undefined: its
     * revision is still needed to write over it.
     */
    async currentEntry(path: string): Promise<FileEntry | undefined> {
        const id = await this.idFor(path);
        const raw = await this.couch.get(id);
        if (!raw) return undefined;
        const decoded = await decodeDocument(raw as never, this.options.transform);
        return decoded as unknown as FileEntry;
    }

    /** Write a file, creating it if it does not exist. */
    async write(request: WriteRequest): Promise<WriteReceipt> {
        this.assertWritable(`write "${request.path}"`);
        const path = normalizePrefixedPath(request.path);
        assertWritablePath(path);

        const id = await this.idFor(path);
        const existingRaw = await this.couch.get(id);
        const existing = existingRaw
            ? ((await decodeDocument(existingRaw as never, this.options.transform)) as unknown as FileEntry)
            : undefined;

        this.assertExpectedRevision(id, request.expectedRev, existing?._rev);

        const now = this.now();
        const mtime = request.mtime ?? now;
        // Creation time survives an edit. Losing it is invisible until someone
        // sorts by it, and then every note edited through here sorts as new.
        const ctime = existing && !isDeleted(existing) ? existing.ctime : mtime;

        const previousChildren = reusableChunkIds(existing);

        const composed = await composeWrite(path, request.content, {
            settings: this.options.settings,
            existingChunkIds: previousChildren,
            now,
            mtime,
            ctime,
        });

        const reused = composed.children.filter((child) => previousChildren.has(child)).length;

        const encodedChunks = await Promise.all(
            composed.chunks.map((chunk) => encodeDocument(chunk as never, this.options.transform))
        );
        const chunkResults = await this.couch.bulkPut(encodedChunks as unknown as Record<string, unknown>[]);

        const failures = chunkResults.filter((result) => !result.ok && !result.conflict);
        if (failures.length > 0) {
            throw new Error(
                `Could not write ${failures.length} chunk(s) for "${path}", so the note was not written: ` +
                    failures
                        .slice(0, 3)
                        .map((f) => `${f.id} (${f.error})`)
                        .join(", ")
            );
        }

        const entry: Record<string, unknown> = { ...(composed.entry as unknown as Record<string, unknown>) };
        if (existing?._rev) entry._rev = existing._rev;
        const parentRev = existing?._rev;
        const encodedEntry = await encodeDocument(entry as never, this.options.transform, { path });
        const result = await this.couch.put(encodedEntry as unknown as Record<string, unknown>);

        const patchError = await this.patchReplica(
            composed.chunks.map((chunk, index) => ({
                doc: chunk as unknown as Record<string, unknown>,
                rev: chunkResults[index]?.rev,
            })),
            withAncestry(
                { ...(composed.entry as unknown as Record<string, unknown>), _rev: result.rev },
                parentRev
            )
        );

        return {
            path,
            id,
            rev: result.rev,
            previousRev: existing?._rev,
            created: !existing || isDeleted(existing),
            deleted: false,
            chunksWritten: chunkResults.filter((r) => r.ok).length,
            chunksReused: reused,
            chunksAlreadyPresent: chunkResults.filter((r) => r.conflict).length,
            size: composed.entry.size,
            replicaPatchError: patchError,
        };
    }

    /**
     * Mark a file deleted.
     *
     * Soft by default: the document survives with `deleted: true` and keeps its
     * chunk list, which is what the plugin does and what makes it reversible.
     */
    async remove(request: DeleteRequest): Promise<WriteReceipt> {
        this.assertWritable(`delete "${request.path}"`);
        const path = normalizePrefixedPath(request.path);
        assertWritablePath(path);

        const id = await this.idFor(path);
        const existingRaw = await this.couch.get(id);
        if (!existingRaw) throw new WriteTargetMissingError(path);

        const existing = (await decodeDocument(
            existingRaw as never,
            this.options.transform
        )) as unknown as ChunkedEntry;
        this.assertExpectedRevision(id, request.expectedRev, existing._rev);
        this.assertTombstoneSafe(existing, path);

        const tombstone = composeDeletion(existing, { now: this.now(), hard: request.hard });
        const encoded = await encodeDocument(tombstone as never, this.options.transform, { path });
        const result = await this.couch.put(encoded as unknown as Record<string, unknown>);

        const patchError = await this.patchReplica(
            [],
            withAncestry(
                { ...(tombstone as unknown as Record<string, unknown>), _rev: result.rev },
                existing._rev
            )
        );

        return {
            path,
            id,
            rev: result.rev,
            previousRev: existing._rev,
            created: false,
            deleted: true,
            chunksWritten: 0,
            chunksReused: 0,
            chunksAlreadyPresent: 0,
            size: existing.size ?? 0,
            replicaPatchError: patchError,
        };
    }

    protected assertWritable(what: string): void {
        if (this.readOnly) throw new ReadOnlyError(what);
    }

    /**
     * Refuse a soft delete that would publish a note's plaintext.
     *
     * A tombstone is composed by spreading the decoded document, so a legacy
     * pre-chunking note carries its content in `data`. `encodeDocument` only
     * re-encrypts payloads on chunk and `syncinfo` IDs, so that `data` would go
     * back to CouchDB in the clear, replacing ciphertext with plaintext
     * permanently. Refusing is the honest outcome: the fix is to write the note
     * through the chunked path first, or to delete it from Obsidian.
     */
    protected assertTombstoneSafe(existing: FileEntry, path: string): void {
        const carriesInlineData = typeof (existing as { data?: unknown }).data !== "undefined";
        if (!carriesInlineData || !this.options.settings.encrypt) return;
        throw new LegacyDeletionError(path);
    }

    /**
     * Compare the revision the caller expected against what is actually there.
     *
     * `null` asserts absence, so a create cannot silently become an overwrite.
     */
    protected assertExpectedRevision(id: string, expected: string | null, actual: string | undefined): void {
        if (expected === null) {
            if (actual === undefined) return;
            throw new RevisionConflictError(id, undefined, { _id: id, _rev: actual });
        }
        if (expected !== actual) {
            throw new RevisionConflictError(id, expected, { _id: id, _rev: actual });
        }
    }

    /**
     * Put the documents just written into the local replica.
     *
     * `new_edits: false` inserts the revision CouchDB assigned rather than
     * generating a new one, which is what replication itself does. Without it
     * the replica would hold a different revision of the same content and the
     * next pull would see a spurious conflict.
     *
     * The `_revisions` ancestry that `withAncestry` attaches is not optional
     * decoration. A document inserted with `new_edits: false` and no ancestry
     * has nothing to attach it to the revision tree, so PouchDB starts a new
     * branch: the replica ends up holding a permanent conflict leaf per write,
     * each a full copy of the note, and pull replication never repairs it
     * because `_revs_diff` reports nothing missing. Reads still return the
     * right winner, which is precisely what makes it easy to miss.
     *
     * Returns a message rather than throwing: the write has already been
     * accepted upstream by the time this runs.
     */
    protected async patchReplica(
        chunks: { doc: Record<string, unknown>; rev: string | undefined }[],
        entry: Record<string, unknown>
    ): Promise<string | undefined> {
        const docs: Record<string, unknown>[] = [];
        for (const { doc, rev } of chunks) {
            // A chunk the server already had comes back without a revision.
            // It is either in the replica already or will arrive by pull, and
            // the reader fetches a missing chunk directly regardless.
            if (rev) docs.push(withAncestry({ ...doc, _rev: rev }, undefined));
        }
        docs.push(entry);

        try {
            await this.options.replicator.database.bulkDocs(docs as never, { new_edits: false } as never);
            return undefined;
        } catch (error) {
            const message =
                `The write succeeded upstream but the local replica could not be updated: ` +
                `${(error as Error).message}. Reads may be briefly stale until replication catches up.`;
            this.options.onWarning?.(message);
            return message;
        }
    }
}

/** Reject internal-container paths, and anything the plugin would not sync. */
export function assertWritablePath(path: string): void {
    assertSyncablePath(path);
    const [prefix] = expandPathPrefix(path);
    if (prefix !== "" && isKnownPathPrefix(prefix)) throw new UnwritablePathError(path);
}

/**
 * The chunks of an existing document that a new write may safely skip sending.
 *
 * Two documents look like they have reusable chunks and do not.
 *
 * A document with a non-empty `eden` may reference chunks that exist *only*
 * inside it, as an inline payload rather than as chunk documents. Treating
 * those IDs as present upstream would write a note referencing chunks that
 * exist nowhere, and `eden` is not carried forward. The reader refuses such
 * documents outright; the write path has to refuse to trust them too.
 *
 * A soft-deleted document's chunks are exactly the ones the plugin's orphan
 * cleanup is entitled to collect, so the guarantee that a live document's
 * chunks are present does not extend to a tombstone's.
 *
 * In both cases the answer is to send every chunk. The cost is bandwidth on a
 * write that was going to happen anyway.
 */
function reusableChunkIds(existing: FileEntry | undefined): Set<string> {
    if (!existing || !isFileEntry(existing) || isDeleted(existing)) return new Set();

    const eden = (existing as { eden?: Record<string, unknown> }).eden;
    if (eden && Object.keys(eden).length > 0) return new Set();

    if (!("children" in existing)) return new Set();
    return new Set((existing as ChunkedEntry).children ?? []);
}

/**
 * Attach the revision ancestry a `new_edits: false` insert needs.
 *
 * CouchDB assigns `N-hash` with the parent as generation `N-1`, so a two
 * element path is the whole ancestry PouchDB needs to graft the revision onto
 * the branch it already holds. A document with no parent is a new root and
 * carries only its own hash.
 */
function withAncestry(doc: Record<string, unknown>, parentRev: string | undefined): Record<string, unknown> {
    const rev = String(doc._rev ?? "");
    const [generation, hash] = rev.split("-");
    const start = Number(generation);
    if (!hash || !Number.isFinite(start)) return doc;

    const ids = [hash];
    if (parentRev) {
        const parentHash = parentRev.split("-")[1];
        if (parentHash) ids.push(parentHash);
    }
    return { ...doc, _revisions: { start, ids } };
}
