/**
 * The mapping between vault paths and CouchDB document IDs.
 *
 * Two rules here are easy to get wrong and silently destructive:
 *
 *  - With `handleFilenameCaseSensitive` false (the default), the ID is derived
 *    from the *lowercased* path while the `path` field keeps the true casing.
 *    Deriving a path from an ID therefore loses case; always prefer the `path`
 *    field of the document.
 *  - With path obfuscation on, the ID is a one-way hash. It cannot be inverted.
 *    Writing to an existing path means recomputing the same hash from the same
 *    input string; any difference creates a duplicate document instead of
 *    updating the existing one.
 */

import { writeString } from "octagonal-wheels/binary/base64.js";
import { PATH_PREFIXES, PREFIX_OBFUSCATED } from "./constants.js";
import { asDocumentID, asVaultPath, type DocumentID, type VaultPath } from "./types.js";

/**
 * SHA-256 of a string, lowercase hex.
 *
 * Upstream wraps this in a loop that re-digests the same buffer `key.length`
 * times and discards every intermediate result, so the value equals a single
 * SHA-256. Reproduced as the single digest it actually is; the differential
 * tests assert equality with upstream.
 */
export async function hashString(key: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", writeString(key));
    return Buffer.from(digest).toString("hex");
}

/**
 * Split a leading prefix off a path or document ID, on the first `:`.
 *
 * This is upstream's rule verbatim, and it is deliberately not restricted to
 * the known prefixes. A path containing a stray colon therefore produces a
 * "prefix" that is not one of `i:` / `ix:` / `ps:` - which is exactly what the
 * plugin does, and why such paths are rejected as sync targets rather than
 * stored. See {@link assertSyncablePath}.
 */
export function expandPathPrefix(path: string): [prefix: string, body: string] {
    const at = path.indexOf(":");
    if (at < 0) return ["", path];
    return [path.slice(0, at + 1), path.slice(at + 1)];
}

/** Identical to {@link expandPathPrefix}; kept separate to mirror upstream. */
export const expandDocumentIDPrefix = expandPathPrefix;

/** True for the prefixes the plugin uses to namespace non-note documents. */
export function isKnownPathPrefix(prefix: string): boolean {
    return (PATH_PREFIXES as readonly string[]).includes(prefix);
}

export class UnsyncablePathError extends Error {
    constructor(path: string) {
        super(
            `Path "${path}" contains a colon, which the plugin refuses to sync. ` +
                `A document written at this path would never be read back by Obsidian.`
        );
        this.name = "UnsyncablePathError";
    }
}

/**
 * Reject a path the plugin would refuse to sync.
 *
 * Upstream's `isTargetFile` returns false for any path whose body contains `:`,
 * and that gate sits in front of both reading and writing. Without this check
 * we would happily compose a well-formed document at an ID nothing ever looks
 * at - a write that reports success and changes nothing the user can see.
 */
export function assertSyncablePath(path: VaultPath | string): void {
    const source = `${path}`;
    const [prefix, body] = expandPathPrefix(source);
    // A known prefix is legitimate; anything else means a colon in the name.
    if (prefix !== "" && !isKnownPathPrefix(prefix)) throw new UnsyncablePathError(source);
    if (body.includes(":")) throw new UnsyncablePathError(source);
}

/**
 * Obsidian's `normalizePath`, which the plugin applies before mapping a path
 * to an ID.
 *
 * Reproducing it matters for two reasons. Unicode normalisation to NFC means a
 * decomposed and a composed spelling of the same filename map to one document
 * rather than two. And stripping a leading slash keeps the mapping invertible:
 * `pathToId` escapes a leading `_` by prefixing `/`, and `idToPath` undoes that
 * by removing any leading `/`, so a path that genuinely began with one would
 * come back short a character.
 */
export function normalizeVaultPath(path: string): string {
    // Obsidian folds the two space characters that survive a copy-paste from a
    // word processor. Not doing so would map such a filename to a different
    // document than every other client uses, silently creating a duplicate.
    const spaces = path.replace(/[  ]/g, " ");
    const collapsed = spaces.replace(/([\\/])+/g, "/");
    const trimmed = collapsed.replace(/^\/+/, "").replace(/\/+$/, "");
    return trimmed.normalize("NFC");
}

