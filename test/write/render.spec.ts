/**
 * The renderer's job is to make a review possible, so what these check is not
 * that a string was produced but that the properties a review depends on hold:
 * the totals are stated, destructive changes are never dropped, and truncation
 * is always announced with its count.
 */

import { describe, expect, it } from "vitest";
import { renderPlan } from "../../src/write/render.js";
import type { Plan, PlannedChange } from "../../src/write/plans.js";

const NOW = 1_800_000_000_000;

function change(over: Partial<PlannedChange> & { path: string }): PlannedChange {
    return {
        effect: "update",
        id: over.path,
        rev: "1-a",
        sizeBefore: 100,
        sizeAfter: 120,
        chunksBefore: 1,
        chunksAfter: 1,
        unchanged: false,
        ...over,
    };
}

function planOf(changes: PlannedChange[]): Plan {
    const effective = changes.filter((c) => !c.unchanged);
    return {
        id: "plan-1",
        createdAt: NOW,
        expiresAt: NOW + 15 * 60 * 1000,
        changes,
        totals: {
            creates: effective.filter((c) => c.effect === "create").length,
            updates: effective.filter((c) => c.effect === "update").length,
            deletes: effective.filter((c) => c.effect === "delete").length,
            moves: effective.filter((c) => c.effect === "move").length,
            unchanged: changes.filter((c) => c.unchanged).length,
            bytesBefore: changes.reduce((sum, c) => sum + (c.sizeBefore ?? 0), 0),
            bytesAfter: changes.reduce((sum, c) => sum + (c.sizeAfter ?? 0), 0),
        },
    };
}

const render = (changes: PlannedChange[]) => renderPlan(planOf(changes), { now: NOW });

describe("renderPlan", () => {
    it("leads with the totals", () => {
        const out = render([
            change({ path: "a.md", effect: "create" }),
            change({ path: "b.md" }),
            change({ path: "c.md", effect: "delete", notable: true }),
        ]);

        expect(out.split("\n")[0]).toBe(
            "This plan will change 3 note(s): 1 to create, 1 to change, 1 to delete."
        );
    });

    it("lists every notable change however long the plan is", () => {
        const changes = [
            ...Array.from({ length: 60 }, (_, i) =>
                change({ path: `add-${i}.md`, summary: "adds status = done" })
            ),
            ...Array.from({ length: 30 }, (_, i) =>
                change({ path: `over-${i}.md`, notable: true, summary: "overwrites status (to done)" })
            ),
        ];

        const out = render(changes);

        for (let i = 0; i < 30; i++) expect(out).toContain(`over-${i}.md`);
        expect(out).toContain("Replaces or removes existing content (30, all listed)");
    });

    it("samples the routine changes and says exactly how many it left out", () => {
        const out = render(
            Array.from({ length: 25 }, (_, i) => change({ path: `add-${i}.md`, summary: "adds status" }))
        );

        expect(out).toContain("Adds without replacing anything (25)");
        expect(out).toContain("and 17 more, all of the same shape.");
        expect(out).toContain("add-0.md");
        expect(out).not.toContain("add-20.md");
    });

    it("does not truncate a routine list that fits", () => {
        const out = render(Array.from({ length: 8 }, (_, i) => change({ path: `add-${i}.md` })));
        expect(out).not.toContain("more, all of the same shape");
        expect(out).toContain("add-7.md");
    });

    it("uses the composing tool's words where it supplied any", () => {
        const out = render([change({ path: "a.md", summary: "adds status = archived" })]);
        expect(out).toContain("a.md: adds status = archived");
        expect(out).not.toContain("100 B to 120 B");
    });

    it("falls back to sizes rather than omitting a line", () => {
        const out = render([change({ path: "a.md" })]);
        expect(out).toContain("a.md: 100 B to 120 B");
    });

    it("states the no-ops without listing them", () => {
        const out = render([
            change({ path: "a.md", summary: "adds status" }),
            ...Array.from({ length: 12 }, (_, i) => change({ path: `same-${i}.md`, unchanged: true })),
        ]);

        expect(out).toContain("12 note(s) already say exactly this and will be skipped");
        expect(out).not.toContain("same-0.md");
    });

    it("says there is nothing to do rather than offering an ID to commit", () => {
        const out = render([change({ path: "a.md", unchanged: true })]);
        expect(out).toContain("changes none of them");
        expect(out).toContain("no need to commit it");
        expect(out).not.toContain("plan-1");
    });

    it("prints the ID, the expiry and how to apply it", () => {
        const out = render([change({ path: "a.md" })]);
        expect(out).toContain("Plan plan-1");
        expect(out).toContain("Expires in 15 minute(s), and is single use. Nothing has been written.");
        expect(out).toContain("commit_plan");
        expect(out).toContain("discard_plan");
    });

    it("reports byte movement only when it is worth reading", () => {
        const small = render([change({ path: "a.md", sizeBefore: 100, sizeAfter: 120 })]);
        expect(small).not.toContain("adding");

        const large = render([change({ path: "a.md", sizeBefore: 100, sizeAfter: 100_000 })]);
        expect(large).toContain("adding about 97.6 KiB");
    });

    it("names what was excluded and why", () => {
        const out = renderPlan(planOf([change({ path: "a.md" })]), {
            now: NOW,
            excluded: [{ path: "broken.md", reason: "it is not valid YAML." }],
        });

        expect(out).toContain("Excluded (1):");
        expect(out).toContain("broken.md: it is not valid YAML.");
    });
});

describe("a relocation in a plan", () => {
    it("shows both paths, because the old one is half the change", () => {
        const out = render([
            change({
                path: "Interacts/Superseded/Peter Litzow.pdf",
                from: "Interacts/Peter Litzow.pdf",
                effect: "move",
                notable: true,
            }),
        ]);

        expect(out.split("\n")[0]).toBe("This plan will change 1 note(s): 1 to move.");
        expect(out).toContain("Interacts/Peter Litzow.pdf -> Interacts/Superseded/Peter Litzow.pdf");
    });

    it("never truncates the move itself out of a long plan", () => {
        // The link rewrites are routine and repetitive and get sampled. The
        // relocation is the thing the plan is about, and a plan that showed
        // twenty edits and not the move would be describing the wrong change.
        const rewrites = Array.from({ length: 40 }, (_unused, i) =>
            change({ path: `notes/${i}.md`, summary: "rewrites 1 link" })
        );
        const out = render([
            change({
                path: "Meetings/Minutes.md",
                from: "Meetings/Notes.md",
                effect: "move",
                notable: true,
                summary: "renamed, so 40 links are rewritten",
            }),
            ...rewrites,
        ]);

        expect(out).toContain("Meetings/Notes.md -> Meetings/Minutes.md: renamed, so 40 links are rewritten");
        expect(out).toContain("and 32 more, all of the same shape.");
    });
});
