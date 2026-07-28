/**
 * Note parsing.
 *
 * The rules here are Obsidian's, not Markdown's, and most of the tests exist
 * for cases where following Markdown would give the wrong answer: a `#` inside
 * a code fence is not a tag, `#2026` is not a tag, `---` halfway down a note is
 * a horizontal rule rather than frontmatter.
 *
 * Getting these wrong does not throw. It quietly pollutes the tag inventory
 * and the link graph, which are exactly the things the vault owner would use
 * to decide what their schema should be.
 */

import { describe, expect, it } from "vitest";
import { classifyProperty, parseNote, propertyValueToText } from "../../src/note/parse.js";

describe("frontmatter", () => {
    it("parses properties and removes the block from the body", () => {
        const note = parseNote("---\ntitle: A Note\ncount: 3\ndone: true\n---\n# Heading\n\nBody.\n");
        expect(note.properties).toEqual({ title: "A Note", count: 3, done: true });
        expect(note.body).toBe("# Heading\n\nBody.\n");
    });

    it("only recognises frontmatter on the very first line", () => {
        // A `---` further down is a horizontal rule. Treating it as
        // frontmatter would swallow real content.
        const text = "Some intro.\n\n---\ntitle: Not Frontmatter\n---\n\nMore.\n";
        const note = parseNote(text);
        expect(note.properties).toEqual({});
        expect(note.body).toBe(text);
    });

    it("accepts an empty frontmatter block", () => {
        const note = parseNote("---\n---\nBody.\n");
        expect(note.properties).toEqual({});
        expect(note.frontmatterError).toBeUndefined();
        expect(note.body).toBe("Body.\n");
    });

    it("reports malformed YAML rather than failing the whole note", () => {
        const note = parseNote("---\ntitle: [unclosed\n---\nBody.\n");
        expect(note.frontmatterError).toBeTruthy();
        expect(note.properties).toEqual({});
        expect(note.body).toBe("Body.\n");
    });

    it("reports frontmatter that is not a mapping", () => {
        const note = parseNote("---\n- one\n- two\n---\nBody.\n");
        expect(note.frontmatterError).toMatch(/array/);
    });

    it("handles CRLF line endings", () => {
        const note = parseNote("---\r\ntitle: Windows\r\n---\r\nBody.\r\n");
        expect(note.properties).toEqual({ title: "Windows" });
    });

    it("copes with a note that is only frontmatter", () => {
        const note = parseNote("---\ntitle: Stub\n---\n");
        expect(note.properties).toEqual({ title: "Stub" });
        expect(note.body).toBe("");
    });
});

describe("tags", () => {
    it("collects inline tags", () => {
        expect(parseNote("Some #project and #area/home here.").tags).toEqual(["area/home", "project"]);
    });

    it("collects frontmatter tags as a list", () => {
        expect(parseNote("---\ntags: [one, two]\n---\n").tags).toEqual(["one", "two"]);
    });

    it("collects frontmatter tags from a space- or comma-separated string", () => {
        expect(parseNote("---\ntags: one, two three\n---\n").tags).toEqual(["one", "three", "two"]);
    });

    it("treats an unquoted hash in frontmatter as a YAML comment", () => {
        // YAML's rule, not a choice made here: `#` after whitespace starts a
        // comment, so everything from `#two` onwards is discarded. Worth
        // pinning, because it surprises people writing frontmatter by hand.
        expect(parseNote("---\ntags: one #two, three\n---\n").tags).toEqual(["one"]);
    });

    it("keeps hashed tags when the string is quoted", () => {
        expect(parseNote('---\ntags: "#one #two"\n---\n').tags).toEqual(["one", "two"]);
    });

    it("accepts the legacy singular tag key", () => {
        expect(parseNote("---\ntag: solo\n---\n").tags).toEqual(["solo"]);
    });

    it("merges frontmatter and inline tags without duplicates", () => {
        expect(parseNote("---\ntags: [shared]\n---\n#shared and #other").tags).toEqual(["other", "shared"]);
    });

    it("ignores purely numeric tags, as Obsidian does", () => {
        expect(parseNote("Issue #1 and year #2026 and #v2").tags).toEqual(["v2"]);
    });

    it("ignores a hash that is not at a word boundary", () => {
        expect(parseNote("colour#3 and https://example.com/#anchor").tags).toEqual([]);
    });

    it("ignores tags inside fenced code blocks", () => {
        const note = parseNote("Real #tag\n\n```bash\n# not a comment tag\necho '#nope'\n```\n");
        expect(note.tags).toEqual(["tag"]);
    });

    it("ignores tags inside inline code", () => {
        expect(parseNote("Use `#include <stdio.h>` and tag #real").tags).toEqual(["real"]);
    });

    it("ignores tags inside math", () => {
        expect(parseNote("$x \\#y$ and #real").tags).toEqual(["real"]);
    });

    it("accepts a tag opening a line or following a bracket", () => {
        expect(parseNote("#first\n(#second) [#third]").tags).toEqual(["first", "second", "third"]);
    });
});

