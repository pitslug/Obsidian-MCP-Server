/**
 * Our chunker against the plugin's.
 *
 * This is the strongest test in the suite. Round-trip tests prove we can read
 * back what we wrote; only this proves we agree with the program that everyone
 * else's device is running. If these pass across a wide input space, the write
 * path deduplicates against existing chunks exactly as another device would.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { splitRabinKarp, computeSizing } from "../../src/vault-model/chunking/rabin-karp.js";
import { encodeUtf8 } from "../../src/vault-model/chunking/encoding.js";
import { BOUNDARY_SIZES, awkwardText, binaryContent, filler, fillerBytes } from "../helpers/content.js";
import { binaryBlob, textBlob, upstreamSplitRabinKarp } from "../helpers/upstream.js";

const SELF_HOSTED_MAX_PIECE = 102400 * 61; // customChunkSize: 60
const MIN_CHUNK = 20;

async function compareText(text: string, doPlainSplit = true, absoluteMax = SELF_HOSTED_MAX_PIECE) {
    const mine = splitRabinKarp(
        { bytes: encodeUtf8(text), isTextBlob: true, doPlainSplit },
        { absoluteMaxPieceSize: absoluteMax, minimumChunkSize: MIN_CHUNK }
    );
    const theirs = await upstreamSplitRabinKarp(textBlob(text), absoluteMax, doPlainSplit, MIN_CHUNK);
    return { mine, theirs };
}

async function compareBinary(bytes: Uint8Array, path = "file.bin") {
    const doPlainSplit = path.endsWith(".md");
    const mine = splitRabinKarp(
        { bytes, isTextBlob: false, doPlainSplit },
        { absoluteMaxPieceSize: SELF_HOSTED_MAX_PIECE, minimumChunkSize: MIN_CHUNK }
    );
    const theirs = await upstreamSplitRabinKarp(
        binaryBlob(bytes),
        SELF_HOSTED_MAX_PIECE,
        doPlainSplit,
        MIN_CHUNK
    );
    return { mine, theirs };
}

describe("Rabin-Karp splitter vs the plugin", () => {
    it("agrees on generated text", async () => {
        await fc.assert(
            fc.asyncProperty(awkwardText(), async (text) => {
                const { mine, theirs } = await compareText(text);
                expect(mine).toEqual(theirs);
            }),
            { numRuns: 250 }
        );
    });

    it("agrees on long text spanning many chunks", async () => {
        for (const size of [5_000, 20_000, 120_000, 400_000]) {
            const { mine, theirs } = await compareText(filler(size));
            expect(mine).toEqual(theirs);
            expect(mine.length).toBeGreaterThan(1);
        }
    });

    it("agrees at and around every derived size boundary", async () => {
        for (const size of BOUNDARY_SIZES) {
            const { mine, theirs } = await compareText(filler(size));
            expect(mine, `text of length ${size}`).toEqual(theirs);
        }
    });

    it("agrees on binary content", async () => {
        await fc.assert(
            fc.asyncProperty(binaryContent(), async (bytes) => {
                const { mine, theirs } = await compareBinary(bytes);
                expect(mine).toEqual(theirs);
            }),
            { numRuns: 150 }
        );
    });

    it("agrees on larger binary content", async () => {
        for (const size of [1_000, 50_000, 300_000]) {
            const { mine, theirs } = await compareBinary(fillerBytes(size));
            expect(mine, `bytes of length ${size}`).toEqual(theirs);
        }
    });

    it("agrees when doPlainSplit is false but the blob is text", async () => {
        // A .png whose content arrived as a string still takes the text path.
        const { mine, theirs } = await compareText(filler(9_000), false);
        expect(mine).toEqual(theirs);
    });

    it("agrees on multi-byte sequences that land on boundaries", async () => {
        // Repeated 3- and 4-byte characters maximise the chance that a boundary
        // candidate falls mid-sequence and has to be skipped.
        for (const unit of ["日", "👨‍👩‍👧‍👦", "é", "\u{10FFFF}"]) {
            for (const count of [50, 500, 2_000]) {
                const text = unit.repeat(count);
                const { mine, theirs } = await compareText(text);
                expect(mine, `${unit} × ${count}`).toEqual(theirs);
            }
        }
    });

    it("agrees on text with a leading byte order mark", async () => {
        const { mine, theirs } = await compareText("﻿" + filler(3_000));
        expect(mine).toEqual(theirs);
        expect(mine[0]?.startsWith("﻿")).toBe(true);
    });

    it("agrees on mixed line endings", async () => {
        const lines = Array.from({ length: 400 }, (_, i) =>
            i % 3 === 0 ? `line ${i}\r\n` : i % 3 === 1 ? `line ${i}\n` : `line ${i}\r`
        ).join("");
        const { mine, theirs } = await compareText(lines);
        expect(mine).toEqual(theirs);
    });

    it("agrees on the empty input", async () => {
        const { mine, theirs } = await compareText("");
        expect(mine).toEqual(theirs);
        expect(mine).toEqual([]);
    });

    it("agrees when the absolute max piece size is at the floor", async () => {
        const { mine, theirs } = await compareText(filler(80_000), true, 1);
        expect(mine).toEqual(theirs);
    });
});

describe("derived sizing", () => {
    it("switches text above 4 MiB to binary parameters", () => {
        const big = computeSizing(
            { bytes: new Uint8Array(4 * 1024 * 1024), isTextBlob: true, doPlainSplit: true },
            { absoluteMaxPieceSize: SELF_HOSTED_MAX_PIECE, minimumChunkSize: MIN_CHUNK }
        );
        expect(big.plainSplit).toBe(false);
        expect(big.avgChunkSize).toBe(256 * 1024 * 4);
    });

    it("grows the plain chunk unit to keep chunk count bounded", () => {
        const small = computeSizing(
            { bytes: new Uint8Array(1_000), isTextBlob: true, doPlainSplit: true },
            { absoluteMaxPieceSize: SELF_HOSTED_MAX_PIECE, minimumChunkSize: MIN_CHUNK }
        );
        const large = computeSizing(
            { bytes: new Uint8Array(1_000_000), isTextBlob: true, doPlainSplit: true },
            { absoluteMaxPieceSize: SELF_HOSTED_MAX_PIECE, minimumChunkSize: MIN_CHUNK }
        );
        expect(small.avgChunkSize).toBe(256);
        expect(large.avgChunkSize).toBeGreaterThan(small.avgChunkSize);
    });

    it("never lets min exceed max, or avg fall outside them", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 500_000 }),
                fc.integer({ min: 0, max: 1_000_000 }),
                fc.integer({ min: 1, max: 10_000_000 }),
                fc.boolean(),
                (size, minimumChunkSize, absoluteMaxPieceSize, isTextBlob) => {
                    const sizing = computeSizing(
                        { bytes: new Uint8Array(size), isTextBlob, doPlainSplit: isTextBlob },
                        { absoluteMaxPieceSize, minimumChunkSize }
                    );
                    expect(sizing.minChunkSize).toBeLessThanOrEqual(sizing.maxChunkSize);
                    expect(sizing.avgChunkSize).toBeGreaterThanOrEqual(sizing.minChunkSize);
                    expect(sizing.avgChunkSize).toBeLessThanOrEqual(sizing.maxChunkSize);
                    expect(sizing.avgChunkSize).toBeGreaterThan(0);
                }
            ),
            { numRuns: 300 }
        );
    });
});
