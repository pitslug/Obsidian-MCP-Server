/**
 * Chunk identity against the primitives the plugin actually runs.
 *
 * The plugin hashes through a vendored, patched copy of `xxhash-wasm@1.0.2`
 * that ships inside `octagonal-wheels`. We depend on the unpatched package
 * directly, so the first thing worth proving is that the two agree — if they
 * ever diverge, every chunk ID we compute is wrong and deduplication silently
 * stops working.
 *
 * The salt derivation is then checked against the constants as published, and
 * the ID format against the shape the plugin's read path expects.
 */

import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import xxhash, { type XXHashAPI } from "xxhash-wasm";
import { xxhashNew } from "octagonal-wheels/hash/xxhash.js";
import { fallbackMixedHashEach, mixedHash } from "octagonal-wheels/hash/purejs.js";
import { ChunkHasher, derivePassphraseSalts } from "../../src/vault-model/hash.js";
import { SALT_OF_ID, SEED_MURMURHASH } from "../../src/vault-model/constants.js";
import { HashAlgorithms } from "../../src/vault-model/settings.js";
import { upstreamSaltOfId, upstreamSeedMurmurhash } from "../helpers/upstream.js";

const PASSPHRASE = "correct horse battery staple";

let plain: XXHashAPI;
let patched: Awaited<ReturnType<typeof xxhashNew>>;

beforeAll(async () => {
    plain = await xxhash();
    patched = await xxhashNew();
});

describe("xxhash-wasm vs the copy vendored in octagonal-wheels", () => {
    it("agrees on h64 for arbitrary strings", () => {
        fc.assert(
            fc.property(fc.fullUnicodeString({ maxLength: 500 }), (input) => {
                expect(plain.h64(input)).toBe(patched.h64(input));
            }),
            { numRuns: 300 }
        );
    });

    it("agrees on h32 and h32Raw", () => {
        fc.assert(
            fc.property(fc.fullUnicodeString({ maxLength: 500 }), (input) => {
                expect(plain.h32(input)).toBe(patched.h32(input));
                const bytes = new TextEncoder().encode(input);
                expect(plain.h32Raw(bytes)).toBe(patched.h32Raw(bytes));
            }),
            { numRuns: 300 }
        );
    });
});

describe("salt constants", () => {
    it("matches the value shipped by the plugin, control character and all", () => {
        expect(SALT_OF_ID).toBe(upstreamSaltOfId);
        expect(SALT_OF_ID.charCodeAt(8)).toBe(3);
        expect(SEED_MURMURHASH).toBe(upstreamSeedMurmurhash);
    });

    it("derives the salts the way the plugin does", () => {
        const usingLetters = ~~((PASSPHRASE.length / 4) * 3);
        const forHash = SALT_OF_ID + PASSPHRASE.substring(0, usingLetters);
        const derived = derivePassphraseSalts(PASSPHRASE);
        expect(derived.hashedPassphrase).toBe(fallbackMixedHashEach(forHash));
        expect(derived.hashedPassphrase32).toBe(mixedHash(forHash, SEED_MURMURHASH)[0]);
    });

    it("uses only the first three quarters of the passphrase", () => {
        // Upstream truncates, so these two passphrases salt identically.
        // Surprising, but reproducing it is the point.
        const a = derivePassphraseSalts("abcdefgh");
        const b = derivePassphraseSalts("abcdefXY");
        expect(a.hashedPassphrase).toBe(b.hashedPassphrase);
    });
});

describe("chunk IDs", () => {
    it("are pure content hashes — no path, position or revision input", async () => {
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: false,
            passphrase: "",
        });
        await fc.assert(
            fc.asyncProperty(fc.string({ maxLength: 300 }), async (piece) => {
                const first = await hasher.computeChunkId(piece);
                const second = await hasher.computeChunkId(piece);
                expect(first).toBe(second);
            }),
            { numRuns: 200 }
        );
    });

    it("follow the documented formula for the default algorithm", async () => {
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: false,
            passphrase: "",
        });
        await fc.assert(
            fc.asyncProperty(fc.fullUnicodeString({ maxLength: 300 }), async (piece) => {
                const expected = "h:" + plain.h64(`${piece}-${piece.length}`).toString(36);
                expect(await hasher.computeChunkId(piece)).toBe(expected);
            }),
            { numRuns: 200 }
        );
    });

    it("carry the '+' marker and the passphrase salt when E2EE is on", async () => {
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: true,
            passphrase: PASSPHRASE,
        });
        const { hashedPassphrase } = derivePassphraseSalts(PASSPHRASE);
        const piece = "some chunk content";
        const expected = "h:+" + plain.h64(`${piece}-${hashedPassphrase}-${piece.length}`).toString(36);
        expect(await hasher.computeChunkId(piece)).toBe(expected);
    });

    it("sort inside the range the plugin uses to exclude them", async () => {
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: false,
            passphrase: "",
        });
        await fc.assert(
            fc.asyncProperty(fc.string({ maxLength: 200 }), async (piece) => {
                const id = await hasher.computeChunkId(piece);
                expect(id >= "h:").toBe(true);
                expect(id < "h:\u{10ffff}").toBe(true);
            }),
            { numRuns: 200 }
        );
    });

    it("use the UTF-16 length, not the byte length", async () => {
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.XXHASH64,
            encrypt: false,
            passphrase: "",
        });
        const emoji = "😀"; // one code point, two UTF-16 units, four UTF-8 bytes
        expect(emoji.length).toBe(2);
        const expected = "h:" + plain.h64(`${emoji}-2`).toString(36);
        expect(await hasher.computeChunkId(emoji)).toBe(expected);
    });

    it("produce distinct IDs for every supported algorithm", async () => {
        const piece = "the same content everywhere";
        const ids = new Set<string>();
        for (const hashAlg of Object.values(HashAlgorithms)) {
            const hasher = await ChunkHasher.create({ hashAlg, encrypt: false, passphrase: "" });
            ids.add(await hasher.computeChunkId(piece));
        }
        expect(ids.size).toBe(Object.values(HashAlgorithms).length);
    });

    it("can produce a negative legacy hash, which is expected", async () => {
        // The legacy algorithm XORs into a signed int32, so IDs may begin "h:-".
        const hasher = await ChunkHasher.create({
            hashAlg: HashAlgorithms.LEGACY,
            encrypt: false,
            passphrase: "",
        });
        const ids = await Promise.all(
            Array.from({ length: 200 }, (_, i) => hasher.computeChunkId(`content ${i}`))
        );
        expect(ids.some((id) => id.startsWith("h:-"))).toBe(true);
    });
});
