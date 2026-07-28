/**
 * Chunk identity.
 *
 * A chunk's document ID is a pure content hash. There is no per-document,
 * per-revision, per-path or per-position salt — only, when E2EE is on, a
 * single vault-wide value derived from the passphrase. Identical chunk text
 * anywhere in the vault yields an identical ID, which is the whole
 * deduplication mechanism.
 *
 * This confirms the first assumption in the design document. The write path can
 * therefore reuse existing chunks across notes, and can treat a 409 on a chunk
 * PUT as success — the document already there has, by construction, the same
 * content.
 *
 * The caveat is that nothing upstream verifies this. A 409 is unconditionally
 * read as "already exists"; a genuine hash collision would silently alias two
 * different pieces. We do not add verification here (it would diverge from the
 * plugin), but the write executor should log chunk-ID collisions where the
 * local content differs.
 */

import xxhash, { type XXHashAPI } from "xxhash-wasm";
import { writeString } from "octagonal-wheels/binary/base64.js";
import { fallbackMixedHashEach, mixedHash } from "octagonal-wheels/hash/purejs.js";
import { HASH_ENCRYPTED_MARKER, PREFIX_CHUNK, SALT_OF_ID, SEED_MURMURHASH } from "./constants.js";
import { HashAlgorithms, type HashAlgorithm } from "./settings.js";
import { asDocumentID, type DocumentID } from "./types.js";

let xxhashApi: XXHashAPI | undefined;

/** Load the xxhash WASM module. Idempotent; safe to call concurrently. */
let xxhashPromise: Promise<XXHashAPI> | undefined;
export async function initHashing(): Promise<XXHashAPI> {
    if (xxhashApi) return xxhashApi;
    // A failed load must not be cached, or every later call rejects forever
    // with no way to retry.
    xxhashPromise ??= xxhash()
        .then((api) => {
            xxhashApi = api;
            return api;
        })
        .catch((error: unknown) => {
            xxhashPromise = undefined;
            throw error;
        });
    return xxhashPromise;
}

/**
 * The two passphrase-derived values used to salt chunk hashes.
 *
 * Only the first three quarters of the passphrase characters are used —
 * `~~((length / 4) * 3)`. That is upstream behaviour, not a typo here.
 */
export function derivePassphraseSalts(passphrase: string): {
    hashedPassphrase: string;
    hashedPassphrase32: number;
} {
    const usingLetters = ~~((passphrase.length / 4) * 3);
    const passphraseForHash = SALT_OF_ID + passphrase.substring(0, usingLetters);
    return {
        hashedPassphrase: fallbackMixedHashEach(passphraseForHash),
        hashedPassphrase32: mixedHash(passphraseForHash, SEED_MURMURHASH)[0],
    };
}

export interface ChunkHasherOptions {
    hashAlg: HashAlgorithm;
    encrypt: boolean;
    passphrase: string;
}

/**
 * Computes chunk IDs for one set of vault settings.
 *
 * `piece.length` throughout is the JavaScript UTF-16 length, not the byte
 * length. For binary files the piece is the base64 string, so the hash covers
 * base64 text rather than the underlying bytes.
 */
export class ChunkHasher {
    private readonly hashedPassphrase: string;
    private readonly hashedPassphrase32: number;
    private readonly api: XXHashAPI;

    private constructor(
        private readonly options: ChunkHasherOptions,
        api: XXHashAPI
    ) {
        const salts = derivePassphraseSalts(options.passphrase ?? "");
        this.hashedPassphrase = salts.hashedPassphrase;
        this.hashedPassphrase32 = salts.hashedPassphrase32;
        this.api = api;
    }

    static async create(options: ChunkHasherOptions): Promise<ChunkHasher> {
        return new ChunkHasher(options, await initHashing());
    }

    /** The bare hash, without the `h:` prefix or the `+` encryption marker. */
    async computeHash(piece: string): Promise<string> {
        const { hashAlg } = this.options;
        const encrypted = this.options.encrypt;

        switch (hashAlg) {
            case HashAlgorithms.XXHASH64:
                return encrypted
                    ? this.api.h64(`${piece}-${this.hashedPassphrase}-${piece.length}`).toString(36)
                    : this.api.h64(`${piece}-${piece.length}`).toString(36);

            case HashAlgorithms.XXHASH32:
                return encrypted
                    ? this.api.h32(`${piece}-${this.hashedPassphrase}-${piece.length}`).toString(36)
                    : this.api.h32(`${piece}-${piece.length}`).toString(36);

            case HashAlgorithms.MIXED_PUREJS:
                // Note the missing separators in the encrypted variant. Upstream.
                return encrypted
                    ? fallbackMixedHashEach(`${piece}${this.hashedPassphrase}${piece.length}`)
                    : fallbackMixedHashEach(`${piece}-${piece.length}`);

            case HashAlgorithms.SHA1:
                return encrypted
                    ? await sha1Base64(`${piece}-${this.hashedPassphrase}-${piece.length}`)
                    : await sha1Base64(`${piece}-${piece.length}`);

            case HashAlgorithms.LEGACY: {
                // XXH32 over raw UTF-8 bytes, XORed. The XOR yields a signed
                // int32, so legacy IDs can begin with "-".
                const raw = this.api.h32Raw(writeString(piece));
                return encrypted
                    ? (raw ^ this.hashedPassphrase32 ^ piece.length).toString(36)
                    : (raw ^ piece.length).toString(36);
            }

            default: {
                const exhaustive: never = hashAlg;
                throw new Error(`Unknown hash algorithm: ${String(exhaustive)}`);
            }
        }
    }

    /** The full chunk document ID: `h:<hash>`, or `h:+<hash>` under E2EE. */
    async computeChunkId(piece: string): Promise<DocumentID> {
        const hash = await this.computeHash(piece);
        const marker = this.options.encrypt ? HASH_ENCRYPTED_MARKER : "";
        return asDocumentID(`${PREFIX_CHUNK}${marker}${hash}`);
    }

    async computeChunkIds(pieces: readonly string[]): Promise<DocumentID[]> {
        return Promise.all(pieces.map((piece) => this.computeChunkId(piece)));
    }
}

/** WebCrypto SHA-1, base64-encoded — so these IDs contain `+`, `/` and `=`. */
async function sha1Base64(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", writeString(input));
    return Buffer.from(digest).toString("base64");
}
