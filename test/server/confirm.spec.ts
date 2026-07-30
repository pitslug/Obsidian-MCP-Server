/**
 * Confirming index results against the vault.
 *
 * This is the guard on the one wrong answer that matters most: a note the user
 * deleted coming back as context for a question. The index is a cache, and the
 * failure it has is not lag but persistence, so these tests are written from the
 * cache's point of view. Every one of them starts with an index that holds a
 * note the vault does not, because that is the state a dead changes feed leaves
 * behind and no amount of correctness in the delete path prevents.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultIndex } from "../../src/index/index.js";
import { confirmLive, staleness } from "../../src/server/confirm.js";
import type { VaultReader } from "../../src/vault/reader.js";
import { asDocumentID, asVaultPath, type AssembledFile } from "../../src/vault-model/types.js";

let index: VaultIndex;
let asked: string[][];

function note(path: string, text: string): AssembledFile {
    return {
        path: asVaultPath(path),
        id: asDocumentID(path.toLowerCase()),
        rev: "1-a",
        kind: "text",
        text,
        ctime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        size: Buffer.byteLength(text, "utf8"),
        deleted: false,
        children: ["h:one"],
    } as AssembledFile;
}

/** A vault that holds exactly these paths, and records what it was asked. */
function vaultHolding(...paths: string[]): VaultReader {
    return {
        live: async (asking: readonly string[]) => {
            asked.push([...asking]);
            return new Set(asking.filter((path) => paths.includes(path)));
        },
    } as unknown as VaultReader;
}

const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };

beforeEach(() => {
    index = new VaultIndex(":memory:");
    index.open();
    asked = [];
    warnings.length = 0;
});

afterEach(() => {
    index.close();
});

describe("confirming results against the vault", () => {
    it("returns the rows whose notes still exist, in the order they came", async () => {
        const rows = [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }];

        const result = await confirmLive(
            { index, reader: vaultHolding("a.md", "b.md", "c.md"), log },
            rows,
            (row) => row.path
        );

        // Order is the ranking, for search results. Filtering must not resort.
        expect(result.rows.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
        expect(result.dropped).toEqual([]);
    });

    it("drops a result whose note the vault no longer holds", async () => {
        const rows = [{ path: "kept.md" }, { path: "deleted.md" }, { path: "also-kept.md" }];

        const result = await confirmLive(
            { index, reader: vaultHolding("kept.md", "also-kept.md"), log },
            rows,
            (row) => row.path
        );

        expect(result.rows.map((r) => r.path)).toEqual(["kept.md", "also-kept.md"]);
        expect(result.dropped).toEqual(["deleted.md"]);
    });

    it("removes the stale entry from the index rather than leaving it for a rebuild", async () => {
        index.put(note("deleted.md", "content the vault no longer has"));
        expect(index.search({ query: "content" })).toHaveLength(1);

        await confirmLive({ index, reader: vaultHolding(), log }, [{ path: "deleted.md" }], (r) => r.path);

        // The self-heal: this is the only moment when something has both noticed
        // the staleness and knows which path it is.
        expect(index.search({ query: "content" })).toEqual([]);
        expect(index.count().notes).toBe(0);
    });

    it("says so in the log, because repetition means the feed has stopped", async () => {
        await confirmLive({ index, reader: vaultHolding(), log }, [{ path: "ghost.md" }], (r) => r.path);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("ghost.md");
        expect(warnings[0]).toContain("changes feed");
    });

    it("asks about each path once, however many rows mention it", async () => {
        const rows = [{ path: "same.md" }, { path: "same.md" }, { path: "other.md" }];

        await confirmLive({ index, reader: vaultHolding("same.md", "other.md"), log }, rows, (r) => r.path);

        expect(asked).toEqual([["same.md", "other.md"]]);
    });

    it("does not consult the vault when there is nothing to confirm", async () => {
        const result = await confirmLive({ index, reader: vaultHolding(), log }, [], (r: never) => r);

        expect(result).toEqual({ rows: [], dropped: [] });
        expect(asked).toEqual([]);
    });

    it("works without a logger, since one is optional", async () => {
        const result = await confirmLive(
            { index, reader: vaultHolding() },
            [{ path: "x.md" }],
            (r) => r.path
        );

        expect(result.rows).toEqual([]);
        expect(result.dropped).toEqual(["x.md"]);
    });
});

describe("what the caller is told", () => {
    it("says nothing when nothing was dropped", () => {
        expect(staleness([])).toEqual([]);
    });

    it("counts what was left out", () => {
        const [line] = staleness(["gone.md"]);
        expect(line).toContain("1 result was left out");
        expect(line).toContain("index has been corrected");
    });

    it("never names the note, whatever the count", () => {
        // The point of the whole mechanism. A path is enough for a model to
        // repeat it to the user or to try reading it, and the user deleted it.
        expect(staleness(["private.md"])[0]).not.toContain("private.md");

        const [many] = staleness(["a.md", "b.md", "c.md", "d.md"]);
        expect(many).toContain("4 results were left out");
        for (const path of ["a.md", "b.md", "c.md", "d.md"]) expect(many).not.toContain(path);
    });
});