/**
 * Normalise a path the way the plugin's wrapper does: only the portion after
 * the last prefix separator, so `i:` and friends survive intact.
 */
export function normalizePrefixedPath(path: string): string {
    const parts = `${path}`.split(":");
    const last = parts.pop() ?? "";
    parts.push(normalizeVaultPath(last));
    return parts.join(":");
}

export interface IdOptions {
    /** The obfuscation passphrase, or false/empty when obfuscation is off. */
    obfuscatePassphrase: string | false;
    /** True when `handleFilenameCaseSensitive` is false. */
    caseInsensitive: boolean;
    /**
     * Skip path normalisation. Only for differential testing against
     * `path2id_base`, which is called by the plugin *after* normalisation.
     */
    skipNormalize?: boolean;
}

/**
 * Compute the document ID for a vault path.
 *
 * Without obfuscation the ID is the path verbatim, lowercased if
 * case-insensitive, with a `/` inserted in front if it starts with `_` - CouchDB
 * reserves leading-underscore IDs.
 *
 * With obfuscation:
 *   `hp  = hex(SHA256(passphrase))`
 *   `_id = <path prefix> + "f:" + hex(SHA256(hp + ":" + path))`
 * where `path` is the whole prefixed path, lowercased if case-insensitive, and
 * *without* the leading-underscore escape.
 */
export async function pathToId(path: VaultPath | string, options: IdOptions): Promise<DocumentID> {
    const source = options.skipNormalize ? `${path}` : normalizePrefixedPath(`${path}`);
    // An already-obfuscated value passes through untouched.
    if (source.startsWith(PREFIX_OBFUSCATED)) return asDocumentID(source);

    const filename = options.caseInsensitive ? source.toLowerCase() : source;
    const newPrefix = options.obfuscatePassphrase ? PREFIX_OBFUSCATED : "";

    let escaped = filename;
    if (escaped.startsWith("_")) escaped = "/" + escaped;

    if (!options.obfuscatePassphrase) {
        return asDocumentID(newPrefix + escaped);
    }

    const [prefix, body] = expandPathPrefix(escaped);
    if (body.startsWith(PREFIX_OBFUSCATED)) return asDocumentID(newPrefix + escaped);

    const hashedPassphrase = await hashString(options.obfuscatePassphrase);
    // Note: `filename`, not `escaped` - the leading-underscore escape is not
    // part of the hashed input. This asymmetry is upstream.
    const out = await hashString(`${hashedPassphrase}:${filename}`);
    return asDocumentID(prefix + newPrefix + out);
}

export class ObfuscatedIdError extends Error {
    constructor(id: string) {
        super(
            `Document ID "${id}" is obfuscated and cannot be converted back to a path. ` +
                `Read the path from the document's decrypted "path" field instead.`
        );
        this.name = "ObfuscatedIdError";
    }
}

/**
 * Recover a vault path from a document ID.
 *
 * Throws for obfuscated IDs, which are one-way. When the document is available,
 * use {@link entryPath} instead - it reads the `path` field, which survives
 * both obfuscation and case folding.
 */
export function idToPath(id: DocumentID | string): VaultPath {
    const source = `${id}`;
    if (source.startsWith(PREFIX_OBFUSCATED)) throw new ObfuscatedIdError(source);
    const [prefix, body] = expandDocumentIDPrefix(source);
    if (body.startsWith(PREFIX_OBFUSCATED)) throw new ObfuscatedIdError(source);
    if (body.startsWith("/")) return asVaultPath(body.slice(1));
    return asVaultPath(prefix + body);
}

/**
 * The authoritative path of a document: its `path` field if present, else
 * derived from the ID.
 */
export function entryPath(entry: { _id: DocumentID | string; path?: string }): VaultPath {
    if (entry.path) return idToPath(entry.path);
    return idToPath(entry._id);
}

/** Strip an `i:` / `ix:` / `ps:` prefix, returning the bare vault path. */
export function stripPathPrefix(path: VaultPath | string): {
    prefix: string;
    path: VaultPath;
} {
    const [prefix, body] = expandPathPrefix(`${path}`);
    return { prefix, path: asVaultPath(body) };
}

/** True for documents the plugin manages but which are not vault notes. */
export function isInternalPath(path: VaultPath | string): boolean {
    return expandPathPrefix(`${path}`)[0] !== "";
}
