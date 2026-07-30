/**
 * Link resolution, and what moving a file would do to it.
 *
 * Two things are being checked here and they are worth separating. The first is
 * that the code copy of the resolution rule agrees with the SQL copy, because
 * `resolutionImpact` answers a hypothetical question that no table can answer
 * and therefore had to restate the rule. The second is the impact itself, where
 * the case that matters is not the broken link but the silent one: a link that
 * still resolves, to something else.
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

/** How the index resolved each link, as a map from "source|target". */
function resolvedByIndex(): Map<string, string | undefined> {
    const out = new Map<string, string | undefined>();
    for (const path of index.allPaths()) {
        for (const link of index.outgoingLinks(path)) {
            out.set(`${path}|${link.target}`, link.resolvedPath);
        }
    }
    return out;
}

beforeEach(() => {
    index = new VaultIndex(":memory:");
    index.open();
});

afterEach(() => {
    index.close();
});

describe("the two copies of the resolution rule", () => {
    it("agree on every link in a vault that exercises all four passes", () => {
        // One note per pass, plus the shapes that have caught this out before:
        // a duplicate basename, a partial path, a case difference, and an
        // underscore that LIKE would otherwise read as a wildcard.
        index.put(binary("Interacts/Peter Litzow.pdf"));
        index.put(binary("Interacts/Superseded/Peter Litzow.pdf"));
        index.put(binary("Meetings/RLT/Attachments/Deck.pptx"));
        index.put(note("Meetings/RLT/Strategy.md"));
        index.put(note("report-2026.md"));
        index.put(
            note(
                "Hub.md",
                [
                    "[[Meetings/RLT/Strategy.md]]", // exact path
                    "[[Meetings/RLT/Strategy]]", // path without the extension
                    "![[Deck.pptx]]", // basename with extension
                    "[[Strategy]]", // basename without
                    "[[Attachments/Deck.pptx]]", // a partial path
                    "[[peter litzow]]", // a case difference
                    "[[report_2026]]", // an underscore, not a wildcard
                    "[[Nothing At All]]", // resolves to nothing
                ].join("\n\n")
            )
        );
        index.resolveLinks();

        const paths = index.allPaths();
        const fromSql = resolvedByIndex();
        expect(fromSql.size).toBe(8);

        for (const [key, resolved] of fromSql) {
            const target = key.slice(key.indexOf("|") + 1);
            expect(resolveTarget(target, paths), `resolving "${target}"`).toBe(resolved);
        }
    });

    it("does not resolve an extensionless link to a file that is not a note", () => {
        // Obsidian would: `[[Peter Litzow]]` opens the PDF when nothing else
        // carries that name. Both copies of the rule here only ever append
        // ".md", so the link is broken instead. Written down rather than
        // fixed, because changing what an existing link means is not a thing
        // to do inside a change about moving files, and a link this reports as
        // broken is at least visible in vault_health.
        index.put(binary("Interacts/Peter Litzow.pdf"));
        index.put(note("Hub.md", "[[Peter Litzow]]"));
        index.resolveLinks();

        expect(index.outgoingLinks("Hub.md")[0]?.resolvedPath).toBeUndefined();
        expect(resolveTarget("Peter Litzow", index.allPaths())).toBeUndefined();
    });

    it("does not let an underscore in a link act as a wildcard", () => {
        // `[[report_2026]]` matching `report-2026.md` is what LIKE does
        // unescaped, and it decides what a link means rather than merely what a
        // listing includes.
        index.put(note("notes/report-2026.md"));
        index.put(note("Hub.md", "[[report_2026]]"));
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

    it("does not offer to drop an extension that is not .md", () => {
        expect(candidateTargets("Interacts/Peter Litzow.pdf").sort()).toEqual(
            ["Interacts/Peter Litzow.pdf", "Peter Litzow.pdf"].sort()
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

    it("counts an alias, a subpath and an embed as the same link", () => {
        // The target is what resolves. What the reader sees, which heading it
        // jumps to, and whether it renders inline are all downstream of that.
        index.put(
            note(
                "Aliased.md",
                "[[Peter Litzow.pdf|Pete]] and [[Peter Litzow.pdf#Findings]] and ![[Peter Litzow.pdf]]"
            )
        );
        index.resolveLinks();

        const impact = index.resolutionImpact(
            "Interacts/Peter Litzow.pdf",
            "Interacts/Superseded/2026/Peter Litzow.pdf"
        );
        const sources = impact.repoints.map((repoint) => repoint.source).sort();
        expect(sources).toEqual(["Aliased.md", "Meetings/Notes.md"]);
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
