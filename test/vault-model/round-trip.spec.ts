/**
 * Splitting a file into chunks and reassembling it is the identity function.
 *
 * This is the property the design document names first, because it is the one
 * whose failure is unrecoverable: a note that survives a write in a subtly
 * altered form is not something anyone notices until much later.
 *
 * It is asserted end to end - through `composeWrite`, which is what the write
 * executor will actually call, and back through `assembleFile`, which is what
 * every read goes through - rather than over the splitter alone.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { composeWrite } from "../../src/vault-model/compose.js";
import { assembleFile } from "../../src/vault-model/assemble.js";
import { DEFAULT_FORMAT_SETTINGS, resolveSettings } from "../../src/vault-model/settings.js";
import { TYPE_CHUNK } from "../../src/vault-model/constants.js";
import type { ChunkEntry, ChunkedEntry, FileContent } from "../../src/vault-model/types.js";
import { BOUNDARY_SIZES, awkwardText, binaryContent, filler, fillerBytes } from "../helpers/content.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });

/** Compose, then feed the composed chunks straight back into assembly. */
async function roundTrip(path: string, content: FileContent, settings = SETTINGS) {
    const composed = await composeWrite(path, content, { settings, now: 1_700_000_000_000 });

    const chunks = new Map<string, ChunkEntry>();
    for (const chunk of composed.chunks) chunks.set(chunk._id, chunk);

    // Every referenced chunk must be present - a missing one means composition
    // dropped a duplicate it should have kept a reference to.
    for (const child of composed.children) {
        expect(chunks.has(child), `chunk ${child} missing from composed output`).toBe(true);
    }

    const entry: ChunkedEntry = { ...composed.entry, _rev: "1-abc" };
    return { composed, assembled: assembleFile(entry, chunks) };
}

describe("text round trip", () => {
    it("is the identity function for generated content", async () => {
        await fc.assert(
            fc.asyncProperty(awkwardText(), async (text) => {
                const { assembled } = await roundTrip("note.md", { kind: "text", text });
                expect(assembled.kind).toBe("text");
                expect(assembled.text).toBe(text);
            }),
            { numRuns: 200 }
        );
    });

    it("is the identity function at every derived size boundary", async () => {
        for (const size of BOUNDARY_SIZES) {
            const text = filler(size);
            const { assembled } = await roundTrip("note.md", { kind: "text", text });
            expect(assembled.text, `text of length ${size}`).toBe(text);
        }
    });

    it("survives content large enough to span hundreds of chunks", async () => {
        for (const size of [50_000, 500_000, 1_500_000]) {
            const text = filler(size);
            const { composed, assembled } = await roundTrip("big.md", { kind: "text", text });
            expect(assembled.text, `text of length ${size}`).toBe(text);
            expect(composed.children.length).toBeGreaterThan(10);
        }
    });

    it("survives text above the 4 MiB plain-split limit", async () => {
        // Above this the splitter switches to binary sizing but still emits
        // text, which is the corner most likely to be got wrong.
        const text = filler(4 * 1024 * 1024 + 1_000);
        const { assembled } = await roundTrip("huge.md", { kind: "text", text });
        expect(assembled.text).toBe(text);
    });

    it("preserves a leading byte order mark", async () => {
        const text = "﻿# Heading\n\n" + filler(3_000);
        const { assembled } = await roundTrip("bom.md", { kind: "text", text });
        expect(assembled.text).toBe(text);
        expect(assembled.text?.charCodeAt(0)).toBe(0xfeff);
    });

    it("preserves mixed line endings exactly", async () => {
        const text = Array.from({ length: 500 }, (_, i) =>
            i % 3 === 0 ? `line ${i}\r\n` : i % 3 === 1 ? `line ${i}\n` : `line ${i}\r`
        ).join("");
        const { assembled } = await roundTrip("endings.md", { kind: "text", text });
        expect(assembled.text).toBe(text);
    });

    it("preserves astral-plane characters split across chunks", async () => {
        for (const unit of ["👨‍👩‍👧‍👦", "𝕳𝖊𝖑𝖑𝖔", "🏳️‍🌈", "\u{10FFFF}"]) {
            const text = unit.repeat(2_000);
            const { assembled } = await roundTrip("emoji.md", { kind: "text", text });
            expect(assembled.text, unit).toBe(text);
        }
    });

    it("handles an empty file", async () => {
        const { composed, assembled } = await roundTrip("empty.md", { kind: "text", text: "" });
        expect(assembled.text).toBe("");
        expect(composed.children).toEqual([]);
        expect(assembled.size).toBe(0);
    });

    it("handles a file of a single character", async () => {
        const { assembled } = await roundTrip("one.md", { kind: "text", text: "x" });
        expect(assembled.text).toBe("x");
    });

    it("handles content that is only whitespace", async () => {
        const text = " \n\t\r\n".repeat(500);
        const { assembled } = await roundTrip("ws.md", { kind: "text", text });
        expect(assembled.text).toBe(text);
    });
});

