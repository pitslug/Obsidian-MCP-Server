/**
 * Our path↔ID mapping against the plugin's.
 *
 * Getting this wrong does not throw. It writes a document at an ID nobody
 * reads, leaving the original untouched and a duplicate behind — so it is worth
 * testing harder than the failure mode suggests.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
    hashString,
    idToPath,
    normalizePrefixedPath,
    normalizeVaultPath,
    pathToId,
    assertSyncablePath,
    ObfuscatedIdError,
    UnsyncablePathError,
} from "../../src/vault-model/ids.js";
import { upstreamId2Path, upstreamPath2Id } from "../helpers/upstream.js";

const PASSPHRASE = "correct horse battery staple";

/** Paths the plugin actually produces, plus the awkward corners. */
const paths = (): fc.Arbitrary<string> =>
    fc.oneof(
        fc.constantFrom(
            "note.md",
            "Note.MD",
            "folder/note.md",
            "folder/sub folder/note with spaces.md",
            "_underscore.md",
            "_/nested.md",
            "日本語/ノート.md",
            "emoji 👋.md",
            "i:.obsidian/plugins/foo/data.json",
            "ix:device/plugin/name.md",
            "ps:something",
            "attachments/image.png",
            ".hidden.md",
            "a".repeat(200) + ".md"
        ),
        fc
            .array(
                fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes(":")),
                {
                    minLength: 1,
                    maxLength: 4,
                }
            )
            .map((parts) => parts.join("/") + ".md")
    );

describe("pathToId vs the plugin", () => {
    it("agrees with obfuscation off, case-insensitive", async () => {
        await fc.assert(
            fc.asyncProperty(paths(), async (path) => {
                expect(
                    await pathToId(path, {
                        obfuscatePassphrase: false,
                        caseInsensitive: true,
                        skipNormalize: true,
                    })
                ).toBe(await upstreamPath2Id(path, false, true));
            }),
            { numRuns: 200 }
        );
    });

    it("agrees with obfuscation off, case-sensitive", async () => {
        await fc.assert(
            fc.asyncProperty(paths(), async (path) => {
                expect(
                    await pathToId(path, {
                        obfuscatePassphrase: false,
                        caseInsensitive: false,
                        skipNormalize: true,
                    })
                ).toBe(await upstreamPath2Id(path, false, false));
            }),
            { numRuns: 200 }
        );
    });

    it("agrees with obfuscation on", async () => {
        await fc.assert(
            fc.asyncProperty(paths(), fc.boolean(), async (path, caseInsensitive) => {
                expect(
                    await pathToId(path, {
                        obfuscatePassphrase: PASSPHRASE,
                        caseInsensitive,
                        skipNormalize: true,
                    })
                ).toBe(await upstreamPath2Id(path, PASSPHRASE, caseInsensitive));
            }),
            { numRuns: 200 }
        );
    });

    it("agrees on already-obfuscated input", async () => {
        const already = "f:deadbeef";
        expect(
            await pathToId(already, {
                obfuscatePassphrase: PASSPHRASE,
                caseInsensitive: true,
                skipNormalize: true,
            })
        ).toBe(await upstreamPath2Id(already, PASSPHRASE, true));
    });
});

describe("idToPath vs the plugin", () => {
    it("agrees for unobfuscated IDs", async () => {
        await fc.assert(
            fc.asyncProperty(paths(), async (path) => {
                const id = await pathToId(path, {
                    obfuscatePassphrase: false,
                    caseInsensitive: false,
                    skipNormalize: true,
                });
                expect(idToPath(id)).toBe(upstreamId2Path(id));
            }),
            { numRuns: 200 }
        );
    });

    it("prefers the document's path field over the ID", async () => {
        const id = await pathToId("Folder/Note.md", {
            obfuscatePassphrase: false,
            caseInsensitive: true,
        });
        expect(id).toBe("folder/note.md");
        expect(idToPath(id)).toBe("folder/note.md");
        // Which is why reads must use `path`: the ID has lost the casing.
        expect(upstreamId2Path(id, { path: "Folder/Note.md" })).toBe("Folder/Note.md");
    });
});

describe("hashString", () => {
    it("equals a single SHA-256, despite upstream's loop", async () => {
        await fc.assert(
            fc.asyncProperty(fc.string({ maxLength: 200 }), async (input) => {
                const expected = Buffer.from(
                    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
                ).toString("hex");
                expect(await hashString(input)).toBe(expected);
            }),
            { numRuns: 100 }
        );
    });
});

