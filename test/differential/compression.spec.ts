/**
 * Our compression layer against the plugin's.
 *
 * Both directions matter and they are not symmetric: we must be able to read
 * what the plugin wrote, and the plugin must be able to read what we write.
 * Deflate output is not guaranteed to be byte-identical across implementations,
 * so these assert on decoded content rather than on the encoded bytes — except
 * where the marker itself is the contract.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compressData, decompressData, isCompressed } from "../../src/vault-model/compression.js";
import { MARK_SHIFT_COMPRESSED } from "../../src/vault-model/constants.js";
import {
    upstreamCompressText,
    upstreamDecompressText,
    upstreamMarkShiftCompressed,
} from "../helpers/upstream.js";

/** Content that actually compresses, so the "only if shorter" rule does not skip it. */
const compressible = (): fc.Arbitrary<string> =>
    fc.oneof(
        fc.constantFrom(
            "a".repeat(5000),
            "# Heading\n\nSome text.\n".repeat(200),
            JSON.stringify({ key: "value".repeat(200) }),
            "日本語".repeat(1000)
        ),
        fc
            .tuple(fc.string({ minLength: 1, maxLength: 40 }), fc.integer({ min: 50, max: 400 }))
            .map(([seed, times]) => (seed || "x").repeat(times))
    );

describe("compression markers", () => {
    it("uses the same marker as the plugin", () => {
        expect(MARK_SHIFT_COMPRESSED).toBe(upstreamMarkShiftCompressed);
        expect(MARK_SHIFT_COMPRESSED).toBe("LZ");
    });
});

describe("we can read what the plugin writes", () => {
    it("decompresses the plugin's output", async () => {
        await fc.assert(
            fc.asyncProperty(compressible(), async (text) => {
                const theirs = MARK_SHIFT_COMPRESSED + (await upstreamCompressText(text));
                expect(await decompressData(theirs)).toBe(text);
            }),
            { numRuns: 40 }
        );
    });

    it("decompresses base64 payloads, which take the '~' path", async () => {
        const base64 = Buffer.from(new Uint8Array(4000).fill(7)).toString("base64");
        const theirs = MARK_SHIFT_COMPRESSED + (await upstreamCompressText(base64));
        expect(await decompressData(theirs)).toBe(base64);
    });
});

describe("the plugin can read what we write", () => {
    it("round-trips through the plugin's decompressor", async () => {
        await fc.assert(
            fc.asyncProperty(compressible(), async (text) => {
                const ours = await compressData(text);
                if (!isCompressed(ours)) {
                    // Compression did not help; the field is stored verbatim.
                    expect(ours).toBe(text);
                    return;
                }
                const body = ours.slice(MARK_SHIFT_COMPRESSED.length);
                expect(await upstreamDecompressText(body)).toBe(text);
            }),
            { numRuns: 40 }
        );
    });

    it("agrees on whether a payload is base64", async () => {
        // The '~' marker must match, or the payload decodes to the wrong form.
        const inputs = [
            Buffer.from("hello world hello world").toString("base64").repeat(50),
            "not base64 at all!! ".repeat(100),
            "AAAA".repeat(500),
        ];
        for (const input of inputs) {
            const ours = await compressData(input);
            const theirs = MARK_SHIFT_COMPRESSED + (await upstreamCompressText(input));
            if (isCompressed(ours)) {
                const ourMarked = ours[MARK_SHIFT_COMPRESSED.length] === "~";
                const theirMarked = theirs[MARK_SHIFT_COMPRESSED.length] === "~";
                expect(ourMarked, `base64 detection for ${input.slice(0, 20)}…`).toBe(theirMarked);
            }
        }
    });
});

describe("round trip", () => {
    it("is the identity function", async () => {
        await fc.assert(
            fc.asyncProperty(fc.fullUnicodeString({ maxLength: 2000 }), async (text) => {
                expect(await decompressData(await compressData(text))).toBe(text);
            }),
            { numRuns: 60 }
        );
    });

    it("leaves incompressible content alone rather than growing it", async () => {
        const short = "hi";
        expect(await compressData(short)).toBe(short);
    });

    it("passes unmarked data through untouched", async () => {
        expect(await decompressData("plain text")).toBe("plain text");
    });

    it("is idempotent — compressing twice does not double-wrap", async () => {
        const once = await compressData("x".repeat(5000));
        expect(await compressData(once)).toBe(once);
    });

    it("handles the empty string", async () => {
        expect(await compressData("")).toBe("");
        expect(await decompressData("")).toBe("");
    });

    it("fails loudly on a corrupt payload", async () => {
        await expect(decompressData(MARK_SHIFT_COMPRESSED + "!!!!not-base64!!!!")).rejects.toThrow(
            /decompress/i
        );
    });
});
