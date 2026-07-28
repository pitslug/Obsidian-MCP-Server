/**
 * How chunk payloads are encoded.
 *
 * Text chunks are UTF-8 decoded strings stored directly in JSON. Binary chunks
 * are standard (padded, `+`/`/`) base64.
 *
 * `decodeChunkText` must not strip a leading byte order mark - a BOM at the
 * start of a file is content, and dropping it would make round-tripping lossy
 * for exactly the files most likely to notice. Upstream constructs its decoder
 * with `ignoreBOM: true` for this reason; so do we.
 */

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export function decodeChunkText(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}

export function encodeChunkBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeChunkBase64(text: string): Uint8Array {
    return new Uint8Array(Buffer.from(text, "base64"));
}

export function encodeUtf8(text: string): Uint8Array {
    return encoder.encode(text);
}
