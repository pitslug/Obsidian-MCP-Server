/**
 * The V3 content-defined chunker (`chunkSplitterVersion: "v3-rabin-karp"`),
 * which is the default for any vault created by a current plugin version.
 *
 * This is a faithful reimplementation of `splitPiecesRabinKarp`. Several of its
 * properties look like bugs and are load-bearing regardless, because matching
 * the plugin byte for byte is the entire point:
 *
 *  - The rolling hash is never reset at a chunk boundary; it runs continuously
 *    over the whole input.
 *  - The window does not slide until `pos >= start + windowSize`, so for the
 *    first 48 bytes after each boundary the hash covers a growing prefix rather
 *    than a fixed window. Chunking is therefore position-dependent in a way a
 *    textbook Rabin-Karp CDC is not.
 *  - The boundary test is `hash % avg === 1`, not `=== 0`.
 *  - Arithmetic is signed 32-bit (`Math.imul`, `| 0`) and compared unsigned.
 *
 * The UTF-8 continuation-byte guard means a boundary can be skipped, so a chunk
 * may exceed `maxChunkSize` by up to three bytes.
 */

import {
    RK_ABSOLUTE_MAX_PIECE_SIZE_FLOOR,
    RK_BOUNDARY_PATTERN,
    RK_CHUNK_UNIT_BINARY,
    RK_CHUNK_UNIT_PLAIN_BASE,
    RK_CHUNK_UNIT_PLAIN_STEP,
    RK_MAX_CHUNK_COUNT,
    RK_PLAIN_SPLIT_SIZE_LIMIT,
    RK_PRIME,
    RK_WINDOW_SIZE,
} from "../constants.js";
import { decodeChunkText, encodeChunkBase64 } from "./encoding.js";

export interface RabinKarpInput {
    bytes: Uint8Array;
    /**
     * Whether the source blob was `text/plain`. True whenever the content came
     * from a JavaScript string, regardless of file extension — which is why in
     * practice almost everything the plugin writes takes the text path.
     */
    isTextBlob: boolean;
    /** `shouldSplitAsPlainText(path)`: a `.md`, `.txt` or `.canvas` extension. */
    doPlainSplit: boolean;
}

export interface RabinKarpParams {
    absoluteMaxPieceSize: number;
    minimumChunkSize: number;
}

export interface RabinKarpSizing {
    minChunkSize: number;
    avgChunkSize: number;
    maxChunkSize: number;
    plainSplit: boolean;
}

/**
 * Derive the size parameters for one input.
 *
 * Exposed separately because the sizes depend on the total input length, which
 * makes the chunker's behaviour non-obvious and worth asserting directly.
 */
export function computeSizing(input: RabinKarpInput, params: RabinKarpParams): RabinKarpSizing {
    let plainSplit = input.doPlainSplit || input.isTextBlob;
    const dataSize = input.bytes.length;
    let chunkUnitPlain = RK_CHUNK_UNIT_PLAIN_BASE;

    if (plainSplit) {
        if (dataSize >= RK_PLAIN_SPLIT_SIZE_LIMIT) {
            // Large text is chunked with binary-sized parameters, but is still
            // emitted as text. Both halves of that matter.
            plainSplit = false;
        } else {
            let estimatedChunkCount: number;
            do {
                estimatedChunkCount = dataSize / (chunkUnitPlain * 4);
                if (estimatedChunkCount > RK_MAX_CHUNK_COUNT) {
                    chunkUnitPlain += RK_CHUNK_UNIT_PLAIN_STEP;
                }
            } while (estimatedChunkCount > RK_MAX_CHUNK_COUNT);
        }
    }

    const fixedAvgChunkSize = plainSplit ? chunkUnitPlain * 4 : RK_CHUNK_UNIT_BINARY * 4;
    const fixedMaxChunkSize = plainSplit ? chunkUnitPlain * 16 : RK_CHUNK_UNIT_BINARY * 16;
    const fixedMinChunkSize = plainSplit ? chunkUnitPlain * 2 : RK_CHUNK_UNIT_BINARY;

    const effectiveAbsoluteMaxPieceSize = Math.max(
        params.absoluteMaxPieceSize,
        RK_ABSOLUTE_MAX_PIECE_SIZE_FLOOR
    );
    const maxChunkSize = Math.min(fixedMaxChunkSize, effectiveAbsoluteMaxPieceSize);
    const minChunkSize = Math.min(Math.max(fixedMinChunkSize, params.minimumChunkSize), maxChunkSize);
    const avgChunkSize = Math.min(Math.max(fixedAvgChunkSize, minChunkSize), maxChunkSize);

    return { minChunkSize, avgChunkSize, maxChunkSize, plainSplit };
}

/**
 * Split content into chunks.
 *
 * Text chunks are returned as decoded UTF-8 strings; binary chunks as standard
 * base64. Which one applies is decided by the source blob's type, not by the
 * derived `plainSplit`.
 */
export function splitRabinKarp(input: RabinKarpInput, params: RabinKarpParams): string[] {
    const { minChunkSize, avgChunkSize, maxChunkSize } = computeSizing(input, params);

    const hashModulus = avgChunkSize;
    let pPowW = 1;
    for (let i = 0; i < RK_WINDOW_SIZE - 1; i++) {
        pPowW = Math.imul(pPowW, RK_PRIME);
    }

    const buffer = input.bytes;
    const length = buffer.length;
    const isText = input.isTextBlob;
    const emit = (from: number, to: number): string =>
        isText ? decodeChunkText(buffer.subarray(from, to)) : encodeChunkBase64(buffer.subarray(from, to));

    const out: string[] = [];
    let pos = 0;
    let hash = 0;
    let start = 0;

    while (pos < length) {
        const byte = buffer[pos] as number;

        if (pos >= start + RK_WINDOW_SIZE) {
            const oldByte = buffer[pos - RK_WINDOW_SIZE] as number;
            const oldByteTerm = Math.imul(oldByte, pPowW);
            hash = (hash - oldByteTerm) | 0;
            hash = Math.imul(hash, RK_PRIME);
            hash = (hash + byte) | 0;
        } else {
            hash = Math.imul(hash, RK_PRIME);
            hash = (hash + byte) | 0;
        }

        const currentChunkSize = pos - start + 1;
        let isBoundaryCandidate = false;
        if (currentChunkSize >= minChunkSize) {
            if ((hash >>> 0) % hashModulus === RK_BOUNDARY_PATTERN) isBoundaryCandidate = true;
        }
        if (currentChunkSize >= maxChunkSize) isBoundaryCandidate = true;

        if (isBoundaryCandidate) {
            let isSafeBoundary = true;
            if (isText) {
                // Never split in the middle of a UTF-8 sequence.
                if (pos + 1 < length && ((buffer[pos + 1] as number) & 0xc0) === 0x80) {
                    isSafeBoundary = false;
                }
            }
            if (isSafeBoundary) {
                out.push(emit(start, pos + 1));
                start = pos + 1;
            }
        }
        pos++;
    }

    if (start < length) {
        out.push(emit(start, length));
    }

    return out;
}
