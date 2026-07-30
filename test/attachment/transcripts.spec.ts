/**
 * The transcription store.
 *
 * This is the only store in the system whose contents cannot be recreated from
 * anything else. The index can be deleted and rebuilt from the replica, and the
 * replica from CouchDB; a transcription of a handwritten page exists because a
 * model read the ink once, and if it is lost it has to be paid for again.
 *
 * So the properties defended here are about not losing things: that a rewrite
 * keeps the original creation time, that staleness is detected rather than
 * silently serving a description of a page that has since changed, and that
 * reopening the file finds everything still there.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../../src/index/sqlite.js";
import {
    TranscriptSchemaError,
    TranscriptStore,
    isTranscriptStale,
} from "../../src/attachment/transcripts.js";

let dir: string;
let store: TranscriptStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcripts-"));
    store = new TranscriptStore(join(dir, "nested", "transcripts.sqlite"));
    store.open();
});

afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

const ENTRY = {
    path: "Ink/2026-07-20 meeting.pdf",
    text: "Harmony board meeting. Agreed to defer the Adelaide lease decision.",
    sourceSize: 148_223,
    sourceMtime: 1_753_000_000_000,
    provenance: "claude-opus-5, read from the page",
};

describe("storing and retrieving", () => {
    it("creates the directory it was pointed at", () => {
        // The deployment default is a path inside a volume that may not exist
        // on first boot; failing there would take the whole server down.
        expect(existsSync(join(dir, "nested"))).toBe(true);
        expect(existsSync(join(dir, "nested", "transcripts.sqlite"))).toBe(true);
    });

    it("round-trips every field", () => {
        store.put(ENTRY);
        const stored = store.get(ENTRY.path);
        expect(stored).toMatchObject({
            path: ENTRY.path,
            text: ENTRY.text,
            sourceSize: ENTRY.sourceSize,
            sourceMtime: ENTRY.sourceMtime,
            provenance: ENTRY.provenance,
        });
        expect(stored?.createdAt).toBeGreaterThan(0);
        expect(stored?.updatedAt).toBeGreaterThanOrEqual(stored!.createdAt);
    });

    it("returns undefined for a path never transcribed", () => {
        expect(store.get("Ink/never.pdf")).toBeUndefined();
    });

    it("keeps provenance optional without turning it into the string 'null'", () => {
        store.put({ ...ENTRY, provenance: undefined });
        expect(store.get(ENTRY.path)?.provenance).toBeUndefined();
    });

    it("lists everything in path order", () => {
        store.put({ ...ENTRY, path: "Ink/b.pdf" });
        store.put({ ...ENTRY, path: "Ink/a.pdf" });
        expect(store.all().map((t) => t.path)).toEqual(["Ink/a.pdf", "Ink/b.pdf"]);
    });

    it("removes on request", () => {
        store.put(ENTRY);
        store.remove(ENTRY.path);
        expect(store.get(ENTRY.path)).toBeUndefined();
    });
});

describe("rewriting a transcription", () => {
    it("replaces the text and keeps the original creation time", () => {
        store.put(ENTRY);
        const first = store.get(ENTRY.path)!;

        store.put({ ...ENTRY, text: "A better reading of the same page." });
        const second = store.get(ENTRY.path)!;

        expect(second.text).toBe("A better reading of the same page.");
        // createdAt is the record of when this page was first transcribed, and
        // a correction should not make it look newly done.
        expect(second.createdAt).toBe(first.createdAt);
        expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    });

    it("does not accumulate rows for the same path", () => {
        store.put(ENTRY);
        store.put({ ...ENTRY, text: "again" });
        store.put({ ...ENTRY, text: "and again" });
        expect(store.all()).toHaveLength(1);
    });
});

/**
 * Staleness is tested through `isTranscriptStale`, the exported function, not
 * only through the store's convenience wrapper. The function is what the index
 * builder and the tool layer actually call, and an earlier version of this file
 * tested only a method that nothing in production used: the covered copy was
 * inert while two uncovered copies of the same rule sat elsewhere, free to
 * drift.
 */
