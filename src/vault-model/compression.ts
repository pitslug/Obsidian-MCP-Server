/**
 * The optional deflate layer on `data` fields.
 *
 * Installed before encryption, and `transform-pouch` composes so that the
 * first-installed wrapper ends up outermost. The result:
 *
 *   write:  plaintext → encrypt → compress → wire
 *   read:   wire → decompress → decrypt → plaintext
 *
 * Compression is applied only if it actually shortens the field, so an
 * uncompressed `data` is always possible even with the setting on. Detection is
 * by marker, never by setting.
 *
 * The base64 detection heuristic is imported from `octagonal-wheels` rather than
 * rewritten. It decides whether the `~` marker is set, and a disagreement with
 * upstream about what counts as base64 would produce payloads that decompress
 * to the wrong thing.
 *
 * One deliberate divergence: upstream decodes an uncompressed text payload via
 * `Blob.text()`, which performs a spec "UTF-8 decode" and therefore strips a
 * leading byte order mark. This uses `readString`, which preserves it. A BOM at
 * the start of a file is content; dropping it would make round-tripping lossy.
 * The two differ only for a compressed text chunk whose first bytes are a BOM.
 */

import { deflate, inflate } from "fflate";
import {
    arrayBufferToBase64Single,
    readString,
    tryConvertBase64ToArrayBuffer,
    writeString,
} from "octagonal-wheels/binary/base64.js";
import { MARK_COMPRESSED_WAS_BASE64, MARK_SHIFT_COMPRESSED } from "./constants.js";

export class CompressionError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "CompressionError";
    }
}

export function isCompressed(data: string): boolean {
    return data.startsWith(MARK_SHIFT_COMPRESSED);
}

/**
 * `fflate` hands back a `Uint8Array` over an unconstrained buffer type, while
 * the base64 helpers want one backed by a plain `ArrayBuffer`. The assertion
 * narrows the buffer type without copying; the bytes are identical either way.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const deflateAsync = (input: Bytes): Promise<Bytes> =>
    new Promise((resolve, reject) =>
        deflate(input, { level: 8, consume: true }, (err, out) => (err ? reject(err) : resolve(out as Bytes)))
    );

const inflateAsync = (input: Bytes): Promise<Bytes> =>
    new Promise((resolve, reject) =>
        inflate(input, { consume: true }, (err, out) => (err ? reject(err) : resolve(out as Bytes)))
    );

/**
 * Compress a `data` field, or return it unchanged if compression does not help.
 *
 * A payload that is itself valid base64 is decoded to bytes first - deflating
 * base64 text wastes a quarter of the input - and the result is marked with `~`
 * so the reader knows to re-encode.
 */
export async function compressData(data: string): Promise<string> {
    if (isCompressed(data)) return data;

    const converted = tryConvertBase64ToArrayBuffer(data);
    const payload: Bytes = converted ? new Uint8Array(converted) : (writeString(data) as Bytes);
    if (payload.byteLength === 0) return data;

    const deflated = await deflateAsync(payload);
    const encoded =
        (converted ? MARK_COMPRESSED_WAS_BASE64 : "") + (await arrayBufferToBase64Single(deflated));
    const candidate = MARK_SHIFT_COMPRESSED + encoded;

    return data.length > candidate.length ? candidate : data;
}

/** Reverse {@link compressData}. Returns the input unchanged if unmarked. */
export async function decompressData(data: string): Promise<string> {
    if (!isCompressed(data)) return data;

    const body = data.slice(MARK_SHIFT_COMPRESSED.length);
    if (body.length === 0) return "";

    const wasBase64 = body.startsWith(MARK_COMPRESSED_WAS_BASE64);
    const encoded = wasBase64 ? body.slice(MARK_COMPRESSED_WAS_BASE64.length) : body;
    if (encoded.length === 0) return "";

    let inflated: Bytes;
    try {
        inflated = await inflateAsync(new Uint8Array(Buffer.from(encoded, "base64")));
    } catch (error) {
        throw new CompressionError(
            "Failed to decompress a data field. The document is corrupt, or was written by an " +
                "unrecognised plugin version.",
            { cause: error }
        );
    }

    return wasBase64 ? await arrayBufferToBase64Single(inflated) : readString(inflated);
}
