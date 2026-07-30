/**
 * Link resolution, and what moving a file would do to it.
 *
 * Two things are being checked here and they are worth separating. The first is
 * where a link points, which used to be a parity check between a SQL copy of
 * the rule and a code copy of it, and is now a table of the answers Obsidian
 * gives. The second is the impact of a move, where the case that matters is not
 * the broken link but the silent one: a link that still resolves, to something
 * else.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { VaultIndex } from "../../src/index/index.js";
import { candidateTargets, resolveTarget } from "../../src/index/resolve.js";
import { asDocumentID, asVaultPath, type AssembledFile } from "../../src/vault-model/types.js";

let index: VaultIndex;

function note(path: string, text = ""): AssembledFile {
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

function binary(path: string): AssembledFile {
    return {
        path: asVaultPath(path),
        id: asDocumentID(path.toLowerCase()),
        rev: "1-a",
        kind: "binary",
        bytes: new Uint8Array(16),
        ctime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        size: 16,
        deleted: false,
        children: ["h:bin"],
    } as AssembledFile;
}

beforeEach(() => {
    index = new VaultIndex(":memory:");
    index.open();
});

afterEach(() => {
    index.close();
});

describe("resolving a link", () => {
    /**
     * One vault, one table of cases.
     *
     * This used to assert that two implementations of the rule agreed with each
     * other, because there were two: four UPDATE passes in SQL and a mirror of
     * them in code. There is one now, so the useful question is no longer
     * whether the copies match but whether the answers are right, and these are
     * the answers Obsidian gives.
     */
    beforeEach(() => {
        index.put(binary("Interacts/Anthony Chaytors.pdf"));
        index.put(binary("Interacts/Peter Litzow.pdf"));
        index.put(binary("Interacts/Superseded/Peter Litzow.pdf"));
        index.put(binary("Meetings/RLT/Attachments/Deck.pptx"));
        index.put(note("Meetings/RLT/Strategy.md"));
        index.put(note("report-2026.md"));
    });

    const cases: [string, string | undefined][] = [
        ["Meetings/RLT/Strategy.md", "Meetings/RLT/Strategy.md"], // the whole path
        ["Meetings/RLT/Strategy", "Meetings/RLT/Strategy.md"], // the path, no extension
        ["Deck.pptx", "Meetings/RLT/Attachments/Deck.pptx"], // a name with its extension
        ["Strategy", "Meetings/RLT/Strategy.md"], // a note's name alone
        ["Attachments/Deck.pptx", "Meetings/RLT/Attachments/Deck.pptx"], // part of a path
        ["Anthony Chaytors", "Interacts/Anthony Chaytors.pdf"], // an attachment, unextended
        ["Attachments/Deck", "Meetings/RLT/Attachments/Deck.pptx"], // both at once
        ["RLT/Attachments/Deck.pptx", "Meetings/RLT/Attachments/Deck.pptx"], // any tail, not just the last
        ["ts/Deck.pptx", undefined], // and only tails that start where a folder does
        ["anthony chaytors", "Interacts/Anthony Chaytors.pdf"], // case does not matter
        ["Peter Litzow", "Interacts/Peter Litzow.pdf"], // the shallower of two
        ["report_2026", undefined], // an underscore is a character, not a wildcard
        ["Nothing At All", undefined],
    ];

    for (const [target, expected] of cases) {
        it(`resolves [[${target}]] to ${expected ?? "nothing"}`, () => {
            index.put(note("Hub.md", `[[${target}]]`));
            index.resolveLinks();

            // Through the index, which is what every tool reads, and through
            // the resolver directly, which is what resolutionImpact asks.
            expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBe(expected);
            expect(resolveTarget(target, index.allPaths())).toBe(expected);
        });
    }

    it("prefers a note over an attachment of the same name", () => {
        // Obsidian's own preference, and the reason the extensionless passes
        // sit below the two that append ".md" rather than replacing them.
        index.put(note("Interacts/Anthony Chaytors.md"));
        index.put(note("Hub.md", "[[Anthony Chaytors]]"));
        index.resolveLinks();

        expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBe("Interacts/Anthony Chaytors.md");
    });

    it("prefers an exact case match to a shorter path", () => {
        index.put(note("README.md"));
        index.put(note("archive/readme.md"));
        index.put(note("Hub.md", "[[readme]]"));
        index.resolveLinks();

        expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBe("archive/readme.md");
    });

    it("clears a link that no longer resolves", () => {
        index.put(note("Hub.md", "[[Strategy]]"));
        index.resolveLinks();
        expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBe("Meetings/RLT/Strategy.md");

        index.remove("Meetings/RLT/Strategy.md");
        index.resolveLinks();
        expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBeUndefined();
    });
});

describe("candidateTargets", () => {
    it("lists every way a link could name a path", () => {
        expect(candidateTargets("Meetings/RLT/Notes.md").sort()).toEqual(
            [
                "Meetings/RLT/Notes.md",
                "Meetings/RLT/Notes",
                "RLT/Notes.md",
                "RLT/Notes",
                "Notes.md",
                "Notes",
            ].sort()
        );
    });

    it("drops any extension, not only .md", () => {
        // The half that was missing. Without the unextended forms here,
        // resolutionImpact never asks about `[[Peter Litzow]]`, and a move of
        // that PDF reports that no link would be affected.
        expect(candidateTargets("Interacts/Peter Litzow.pdf").sort()).toEqual(
            [
                "Interacts/Peter Litzow.pdf",
                "Interacts/Peter Litzow",
                "Peter Litzow.pdf",
                "Peter Litzow",
            ].sort()
        );
    });
});

