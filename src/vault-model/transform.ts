/**
 * The document transform: wire form ⇄ plain form.
 *
 * This is the layer `transform-pouch` occupies in the plugin. It is expressed
 * here as two pure functions over documents so it can be exercised without a
 * database, and so the replicator and the write executor can share exactly one
 * definition of what an encrypted document looks like.
 *
 * Which documents are transformed is decided entirely by `_id`:
 *
 *   `h:+…`   chunk with an encrypted payload
 *   `syncinfo`  payload encrypted like a chunk
 *   `f:…`    file document with obfuscated ID; its metadata is protected
 *   `_local/…`  never transformed - which is what makes the PBKDF2 salt
 *               readable before anything can be decrypted
 *
 * Note the consequence for documents with a path prefix: hidden-file and
 * plugin-sync documents get IDs like `i:f:…`, and upstream's obfuscation test
 * is `startsWith("f:")`, so their `path` field is left in the clear. That is
 * reproduced here rather than corrected.
 */

import {
    ENCRYPTED_META_PREFIX,
    ENCRYPT_HKDF_PREFIX,
    ENCRYPT_V3_PREFIX,
    MARK_SHIFT_COMPRESSED,
    PREFIX_ENCRYPTED_CHUNK,
    PREFIX_OBFUSCATED,
    DOCID_SYNCINFO,
} from "./constants.js";
import { compressData, decompressData } from "./compression.js";
import {
    cryptoContextFor,
    DecryptionError,
    decryptPayload,
    encryptPayload,
    isPathProbablyObfuscated,
    obfuscatePathV1,
    type CryptoContext,
} from "./crypto.js";
import { E2EEAlgorithms, type E2EEAlgorithm } from "./settings.js";
import type { AnyDocument, VaultPath } from "./types.js";

export interface TransformContext {
    crypto: CryptoContext | undefined;
    enableCompression: boolean;
    /**
     * Whether this vault encrypts chunk payloads.
     *
     * Required in addition to the `h:+` ID prefix, because that prefix is not a
     * reliable marker on its own: under `hashAlg: "sha1"` the hash is base64, so
     * roughly one unencrypted chunk in sixty-four begins with `+`. Upstream is
     * not exposed to this because it does not install the transform at all when
     * encryption is off; we have to say so explicitly.
     */
    encryptChunks: boolean;
}

/**
 * Build a transform context from a vault's settings.
 *
 * Use this rather than assembling the context by hand: it is what keeps chunk
 * ID shape, chunk encryption and metadata protection consistent with each
 * other. See `cryptoContextFor` for why they cannot be chosen independently.
 */
export function transformContextFor(
    settings: {
        encrypt: boolean;
        passphrase: string;
        usePathObfuscation: boolean;
        useDynamicIterationCount: boolean;
        e2eeAlgorithm: E2EEAlgorithm;
        enableCompression: boolean;
    },
    pbkdf2Salt: Uint8Array<ArrayBuffer> | undefined
): TransformContext {
    return {
        crypto: cryptoContextFor(settings, pbkdf2Salt),
        enableCompression: settings.enableCompression,
        encryptChunks: settings.encrypt,
    };
}

type Doc = Record<string, unknown> & { _id: string };

/** `_local` documents and bare tombstones bypass every transform. */
export function isUntransformable(doc: Doc): boolean {
    if (typeof doc._id === "string" && doc._id.startsWith("_local")) return true;
    if (doc._deleted === true) {
        const meaningful = Object.keys(doc).filter((k) => !k.startsWith("_"));
        return meaningful.length === 0;
    }
    return false;
}

export const isEncryptedChunkId = (id: string): boolean => id.startsWith(PREFIX_ENCRYPTED_CHUNK);
export const isObfuscatedId = (id: string): boolean => id.startsWith(PREFIX_OBFUSCATED);
export const isSyncInfoId = (id: string): boolean => id === DOCID_SYNCINFO;

/** True when a `path` field holds a whole encrypted metadata object. */
export const isEncryptedMeta = (path: string): boolean => path.startsWith(ENCRYPTED_META_PREFIX);

/**
 * Convert a document as stored in CouchDB into its plain form.
 *
 * Failures throw. A partially decoded document is never returned: content that
 * looks plausible but is wrong is worse than an error, and a caller cannot tell
 * the difference after the fact.
 */
export async function decodeDocument<T extends AnyDocument>(document: T, ctx: TransformContext): Promise<T> {
    const doc = { ...(document as unknown as Doc) };
    if (isUntransformable(doc)) return doc as unknown as T;

    // Compression is outermost on the wire, so it comes off first.
    if (typeof doc.data === "string") {
        doc.data = await decompressData(doc.data);
    } else if (Array.isArray(doc.data)) {
        doc.data = await Promise.all(
            doc.data.map((part) => (typeof part === "string" ? decompressData(part) : part))
        );
    }

    const encrypted = doc.e_ === true;
    const needsMeta = isObfuscatedId(doc._id);

    if (!encrypted && !needsMeta) return doc as unknown as T;

    if (!ctx.crypto) {
        throw new DecryptionError(`Document "${doc._id}" is encrypted but no passphrase is configured.`);
    }

    if (encrypted && typeof doc.data === "string") {
        doc.data = await decryptPayload(doc.data, ctx.crypto);
        delete doc.e_;
    }

    if (needsMeta && typeof doc.path === "string") {
        Object.assign(doc, await decodeMetadata(doc.path, ctx.crypto));
    }

    return doc as unknown as T;
}