describe("path normalisation", () => {
    it("makes the mapping invertible for any path", async () => {
        // Without normalisation a path beginning with "/" is not recoverable:
        // idToPath strips a leading slash, because that is how a leading "_" is
        // escaped. The plugin avoids this by normalising first, and so do we.
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(paths(), fc.constantFrom("/leading.md", "/ / .md", "a//b.md", "trailing/")),
                async (path) => {
                    const normalized = normalizeVaultPath(path);
                    const id = await pathToId(path, {
                        obfuscatePassphrase: false,
                        caseInsensitive: false,
                    });
                    // Prefixed paths keep their prefix; compare on the body.
                    if (!path.includes(":")) expect(idToPath(id)).toBe(normalized);
                }
            ),
            { numRuns: 200 }
        );
    });

    it("collapses duplicate separators and trims the ends", () => {
        expect(normalizeVaultPath("/folder//note.md")).toBe("folder/note.md");
        expect(normalizeVaultPath("folder\\note.md")).toBe("folder/note.md");
        expect(normalizeVaultPath("folder/")).toBe("folder");
    });

    it("composes decomposed unicode, so one file is one document", () => {
        const decomposed = "cafe\u0301.md";
        const composed = "caf\u00e9.md";
        expect(decomposed).not.toBe(composed);
        expect(normalizeVaultPath(decomposed)).toBe(composed);
    });

    it("leaves a path prefix alone", () => {
        expect(normalizePrefixedPath("i:/.obsidian//app.json")).toBe("i:.obsidian/app.json");
    });

    it("folds the space characters Obsidian folds", () => {
        // A non-breaking space survives a paste from a word processor and is
        // invisible in the filename. Not folding it would map the note to a
        // different document than every other client uses.
        expect(normalizeVaultPath("My\u00a0Note.md")).toBe("My Note.md");
        expect(normalizeVaultPath("My\u202fNote.md")).toBe("My Note.md");
    });
});

describe("paths the plugin refuses to sync", () => {
    it("rejects a colon in the filename, which would write an unreadable document", async () => {
        await expect(
            pathToId("notes/10:30 standup.md", { obfuscatePassphrase: false, caseInsensitive: true })
        ).resolves.toBeDefined();
        // pathToId itself is permissive, mirroring path2id_base; the guard is
        // separate so reads of existing odd documents still work.
        expect(() => assertSyncablePath("notes/10:30 standup.md")).toThrow(UnsyncablePathError);
    });

    it("allows the plugin's own prefixes", () => {
        expect(() => assertSyncablePath("i:.obsidian/app.json")).not.toThrow();
        expect(() => assertSyncablePath("ix:device/plugin/name.md")).not.toThrow();
        expect(() => assertSyncablePath("ps:something")).not.toThrow();
        expect(() => assertSyncablePath("folder/note.md")).not.toThrow();
    });

    it("rejects a second colon even after a valid prefix", () => {
        expect(() => assertSyncablePath("i:folder/10:30.md")).toThrow(UnsyncablePathError);
    });
});

describe("round trip", () => {
    it("recovers the path for case-sensitive, unobfuscated vaults", async () => {
        await fc.assert(
            fc.asyncProperty(paths(), async (path) => {
                const id = await pathToId(path, { obfuscatePassphrase: false, caseInsensitive: false });
                expect(idToPath(id)).toBe(normalizePrefixedPath(path));
            }),
            { numRuns: 200 }
        );
    });

    it("refuses to invert an obfuscated ID rather than guessing", async () => {
        const id = await pathToId("note.md", {
            obfuscatePassphrase: PASSPHRASE,
            caseInsensitive: true,
        });
        expect(id.startsWith("f:")).toBe(true);
        expect(() => idToPath(id)).toThrow(ObfuscatedIdError);
    });

    it("is stable: the same path always yields the same obfuscated ID", async () => {
        const a = await pathToId("folder/note.md", {
            obfuscatePassphrase: PASSPHRASE,
            caseInsensitive: true,
        });
        const b = await pathToId("folder/note.md", {
            obfuscatePassphrase: PASSPHRASE,
            caseInsensitive: true,
        });
        expect(a).toBe(b);
    });

    it("escapes leading underscores, which CouchDB reserves", async () => {
        const id = await pathToId("_template.md", {
            obfuscatePassphrase: false,
            caseInsensitive: true,
        });
        expect(id).toBe("/_template.md");
        expect(idToPath(id)).toBe("_template.md");
    });

    it("keeps path prefixes outside the obfuscated portion", async () => {
        const id = await pathToId("i:.obsidian/app.json", {
            obfuscatePassphrase: PASSPHRASE,
            caseInsensitive: true,
        });
        expect(id.startsWith("i:f:")).toBe(true);
    });
});
