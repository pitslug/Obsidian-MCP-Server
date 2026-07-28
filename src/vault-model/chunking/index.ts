/**
 * Splitter selection and parameter derivation.
 *
 * A note on why only the V3 splitter is implemented.
 *
 * Chunk boundaries are not part of the correctness contract for a *reader*: a
 * file is reassembled by concatenating its `children` in order, whatever
 * produced them. They are not strictly part of it for a *writer* either — the
 * plugin will read back a document chunked by any algorithm. What differs is
 * deduplication: chunks the plugin would have produced are reused only if we
 * produce identical ones.
 *
 * So writing V3 chunks into a V1- or V2-configured vault is safe but wasteful,
 * and the honest thing is to say so rather than to silently do it. Vaults on
 * the current plugin default to V3, so this is expected to be a dead path.
 * `allowSplitterFallback` opts in to it explicitly.
 */

import { MAX_DOC_SIZE_BIN } from "../constants.js";
import { ChunkAlgorithms, type VaultFormatSettings } from "../settings.js";
import { encodeUtf8 } from "./encoding.js";
import { splitRabinKarp, type RabinKarpInput } from "./rabin-karp.js";
import type { FileContent, VaultPath } from "../types.js";

export * from "./encoding.js";
export * from "./rabin-karp.js";

/** Extensions the plugin chunks with text parameters. */
export function shouldSplitAsPlainText(filename: string): boolean {
    return filename.endsWith(".md") || filename.endsWith(".txt") || filename.endsWith(".canvas");
}

/** Extensions the plugin treats as text when reading a document back. */
export function isPlainTextPath(filename: string): boolean {
    return (
        filename.endsWith(".md") ||
        filename.endsWith(".txt") ||
        filename.endsWith(".svg") ||
        filename.endsWith(".html") ||
        filename.endsWith(".csv") ||
        filename.endsWith(".css") ||
        filename.endsWith(".js") ||
        filename.endsWith(".xml") ||
        filename.endsWith(".canvas")
    );
}

export class UnsupportedSplitterError extends Error {
    constructor(algorithm: string) {
        super(
            `This vault is configured to use the "${algorithm}" chunk splitter, which is not implemented. ` +
                `Writing would produce chunks the plugin can read but cannot deduplicate against existing ones. ` +
                `Set allowSplitterFallback to accept that, or leave writes disabled.`
        );
        this.name = "UnsupportedSplitterError";
    }
}

export interface SplitOptions {
    settings: Pick<VaultFormatSettings, "chunkSplitterVersion" | "minimumChunkSize" | "customChunkSize">;
    /** Permit the V3 splitter to stand in for V1/V2. */
    allowSplitterFallback?: boolean;
}

/**
 * The absolute maximum piece size, from `customChunkSize`.
 *
 * Note the Rabin-Karp splitter clamps this against its own fixed maxima, so on
 * a self-hosted vault (`customChunkSize: 60`, giving ~6 MB) the effective cap
 * for text is 16 × the plain chunk unit, far below it.
 */
export function absoluteMaxPieceSize(customChunkSize: number): number {
    return Math.floor(MAX_DOC_SIZE_BIN * ((customChunkSize || 0) * 1 + 1));
}

/**
 * Split a file's content into chunk payloads.
 *
 * Text content is passed through as a `text/plain` blob would be, which is what
 * the plugin does for anything loaded as a string — so the text path is taken
 * regardless of extension.
 */
export function splitContent(
    path: VaultPath | string,
    content: FileContent,
    options: SplitOptions
): string[] {
    const algorithm = options.settings.chunkSplitterVersion;
    if (algorithm !== ChunkAlgorithms.RabinKarp && !options.allowSplitterFallback) {
        throw new UnsupportedSplitterError(algorithm);
    }

    const bytes = content.kind === "text" ? encodeUtf8(content.text) : content.bytes;
    const input: RabinKarpInput = {
        bytes,
        isTextBlob: content.kind === "text",
        doPlainSplit: shouldSplitAsPlainText(`${path}`),
    };

    return splitRabinKarp(input, {
        absoluteMaxPieceSize: absoluteMaxPieceSize(options.settings.customChunkSize),
        minimumChunkSize: options.settings.minimumChunkSize,
    });
}
