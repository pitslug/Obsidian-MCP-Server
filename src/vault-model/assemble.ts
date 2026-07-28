/**
 * Documents in, file out.
 *
 * Pure: no network, no database handle. The caller supplies every chunk the
 * document references; if one is missing, assembly fails rather than returning
 * a shorter file. A truncated note that looks complete is the worst possible
 * output of this system, so the failure is explicit and names what is missing.
 *
 * Assembly also refuses to run on documents that have not been through
 * {@link decodeDocument}. That is not defensive tidiness: an encrypted document
 * still has a well-formed shape, and its emptied `children` and zeroed `size`
 * are indistinguishable from a genuinely empty note. Checking here is the only
 * place that distinction can still be made.
 */

import { MARK_ENCODED_UTF16, TYPE_NOTE_BINARY, TYPE_NOTE_LEGACY, TYPE_NOTE_PLAIN } from "./constants.js";
import { decodeChunkBase64, isPlainTextPath } from "./chunking/index.js";
import { entryPath } from "./ids.js";
import { assertDecoded, assertMetadataDecoded } from "./transform.js";
import type {
    AssembledFile,
    ChunkEntry,
    ChunkedEntry,
    ContentKind,
    DocumentID,
    FileEntry,
    LegacyNoteEntry,
} from "./types.js";

export class MissingChunkError extends Error {
    readonly missing: string[];
    constructor(path: string, missing: string[]) {
        super(
            `Cannot assemble "${path}": ${missing.length} chunk(s) missing from the supplied set ` +
                `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}). ` +
                `Fetch them from CouchDB, or treat the note as unreadable.`
        );
        this.name = "MissingChunkError";
        this.missing = missing;
    }
}

export class UnsupportedDocumentError extends Error {
    constructor(id: string, reason: string) {
        super(`Document "${id}" cannot be assembled: ${reason}`);
        this.name = "UnsupportedDocumentError";
    }
}

export class SizeMismatchError extends Error {
    constructor(path: string, recorded: number, actual: number) {
        super(
            `Assembled "${path}" to ${actual} bytes but the document records ${recorded}. ` +
                `The chunk set does not match what was written; refusing to return it.`
        );
        this.name = "SizeMismatchError";
    }
}

/**
 * True for documents that represent a file in the vault.
 *
 * A missing `type` means a pre-chunking legacy note, which upstream still
 * reads - the oldest documents in a long-lived vault have no `type` at all.
 */
export function isFileEntry(doc: { type?: unknown; _id?: unknown; data?: unknown }): boolean {
    if (doc.type === TYPE_NOTE_PLAIN || doc.type === TYPE_NOTE_BINARY) return true;
    return isLegacyNote(doc);
}

/** Upstream's test: `!meta.type || meta.type == "notes"`. */
export function isLegacyNote(doc: { type?: unknown }): boolean {
    return !doc.type || doc.type === TYPE_NOTE_LEGACY;
}

/** Honours both the in-body `deleted` flag and CouchDB's `_deleted`. */
export function isDeleted(doc: { deleted?: boolean; _deleted?: boolean }): boolean {
    return doc.deleted === true || doc._deleted === true;
}

/**
 * Whether a document's content is text.
 *
 * Upstream checks `type`, then the in-memory `datatype` - which it sets from
 * `type` when responding - then falls back to the file extension. The third
 * check is reached for `newnote` documents too, so a `newnote` at a plain-text
 * path reads as text upstream, and must here as well: treating it as binary
 * would base64-decode ordinary prose into noise, silently.
 */
export function contentKind(doc: { type?: unknown; path?: string; _id?: unknown }): ContentKind {
    if (doc.type === TYPE_NOTE_PLAIN) return "text";
    const path = doc.path ?? (typeof doc._id === "string" ? doc._id : "");
    return isPlainTextPath(path) ? "text" : "binary";
}

export interface AssembleOptions {
    /**
     * Verify the assembled length against the document's recorded `size`.
     * On by default for chunked documents, where the value is written by the
     * same code path that wrote the chunks and is therefore a real check.
     */
    verifySize?: boolean;
}

/**
 * Assemble a file from its document and the chunks it references.
 *
 * `chunks` may hold more than the document needs; only `children` are used, in
 * order, and a repeated chunk ID is used as many times as it appears.
 */
