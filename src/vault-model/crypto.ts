/**
 * The E2EE boundary.
 *
 * Everything here delegates the actual cryptography to `octagonal-wheels`, the
 * same package the plugin uses. Reimplementing AES-GCM key derivation to
 * match a specific 16-byte-IV legacy quirk would be a way to lose a vault for
 * no benefit; what this file owns is the *layering* - which fields of which
 * documents are encrypted, and in what order relative to compression.
 *
 * Four wire formats exist. Only the first is produced by current clients; the
 * rest must still be readable.
 *
 *   `%=…`  AES-256-GCM, HKDF per message, PBKDF2(310000) master. Current.
 *   `%…`   Legacy AES-256-GCM, hex IV(16) + hex salt(16) + base64.
 *   `%~…`  Deprecated V3. Decrypt only.
 *   `[…]`  Oldest format, a JSON array. Decrypt only.
 */

import {
    decrypt as owDecrypt,
    encrypt as owEncryptLegacy,
    obfuscatePath as owObfuscatePath,
} from "octagonal-wheels/encryption/encryption.js";
import { decrypt as owDecryptHKDF, encrypt as owEncryptHKDF } from "octagonal-wheels/encryption/hkdf.js";
import {
    ENCRYPT_HKDF_PREFIX,
    ENCRYPT_V1_PREFIX,
    ENCRYPT_LEGACY_PREFIX,
    ENCRYPT_V3_PREFIX,
} from "./constants.js";
import { E2EEAlgorithms, type E2EEAlgorithm } from "./settings.js";

export class DecryptionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "DecryptionError";
    }
}

export interface CryptoContext {
    passphrase: string;
    /** The vault-wide PBKDF2 salt, from `_local/obsidian_livesync_sync_parameters`. */
    pbkdf2Salt: Uint8Array<ArrayBuffer>;
    useDynamicIterationCount: boolean;
    algorithm: E2EEAlgorithm;
}

/**
 * True if a string is in one of the known ciphertext formats.
 *
 * Deliberately stricter than "starts with `%` or `[`": an ordinary Markdown
 * chunk beginning `[[wikilink]]`, or a line starting with a percent sign, is
 * not ciphertext, and a loose test here would misroute real content.
 */
export function looksEncrypted(data: string): boolean {
    if (data.startsWith(ENCRYPT_HKDF_PREFIX)) return true;
    if (data.startsWith(ENCRYPT_V3_PREFIX)) return true;
    // Legacy: "%" + 32 hex IV + 32 hex salt + base64.
    if (data.startsWith(ENCRYPT_LEGACY_PREFIX) && /^%[0-9a-f]{64}./.test(data)) return true;
    // Oldest: a JSON array of exactly three quoted strings.
    if (data.startsWith(ENCRYPT_V1_PREFIX) && /^\["[^"]*","[0-9a-f]+","[0-9a-f]+"\]$/.test(data)) {
        return true;
    }
    return false;
}

/**
 * Build the crypto context implied by a vault's settings.
 *
 * This exists so that the chunk-ID shape and the encryption of chunk payloads
 * cannot be configured independently. They are two halves of one decision: a
 * chunk whose ID lacks the `+` marker is never encrypted by the transform, so
 * composing with `encrypt: false` while encoding with a passphrase writes
 * plaintext chunks into an encrypted vault, with no error at any point.
 */
