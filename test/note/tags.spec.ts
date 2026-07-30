/**
 * Renaming and removing tags in a note.
 *
 * The same shape of risk as the link rewriter: the failure worth guarding
 * against is not a tag left behind, which is visible in the tag inventory, but
 * an edit to something that was never a tag. A word after a hash in a code
 * fence, a heading, a colour in a snippet.
 */

import { describe, expect, it } from "vitest";
import { inlineTags, isUnder, renamed, retagProperty, rewriteInlineTag } from "../../src/note/tags.js";

const rename = (text: string, from: string, to: string) => rewriteInlineTag(text, { from, to });
const drop = (text: string, from: string) => rewriteInlineTag(text, { from, to: undefined });

describe("what counts as being under a tag", () => {
    it("counts the tag itself and anything nested below it", () => {
        expect(isUnder("work", "work")).toBe(true);
        expect(isUnder("work/client", "work")).toBe(true);
        expect(isUnder("work/client/acme", "work")).toBe(true);
    });

    it("does not count a tag that merely starts with the same letters", () => {
        // `#workshop` is not a `#work` tag, and a prefix match without the
        // separator would quietly rename it.
        expect(isUnder("workshop", "work")).toBe(false);
        expect(isUnder("homework", "work")).toBe(false);
    });

    it("carries whatever was nested through a rename", () => {
        expect(renamed("work/client", "work", "client")).toBe("client/client");
        expect(renamed("work", "work", "clients/active")).toBe("clients/active");
    });
});

describe("renaming an inline tag", () => {
    it("changes the tag and nothing around it", () => {
        const out = rename("Called them about #work today.", "work", "client");
        expect(out).toEqual({ text: "Called them about #client today.", changed: 1 });
    });

    it("takes the nested tags with it", () => {
        const out = rename("#work and #work/acme and #work/acme/renewal", "work", "client");
        expect(out.text).toBe("#client and #client/acme and #client/acme/renewal");
        expect(out.changed).toBe(3);
    });

    it("leaves a tag that only starts the same way", () => {
        const out = rename("#work #workshop #homework", "work", "client");
        expect(out.text).toBe("#client #workshop #homework");
        expect(out.changed).toBe(1);
    });

    it("leaves code fences, inline code and frontmatter alone", () => {
        const text = [
            "---",
            "tags: [work]",
            "---",
            "",
            "```sh",
            "# work is a comment here",
            "echo '#work'",
            "```",
            "",
            "`#work` and #work",
        ].join("\n");

        const out = rename(text, "work", "client");
        expect(out.changed).toBe(1);
        expect(out.text).toBe(text.replace("`#work` and #work", "`#work` and #client"));
    });

    it("does not touch a heading", () => {
        // `# Work` is a heading, not a tag, and the rule the parser uses knows
        // the difference because a tag has no space after the hash.
        const out = rename("# Work\n\nSomething about #work.", "work", "client");
        expect(out.text).toBe("# Work\n\nSomething about #client.");
    });
});

describe("removing an inline tag", () => {
    it("takes one space with it, so the sentence still reads", () => {
        expect(drop("Called them about #work today.", "work").text).toBe("Called them about today.");
    });

    it("leaves the line when the tag was the whole of it", () => {
        // An empty line is a smaller edit than deleting a line, and it is at
        // least visible to whoever looks at the note next.
        expect(drop("first\n#work\nlast", "work").text).toBe("first\n\nlast");
    });

    it("does not eat the two trailing spaces that mean a line break", () => {
        const out = drop("a line ending in a break  \n#work", "work");
        expect(out.text).toBe("a line ending in a break  \n");
    });

    it("removes the nested ones too", () => {
        expect(drop("#work #work/acme keep", "work").text).toBe("keep");
    });
});

describe("reading the tags back out", () => {
    it("lists them in order, including repeats", () => {
        expect(inlineTags("#a then #b then #a")).toEqual(["a", "b", "a"]);
    });
});

describe("the frontmatter half", () => {
    it("renames one element of a list and leaves the others", () => {
        expect(retagProperty(["work", "idea"], { from: "work", to: "client" })).toEqual(["client", "idea"]);
    });

    it("keeps a string a string", () => {
        // A note written `tags: work idea` should not silently become a list
        // because something renamed a tag in it.
        expect(retagProperty("work idea", { from: "work", to: "client" })).toBe("client idea");
    });

    it("merges rather than duplicating when the new tag is already there", () => {
        expect(retagProperty(["work", "client"], { from: "work", to: "client" })).toEqual(["client"]);
    });

    it("keeps a leading hash where somebody quoted one", () => {
        expect(retagProperty(["#work"], { from: "work", to: "client" })).toEqual(["#client"]);
    });

    it("renames the nested tags", () => {
        expect(retagProperty(["work/acme"], { from: "work", to: "client" })).toEqual(["client/acme"]);
    });

    it("returns an empty list when the last tag is removed", () => {
        expect(retagProperty(["work"], { from: "work", to: undefined })).toEqual([]);
    });

    it("says nothing happened rather than rewriting a value it did not change", () => {
        // Setting a property to what it already is rewrites its formatting for
        // no reason, and puts a line in a plan for a note that will not change.
        expect(retagProperty(["idea"], { from: "work", to: "client" })).toBeUndefined();
        expect(retagProperty(undefined, { from: "work", to: "client" })).toBeUndefined();
        expect(retagProperty(42, { from: "work", to: "client" })).toBeUndefined();
    });
});
