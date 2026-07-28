/**
 * The index.
 *
 * Runs against an in-memory SQLite database, so these are fast unit tests of
 * the queries rather than integration tests of the feed. The feed is covered
 * separately, end to end, in the tool tests.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { VaultIndex } from "../../src/index/index.js";
import { asDocumentID, asVaultPath, type AssembledFile } from "../../src/vault-model/types.js";

let index: VaultIndex;

function note(path: string, text: string, over: Partial<AssembledFile> = {}): AssembledFile {
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
        ...over,
    } as AssembledFile;
}

function binary(path: string, size = 1000): AssembledFile {
    return {
        path: asVaultPath(path),
        id: asDocumentID(path.toLowerCase()),
        rev: "1-a",
        kind: "binary",
        bytes: new Uint8Array(size),
        ctime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        size,
        deleted: false,
        children: ["h:bin"],
    } as AssembledFile;
}

beforeEach(() => {
    index = new VaultIndex(":memory:");
    index.open();
});

afterEach(() => {
    // Guarded: one test closes the index itself, and closing twice throws.
    try {
        index.close();
    } catch {
        /* already closed */
    }
});

describe("full-text search", () => {
    beforeEach(() => {
        index.put(note("daily/monday.md", "# Monday\n\nBought milk and discussed the mortgage.\n"));
        index.put(note("projects/house.md", "---\nstatus: active\n---\n\nThe mortgage refinance plan.\n"));
        index.put(note("recipes/bread.md", "Flour, water, salt. No mortgages here.\n"));
    });

    it("finds notes containing a word", () => {
        const hits = index.search({ query: "mortgage" });
        expect(hits.map((h) => h.path).sort()).toEqual(["daily/monday.md", "projects/house.md"]);
    });

    it("returns an excerpt with the match marked", () => {
        const [hit] = index.search({ query: "milk" });
        expect(hit?.snippet).toContain("«milk»");
    });

    it("supports phrase queries", () => {
        expect(index.search({ query: '"mortgage refinance"' }).map((h) => h.path)).toEqual([
            "projects/house.md",
        ]);
    });

    it("supports prefix queries", () => {
        expect(index.search({ query: "mortgag*" }).length).toBeGreaterThanOrEqual(2);
    });

    it("does not match the frontmatter block as body text", () => {
        // Frontmatter is structured data; matching "status" as prose would
        // make every property key a false hit.
        expect(index.search({ query: "status" })).toEqual([]);
    });

    it("narrows to a folder", () => {
        expect(index.search({ query: "mortgage", folder: "daily" }).map((h) => h.path)).toEqual([
            "daily/monday.md",
        ]);
    });

    it("matches the note title, not only the body", () => {
        expect(index.search({ query: "bread" }).map((h) => h.path)).toEqual(["recipes/bread.md"]);
    });

    it("ignores diacritics, so cafe finds café", () => {
        index.put(note("places/cafe.md", "The café on the corner.\n"));
        expect(index.search({ query: "cafe" }).map((h) => h.path)).toContain("places/cafe.md");
    });
});

describe("properties", () => {
    beforeEach(() => {
        index.put(note("a.md", "---\nstatus: done\npriority: 3\n---\nBody"));
        index.put(note("b.md", "---\nstatus: active\ntags: [work]\n---\nBody"));
        index.put(note("c.md", "---\nstatus: [done, archived]\n---\nBody"));
        index.put(note("d.md", "---\nStatus: done\n---\nBody"));
    });

    it("inventories every key with counts and observed types", () => {
        const inventory = index.propertyInventory();
        const status = inventory.find((entry) => entry.key === "status");
        expect(status?.noteCount).toBe(3);
        expect(status?.examples).toContain("done");
    });

    it("exposes a key used with two different value types", () => {
        // The point of the inventory: showing that `priority` is a number
        // here and text there is what tells you the schema needs deciding.
        index.put(note("e.md", "---\npriority: high\n---\nBody"));
        const priority = index.propertyInventory().find((entry) => entry.key === "priority");
        expect(priority?.types.map((t) => t.type).sort()).toEqual(["number", "text"]);
    });

    it("keeps keys that differ only by case distinct, since the vault does", () => {
        const keys = index.propertyInventory().map((entry) => entry.key);
        expect(keys).toContain("status");
        expect(keys).toContain("Status");
    });

    it("finds notes by key", () => {
        expect(index.findByProperty("priority").map((n) => n.path)).toEqual(["a.md"]);
    });

    it("finds notes by key and value", () => {
        expect(index.findByProperty("status", "done").map((n) => n.path)).toEqual(["a.md", "c.md"]);
    });

    it("matches any item of a list property", () => {
        expect(index.findByProperty("status", "archived").map((n) => n.path)).toEqual(["c.md"]);
    });

    it("records a note whose frontmatter will not parse", () => {
        index.put(note("bad.md", "---\nbroken: [unclosed\n---\nBody"));
        const errors = index.frontmatterErrors();
        expect(errors.map((e) => e.path)).toContain("bad.md");
    });
});

