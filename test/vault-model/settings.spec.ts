/**
 * Reading format settings from the vault rather than assuming them.
 *
 * Every device that syncs publishes its own copy into the milestone document.
 * If two disagree about a setting that changes the storage format, that is a
 * real problem in the vault — the plugin blocks sync on it — and guessing a
 * winner here would turn a visible problem into a silent one.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_FORMAT_SETTINGS, readTweakValues, resolveSettings } from "../../src/vault-model/settings.js";
import { asDocumentID, type MilestoneEntry } from "../../src/vault-model/types.js";

const milestone = (tweaks: Record<string, Record<string, unknown>>): MilestoneEntry => ({
    _id: asDocumentID("_local/obsydian_livesync_milestone"),
    type: "milestoneinfo",
    created: 0,
    accepted_nodes: [],
    node_info: {},
    locked: false,
    node_chunk_info: {},
    tweak_values: tweaks,
});

describe("defaults", () => {
    it("match a vault created by a current plugin version", () => {
        expect(DEFAULT_FORMAT_SETTINGS.hashAlg).toBe("xxhash64");
        expect(DEFAULT_FORMAT_SETTINGS.chunkSplitterVersion).toBe("v3-rabin-karp");
        expect(DEFAULT_FORMAT_SETTINGS.e2eeAlgorithm).toBe("v2");
        expect(DEFAULT_FORMAT_SETTINGS.encrypt).toBe(false);
        expect(DEFAULT_FORMAT_SETTINGS.handleFilenameCaseSensitive).toBe(false);
    });

    it("are overridable one key at a time", () => {
        const resolved = resolveSettings({ encrypt: true, passphrase: "x" });
        expect(resolved.encrypt).toBe(true);
        expect(resolved.hashAlg).toBe(DEFAULT_FORMAT_SETTINGS.hashAlg);
    });
});

describe("reading tweak values", () => {
    it("extracts settings when every device agrees", () => {
        const { settings, conflicts, nodeCount } = readTweakValues(
            milestone({
                deviceA: { encrypt: true, usePathObfuscation: true, hashAlg: "xxhash64" },
                deviceB: { encrypt: true, usePathObfuscation: true, hashAlg: "xxhash64" },
            })
        );
        expect(settings.encrypt).toBe(true);
        expect(settings.usePathObfuscation).toBe(true);
        expect(settings.hashAlg).toBe("xxhash64");
        expect(conflicts).toEqual({});
        expect(nodeCount).toBe(2);
    });

    it("reports a disagreement instead of picking a winner", () => {
        const { settings, conflicts } = readTweakValues(
            milestone({
                deviceA: { encrypt: true },
                deviceB: { encrypt: false },
            })
        );
        expect(settings.encrypt).toBeUndefined();
        expect(conflicts.encrypt).toEqual([true, false]);
    });

    it("renames the plugin's E2EEAlgorithm key to ours", () => {
        const { settings } = readTweakValues(milestone({ deviceA: { E2EEAlgorithm: "v2" } }));
        expect(settings.e2eeAlgorithm).toBe("v2");
    });

    it("ignores keys no device has published", () => {
        const { settings } = readTweakValues(milestone({ deviceA: { encrypt: false } }));
        expect("hashAlg" in settings).toBe(false);
    });

    it("copes with a vault that has no milestone document yet", () => {
        const { settings, conflicts, nodeCount } = readTweakValues(undefined);
        expect(settings).toEqual({});
        expect(conflicts).toEqual({});
        expect(nodeCount).toBe(0);
    });

    it("rejects a value of the wrong type rather than adopting it", () => {
        // "false" is truthy. Adopting it here would flip every document ID's
        // casing and duplicate every note on the next write.
        const { settings, invalid } = readTweakValues(
            milestone({ deviceA: { handleFilenameCaseSensitive: "false" } })
        );
        expect(settings.handleFilenameCaseSensitive).toBeUndefined();
        expect(invalid.handleFilenameCaseSensitive).toBe("false");
    });

    it("rejects an unrecognised enum value", () => {
        const { settings, invalid } = readTweakValues(
            milestone({ deviceA: { hashAlg: "blake3", chunkSplitterVersion: "v9" } })
        );
        expect(settings.hashAlg).toBeUndefined();
        expect(invalid.hashAlg).toBe("blake3");
        expect(invalid.chunkSplitterVersion).toBe("v9");
    });

    it("accepts the empty string as the legacy hash algorithm", () => {
        const { settings, invalid } = readTweakValues(milestone({ deviceA: { hashAlg: "" } }));
        expect(settings.hashAlg).toBe("");
        expect(invalid).toEqual({});
    });

    it("surfaces useEden, which this model cannot read documents from", () => {
        const { settings } = readTweakValues(milestone({ deviceA: { useEden: true } }));
        expect(settings.useEden).toBe(true);
    });

    it("treats an undefined value on one device as no opinion", () => {
        const { settings, conflicts } = readTweakValues(
            milestone({
                deviceA: { encrypt: true },
                deviceB: {},
            })
        );
        expect(settings.encrypt).toBe(true);
        expect(conflicts).toEqual({});
    });
});
