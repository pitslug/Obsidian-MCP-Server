/**
 * File in, documents out.
 *
 * Pure, like assembly: this decides what should be written, and hands back
 * documents for someone else to PUT. It performs no I/O and makes no decisions
 * about revisions or conflict handling — those belong to the write executor,
 * which is the only unit permitted a state-changing request.
 */

import { TYPE_CHUNK, TYPE_NOTE_BINARY, TYPE_NOTE_PLAIN } from "./constants.js";
import { splitContent, type SplitOptions } from "./chunking/index.js";
import { ChunkHasher } from "./hash.js";
import { assertSyncablePath, pathToId } from "./ids.js";
import type { VaultFormatSettings } from "./settings.js";
import {
    type DocumentID,
    type ChunkEntry,
    type ChunkedEntry,
    type ComposedWrite,
    type FileContent,
    type VaultPath,
} from "./types.js";

export interface ComposeOptions {
    settings: VaultFormatSettings;
    /** Chunk IDs already known to exist upstream, so they are not re-sent. */
    existingChunkIds?: ReadonlySet<string>;
    /** Defaults to now. Supplied explicitly to keep composition deterministic. */
    now?: number;
    /** Creation time for a new file. Defaults to `mtime`. */
    ctime?: number;
    mtime?: number;
    allowSplitterFallback?: boolean;
}

/**
 * Compose the documents that persist a file's content.
 *
 * `size` is the byte length of the content, not the character length — for text
 * that is the UTF-8 length. Getting this wrong is cosmetic in Obsidian but shows
 * up in the plugin's own consistency reporting, so it is computed rather than
 * approximated.
 */
export async function composeWrite(
    path: VaultPath | string,
    content: FileContent,
    options: ComposeOptions
): Promise<ComposedWrite> {
    const { settings } = options;

    // Refuse a path the plugin would never sync, before composing anything.
    assertSyncablePath(path);

    const splitOptions: SplitOptions = {
        settings,
        allowSplitterFallback: options.allowSplitterFallback ?? false,
    };
    const pieces = splitContent(path, content, splitOptions);

    const hasher = await ChunkHasher.create({
        hashAlg: settings.hashAlg,
        encrypt: settings.encrypt,
        passphrase: settings.passphrase,
    });
    const children = await hasher.computeChunkIds(pieces);

    const existing = options.existingChunkIds;
    const emitted = new Set<string>();
    const chunks: ChunkEntry[] = [];
    for (const [index, id] of children.entries()) {
        if (existing?.has(id)) continue;
        if (emitted.has(id)) continue;
        emitted.add(id);
        chunks.push({
            _id: id,
            type: TYPE_CHUNK,
            data: pieces[index] as string,
        });
    }

    const id = await pathToId(path, {
        obfuscatePassphrase: settings.usePathObfuscation ? settings.passphrase : false,
        caseInsensitive: !settings.handleFilenameCaseSensitive,
    });

    const now = options.now ?? Date.now();
    const mtime = options.mtime ?? now;
    const ctime = options.ctime ?? mtime;

    const entry: Omit<ChunkedEntry, "_rev"> = {
        _id: id,
        path: path as VaultPath,
        ctime,
        mtime,
        size: contentByteLength(content),
        type: content.kind === "text" ? TYPE_NOTE_PLAIN : TYPE_NOTE_BINARY,
        children: children.map(String),
        eden: {},
    };

    return { chunks, entry, children: children.map(String) };
}

/**
 * Compose the document that marks a file deleted.
 *
 * The plugin's default is a soft delete: the document survives with
 * `deleted: true`, keeps its `children`, and gets a bumped `mtime`. Only with
 * `deleteMetadataOfDeletedFiles` does it also set `_deleted`. Soft deletion is
 * what this produces, because it is reversible and because a hard delete
 * removes the record other devices reconcile against.
 */
export function composeDeletion(
    entry: ChunkedEntry,
    options: { now?: number; hard?: boolean } = {}
): ChunkedEntry {
    const now = options.now ?? Date.now();
    const next: ChunkedEntry = { ...entry, deleted: true, mtime: now };
    if (options.hard) next._deleted = true;
    return next;
}

function contentByteLength(content: FileContent): number {
    if (content.kind === "binary") return content.bytes.length;
    return Buffer.byteLength(content.text, "utf8");
}

/** The chunk document ID a given payload would get under these settings. */
export async function chunkIdFor(piece: string, settings: VaultFormatSettings): Promise<DocumentID> {
    const hasher = await ChunkHasher.create({
        hashAlg: settings.hashAlg,
        encrypt: settings.encrypt,
        passphrase: settings.passphrase,
    });
    return hasher.computeChunkId(piece);
}
