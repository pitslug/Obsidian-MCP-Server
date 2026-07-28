/**
 * Assembly, and specifically its failure modes.
 *
 * The design document is explicit that a partially assembled note must never be
 * returned, because a truncated note that looks complete is worse than an
 * error. Most of what follows tests that the failure happens rather than that
 * the success does.
 */

import { describe, expect, it } from "vitest";
import {
    assembleFile,
    contentKind,
    isDeleted,
    isFileEntry,
    isLegacyNote,
    MissingChunkError,
    requiredChunkIds,
    SizeMismatchError,
    UnsupportedDocumentError,
} from "../../src/vault-model/assemble.js";
import {
    TYPE_CHUNK,
    TYPE_NOTE_BINARY,
    TYPE_NOTE_LEGACY,
    TYPE_NOTE_PLAIN,
} from "../../src/vault-model/constants.js";
import {
    asDocumentID,
    asVaultPath,
    type ChunkEntry,
    type ChunkedEntry,
    type LegacyNoteEntry,
} from "../../src/vault-model/types.js";

const chunk = (id: string, data: string): ChunkEntry => ({
    _id: asDocumentID(id),
    type: TYPE_CHUNK,
    data,
});

const chunkMap = (...entries: ChunkEntry[]) => new Map(entries.map((c) => [String(c._id), c]));

const entry = (over: Partial<ChunkedEntry> = {}): ChunkedEntry => ({
    _id: asDocumentID("note.md"),
    _rev: "3-abc",
    path: asVaultPath("Note.md"),
    ctime: 1_000,
    mtime: 2_000,
    size: 2,
    type: TYPE_NOTE_PLAIN,
    children: ["h:a", "h:b"],
    eden: {},
    ...over,
});

/** `size` is verified during assembly, so fixtures must declare the real one. */
const sized = (text: string, over: Partial<ChunkedEntry> = {}): ChunkedEntry =>
    entry({ size: Buffer.byteLength(text, "utf8"), ...over });

describe("assembly", () => {
    it("concatenates chunks in the order children lists them", () => {
        const doc = sized("BAAAB", { children: ["h:b", "h:a", "h:b"] });
        const result = assembleFile(doc, chunkMap(chunk("h:a", "AAA"), chunk("h:b", "B")));
        expect(result.text).toBe("BAAAB");
    });

    it("uses a repeated chunk as many times as it is referenced", () => {
        const doc = sized("xyxyxy", { children: ["h:a", "h:a", "h:a"] });
        const result = assembleFile(doc, chunkMap(chunk("h:a", "xy")));
        expect(result.text).toBe("xyxyxy");
    });

    it("ignores chunks it was given but does not need", () => {
        const doc = sized("one", { children: ["h:a"] });
        const result = assembleFile(doc, chunkMap(chunk("h:a", "one"), chunk("h:z", "unused")));
        expect(result.text).toBe("one");
    });

    it("takes the path from the path field, not the ID", () => {
        // The ID is lowercased; only `path` has the real casing.
        const result = assembleFile(
            entry({ _id: asDocumentID("note.md"), path: asVaultPath("Folder/Note.md") }),
            chunkMap(chunk("h:a", "a"), chunk("h:b", "b"))
        );
        expect(result.path).toBe("Folder/Note.md");
        expect(result.text).toBe("ab");
    });

    it("reports the revision so a writer can use it", () => {
        const result = assembleFile(entry(), chunkMap(chunk("h:a", "a"), chunk("h:b", "b")));
        expect(result.rev).toBe("3-abc");
    });
});

describe("failure modes", () => {
    it("refuses to return a note whose chunks are missing", () => {
        const doc = entry({ children: ["h:a", "h:missing"] });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "partial")))).toThrow(MissingChunkError);
    });

    it("names the missing chunks so the caller can fetch them", () => {
        const doc = entry({ children: ["h:a", "h:missing1", "h:missing2"] });
        try {
            assembleFile(doc, chunkMap(chunk("h:a", "a")));
            expect.unreachable("should have thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(MissingChunkError);
            expect((error as MissingChunkError).missing).toEqual(["h:missing1", "h:missing2"]);
        }
    });

    it("never returns the partial content it managed to assemble", () => {
        const doc = entry({ children: ["h:a", "h:missing"] });
        let thrown: unknown;
        try {
            assembleFile(doc, chunkMap(chunk("h:a", "the visible half")));
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(MissingChunkError);
        expect(String(thrown)).not.toContain("the visible half");
    });

    it("rejects a document that is not a file", () => {
        const notAFile = { ...entry(), type: "leaf" } as unknown as ChunkedEntry;
        expect(() => assembleFile(notAFile, chunkMap())).toThrow(UnsupportedDocumentError);
    });

    it("refuses the legacy encoded-UTF16 binary format rather than guessing", () => {
        const doc = entry({
            type: TYPE_NOTE_BINARY,
            path: asVaultPath("image.png"),
            children: ["h:a"],
        });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "%encoded-utf16")))).toThrow(
            UnsupportedDocumentError
        );
    });

    it("refuses a binary payload that is not valid base64", () => {
        // Buffer.from silently discards invalid characters, so without an
        // explicit check this decodes to plausible-looking noise.
        const doc = entry({
            type: TYPE_NOTE_BINARY,
            path: asVaultPath("image.png"),
            children: ["h:a"],
        });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "this is not base64!")))).toThrow(
            UnsupportedDocumentError
        );
    });

    it("refuses a document whose metadata is still encrypted", () => {
        // An encrypted document has empty children and a zero size, which is
        // indistinguishable from an empty note without this check.
        const doc = entry({
            _id: asDocumentID("f:abc"),
            path: asVaultPath("/\\:%=ciphertext"),
            children: [],
            size: 0,
        });
        expect(() => assembleFile(doc, chunkMap())).toThrow(/still holds encrypted metadata/);
    });

    it("refuses a chunk payload that is still encrypted", () => {
        const doc = sized("x", { children: ["h:+a"] });
        expect(() => assembleFile(doc, chunkMap(chunk("h:+a", "%=Y2lwaGVydGV4dA==")))).toThrow(
            /still looks encrypted/
        );
    });

    it("refuses a chunk payload that is still compressed", () => {
        const doc = sized("x", { children: ["h:a"] });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "\u000ELZ\u001Dpayload")))).toThrow(
            /still compressed/
        );
    });

    it("refuses a document carrying inline eden chunks", () => {
        const doc = sized("ab", { eden: { "h:e": { data: "inline", epoch: 1 } } });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "a"), chunk("h:b", "b")))).toThrow(/eden/);
    });

    it("refuses a note whose assembled length disagrees with its recorded size", () => {
        const doc = entry({ size: 999, children: ["h:a"] });
        expect(() => assembleFile(doc, chunkMap(chunk("h:a", "short")))).toThrow(SizeMismatchError);
    });
});