describe("resolutionImpact", () => {
    /** The vault as it really is, in the part that matters: a duplicate name. */
    beforeEach(() => {
        index.put(binary("Interacts/Peter Litzow.pdf"));
        index.put(binary("Interacts/Superseded/Peter Litzow.pdf"));
        index.put(note("Meetings/Notes.md", "Saw [[Peter Litzow.pdf]] about it."));
        index.resolveLinks();
    });

    it("reports nothing for a move that changes no resolution", () => {
        // The common case, and a false positive here would block it. The link
        // is a basename, so the folder it points into is not its business.
        index.put(binary("Interacts/Current/Placeholder.pdf"));
        index.resolveLinks();

        const impact = index.resolutionImpact("Interacts/Current/Placeholder.pdf", "Archive/Placeholder.pdf");
        expect(impact).toEqual({ breaks: [], repoints: [] });
    });

    it("reports the repoint when a moved file loses a name to its own duplicate", () => {
        // The real one. `[[Peter Litzow]]` resolves to the shorter path today;
        // move that file deeper and the same text names the superseded copy,
        // with nothing broken and nothing changed in any note.
        const impact = index.resolutionImpact(
            "Interacts/Peter Litzow.pdf",
            "Interacts/Superseded/2026/Peter Litzow.pdf"
        );

        expect(impact.breaks).toEqual([]);
        expect(impact.repoints).toEqual([
            {
                source: "Meetings/Notes.md",
                target: "Peter Litzow.pdf",
                was: "Interacts/Peter Litzow.pdf",
                becomes: "Interacts/Superseded/Peter Litzow.pdf",
            },
        ]);
    });

    it("says nothing when a link simply follows the file it names", () => {
        // A basename link to a file that moves within the vault still resolves
        // to that file. Reporting it would make every ordinary move look
        // dangerous, which is how a warning stops being read.
        const impact = index.resolutionImpact("Meetings/Notes.md", "Archive/Notes.md");
        expect(impact).toEqual({ breaks: [], repoints: [] });
    });

    it("reports a break when a link names the path rather than the file", () => {
        index.put(note("Hub.md", "See [[Interacts/Peter Litzow.pdf]]."));
        index.resolveLinks();

        const impact = index.resolutionImpact("Interacts/Peter Litzow.pdf", "Archive/Peter Litzow.pdf");
        expect(impact.breaks).toContainEqual({ source: "Hub.md", target: "Interacts/Peter Litzow.pdf" });
    });

    it("reports a break when a rename takes the name a link uses", () => {
        index.put(note("Hub.md", "See [[Meetings/Notes]] and ![[Notes]]."));
        index.resolveLinks();

        const impact = index.resolutionImpact("Meetings/Notes.md", "Meetings/Minutes.md");
        expect(impact.breaks.map((link) => link.target).sort()).toEqual(["Meetings/Notes", "Notes"]);
        expect(impact.repoints).toEqual([]);
    });

    it("counts a plain link and an embed of the same note separately", () => {
        // The count goes in a refusal that sends people to plan_move, and
        // plan_move rewrites both, so reporting one was a message disagreeing
        // with the tool it recommends. An alias is not a separate link: it
        // changes what the reader sees and nothing about what resolves, and
        // the index does not record it as its own row either.
        index.put(note("Hub.md", "[[Peter Litzow.pdf|Pete]] and ![[Peter Litzow.pdf#Findings]]"));
        index.resolveLinks();

        const impact = index.resolutionImpact(
            "Interacts/Peter Litzow.pdf",
            "Interacts/Superseded/2026/Peter Litzow.pdf"
        );

        const fromHub = impact.repoints.filter((repoint) => repoint.source === "Hub.md");
        expect(fromHub.length).toBe(2);
        expect(fromHub.map((link) => [link.subpath, link.embed])).toEqual([
            [undefined, undefined],
            ["Findings", true],
        ]);
    });

    it("finds the break whether the link is plain or an embed", () => {
        // The half of this that was never in doubt, asserted so it stays that
        // way: resolution reads the target and nothing else, so collapsing two
        // link rows that share a target could only ever undercount a report,
        // never hide a break or a repoint.
        index.put(note("Embeds.md", "![[Meetings/Notes]]"));
        index.resolveLinks();

        const impact = index.resolutionImpact("Meetings/Notes.md", "Meetings/Minutes.md");
        expect(impact.breaks).toEqual([{ source: "Embeds.md", target: "Meetings/Notes", embed: true }]);
    });

    it("reports a copy that would take a link from the file it was copied from", () => {
        // A copy adds a basename rather than moving one, so nothing breaks and
        // the original is still there. If the copy lands on a shorter path it
        // takes the inbound links anyway, which is the same silent failure as a
        // repoint and arrives through the tool least likely to be reviewed.
        const impact = index.resolutionImpact("Interacts/Superseded/Peter Litzow.pdf", "Peter Litzow.pdf", {
            keepSource: true,
        });

        expect(impact.breaks).toEqual([]);
        expect(impact.repoints).toEqual([
            {
                source: "Meetings/Notes.md",
                target: "Peter Litzow.pdf",
                was: "Interacts/Peter Litzow.pdf",
                becomes: "Peter Litzow.pdf",
            },
        ]);
    });

    it("treats a copy that keeps the original's links as no impact at all", () => {
        const impact = index.resolutionImpact(
            "Interacts/Peter Litzow.pdf",
            "Interacts/Superseded/Copies/Peter Litzow.pdf",
            { keepSource: true }
        );
        expect(impact).toEqual({ breaks: [], repoints: [] });
    });
});