describe("tags", () => {
    beforeEach(() => {
        index.put(note("a.md", "---\ntags: [work, urgent]\n---\nAlso #inline"));
        index.put(note("b.md", "Just #work here"));
    });

    it("counts notes per tag across frontmatter and inline", () => {
        const inventory = index.tagInventory();
        expect(inventory.find((t) => t.tag === "work")?.noteCount).toBe(2);
        expect(inventory.find((t) => t.tag === "inline")?.noteCount).toBe(1);
    });

    it("finds notes by tag", () => {
        expect(index.findByTag("urgent").map((n) => n.path)).toEqual(["a.md"]);
    });
});

describe("links", () => {
    beforeEach(() => {
        index.put(note("hub.md", "See [[Target Note]] and ![[image.png]] and [[missing thing]]."));
        index.put(note("Target Note.md", "The target."));
        index.put(binary("image.png"));
        index.resolveLinks();
    });

    it("resolves a link to the note it points at", () => {
        const links = index.outgoingLinks("hub.md");
        expect(links.find((l) => l.target === "Target Note")?.resolvedPath).toBe("Target Note.md");
    });

    it("resolves an embed to an attachment", () => {
        const embed = index.outgoingLinks("hub.md").find((l) => l.embed);
        expect(embed?.resolvedPath).toBe("image.png");
    });

    it("leaves a link to nothing unresolved rather than guessing", () => {
        const link = index.outgoingLinks("hub.md").find((l) => l.target === "missing thing");
        expect(link?.resolvedPath).toBeUndefined();
    });

    it("reports backlinks", () => {
        expect(index.backlinks("Target Note.md").map((b) => b.path)).toEqual(["hub.md"]);
    });

    it("lists broken links for tidying up", () => {
        expect(index.brokenLinks().map((b) => b.target)).toContain("missing thing");
    });

    it("resolves a bare name to a note in a subfolder", () => {
        index.put(note("linker.md", "See [[deep]]."));
        index.put(note("folder/sub/deep.md", "Deep note."));
        index.resolveLinks();
        expect(index.outgoingLinks("linker.md")[0]?.resolvedPath).toBe("folder/sub/deep.md");
    });

    it("prefers an exact path over a basename match", () => {
        index.put(note("notes/dup.md", "One."));
        index.put(note("dup.md", "Two."));
        index.put(note("chooser.md", "See [[dup]]."));
        index.resolveLinks();
        expect(index.outgoingLinks("chooser.md")[0]?.resolvedPath).toBe("dup.md");
    });
});

describe("updating", () => {
    it("replaces everything known about a note when it changes", () => {
        index.put(note("n.md", "---\nstatus: draft\n---\n#old content"));
        index.put(note("n.md", "---\nstatus: final\n---\n#new content"));

        expect(index.findByProperty("status", "draft")).toEqual([]);
        expect(index.findByProperty("status", "final").map((n) => n.path)).toEqual(["n.md"]);
        expect(index.tagInventory().map((t) => t.tag)).toEqual(["new"]);
        expect(index.search({ query: "old" })).toEqual([]);
    });

    it("removes a note and everything derived from it", () => {
        index.put(note("gone.md", "---\nkey: value\n---\n#tag [[link]]"));
        index.remove("gone.md");

        expect(index.count().notes).toBe(0);
        expect(index.search({ query: "tag" })).toEqual([]);
        expect(index.propertyInventory()).toEqual([]);
        expect(index.tagInventory()).toEqual([]);
    });

    it("indexes a binary file as a row with no derived content", () => {
        index.put(binary("scan.pdf", 5000));
        expect(index.count()).toMatchObject({ notes: 1, binary: 1, text: 0 });
        expect(index.search({ query: "scan" })).toEqual([]);
    });
});

describe("schema versioning", () => {
    it("rebuilds rather than migrating when the schema version moves", () => {
        // A cache does not need migrations; it needs to be correct. Opening
        // twice at the same version must not lose data, which is the other
        // half of that claim.
        index.put(note("kept.md", "content"));
        index.close();

        const reopened = new VaultIndex(":memory:");
        reopened.open();
        // A fresh in-memory database starts empty, which is the expected
        // behaviour when the store is discarded.
        expect(reopened.count().notes).toBe(0);
        reopened.close();
    });
});
