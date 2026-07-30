import { describe, expect, it } from "vitest";
import { AmbiguousHeadingError, appendUnderHeading } from "../../src/note/sections.js";

describe("appendUnderHeading", () => {
    it("appends at the end of the named section, not the end of the note", () => {
        const note = ["# Day", "", "## Log", "", "- woke up", "", "## Reflections", "", "quiet.", ""].join(
            "\n"
        );

        const { text, headingCreated } = appendUnderHeading(note, "Log", "- had lunch");

        expect(headingCreated).toBe(false);
        expect(text).toBe(
            [
                "# Day",
                "",
                "## Log",
                "",
                "- woke up",
                "- had lunch",
                "",
                "## Reflections",
                "",
                "quiet.",
                "",
            ].join("\n")
        );
    });

    it("keeps the blank line that separates the section from the next heading", () => {
        const note = "## A\n\nfirst\n\n## B\n\nsecond\n";
        const { text } = appendUnderHeading(note, "A", "more");
        expect(text).toContain("first\n\nmore\n\n## B");
    });

    it("treats a deeper heading as part of the section", () => {
        const note = [
            "## Log",
            "",
            "- one",
            "",
            "### Morning",
            "",
            "- two",
            "",
            "## Other",
            "",
            "x",
            "",
        ].join("\n");

        const { text } = appendUnderHeading(note, "Log", "- three");

        // After the subsection, because a subsection belongs to its parent.
        expect(text).toContain("- two\n- three\n\n## Other");
    });

    it("appends to a section that runs to the end of the note", () => {
        const { text } = appendUnderHeading("## Log\n\n- one\n", "Log", "- two");
        // One newline, not two: a blank line between list items ends the list
        // and starts another, which renders as two lists with a gap.
        expect(text).toBe("## Log\n\n- one\n- two\n");
    });

    it("puts the first entry directly under an empty heading", () => {
        const note = "## Log\n\n## Later\n\nx\n";
        const { text } = appendUnderHeading(note, "Log", "- first");
        expect(text).toBe("## Log\n\n- first\n\n## Later\n\nx\n");
    });

    it("creates the heading at the end when it does not exist", () => {
        const result = appendUnderHeading("# Day\n\nsome prose.\n", "Log", "- one");

        expect(result.headingCreated).toBe(true);
        expect(result.level).toBe(2);
        expect(result.text).toBe("# Day\n\nsome prose.\n\n## Log\n\n- one\n");
    });

    it("creates the heading at the requested level", () => {
        const result = appendUnderHeading("x\n", "Log", "- one", { level: 3 });
        expect(result.text).toBe("x\n\n### Log\n\n- one\n");
    });

    it("does not put a gap above the heading in an empty note", () => {
        const result = appendUnderHeading("", "Log", "- one");
        expect(result.text).toBe("## Log\n\n- one\n");
    });

    it("leaves frontmatter untouched and does not search it", () => {
        // A YAML comment at the start of a line is shaped exactly like a
        // level-one heading, and matching it would append into the properties.
        const note = "---\n# Log\ntags: [x]\n---\n\n## Log\n\n- one\n";
        const { text } = appendUnderHeading(note, "Log", "- two");

        expect(text.startsWith("---\n# Log\ntags: [x]\n---\n")).toBe(true);
        expect(text).toBe("---\n# Log\ntags: [x]\n---\n\n## Log\n\n- one\n- two\n");
    });

    it("ignores headings inside fenced code", () => {
        const note = ["## Real", "", "```md", "## Log", "not a heading", "```", "", "text", ""].join("\n");

        const result = appendUnderHeading(note, "Log", "- one");

        expect(result.headingCreated).toBe(true);
        expect(result.text).toContain("```md\n## Log\nnot a heading\n```");
        expect(result.text.trimEnd().endsWith("## Log\n\n- one")).toBe(true);
    });

    it("matches case-insensitively when nothing matches exactly", () => {
        const { text, headingCreated } = appendUnderHeading("## log\n\n- one\n", "Log", "- two");
        expect(headingCreated).toBe(false);
        expect(text).toBe("## log\n\n- one\n- two\n");
    });

    it("prefers an exact match over a differently cased one", () => {
        const note = "## log\n\nlower\n\n## Log\n\nupper\n";
        const { text } = appendUnderHeading(note, "Log", "added");
        expect(text).toBe("## log\n\nlower\n\n## Log\n\nupper\n\nadded\n");
    });

    it("refuses an ambiguous heading rather than picking one", () => {
        const note = "## Log\n\na\n\n## Log\n\nb\n";
        expect(() => appendUnderHeading(note, "Log", "c")).toThrow(AmbiguousHeadingError);
    });

    it("keeps the blank line when what follows a list is not a list item", () => {
        // The rule is about joining a list, not about lists in general. A
        // paragraph after one is a paragraph and needs the gap.
        const { text } = appendUnderHeading("## Log\n\n- one\n", "Log", "And a closing thought.");
        expect(text).toBe("## Log\n\n- one\n\nAnd a closing thought.\n");
    });

    it("keeps the blank line when a list starts after a paragraph", () => {
        const { text } = appendUnderHeading("## Log\n\nSome prose.\n", "Log", "- one");
        expect(text).toBe("## Log\n\nSome prose.\n\n- one\n");
    });

    it("joins a numbered list too, and one that is indented", () => {
        expect(appendUnderHeading("## Log\n\n1. one\n", "Log", "2. two").text).toBe(
            "## Log\n\n1. one\n2. two\n"
        );
        expect(appendUnderHeading("## Log\n\n- one\n", "Log", "  - nested").text).toBe(
            "## Log\n\n- one\n  - nested\n"
        );
    });

    it("honours a custom separator", () => {
        const { text } = appendUnderHeading("## Log\n\n- one\n", "Log", "- two", { separator: "\n" });
        expect(text).toBe("## Log\n\n- one\n- two\n");
    });

    it("keeps the note's line endings", () => {
        const note = "## Log\r\n\r\n- one\r\n\r\n## Next\r\n";
        const { text } = appendUnderHeading(note, "Log", "- two");
        expect(text).toBe("## Log\r\n\r\n- one\r\n- two\r\n\r\n## Next\r\n");
        expect(text).not.toMatch(/[^\r]\n/);
    });

    it("accepts a heading given with its hashes", () => {
        const { text, headingCreated } = appendUnderHeading("## Log\n\n- one\n", "## Log", "- two");
        expect(headingCreated).toBe(false);
        expect(text).toBe("## Log\n\n- one\n- two\n");
    });
});