describe("wikilinks", () => {
    it("finds plain links", () => {
        const [link] = parseNote("See [[Another Note]].").links;
        expect(link).toMatchObject({ target: "Another Note", embed: false });
    });

    it("separates the alias", () => {
        const [link] = parseNote("See [[Target|the display text]].").links;
        expect(link).toMatchObject({ target: "Target", alias: "the display text" });
    });

    it("separates a heading reference", () => {
        const [link] = parseNote("See [[Target#Some Heading]].").links;
        expect(link).toMatchObject({ target: "Target", subpath: "Some Heading" });
    });

    it("handles a heading and an alias together", () => {
        const [link] = parseNote("See [[Target#Heading|shown]].").links;
        expect(link).toMatchObject({ target: "Target", subpath: "Heading", alias: "shown" });
    });

    it("marks embeds", () => {
        const [link] = parseNote("![[image.png]]").links;
        expect(link).toMatchObject({ target: "image.png", embed: true });
    });

    it("treats a same-note anchor as having no target", () => {
        const [link] = parseNote("See [[#Just A Heading]].").links;
        expect(link).toMatchObject({ target: "", subpath: "Just A Heading" });
    });

    it("ignores links inside code fences", () => {
        expect(parseNote("```\n[[not a link]]\n```\n[[real]]").links).toHaveLength(1);
    });

    it("finds several links on one line", () => {
        expect(parseNote("[[a]] then [[b]] then [[c]]").links.map((l) => l.target)).toEqual(["a", "b", "c"]);
    });
});

describe("markdown links", () => {
    it("finds links to vault files", () => {
        expect(parseNote("See [the note](folder/note.md).").markdownLinks).toEqual(["folder/note.md"]);
    });

    it("decodes percent-encoded paths", () => {
        expect(parseNote("[x](folder/a%20note.md)").markdownLinks).toEqual(["folder/a note.md"]);
    });

    it("excludes external URLs", () => {
        const note = parseNote("[a](https://example.com) [b](mailto:x@y.z) [c](note.md)");
        expect(note.markdownLinks).toEqual(["note.md"]);
    });

    it("excludes same-note anchors", () => {
        expect(parseNote("[a](#heading)").markdownLinks).toEqual([]);
    });

    it("strips a heading fragment from the target", () => {
        expect(parseNote("[a](note.md#heading)").markdownLinks).toEqual(["note.md"]);
    });
});

describe("headings", () => {
    it("records level and text", () => {
        const note = parseNote("# One\n\n## Two\n\n###### Six\n");
        expect(note.headings).toEqual([
            { level: 1, text: "One" },
            { level: 2, text: "Two" },
            { level: 6, text: "Six" },
        ]);
    });

    it("ignores a hash run inside a code fence", () => {
        expect(parseNote("```\n# Not a heading\n```\n# Real\n").headings).toEqual([
            { level: 1, text: "Real" },
        ]);
    });

    it("strips trailing hashes", () => {
        expect(parseNote("## Closed ##\n").headings).toEqual([{ level: 2, text: "Closed" }]);
    });
});

describe("property classification", () => {
    it("names the shapes a person would use when designing a schema", () => {
        expect(classifyProperty("some text")).toBe("text");
        expect(classifyProperty(42)).toBe("number");
        expect(classifyProperty(true)).toBe("checkbox");
        expect(classifyProperty("2026-07-28")).toBe("date");
        expect(classifyProperty("2026-07-28T09:30:00")).toBe("datetime");
        expect(classifyProperty(["a", "b"])).toBe("list");
    });

    it("treats null, undefined and empty string as empty", () => {
        expect(classifyProperty(null)).toBe("empty");
        expect(classifyProperty(undefined)).toBe("empty");
        expect(classifyProperty("")).toBe("empty");
    });

    it("does not mistake a version number for a date", () => {
        expect(classifyProperty("2026-07")).toBe("text");
        expect(classifyProperty("1.2.3")).toBe("text");
    });

    it("renders values for display and exact matching", () => {
        expect(propertyValueToText(["a", "b"])).toBe("a, b");
        expect(propertyValueToText(true)).toBe("true");
        expect(propertyValueToText(null)).toBe("");
    });
});

describe("robustness", () => {
    it("handles an empty note", () => {
        const note = parseNote("");
        expect(note.tags).toEqual([]);
        expect(note.links).toEqual([]);
        expect(note.body).toBe("");
    });

    it("handles a note that is only a code fence", () => {
        expect(parseNote("```\n#tag [[link]]\n```").tags).toEqual([]);
    });

    it("handles an unterminated code fence without hanging", () => {
        // A masking regex that requires a closing fence must not backtrack
        // catastrophically on one that never closes.
        const note = parseNote("```\n#tag\n" + "x".repeat(5000));
        expect(note).toBeTruthy();
    });
});
