/**
 * Editing frontmatter.
 *
 * Most of these assert on the whole note rather than on the parsed properties,
 * because the thing that matters is what the author sees next time they open
 * it. A test that checked `properties.status === "draft"` would pass just as
 * happily if every comment had been stripped and every key reordered.
 */

import { describe, expect, it } from "vitest";
import { editFrontmatter, FrontmatterUnreadableError } from "../../src/note/frontmatter.js";
import { parseNote } from "../../src/note/parse.js";

describe("adding and changing properties", () => {
    it("adds a property to a note that has none, leaving the body alone", () => {
        const note = "# Heading\n\nSome body text.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "draft" } });

        expect(result.text).toBe("---\nstatus: draft\n---\n# Heading\n\nSome body text.\n");
        expect(result.added).toEqual(["status"]);
    });

    it("adds to an existing block without reformatting the rest", () => {
        const note = "---\ntitle: A note  # written by hand\ntags:\n  - one\n  - two\n---\n\nBody.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "draft" } });

        // The comment, the block sequence style and the key order all survive.
        expect(result.text).toContain("title: A note # written by hand");
        expect(result.text).toContain("tags:\n  - one\n  - two\n");
        expect(result.text).toContain("status: draft");
        expect(result.text.endsWith("---\n\nBody.\n")).toBe(true);
    });

    it("overwrites a property that is already there", () => {
        const note = "---\nstatus: draft\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "published" } });

        expect(result.text).toBe("---\nstatus: published\n---\nBody.\n");
        expect(result.changed).toEqual(["status"]);
        expect(result.added).toEqual([]);
    });

    it("leaves a property alone when it already has that value", () => {
        // Setting a property to what it already says would rewrite its
        // formatting for nothing, and would make a batch report changes it did
        // not make.
        const note = "---\nstatus: 'draft'\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "draft" } });

        expect(result.text).toBe(note);
        expect(result.unchanged).toEqual(["status"]);
    });

    it("handles lists, numbers and booleans", () => {
        const note = "Body only.\n";
        const result = editFrontmatter("note.md", note, {
            set: { tags: ["one", "two"], priority: 3, done: false },
        });

        const parsed = parseNote(result.text);
        expect(parsed.properties.tags).toEqual(["one", "two"]);
        expect(parsed.properties.priority).toBe(3);
        expect(parsed.properties.done).toBe(false);
        expect(parsed.body).toBe("Body only.\n");
    });

    it("compares list values structurally, not by identity", () => {
        const note = "---\ntags:\n  - one\n  - two\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { set: { tags: ["one", "two"] } });
        expect(result.unchanged).toEqual(["tags"]);
        expect(result.text).toBe(note);
    });
});

describe("removing properties", () => {
    it("removes one and leaves the others", () => {
        const note = "---\ntitle: A note\nstatus: draft\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { remove: ["status"] });

        expect(result.text).toBe("---\ntitle: A note\n---\nBody.\n");
        expect(result.removed).toEqual(["status"]);
    });

    it("ignores a property that is not there", () => {
        const note = "---\ntitle: A note\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { remove: ["nonexistent"] });

        expect(result.text).toBe(note);
        expect(result.removed).toEqual([]);
    });

    it("drops the block entirely when the last property goes", () => {
        // Left alone, the serialiser emits the empty mapping as the literal
        // `{}`, which is worse than no block at all.
        const note = "---\nstatus: draft\n---\n# Heading\n\nBody.\n";
        const result = editFrontmatter("note.md", note, { remove: ["status"] });

        expect(result.text).toBe("# Heading\n\nBody.\n");
    });
});

describe("refusing to guess", () => {
    it("refuses frontmatter that is not valid YAML", () => {
        const note = "---\ntitle: [unclosed\n---\nBody.\n";
        expect(() => editFrontmatter("broken.md", note, { set: { status: "draft" } })).toThrow(
            FrontmatterUnreadableError
        );
    });

    it("refuses frontmatter that is a list rather than a set of properties", () => {
        const note = "---\n- one\n- two\n---\nBody.\n";
        const error = (() => {
            try {
                editFrontmatter("list.md", note, { set: { status: "draft" } });
            } catch (e) {
                return e as Error;
            }
            return undefined;
        })();

        expect(error).toBeInstanceOf(FrontmatterUnreadableError);
        expect(error?.message).toContain("not a set of properties");
    });
});

describe("leaving the note as the author wrote it", () => {
    it("keeps CRLF line endings", () => {
        const note = "---\r\ntitle: A note\r\n---\r\nBody.\r\n";
        const result = editFrontmatter("note.md", note, { set: { status: "draft" } });

        expect(result.text).toBe("---\r\ntitle: A note\r\nstatus: draft\r\n---\r\nBody.\r\n");
    });

    it("does not treat a horizontal rule further down as frontmatter", () => {
        // A `---` on line 5 is a horizontal rule. Treating it as a block would
        // swallow the four lines above it.
        const note = "# Heading\n\nSome text.\n\n---\n\nMore text.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "draft" } });

        expect(result.text).toBe("---\nstatus: draft\n---\n" + note);
        expect(parseNote(result.text).body).toBe(note);
    });

    it("preserves a multi-line block scalar it was not asked to touch", () => {
        const note = "---\nsummary: |\n  first line\n  second line\nstatus: draft\n---\nBody.\n";
        const result = editFrontmatter("note.md", note, { set: { status: "published" } });

        expect(result.text).toContain("summary: |\n  first line\n  second line\n");
    });

    it("round-trips through the parser", () => {
        const note = "---\ntitle: A note\n---\n# Heading\n\n#inline-tag and a [[wikilink]].\n";
        const result = editFrontmatter("note.md", note, { set: { tags: ["added"] } });
        const parsed = parseNote(result.text);

        expect(parsed.properties.title).toBe("A note");
        expect(parsed.tags).toContain("added");
        expect(parsed.tags).toContain("inline-tag");
        expect(parsed.links.map((l) => l.target)).toContain("wikilink");
    });
});
