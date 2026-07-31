/**
 * Rewriting links after a file moves.
 *
 * The failure this guards against is not a link left pointing at nothing, which
 * is loud. It is an edit that changed something other than the link: a mention
 * in prose, an example inside a code fence, the alias somebody chose. Those are
 * silent, and they are somebody's writing.
 */

import { describe, expect, it } from "vitest";
import { renderWikilink, retarget, rewriteLinkTargets } from "../../src/note/links.js";

const rewrite = (text: string, from: string, to: string, targets: string[]) =>
    rewriteLinkTargets(text, { from, to, targets });

describe("retarget", () => {
    it("keeps a basename a basename", () => {
        expect(retarget("Notes", "Meetings/Notes.md", "Archive/Minutes.md")).toBe("Minutes");
        expect(retarget("Notes.md", "Meetings/Notes.md", "Archive/Minutes.md")).toBe("Minutes.md");
    });

    it("gives a link that spelled out folders the whole new path", () => {
        expect(retarget("Meetings/Notes.md", "Meetings/Notes.md", "Archive/Minutes.md")).toBe(
            "Archive/Minutes.md"
        );
        expect(retarget("Meetings/Notes", "Meetings/Notes.md", "Archive/Minutes.md")).toBe("Archive/Minutes");
    });

    it("keeps an extension the link spelled out", () => {
        expect(retarget("Peter Litzow.pdf", "Interacts/Peter Litzow.pdf", "Archive/Pete.pdf")).toBe(
            "Pete.pdf"
        );
    });

    it("leaves off an extension the link left off, whatever it is", () => {
        // Until 31 July 2026 only `.md` came off here, because until then only
        // a note could be named without its extension. Now that `[[Peter
        // Litzow]]` resolves to a PDF, a rename that answered it with `[[Pete
        // Litzow.pdf]]` would be editing somebody's style into their note, one
        // link at a time, for no reason they asked for.
        expect(retarget("Peter Litzow", "Interacts/Peter Litzow.pdf", "Archive/Pete.pdf")).toBe("Pete");
        expect(retarget("Interacts/Peter Litzow", "Interacts/Peter Litzow.pdf", "Archive/Pete.pdf")).toBe(
            "Archive/Pete"
        );
    });
});

describe("rewriteLinkTargets", () => {
    it("changes the target and nothing else", () => {
        const out = rewrite(
            "Before. [[Notes|the minutes]] after.",
            "Meetings/Notes.md",
            "Meetings/Minutes.md",
            ["Notes"]
        );

        expect(out.text).toBe("Before. [[Minutes|the minutes]] after.");
        expect(out.changed).toBe(1);
    });

    it("keeps the subpath and the embed marker", () => {
        const out = rewrite(
            "![[Notes#Actions]] and [[Notes#Actions|jump]]",
            "Meetings/Notes.md",
            "Meetings/Minutes.md",
            ["Notes"]
        );

        expect(out.text).toBe("![[Minutes#Actions]] and [[Minutes#Actions|jump]]");
        expect(out.changed).toBe(2);
    });

    it("keeps the spacing somebody typed inside the brackets", () => {
        const out = rewrite("[[ Notes ]]", "Meetings/Notes.md", "Meetings/Minutes.md", ["Notes"]);
        expect(out.text).toBe("[[ Minutes ]]");
    });

    it("leaves prose that merely says the name alone", () => {
        // The caller passes target strings, not a search term, precisely so
        // that this cannot happen.
        const out = rewrite(
            "Notes is the old name. See [[Notes]].",
            "Meetings/Notes.md",
            "Meetings/Minutes.md",
            ["Notes"]
        );

        expect(out.text).toBe("Notes is the old name. See [[Minutes]].");
        expect(out.changed).toBe(1);
    });

    it("leaves a link inside a code fence alone", () => {
        // The index never read it as a link either, so rewriting it would be
        // editing documentation to suit a file move.
        const text = ["```", "[[Notes]]", "```", "", "[[Notes]]"].join("\n");
        const out = rewrite(text, "Meetings/Notes.md", "Meetings/Minutes.md", ["Notes"]);

        expect(out.text).toBe(["```", "[[Notes]]", "```", "", "[[Minutes]]"].join("\n"));
        expect(out.changed).toBe(1);
    });

    it("leaves inline code and frontmatter alone", () => {
        const text = ["---", "related: [[Notes]]", "---", "", "`[[Notes]]` and [[Notes]]"].join("\n");
        const out = rewrite(text, "Meetings/Notes.md", "Meetings/Minutes.md", ["Notes"]);

        expect(out.text).toBe(
            ["---", "related: [[Notes]]", "---", "", "`[[Notes]]` and [[Minutes]]"].join("\n")
        );
        expect(out.changed).toBe(1);
    });

    it("rewrites several links in one note without disturbing the offsets", () => {
        const out = rewrite(
            "[[Notes]] then [[Meetings/Notes.md]] then ![[Notes|x]]",
            "Meetings/Notes.md",
            "Archive/2026/Minutes.md",
            ["Notes", "Meetings/Notes.md"]
        );

        expect(out.text).toBe("[[Minutes]] then [[Archive/2026/Minutes.md]] then ![[Minutes|x]]");
        expect(out.changed).toBe(3);
    });

    it("rewrites a markdown link, encoding what has to be encoded", () => {
        const out = rewrite(
            "See [the deck](Attachments/Deck.pptx).",
            "Meetings/Attachments/Deck.pptx",
            "Archive/RLT Presentation.pptx",
            ["Attachments/Deck.pptx"]
        );

        expect(out.text).toBe("See [the deck](Archive/RLT%20Presentation.pptx).");
    });

    it("keeps a markdown link's fragment and its label", () => {
        const out = rewrite("[Notes.md](Notes.md#actions)", "Meetings/Notes.md", "Meetings/Minutes.md", [
            "Notes.md",
        ]);

        // The label is the author's words. Only what is inside the parentheses
        // is a path.
        expect(out.text).toBe("[Notes.md](Minutes.md#actions)");
    });

    it("does nothing when no target was given", () => {
        const out = rewrite("[[Notes]]", "Meetings/Notes.md", "Meetings/Minutes.md", []);
        expect(out).toEqual({ text: "[[Notes]]", changed: 0, rewrites: [] });
    });

    it("reports each rewrite as the reader will see it", () => {
        // The plan is a message, and a count is not one. Two links to the same
        // file, differing only in the marker and the subpath, have to arrive as
        // two different lines or the reader learns nothing from either.
        const out = rewrite(
            "[[Notes|the minutes]] and ![[Notes#Actions]]",
            "Meetings/Notes.md",
            "Archive/Minutes.md",
            ["Notes"]
        );

        expect(out.rewrites).toEqual([
            { before: "[[Notes|the minutes]]", after: "[[Minutes|the minutes]]" },
            { before: "![[Notes#Actions]]", after: "![[Minutes#Actions]]" },
        ]);
    });
});

