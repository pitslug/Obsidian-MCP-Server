/**
 * What the server says about itself.
 *
 * These read like tests of prose, and they are tests of a claim. The string
 * this replaced said the server was read-only, and went on saying it after
 * writing was turned on, so every client was told that editing was impossible
 * while twelve tools that edit sat registered behind the sentence. Nothing
 * failed. Nothing could fail, because nothing was checking.
 */

import { describe, expect, it } from "vitest";
import { CONVENTIONS_LIMIT, serverInstructions, trimConventions } from "../../src/server/instructions.js";

describe("when the deployment is read-only", () => {
    const text = serverInstructions({ readOnly: true, conventions: undefined });

    it("says so", () => {
        expect(text).toContain("read-only");
    });

    it("does not describe writing as something to do carefully", () => {
        // The failure in the other direction: telling a client how to write
        // responsibly, on a server where every write tool is absent, invites
        // it to look for tools that are not there.
        expect(text).not.toContain("Writing is enabled");
        expect(text).not.toContain("commit_plan");
    });
});

describe("when writing is enabled", () => {
    const text = serverInstructions({ readOnly: false, conventions: undefined });

    it("does not tell the client the server is read-only", () => {
        expect(text).not.toContain("read-only");
    });

    it("says the plan has to be shown to somebody before it is committed", () => {
        // The plan protocol only buys anything if the review in the middle
        // happens, and the client is the only thing in a position to do it.
        expect(text).toContain("commit_plan");
        expect(text.toLowerCase()).toContain("shown to the person");
    });

    it("says a delete can usually be undone, and when it cannot", () => {
        // This sentence said the opposite until 31 July 2026, after
        // restore_note had existed for a day. A model reading the old one
        // would not offer the undo, which made the tool that exists to make a
        // delete recoverable invisible at the moment it was wanted.
        expect(text).toContain("restore_note");
        expect(text.toLowerCase()).toContain("collected the pieces");
        expect(text.toLowerCase()).not.toContain("cannot be undone");
    });

    it("points at vault_status rather than listing the tools itself", () => {
        // One list, built by the registrations. A copy here would be a third
        // place for the same fact to be written, and the count in the startup
        // warning has already been wrong once.
        expect(text).toContain("vault_status");
        expect(text).not.toContain("create_note");
        expect(text).not.toContain("move_file");
    });
});

describe("the vault's own conventions", () => {
    const guide = "# How this vault works\n\nTags are singular. Meetings go under Meetings/.";

    it("are reproduced, and named as the vault's own", () => {
        const text = serverInstructions({
            readOnly: false,
            conventions: trimConventions("CLAUDE.md", guide),
        });

        expect(text).toContain("CLAUDE.md");
        expect(text).toContain("Tags are singular.");
    });

    it("win over whatever the client would otherwise do", () => {
        const text = serverInstructions({
            readOnly: false,
            conventions: trimConventions("CLAUDE.md", guide),
        });
        expect(text.toLowerCase()).toContain("wins over");
    });

    it("say when they were cut short, rather than trailing off", () => {
        const long = `${"a".repeat(CONVENTIONS_LIMIT)}\n\nThe part that got cut.`;
        const conventions = trimConventions("CLAUDE.md", long);

        expect(conventions.truncated).toBe(true);
        expect(conventions.text.length).toBeLessThanOrEqual(CONVENTIONS_LIMIT);
        expect(conventions.text).not.toContain("The part that got cut.");

        const text = serverInstructions({ readOnly: false, conventions });
        expect(text).toContain("read_note");
        expect(text).toContain("longer than fits");
    });

    it("are left exactly as written when they fit", () => {
        const conventions = trimConventions("CLAUDE.md", `\n${guide}\n`);
        expect(conventions).toEqual({ path: "CLAUDE.md", text: guide, truncated: false });
    });
});