/**
 * Recover the fields hidden inside an obfuscated document's `path`.
 *
 * Under E2EE v2 that is the whole metadata object - path, times, size and the
 * chunk list - which is why the cleartext document shows zeroed timestamps and
 * an empty `children` until this runs. Under V1 only the path itself is
 * protected.
 */
async function decodeMetadata(path: string, crypto: CryptoContext): Promise<Record<string, unknown>> {
    if (isEncryptedMeta(path)) {
        const payload = path.slice(ENCRYPTED_META_PREFIX.length);
        const json = await decryptPayload(payload, crypto);
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (error) {
            throw new DecryptionError("Decrypted metadata was not valid JSON.", { cause: error });
        }
        if (typeof parsed !== "object" || parsed === null) {
            throw new DecryptionError("Decrypted metadata was not an object.");
        }
        return parsed as Record<string, unknown>;
    }

    if (isPathProbablyObfuscated(path)) {
        return { path: await decryptPayload(path, crypto) };
    }

    // An `f:` document whose path is neither form: leave it alone rather than
    // guess. The caller will see an unusable path rather than a wrong one.
    return {};
}

export interface EncodeOptions {
    /**
     * The plaintext path, when the document ID is obfuscated. Required in that
     * case, since the ID cannot be inverted to recover it.
     */
    path?: VaultPath | string;
}

/**
 * Convert a plain document into the form CouchDB should hold.
 *
 * The inverse of {@link decodeDocument}, and the only place that decides what
 * a written document looks like.
 */
export async function encodeDocument<T extends AnyDocument>(
    document: T,
    ctx: TransformContext,
    options: EncodeOptions = {}
): Promise<T> {
    const doc = { ...(document as unknown as Doc) };
    if (isUntransformable(doc)) return doc as unknown as T;

    // The ID prefix alone is not sufficient - see TransformContext.encryptChunks.
    const shouldEncryptPayload = (ctx.encryptChunks && isEncryptedChunkId(doc._id)) || isSyncInfoId(doc._id);
    const shouldProtectMeta = isObfuscatedId(doc._id);

    if (shouldEncryptPayload || shouldProtectMeta) {
        if (!ctx.crypto) {
            throw new DecryptionError(
                `Document "${doc._id}" requires encryption but no passphrase is configured.`
            );
        }
    }

    if (shouldEncryptPayload && ctx.crypto && typeof doc.data === "string" && doc.e_ !== true) {
        doc.data = await encryptPayload(doc.data, ctx.crypto);
        doc.e_ = true;
    }

    if (shouldProtectMeta && ctx.crypto) {
        const plainPath = `${options.path ?? doc.path ?? ""}`;
        if (!plainPath) {
            throw new DecryptionError(
                `Cannot write obfuscated document "${doc._id}" without knowing its plaintext path.`
            );
        }
        if (ctx.crypto.algorithm === E2EEAlgorithms.V2) {
            // Sealing an already-sealed document would encrypt the ciphertext
            // along with the zeroed timestamps and the emptied chunk list,
            // destroying the only record of which chunks the note is made of.
            // Upstream guards this in two places; so does this.
            if (isEncryptedMeta(`${doc.path ?? ""}`)) {
                throw new DecryptionError(
                    `Document "${doc._id}" already carries encrypted metadata. Refusing to encrypt ` +
                        `it again, which would discard its real path and chunk list irrecoverably.`
                );
            }
            const meta = {
                path: plainPath,
                mtime: doc.mtime,
                ctime: doc.ctime,
                size: doc.size,
                children: "children" in doc ? doc.children : undefined,
            };
            const sealed = await encryptPayload(JSON.stringify(meta), ctx.crypto);
            doc.path = ENCRYPTED_META_PREFIX + sealed;
            doc.mtime = 0;
            doc.ctime = 0;
            doc.size = 0;
            if ("children" in doc) doc.children = [];
        } else if (!isPathProbablyObfuscated(plainPath)) {
            doc.path = await obfuscatePathV1(plainPath, ctx.crypto);
        }
    }

    // Compression goes on last, so it sits outermost on the wire.
    if (ctx.enableCompression && typeof doc.data === "string") {
        doc.data = await compressData(doc.data);
    }

    return doc as unknown as T;
}

/**
 * Whether a payload still carries a ciphertext marker.
 *
 * Called on the way in to assembly, not merely on the way out of decoding - a
 * caller that forgets to decode is the realistic mistake, and it produces
 * content that looks like a note rather than an error.
 */
export function assertDecoded(id: string, data: string): void {
    if (data.startsWith(ENCRYPT_HKDF_PREFIX) || data.startsWith(ENCRYPT_V3_PREFIX)) {
        throw new DecryptionError(
            `Chunk "${id}" still looks encrypted (payload begins "${data.slice(0, 2)}"). ` +
                `Decode the document before assembling it; refusing to return ciphertext as content.`
        );
    }
    if (data.startsWith(MARK_SHIFT_COMPRESSED)) {
        throw new DecryptionError(
            `Chunk "${id}" is still compressed. Decode the document before assembling it.`
        );
    }
}

/**
 * Whether a file document still holds its metadata in encrypted form.
 *
 * This is the check that separates "an empty note" from "you forgot to
 * decrypt": both present as `children: []` with a zero `size`, and nothing else
 * distinguishes them.
 */
export function assertMetadataDecoded(id: string, path: string | undefined): void {
    if (path && isEncryptedMeta(path)) {
        throw new DecryptionError(
            `Document "${id}" still holds encrypted metadata. Its path and chunk list are not ` +
                `available; decode it before assembling. (Assembling now would yield an empty note.)`
        );
    }
}