describe("binary round trip", () => {
    it("is the identity function for generated bytes", async () => {
        await fc.assert(
            fc.asyncProperty(binaryContent(), async (bytes) => {
                const { assembled } = await roundTrip("file.bin", { kind: "binary", bytes });
                expect(assembled.kind).toBe("binary");
                expect(assembled.bytes).toEqual(bytes);
            }),
            { numRuns: 150 }
        );
    });

    it("survives sizes around the binary chunk unit", async () => {
        for (const size of [0, 1, 255, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, 700_000]) {
            const bytes = fillerBytes(size);
            const { assembled } = await roundTrip("file.bin", { kind: "binary", bytes });
            expect(assembled.bytes, `bytes of length ${size}`).toEqual(bytes);
        }
    });

    it("survives bytes that are not valid UTF-8", async () => {
        const bytes = new Uint8Array([0xff, 0xfe, 0x80, 0x81, 0xc0, 0x00, 0xed, 0xa0, 0x80]);
        const { assembled } = await roundTrip("invalid.bin", { kind: "binary", bytes });
        expect(assembled.bytes).toEqual(bytes);
    });

    it("records the byte length, not the character length", async () => {
        const bytes = fillerBytes(1234);
        const { assembled } = await roundTrip("sized.bin", { kind: "binary", bytes });
        expect(assembled.size).toBe(1234);
    });
});

describe("composition invariants", () => {
    it("records size as the UTF-8 byte length for text", async () => {
        const text = "日本語のテキスト"; // 8 characters, 24 bytes
        const { assembled } = await roundTrip("bytes.md", { kind: "text", text });
        expect(assembled.size).toBe(Buffer.byteLength(text, "utf8"));
        expect(assembled.size).not.toBe(text.length);
    });

    it("emits each distinct chunk once, however often it is referenced", async () => {
        // A file built of a repeating block should dedupe heavily.
        const block = filler(400, 7);
        const text = block.repeat(40);
        const { composed } = await roundTrip("repeating.md", { kind: "text", text });
        const distinct = new Set(composed.children);
        expect(composed.chunks.length).toBe(distinct.size);
        expect(composed.chunks.length).toBeLessThan(composed.children.length);
    });

    it("omits chunks the caller says already exist upstream", async () => {
        const text = filler(20_000);
        const first = await composeWrite("note.md", { kind: "text", text }, { settings: SETTINGS });
        const existing = new Set(first.children);

        const second = await composeWrite(
            "note.md",
            { kind: "text", text },
            { settings: SETTINGS, existingChunkIds: existing }
        );
        expect(second.chunks).toEqual([]);
        expect(second.children).toEqual(first.children);
    });

    it("reuses chunk IDs across different files with shared content", async () => {
        const shared = filler(5_000, 3);
        const a = await composeWrite("a.md", { kind: "text", text: shared }, { settings: SETTINGS });
        const b = await composeWrite("b.md", { kind: "text", text: shared }, { settings: SETTINGS });
        expect(b.children).toEqual(a.children);
        expect(b.entry._id).not.toBe(a.entry._id);
    });

    it("is deterministic - the same input composes identically", async () => {
        const content: FileContent = { kind: "text", text: filler(9_000) };
        const options = { settings: SETTINGS, now: 1_700_000_000_000 };
        const a = await composeWrite("note.md", content, options);
        const b = await composeWrite("note.md", content, options);
        expect(b).toEqual(a);
    });

    it("marks every emitted chunk as a leaf document", async () => {
        const { composed } = await roundTrip("note.md", { kind: "text", text: filler(9_000) });
        for (const chunk of composed.chunks) {
            expect(chunk.type).toBe(TYPE_CHUNK);
            expect(chunk._id.startsWith("h:")).toBe(true);
        }
    });

    it("writes an empty eden, as current clients do", async () => {
        const { composed } = await roundTrip("note.md", { kind: "text", text: "hello" });
        expect(composed.entry.eden).toEqual({});
    });
});

describe("round trip under alternative settings", () => {
    it("holds with E2EE chunk hashing enabled", async () => {
        const settings = resolveSettings({
            ...DEFAULT_FORMAT_SETTINGS,
            encrypt: true,
            passphrase: "a passphrase",
            customChunkSize: 60,
        });
        const text = filler(20_000);
        const { composed, assembled } = await roundTrip("note.md", { kind: "text", text }, settings);
        expect(assembled.text).toBe(text);
        for (const id of composed.children) expect(id.startsWith("h:+")).toBe(true);
    });

    it("holds with case-sensitive filenames", async () => {
        const settings = resolveSettings({ handleFilenameCaseSensitive: true, customChunkSize: 60 });
        const { composed } = await roundTrip("Folder/Note.md", { kind: "text", text: "x" }, settings);
        expect(composed.entry._id).toBe("Folder/Note.md");
    });

    it("holds for every hash algorithm", async () => {
        const text = filler(12_000);
        for (const hashAlg of ["xxhash64", "xxhash32", "mixed-purejs", "sha1", ""] as const) {
            const settings = resolveSettings({ hashAlg, customChunkSize: 60 });
            const { assembled } = await roundTrip("note.md", { kind: "text", text }, settings);
            expect(assembled.text, `hashAlg=${hashAlg || "legacy"}`).toBe(text);
        }
    });
});
