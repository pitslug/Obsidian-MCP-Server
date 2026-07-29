/**
 * The encryption and compression boundary.
 *
 * The cryptography itself belongs to `octagonal-wheels` and is not retested
 * here. What is tested is the layering: which documents are transformed, which
 * fields move, and that decode ∘ encode is the identity - including the parts
 * that E2EE v2 deliberately zeroes on the wire.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf.js";
import {
    assertDecoded,
    decodeDocument,
    encodeDocument,
    isUntransformable,
} from "../../src/vault-model/transform.js";
import { DecryptionError, decodePbkdf2Salt, type CryptoContext } from "../../src/vault-model/crypto.js";
import { E2EEAlgorithms } from "../../src/vault-model/settings.js";
import {
    DOCID_MILESTONE,
    ENCRYPTED_META_PREFIX,
    ENCRYPT_HKDF_PREFIX,
    MARK_SHIFT_COMPRESSED,
    TYPE_CHUNK,
    TYPE_NOTE_PLAIN,
} from "../../src/vault-model/constants.js";
import {
    asDocumentID,
    asVaultPath,
    type ChunkEntry,
    type ChunkedEntry,
} from "../../src/vault-model/types.js";

const PASSPHRASE = "correct horse battery staple";
let salt: Uint8Array<ArrayBuffer>;
let v2: CryptoContext;
let v1: CryptoContext;

beforeAll(() => {
    salt = new Uint8Array(createPBKDF2Salt()) as Uint8Array<ArrayBuffer>;
    v2 = {
        passphrase: PASSPHRASE,
        pbkdf2Salt: salt,
        useDynamicIterationCount: false,
        algorithm: E2EEAlgorithms.V2,
    };
    v1 = { ...v2, algorithm: E2EEAlgorithms.V1 };
});

const encryptedChunk = (data: string): ChunkEntry => ({
    _id: asDocumentID("h:+abc123"),
    type: TYPE_CHUNK,
    data,
});

const obfuscatedEntry = (over: Partial<ChunkedEntry> = {}): ChunkedEntry => ({
    _id: asDocumentID("f:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    path: asVaultPath("Folder/Secret Note.md"),
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_001_000,
    size: 42,
    type: TYPE_NOTE_PLAIN,
    children: ["h:+one", "h:+two"],
    eden: {},
    ...over,
});

describe("what gets transformed", () => {
    it("never transforms _local documents - that is how the salt stays readable", () => {
        expect(isUntransformable({ _id: DOCID_MILESTONE })).toBe(true);
        expect(isUntransformable({ _id: "_local/anything" })).toBe(true);
    });

    it("never transforms a bare tombstone", () => {
        expect(isUntransformable({ _id: "note.md", _rev: "2-x", _deleted: true })).toBe(true);
    });

    it("does transform a deletion that still carries fields", () => {
        expect(isUntransformable({ _id: "note.md", _deleted: true, path: "note.md" })).toBe(false);
    });

    it("leaves an ordinary unencrypted document alone", async () => {
        const doc = { _id: asDocumentID("note.md"), type: TYPE_NOTE_PLAIN, data: "hello" };
        const ctx = { crypto: undefined, enableCompression: false, encryptChunks: false };
        expect(await decodeDocument(doc, ctx)).toEqual(doc);
        expect(await encodeDocument(doc, ctx)).toEqual(doc);
    });
});

describe("chunk payloads", () => {
    it("round-trips an encrypted chunk under E2EE v2", async () => {
        const ctx = { crypto: v2, enableCompression: false, encryptChunks: true };
        const plain = encryptedChunk("the chunk content");
        const wire = await encodeDocument(plain, ctx);

        expect(wire.e_).toBe(true);
        expect(wire.data).not.toBe("the chunk content");
        expect(wire.data.startsWith(ENCRYPT_HKDF_PREFIX)).toBe(true);

        const back = await decodeDocument(wire, ctx);
        expect(back.data).toBe("the chunk content");
        expect(back.e_).toBeUndefined();
    });

    it("round-trips under legacy E2EE", async () => {
        const ctx = { crypto: v1, enableCompression: false, encryptChunks: true };
        const wire = await encodeDocument(encryptedChunk("legacy content"), ctx);
        expect(wire.data.startsWith("%")).toBe(true);
        expect(wire.data.startsWith(ENCRYPT_HKDF_PREFIX)).toBe(false);
        expect((await decodeDocument(wire, ctx)).data).toBe("legacy content");
    });

    it("reads a legacy chunk even when configured for v2", async () => {
        const written = await encodeDocument(encryptedChunk("old content"), {
            crypto: v1,
            enableCompression: false,
            encryptChunks: true,
        });
        const read = await decodeDocument(written, {
            crypto: v2,
            enableCompression: false,
            encryptChunks: true,
        });
        expect(read.data).toBe("old content");
    });

    it("does not encrypt a chunk whose ID lacks the '+' marker", async () => {
        const plain: ChunkEntry = { _id: asDocumentID("h:abc"), type: TYPE_CHUNK, data: "clear" };
        const wire = await encodeDocument(plain, {
            crypto: v2,
            enableCompression: false,
            encryptChunks: true,
        });
        expect(wire.data).toBe("clear");
        expect(wire.e_).toBeUndefined();
    });

    it("round-trips with compression on top of encryption", async () => {
        const ctx = { crypto: v2, enableCompression: true, encryptChunks: true };
        const content = "compressible content ".repeat(500);
        const wire = await encodeDocument(encryptedChunk(content), ctx);
        expect(await (await decodeDocument(wire, ctx)).data).toBe(content);
    });

    it("fails loudly when the passphrase is wrong", async () => {
        const wire = await encodeDocument(encryptedChunk("secret"), {
            crypto: v2,
            enableCompression: false,
            encryptChunks: true,
        });
        const wrong: CryptoContext = { ...v2, passphrase: "not the passphrase" };
        await expect(
            decodeDocument(wire, { crypto: wrong, enableCompression: false, encryptChunks: true })
        ).rejects.toThrow(DecryptionError);
    });

    it("fails loudly when no passphrase is configured at all", async () => {
        const wire = await encodeDocument(encryptedChunk("secret"), {
            crypto: v2,
            enableCompression: false,
            encryptChunks: true,
        });
        await expect(
            decodeDocument(wire, { crypto: undefined, enableCompression: false, encryptChunks: false })
        ).rejects.toThrow(DecryptionError);
    });
});

describe("refusing content that was never decoded", () => {
    it("catches an encrypted chunk that reached assembly undecoded", async () => {
        const wire = await encodeDocument(encryptedChunk("secret"), {
            crypto: v2,
            enableCompression: false,
            encryptChunks: true,
        });
        expect(() => assertDecoded(String(wire._id), wire.data)).toThrow(DecryptionError);
    });

    it("catches a chunk that is still compressed", () => {
        expect(() => assertDecoded("h:+abc", MARK_SHIFT_COMPRESSED + "payload")).toThrow(DecryptionError);
        // Compression is orthogonal to encryption, so this one is not gated on
        // the ID: the marker is three control characters, which no note begins
        // with, unlike "%=".
        expect(() => assertDecoded("h:abc", MARK_SHIFT_COMPRESSED + "payload")).toThrow(DecryptionError);
    });

    it("lets a plain chunk through even when its content begins with the marker", () => {
        // The whole point: in a vault with encryption off, "%=" is content.
        // Encryption appends "+" to the hash, so a chunk whose ID is not "h:+"
        // cannot be ciphertext however its payload happens to start.
        expect(() => assertDecoded("h:5be1iqy1t4ip", ENCRYPT_HKDF_PREFIX)).not.toThrow();
        expect(() => assertDecoded("h:abc", "%= printf style\n")).not.toThrow();
        expect(() => assertDecoded("h:abc", "%~ deprecated marker")).not.toThrow();
    });
});

describe("obfuscated metadata", () => {
    it("hides path, times, size and the chunk list under E2EE v2", async () => {
        const ctx = { crypto: v2, enableCompression: false, encryptChunks: true };
        const wire = await encodeDocument(obfuscatedEntry(), ctx);

        expect(wire.path.startsWith(ENCRYPTED_META_PREFIX)).toBe(true);
        expect(wire.mtime).toBe(0);
        expect(wire.ctime).toBe(0);
        expect(wire.size).toBe(0);
        expect(wire.children).toEqual([]);
        // The type stays in the clear, as upstream leaves it.
        expect(wire.type).toBe(TYPE_NOTE_PLAIN);
    });

    it("restores every hidden field on decode", async () => {
        const ctx = { crypto: v2, enableCompression: false, encryptChunks: true };
        const original = obfuscatedEntry();
        const back = await decodeDocument(await encodeDocument(original, ctx), ctx);

        expect(back.path).toBe(original.path);
        expect(back.mtime).toBe(original.mtime);
        expect(back.ctime).toBe(original.ctime);
        expect(back.size).toBe(original.size);
        expect(back.children).toEqual(original.children);
    });

    it("protects only the path under legacy E2EE", async () => {
        const ctx = { crypto: v1, enableCompression: false, encryptChunks: true };
        const original = obfuscatedEntry();
        const wire = await encodeDocument(original, ctx);

        expect(wire.path).not.toBe(original.path);
        // Legacy leaves everything else readable, which is the point of v2.
        expect(wire.mtime).toBe(original.mtime);
        expect(wire.children).toEqual(original.children);

        expect((await decodeDocument(wire, ctx)).path).toBe(original.path);
    });

    it("obfuscates a path deterministically under legacy E2EE", async () => {
        const ctx = { crypto: v1, enableCompression: false, encryptChunks: true };
        const a = await encodeDocument(obfuscatedEntry(), ctx);
        const b = await encodeDocument(obfuscatedEntry(), ctx);
        expect(a.path).toBe(b.path);
    });

    it("refuses to write an obfuscated document with no known path", async () => {
        const ctx = { crypto: v2, enableCompression: false, encryptChunks: true };
        const orphan = { ...obfuscatedEntry(), path: asVaultPath("") };
        await expect(encodeDocument(orphan, ctx)).rejects.toThrow(DecryptionError);
    });

    it("leaves an f:-prefixed path it does not recognise rather than guessing", async () => {
        const odd = { ...obfuscatedEntry(), path: asVaultPath("something-unexpected") };
        const back = await decodeDocument(odd, { crypto: v2, enableCompression: false, encryptChunks: true });
        expect(back.path).toBe("something-unexpected");
    });
});

describe("the PBKDF2 salt", () => {
    it("decodes from the base64 the sync-parameters document holds", () => {
        const encoded = Buffer.from(salt).toString("base64");
        expect(decodePbkdf2Salt(encoded)).toEqual(salt);
    });

    it("fails loudly when the vault has never had one written", () => {
        expect(() => decodePbkdf2Salt("")).toThrow(DecryptionError);
    });
});