describe("legacy documents", () => {
    it("reads inline data from a pre-chunking note", () => {
        const legacy: LegacyNoteEntry = {
            _id: asDocumentID("old.md"),
            path: asVaultPath("old.md"),
            type: TYPE_NOTE_LEGACY,
            data: "inline content",
            ctime: 1,
            mtime: 2,
            size: 14,
        };
        const result = assembleFile(legacy, chunkMap());
        expect(result.text).toBe("inline content");
        expect(result.children).toEqual([]);
    });

    it("joins an array of inline parts", () => {
        const legacy: LegacyNoteEntry = {
            _id: asDocumentID("old.md"),
            path: asVaultPath("old.md"),
            type: TYPE_NOTE_LEGACY,
            data: ["one ", "two ", "three"],
            ctime: 1,
            mtime: 2,
            size: 14,
        };
        expect(assembleFile(legacy, chunkMap()).text).toBe("one two three");
    });
});

describe("deletion", () => {
    it("honours the in-body flag, which is the plugin's default", () => {
        expect(isDeleted({ deleted: true })).toBe(true);
    });

    it("honours CouchDB's own flag", () => {
        expect(isDeleted({ _deleted: true })).toBe(true);
    });

    it("treats a live document as live", () => {
        expect(isDeleted({})).toBe(false);
        expect(isDeleted({ deleted: false, _deleted: false })).toBe(false);
    });

    it("surfaces deletion on the assembled file", () => {
        const result = assembleFile(entry({ deleted: true }), chunkMap(chunk("h:a", "a"), chunk("h:b", "b")));
        expect(result.deleted).toBe(true);
    });
});

describe("content kind", () => {
    it("is text for plain documents", () => {
        expect(contentKind({ type: TYPE_NOTE_PLAIN, _id: "x" })).toBe("text");
    });

    it("is binary for newnote documents at a binary path", () => {
        expect(contentKind({ type: TYPE_NOTE_BINARY, _id: "image.png", path: "image.png" })).toBe("binary");
    });

    it("is text for a newnote document at a plain-text path, as upstream reads it", () => {
        // isTextDocument falls through to the extension check even for
        // "newnote", so treating this as binary would base64-decode prose.
        expect(contentKind({ type: TYPE_NOTE_BINARY, _id: "notes.md", path: "notes.md" })).toBe("text");
    });

    it("falls back to the extension for legacy documents", () => {
        expect(contentKind({ type: TYPE_NOTE_LEGACY, _id: "a.md", path: "a.md" })).toBe("text");
        expect(contentKind({ type: TYPE_NOTE_LEGACY, _id: "a.png", path: "a.png" })).toBe("binary");
    });
});

describe("classification", () => {
    it("recognises the three file document types", () => {
        expect(isFileEntry({ type: TYPE_NOTE_PLAIN })).toBe(true);
        expect(isFileEntry({ type: TYPE_NOTE_BINARY })).toBe(true);
        expect(isFileEntry({ type: TYPE_NOTE_LEGACY })).toBe(true);
    });

    it("excludes chunks and bookkeeping documents", () => {
        for (const type of ["leaf", "chunkpack", "versioninfo", "syncinfo", "milestoneinfo"]) {
            expect(isFileEntry({ type }), String(type)).toBe(false);
        }
    });

    it("treats a document with no type as a legacy note, as upstream does", () => {
        // The oldest documents in a long-lived vault have no `type` at all.
        expect(isFileEntry({})).toBe(true);
        expect(isLegacyNote({})).toBe(true);
    });

    it("collects the chunk IDs a set of documents needs, deduplicated", () => {
        const a = entry({ children: ["h:1", "h:2"] });
        const b = entry({ children: ["h:2", "h:3"] });
        expect(requiredChunkIds([a, b])).toEqual(["h:1", "h:2", "h:3"]);
    });
});