describe("choosing a target that actually resolves", () => {
    /** The duplicate this vault really has. */
    const AFTER = [
        "Interacts/Superseded/Peter Litzow.pdf",
        "Interacts/Superseded/2026/Peter Litzow.pdf",
        "Meetings/Notes.md",
    ];

    it("uses the full path when the short form would name the other file", () => {
        // Without this the rewrite produces the text the link already had, and
        // reports success while leaving the note pointing at the wrong file.
        const out = rewriteLinkTargets("See [[Peter Litzow.pdf]].", {
            from: "Interacts/Peter Litzow.pdf",
            to: "Interacts/Superseded/2026/Peter Litzow.pdf",
            targets: ["Peter Litzow.pdf"],
            paths: AFTER,
        });

        expect(out.text).toBe("See [[Interacts/Superseded/2026/Peter Litzow.pdf]].");
    });

    it("still prefers the short form when it is unambiguous", () => {
        const out = rewriteLinkTargets("See [[Notes]].", {
            from: "Meetings/Notes.md",
            to: "Archive/Minutes.md",
            targets: ["Notes"],
            paths: ["Archive/Minutes.md"],
        });

        expect(out.text).toBe("See [[Minutes]].");
    });

    it("leaves a link alone when the words it already has still point at the file", () => {
        // A move that changes only the folder does not change what a basename
        // means, so there is nothing to rewrite and a plan that claimed
        // otherwise would be asking for consent to a change it is not making.
        // It is also what keeps somebody's own capitalisation: `[[notes]]` is
        // still `Archive/Notes.md` afterwards, so it stays as they wrote it.
        const out = rewriteLinkTargets("See [[notes]] and [[Meetings/Notes]].", {
            from: "Meetings/Notes.md",
            to: "Archive/Notes.md",
            targets: ["notes", "Meetings/Notes"],
            paths: ["Archive/Notes.md"],
        });

        expect(out.text).toBe("See [[notes]] and [[Archive/Notes]].");
        expect(out.changed).toBe(1);
        expect(out.rewrites).toEqual([{ before: "[[Meetings/Notes]]", after: "[[Archive/Notes]]" }]);
    });
});

describe("naming a link in a message", () => {
    it("prints it the way the note has it", () => {
        expect(renderWikilink({ target: "Notes" })).toBe("[[Notes]]");
        expect(renderWikilink({ target: "Notes", embed: true })).toBe("![[Notes]]");
        expect(renderWikilink({ target: "Notes", subpath: "Actions" })).toBe("[[Notes#Actions]]");
        expect(renderWikilink({ target: "Notes", subpath: "Actions", embed: true })).toBe(
            "![[Notes#Actions]]"
        );
    });

    it("distinguishes two links a rename would both affect", () => {
        // The point of it. Reconstructed from the target alone these are the
        // same string, so a refusal listing both prints one line twice and the
        // reader cannot tell an embed is about to change.
        const plain = renderWikilink({ target: "target" });
        const embedded = renderWikilink({ target: "target", subpath: "Detail", embed: true });
        expect(plain).not.toBe(embedded);
    });
});