export function assembleFile(
    entry: FileEntry,
    chunks: ReadonlyMap<string, ChunkEntry | { data: string }>,
    options: AssembleOptions = {}
): AssembledFile {
    if (!isFileEntry(entry)) {
        throw new UnsupportedDocumentError(
            String(entry._id),
            `its type is "${String((entry as { type?: unknown }).type)}", which is not a file document`
        );
    }

    // Refuse anything that has not been decoded, before doing any work with it.
    assertMetadataDecoded(String(entry._id), (entry as { path?: string }).path);
    assertEdenHandled(entry);

    const path = entryPath(entry);
    const kind = contentKind(entry);
    const legacy = isLegacyNote(entry);

    const parts = legacy
        ? legacyParts(entry as LegacyNoteEntry)
        : chunkParts(entry as ChunkedEntry, chunks, path);

    const base = {
        path,
        id: entry._id,
        rev: entry._rev,
        kind,
        ctime: entry.ctime,
        mtime: entry.mtime,
        size: entry.size,
        deleted: isDeleted(entry),
        children: legacy ? [] : [...(entry as ChunkedEntry).children],
    };

    const result: AssembledFile =
        kind === "text"
            ? { ...base, kind: "text", text: parts.join("") }
            : { ...base, kind: "binary", bytes: decodeBinaryParts(String(entry._id), parts) };

    const verify = options.verifySize ?? !legacy;
    if (verify) verifySize(result);

    return result;
}

/**
 * The `size` field is a free integrity check on a chunked document: it was
 * written by whatever produced the chunk list. A mismatch means the chunks are
 * not the ones the note was made of.
 */
function verifySize(file: AssembledFile): void {
    const actual =
        file.kind === "text" ? Buffer.byteLength(file.text ?? "", "utf8") : (file.bytes?.length ?? 0);
    if (file.size !== actual) throw new SizeMismatchError(file.path, file.size, actual);
}

/**
 * `eden` was an inline-chunk optimisation: a chunk referenced by `children` may
 * exist only there. Current clients always write `{}`, but a vault with
 * `useEden` on will have documents this cannot read - so it says so, rather
 * than reporting the chunks as missing and leaving the caller unable to
 * satisfy a request that can never be satisfied.
 */
function assertEdenHandled(entry: FileEntry): void {
    const eden = (entry as { eden?: Record<string, unknown> }).eden;
    if (eden && Object.keys(eden).length > 0) {
        throw new UnsupportedDocumentError(
            String(entry._id),
            `it carries inline "eden" chunks, which are not supported. ` +
                `This vault appears to have the obsolete useEden setting enabled.`
        );
    }
}

function legacyParts(entry: LegacyNoteEntry): string[] {
    const data = (entry as { data?: string | string[] }).data ?? "";
    return Array.isArray(data) ? data : [data];
}

function chunkParts(
    entry: ChunkedEntry,
    chunks: ReadonlyMap<string, ChunkEntry | { data: string }>,
    path: string
): string[] {
    const missing: string[] = [];
    const parts: string[] = [];

    for (const child of entry.children) {
        const chunk = chunks.get(child);
        if (!chunk) {
            if (!missing.includes(child)) missing.push(child);
            continue;
        }
        assertDecoded(child, chunk.data);
        parts.push(chunk.data);
    }

    if (missing.length > 0) throw new MissingChunkError(path, missing);
    return parts;
}

/** Standard base64, strictly - anything else means the payload is not what we think. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode binary chunk payloads.
 *
 * Current clients always write base64. A first chunk beginning with `%` means
 * the legacy encoded-UTF16 format, which this refuses rather than guessing at.
 *
 * The strict base64 check matters more than it looks: `Buffer.from(s, "base64")`
 * silently discards characters it does not recognise, so mis-classified text
 * decodes to plausible-looking noise instead of failing.
 */
function decodeBinaryParts(id: string, parts: string[]): Uint8Array {
    if (parts.length === 0) return new Uint8Array();
    if (parts[0]?.startsWith(MARK_ENCODED_UTF16)) {
        throw new UnsupportedDocumentError(
            id,
            "its payload uses the legacy encoded-UTF16 format (first chunk starts with '%')"
        );
    }

    const decoded = parts.map((part, index) => {
        if (!BASE64_RE.test(part)) {
            throw new UnsupportedDocumentError(
                id,
                `chunk ${index} of its binary payload is not valid base64. The document may be ` +
                    `mis-typed, or the chunk was never decoded.`
            );
        }
        return decodeChunkBase64(part);
    });

    const total = decoded.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of decoded) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** The chunk IDs a set of documents needs, deduplicated. */
export function requiredChunkIds(entries: readonly FileEntry[]): DocumentID[] {
    const seen = new Set<string>();
    for (const entry of entries) {
        if (isLegacyNote(entry)) continue;
        for (const child of (entry as ChunkedEntry).children) seen.add(child);
    }
    return [...seen] as DocumentID[];
}