describe("staleness", () => {
    const stored = { ...ENTRY, createdAt: 1, updatedAt: 1 };

    it("is not stale while the attachment is unchanged", () => {
        expect(isTranscriptStale(stored, ENTRY.sourceSize, ENTRY.sourceMtime)).toBe(false);
    });

    it("is stale once the page has been written on again", () => {
        // Another line of ink: both size and mtime move.
        expect(isTranscriptStale(stored, ENTRY.sourceSize + 900, ENTRY.sourceMtime + 60_000)).toBe(true);
    });

    it("notices a change of mtime alone", () => {
        // A page redrawn to the same byte count is unlikely but not impossible,
        // and treating it as current would leave the wrong text indexed.
        expect(isTranscriptStale(stored, ENTRY.sourceSize, ENTRY.sourceMtime + 1)).toBe(true);
    });

    it("agrees with the store's own wrapper", () => {
        store.put(ENTRY);
        expect(store.isStale(ENTRY.path, ENTRY.sourceSize, ENTRY.sourceMtime)).toBe(false);
        expect(store.isStale(ENTRY.path, ENTRY.sourceSize + 1, ENTRY.sourceMtime)).toBe(true);
    });

    it("reports nothing stale for a path that was never transcribed", () => {
        // "Stale" would be the wrong answer: there is nothing out of date, there
        // is simply nothing. The caller distinguishes the two with get().
        expect(store.isStale("Ink/never.pdf", 10, 20)).toBe(false);
    });
});

/**
 * Losing a transcription is permanent, and the likeliest way to lose one is not
 * a crash: it is a second, worse reading overwriting a first. A model that runs
 * out of room after page one of a forty-page notebook will call
 * `save_transcription` with a fragment, quite happily.
 */
describe("superseded transcriptions", () => {
    it("keeps what a rewrite replaced", () => {
        store.put(ENTRY, 1000);
        store.put({ ...ENTRY, text: "Only got as far as page one." }, 2000);

        const history = store.history(ENTRY.path);
        expect(history).toHaveLength(1);
        expect(history[0]?.text).toBe(ENTRY.text);
        expect(history[0]?.supersededAt).toBe(2000);
        expect(store.get(ENTRY.path)?.text).toBe("Only got as far as page one.");
    });

    it("keeps every version, most recently replaced first", () => {
        store.put({ ...ENTRY, text: "first" }, 1000);
        store.put({ ...ENTRY, text: "second" }, 2000);
        store.put({ ...ENTRY, text: "third" }, 3000);

        expect(store.history(ENTRY.path).map((h) => h.text)).toEqual(["second", "first"]);
        expect(store.get(ENTRY.path)?.text).toBe("third");
    });

    it("has no history for a transcription written once", () => {
        store.put(ENTRY);
        expect(store.history(ENTRY.path)).toEqual([]);
    });

    it("keeps the history when the current transcription is removed", () => {
        // remove() hides a transcription; it must not be a way to destroy the
        // record of one.
        store.put({ ...ENTRY, text: "first" }, 1000);
        store.put({ ...ENTRY, text: "second" }, 2000);
        store.remove(ENTRY.path);

        expect(store.get(ENTRY.path)).toBeUndefined();
        expect(store.history(ENTRY.path).map((h) => h.text)).toEqual(["first"]);
    });
});

describe("orphans", () => {
    it("reports transcriptions whose file is no longer in the vault", () => {
        // What a rename looks like from here: Obsidian deletes the old path and
        // creates a new one, and the transcription is left pointing at nothing.
        store.put({ ...ENTRY, path: "Ink/old name.pdf" });
        store.put({ ...ENTRY, path: "Ink/still here.pdf" });

        const orphans = store.orphans(new Set(["Ink/still here.pdf", "daily/note.md"]));
        expect(orphans.map((o) => o.path)).toEqual(["Ink/old name.pdf"]);
    });

    it("reports none when every transcription still matches a file", () => {
        store.put(ENTRY);
        expect(store.orphans(new Set([ENTRY.path]))).toEqual([]);
    });

    it("does not delete an orphan", () => {
        // The conservative default, and the important one: a renamed file is
        // not a reason to throw away the reading of it.
        store.put(ENTRY);
        store.orphans(new Set());
        expect(store.get(ENTRY.path)?.text).toBe(ENTRY.text);
    });
});

