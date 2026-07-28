/**
 * Document shapes as they exist in CouchDB.
 *
 * These describe the wire format, not the plugin's in-memory types. Notably
 * `datatype` — which appears all over the plugin source — is never persisted;
 * the persisted discriminator is `type`.
 */

import type {
    TYPE_CHUNK,
    TYPE_CHUNK_PACK,
    TYPE_NOTE_BINARY,
    TYPE_NOTE_LEGACY,
    TYPE_NOTE_PLAIN,
} from "./constants.js";

/** A CouchDB document ID. Branded to stop paths being passed where IDs belong. */
export type DocumentID = string & { readonly __brand: "DocumentID" };
/** A vault-relative path, possibly carrying an `i:`/`ix:`/`ps:` prefix. */
export type VaultPath = string & { readonly __brand: "VaultPath" };

export const asDocumentID = (s: string): DocumentID => s as DocumentID;
export const asVaultPath = (s: string): VaultPath => s as VaultPath;

export interface DatabaseEntry {
    _id: DocumentID;
    _rev?: string;
    /** CouchDB-level deletion. */
    _deleted?: boolean;
    _conflicts?: string[];
}

export interface EntryBase {
    /** Creation time, epoch milliseconds. Zeroed on the wire under E2EE v2. */
    ctime: number;
    /** Modification time, epoch milliseconds. Zeroed on the wire under E2EE v2. */
    mtime: number;
    /** Byte length of the reassembled content. Zeroed on the wire under E2EE v2. */
    size: number;
    /** Soft deletion, in the document body. Independent of `_deleted`. */
    deleted?: boolean;
}

/** The obsolete inline-chunk optimisation. Current clients always write `{}`. */
export interface EdenChunk {
    data: string;
    epoch: number;
}

/** A file document whose content lives in chunks. */
export interface ChunkedEntry extends DatabaseEntry, EntryBase {
    path: VaultPath;
    /** Ordered chunk document IDs. May repeat; order is significant. */
    children: string[];
    type: typeof TYPE_NOTE_PLAIN | typeof TYPE_NOTE_BINARY;
    eden?: Record<string, EdenChunk>;
    /** Set by the encryption transform on encrypted documents. */
    e_?: boolean;
}

/** The pre-chunking document format. Content is inline. */
export interface LegacyNoteEntry extends DatabaseEntry, EntryBase {
    path: VaultPath;
    data: string | string[];
    type: typeof TYPE_NOTE_LEGACY;
    eden?: Record<string, EdenChunk>;
}

export type FileEntry = ChunkedEntry | LegacyNoteEntry;

/** A chunk payload document. */
export interface ChunkEntry extends DatabaseEntry {
    type: typeof TYPE_CHUNK;
    data: string;
    isCorrupted?: boolean;
    e_?: boolean;
}

export interface ChunkPackEntry extends DatabaseEntry {
    type: typeof TYPE_CHUNK_PACK;
    data: string;
    e_?: boolean;
}

export interface SyncParametersEntry extends DatabaseEntry {
    type: "sync-parameters";
    /** 1 = legacy, 2 = advanced E2EE. */
    protocolVersion?: number;
    /** Base64 of the 32-byte vault-wide PBKDF2 salt. */
    pbkdf2salt: string;
}

export interface MilestoneEntry extends DatabaseEntry {
    type: "milestoneinfo";
    created: number;
    accepted_nodes: string[];
    node_info: Record<string, unknown>;
    locked: boolean;
    cleaned?: boolean;
    node_chunk_info: Record<string, { min: number; max: number; current: number }>;
    /** Per-node settings that must agree across devices. */
    tweak_values: Record<string, Record<string, unknown>>;
}

export type AnyDocument =
    | FileEntry
    | ChunkEntry
    | ChunkPackEntry
    | SyncParametersEntry
    | MilestoneEntry
    | (DatabaseEntry & { type?: string; [k: string]: unknown });

// --- The model's own view of a note -----------------------------------------

/** Whether a file's content is text or bytes. */
export type ContentKind = "text" | "binary";

interface AssembledFileBase {
    path: VaultPath;
    id: DocumentID;
    rev: string | undefined;
    ctime: number;
    mtime: number;
    /**
     * Size as recorded in the document. Verified against the assembled length
     * for chunked documents; see `assembleFile`.
     */
    size: number;
    deleted: boolean;
    /** Chunk IDs, in order, for diagnostics. */
    children: string[];
}

/**
 * A file, assembled.
 *
 * A discriminated union rather than two optional fields, so that reading
 * `.text` off a binary file is a compile error rather than `undefined` flowing
 * into a note body.
 */
export type AssembledFile =
    | (AssembledFileBase & { kind: "text"; text: string; bytes?: undefined })
    | (AssembledFileBase & { kind: "binary"; bytes: Uint8Array; text?: undefined });

/** Content on the way in to being written. */
export type FileContent = { kind: "text"; text: string } | { kind: "binary"; bytes: Uint8Array };

/** The documents that must be written to persist a file. */
export interface ComposedWrite {
    /** New chunk documents. Chunks already present upstream are not included. */
    chunks: ChunkEntry[];
    /** The file document, without `_rev`; the caller supplies it. */
    entry: Omit<ChunkedEntry, "_rev">;
    /** Every chunk ID referenced, in order — including pre-existing ones. */
    children: string[];
}
