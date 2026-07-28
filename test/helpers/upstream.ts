/**
 * Access to the plugin's own implementation, for differential testing.
 *
 * `@vrtmrz/livesync-commonlib` is a development dependency only. It is imported
 * by explicit file path because its package exports map does not expose these
 * modules, and it must never be imported from `src/` - the whole point of the
 * vault model is that it owns this logic rather than borrowing it. These
 * imports exist so the tests can assert that owning it produced the same
 * answers.
 */

import * as upstreamChunks from "../../node_modules/@vrtmrz/livesync-commonlib/dist/string_and_binary/chunks.js";
import * as upstreamPath from "../../node_modules/@vrtmrz/livesync-commonlib/dist/string_and_binary/path.js";
import * as upstreamCompress from "../../node_modules/@vrtmrz/livesync-commonlib/dist/pouchdb/compress.js";
import * as upstreamConstants from "../../node_modules/@vrtmrz/livesync-commonlib/dist/common/models/shared.const.behabiour.js";

type SplitFn = (
    dataSrc: Blob,
    absoluteMaxPieceSize: number,
    doPlainSplit: boolean,
    minimumChunkSize: number,
    filename?: string,
    useSegmenter?: boolean
) => Promise<() => AsyncGenerator<string, void, unknown>>;

/** Run the plugin's Rabin-Karp splitter and collect its output. */
export async function upstreamSplitRabinKarp(
    blob: Blob,
    absoluteMaxPieceSize: number,
    doPlainSplit: boolean,
    minimumChunkSize: number
): Promise<string[]> {
    const gen = await (upstreamChunks.splitPiecesRabinKarp as unknown as SplitFn)(
        blob,
        absoluteMaxPieceSize,
        doPlainSplit,
        minimumChunkSize
    );
    const out: string[] = [];
    for await (const piece of gen()) out.push(piece);
    return out;
}

export const upstreamPath2Id = upstreamPath.path2id_base as unknown as (
    filename: string,
    obfuscatePassphrase: string | false,
    caseInsensitive: boolean
) => Promise<string>;

export const upstreamId2Path = upstreamPath.id2path_base as unknown as (
    id: string,
    entry?: { path?: string }
) => string;

export const upstreamShouldSplitAsPlainText = upstreamPath.shouldSplitAsPlainText as unknown as (
    filename: string
) => boolean;

export const upstreamIsPlainText = upstreamPath.isPlainText as unknown as (filename: string) => boolean;

export const upstreamCompressText = upstreamCompress._compressText as unknown as (
    text: string
) => Promise<string>;
export const upstreamDecompressText = upstreamCompress._decompressText as unknown as (
    compressed: string
) => Promise<string>;
export const upstreamMarkShiftCompressed = upstreamCompress.MARK_SHIFT_COMPRESSED as string;

export const upstreamSaltOfId = upstreamConstants.SALT_OF_ID as string;
export const upstreamSeedMurmurhash = upstreamConstants.SEED_MURMURHASH as number;

/** Build a blob the way the plugin does for text content. */
export function textBlob(text: string): Blob {
    return new Blob([text], { endings: "transparent", type: "text/plain" });
}

/** Build a blob the way the plugin does for binary content. */
export function binaryBlob(bytes: Uint8Array): Blob {
    return new Blob([new Uint8Array(bytes)], {
        endings: "transparent",
        type: "application/octet-stream",
    });
}