export function cryptoContextFor(
    settings: {
        encrypt: boolean;
        passphrase: string;
        usePathObfuscation: boolean;
        useDynamicIterationCount: boolean;
        e2eeAlgorithm: E2EEAlgorithm;
    },
    pbkdf2Salt: Uint8Array<ArrayBuffer> | undefined
): CryptoContext | undefined {
    if (!settings.encrypt && !settings.usePathObfuscation) return undefined;
    if (!settings.passphrase) {
        throw new DecryptionError(
            "This vault uses encryption or path obfuscation, but no passphrase is configured."
        );
    }
    if (settings.e2eeAlgorithm === E2EEAlgorithms.V2 && !pbkdf2Salt) {
        throw new DecryptionError(
            "E2EE v2 requires the vault's PBKDF2 salt, which lives in " +
                "_local/obsidian_livesync_sync_parameters. Fetch it before decrypting."
        );
    }
    return {
        passphrase: settings.passphrase,
        pbkdf2Salt: pbkdf2Salt ?? new Uint8Array(0),
        useDynamicIterationCount: settings.useDynamicIterationCount,
        algorithm: settings.e2eeAlgorithm,
    };
}

/**
 * Decrypt a payload, choosing the scheme by prefix.
 *
 * `%=` must be tested before `%`, since the former is a prefix of the latter.
 * Under `forceV1` the HKDF path is skipped entirely, matching the plugin.
 */
export async function decryptPayload(data: string, ctx: CryptoContext): Promise<string> {
    try {
        if (data.startsWith(ENCRYPT_HKDF_PREFIX)) {
            if (ctx.algorithm === E2EEAlgorithms.ForceV1) {
                throw new DecryptionError(
                    "Payload is HKDF-encrypted but the vault is configured to force legacy E2EE."
                );
            }
            return await owDecryptHKDF(data, ctx.passphrase, ctx.pbkdf2Salt);
        }
        return await decryptLegacyWithFallback(data, ctx);
    } catch (error) {
        if (error instanceof DecryptionError) throw error;
        throw new DecryptionError(
            "Failed to decrypt payload. The passphrase is wrong, or the data was written by an " +
                "unrecognised plugin version.",
            { cause: error }
        );
    }
}

/**
 * The legacy formats tolerate `useDynamicIterationCount` being set wrongly, by
 * retrying with it off. Upstream does the same, and a vault whose setting drifted
 * would otherwise be unreadable.
 */
async function decryptLegacyWithFallback(data: string, ctx: CryptoContext): Promise<string> {
    try {
        return await owDecrypt(data, ctx.passphrase, ctx.useDynamicIterationCount);
    } catch (first) {
        if (!ctx.useDynamicIterationCount) throw first;
        return await owDecrypt(data, ctx.passphrase, false);
    }
}

/** Encrypt a payload in whichever format this vault's algorithm setting selects. */
export async function encryptPayload(data: string, ctx: CryptoContext): Promise<string> {
    if (ctx.algorithm === E2EEAlgorithms.V2) {
        return await owEncryptHKDF(data, ctx.passphrase, ctx.pbkdf2Salt);
    }
    return await owEncryptLegacy(data, ctx.passphrase, ctx.useDynamicIterationCount);
}

/**
 * Obfuscate a path for the legacy (`V1`) scheme.
 *
 * Deterministic despite being AES-GCM: the salt and IV are derived from
 * `SHA-256(path || passphrase)`. Under E2EE v2 this is not used - the whole
 * metadata object is encrypted into `path` instead.
 */
export async function obfuscatePathV1(path: string, ctx: CryptoContext): Promise<string> {
    return await owObfuscatePath(path, ctx.passphrase, ctx.useDynamicIterationCount);
}

/** Upstream's heuristic for "this `path` field holds a V1-obfuscated path". */
export function isPathProbablyObfuscated(path: string): boolean {
    return path.startsWith(ENCRYPT_LEGACY_PREFIX) && path.length > 64;
}

/** Decode the base64 `pbkdf2salt` from the sync-parameters document. */
export function decodePbkdf2Salt(base64Salt: string): Uint8Array<ArrayBuffer> {
    const salt = new Uint8Array(Buffer.from(base64Salt, "base64"));
    if (salt.length === 0) {
        throw new DecryptionError(
            "The vault's sync-parameters document has an empty PBKDF2 salt. " +
                "It has probably never been written to by an E2EE-enabled client."
        );
    }
    return salt;
}
