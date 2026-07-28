/**
 * The guards that keep a write test off the real vault.
 *
 * Worth testing properly despite being twenty lines, because they are the only
 * thing standing between a mistyped argument and a script that writes to a live
 * vault, and because every case here is one nobody will think to try by hand.
 */

import { describe, expect, it } from "vitest";
import {
    assertScratchDatabase,
    MissingDatabaseError,
    ProtectedDatabaseError,
    TooManyDevicesError,
} from "../../src/write/scratch.js";
import type { MilestoneEntry } from "../../src/vault-model/index.js";

const milestoneWith = (nodes: string[]) => ({ accepted_nodes: nodes }) as unknown as MilestoneEntry;

describe("refusing the wrong database", () => {
    it("refuses the live vault by name", () => {
        expect(() => assertScratchDatabase("obsidiandb", { milestone: undefined })).toThrow(
            ProtectedDatabaseError
        );
    });

    it("refuses it whatever the casing or surrounding whitespace", () => {
        for (const name of ["ObsidianDB", "OBSIDIANDB", "  obsidiandb  "]) {
            expect(() => assertScratchDatabase(name, { milestone: undefined })).toThrow(
                ProtectedDatabaseError
            );
        }
    });

    it("refuses the other names a person reaches for when they mean the real one", () => {
        for (const name of ["obsidian", "vault", "livesync", "notes"]) {
            expect(() => assertScratchDatabase(name, { milestone: undefined })).toThrow(
                ProtectedDatabaseError
            );
        }
    });

    it("has no default and refuses an empty name", () => {
        expect(() => assertScratchDatabase(undefined, { milestone: undefined })).toThrow(
            MissingDatabaseError
        );
        expect(() => assertScratchDatabase("   ", { milestone: undefined })).toThrow(MissingDatabaseError);
    });

    it("refuses a database that several devices have synced to", () => {
        // The name is fine. The database is not: this is what a real vault
        // under a scratch-sounding name looks like.
        const error = (() => {
            try {
                assertScratchDatabase("obsidian-writetest", { milestone: milestoneWith(["a", "b", "c"]) });
            } catch (e) {
                return e as TooManyDevicesError;
            }
            return undefined;
        })();

        expect(error).toBeInstanceOf(TooManyDevicesError);
        expect(error?.message).toContain("--expect-devices 3");
    });

    it("allows several devices when the caller says so explicitly", () => {
        expect(() =>
            assertScratchDatabase("obsidian-writetest", {
                milestone: milestoneWith(["a", "b", "c"]),
                expectedDevices: 3,
            })
        ).not.toThrow();
    });
});

describe("allowing a genuine scratch database", () => {
    it("allows one with a single device synced", () => {
        expect(() =>
            assertScratchDatabase("obsidian-writetest", { milestone: milestoneWith(["laptop"]) })
        ).not.toThrow();
    });

    it("allows one nothing has synced to yet", () => {
        // A database with no milestone is what you have in the minutes between
        // creating it and pointing Obsidian at it. Refusing that would make the
        // guard fire on the correct workflow.
        expect(() => assertScratchDatabase("obsidian-writetest", { milestone: undefined })).not.toThrow();
    });
});