describe("schema version", () => {
    it("refuses to open a store written by a different schema", () => {
        // The index answers this question by dropping everything and rebuilding.
        // That is precisely the response unavailable here, so the only safe
        // action is to stop. A server that will not start is recoverable.
        const path = join(dir, "future.sqlite");
        const db = new DatabaseSync(path);
        db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '99')`).run();
        db.close();

        const future = new TranscriptStore(path);
        expect(() => future.open()).toThrow(TranscriptSchemaError);
        expect(() => future.open()).toThrow(/version 99/);
    });

    it("opens a store it wrote itself", () => {
        const path = join(dir, "ours.sqlite");
        const a = new TranscriptStore(path);
        a.open();
        a.put(ENTRY);
        a.close();

        const b = new TranscriptStore(path);
        expect(() => b.open()).not.toThrow();
        expect(b.get(ENTRY.path)?.text).toBe(ENTRY.text);
        b.close();
    });
});

describe("durability", () => {
    it("survives closing and reopening the store", () => {
        const path = join(dir, "reopen.sqlite");
        const first = new TranscriptStore(path);
        first.open();
        first.put(ENTRY);
        first.close();

        const second = new TranscriptStore(path);
        second.open();
        expect(second.get(ENTRY.path)?.text).toBe(ENTRY.text);
        second.close();
    });

    it("opens an existing store without discarding it", () => {
        // The failure this guards against is a schema statement that drops and
        // recreates: harmless for the index, total loss here.
        const path = join(dir, "twice.sqlite");
        for (const text of ["first pass", "second pass"]) {
            const s = new TranscriptStore(path);
            s.open();
            if (text === "first pass") s.put({ ...ENTRY, text });
            else expect(s.get(ENTRY.path)?.text).toBe("first pass");
            s.close();
        }
    });
});

describe("following a file that moved", () => {
    it("carries the transcription to the new path", () => {
        store.put(ENTRY);
        expect(store.rename(ENTRY.path, "Ink/Superseded/2026-07-20 meeting.pdf")).toBe(true);

        expect(store.get(ENTRY.path)).toBeUndefined();
        expect(store.get("Ink/Superseded/2026-07-20 meeting.pdf")?.text).toBe(ENTRY.text);
    });

    it("carries the history with it", () => {
        // The history is why a bad rewrite is an inconvenience rather than a
        // loss. Left behind under the old path it is neither: it is simply
        // gone, from the point of view of anyone looking.
        store.put(ENTRY, 1_000);
        store.put({ ...ENTRY, text: "A shorter, worse reading." }, 2_000);
        store.rename(ENTRY.path, "Archive/meeting.pdf");

        expect(store.history(ENTRY.path)).toEqual([]);
        expect(store.history("Archive/meeting.pdf").map((row) => row.text)).toEqual([ENTRY.text]);
    });

    it("treats a missing source as nothing to do", () => {
        // Most files have no transcription, so a move that asked first would be
        // asking on every move.
        expect(store.rename("Ink/never transcribed.pdf", "Archive/never transcribed.pdf")).toBe(false);
        expect(store.all()).toEqual([]);
    });

    it("archives anything already at the destination rather than dropping it", () => {
        store.put(ENTRY, 1_000);
        store.put({ ...ENTRY, path: "Archive/meeting.pdf", text: "An older reading." }, 1_500);
        store.rename(ENTRY.path, "Archive/meeting.pdf", 3_000);

        expect(store.get("Archive/meeting.pdf")?.text).toBe(ENTRY.text);
        expect(store.history("Archive/meeting.pdf").map((row) => row.text)).toEqual(["An older reading."]);
    });

    it("gives a copy the same reading, and keeps the original's", () => {
        store.put(ENTRY, 1_000);
        expect(store.copy(ENTRY.path, "Ink/Copies/meeting.pdf", 2_000)).toBe(true);

        expect(store.get(ENTRY.path)?.text).toBe(ENTRY.text);
        const copied = store.get("Ink/Copies/meeting.pdf");
        expect(copied?.text).toBe(ENTRY.text);
        // The reading was made when it was made. Only the row is new.
        expect(copied?.createdAt).toBe(1_000);
        expect(copied?.updatedAt).toBe(2_000);
    });

    it("does not copy a history, which belongs to the file it was made for", () => {
        store.put(ENTRY, 1_000);
        store.put({ ...ENTRY, text: "corrected" }, 2_000);
        store.copy(ENTRY.path, "Ink/Copies/meeting.pdf", 3_000);

        expect(store.history("Ink/Copies/meeting.pdf")).toEqual([]);
        expect(store.history(ENTRY.path).length).toBe(1);
    });
});
