/**
 * The subset of LiveSync settings that changes the storage format.
 *
 * Getting any of these wrong does not fail loudly — it silently produces
 * documents the plugin cannot read, or duplicate documents at new IDs. They
 * should be read from the vault's own milestone document (`tweak_values`)
 * rather than assumed; see `readTweakValues`.
 */

import type { MilestoneEntry } from "./types.js";

export const HashAlgorithms = {
    XXHASH32: "xxhash32",
    XXHASH64: "xxhash64",
    MIXED_PUREJS: "mixed-purejs",
    SHA1: "sha1",
    /** The original algorithm; XXH32 over raw bytes, XORed. */
    LEGACY: "",
} as const;
export type HashAlgorithm = (typeof HashAlgorithms)[keyof typeof HashAlgorithms];

export const ChunkAlgorithms = {
    V1: "v1",
    V2: "v2",
    V2Segmenter: "v2-segmenter",
    RabinKarp: "v3-rabin-karp",
} as const;
export type ChunkAlgorithm = (typeof ChunkAlgorithms)[keyof typeof ChunkAlgorithms];

export const E2EEAlgorithms = {
    /** Legacy AES-GCM. Written by old clients; still readable. */
    V1: "",
    /** AES-256-GCM with HKDF. The current default. */
    V2: "v2",
    /** Write and read V1 only. */
    ForceV1: "forceV1",
} as const;
export type E2EEAlgorithm = (typeof E2EEAlgorithms)[keyof typeof E2EEAlgorithms];

/**
 * Settings that affect what a document looks like in CouchDB.
 *
 * Defaults match `SETTINGS_SCHEMA_DEFAULTS` in commonlib, which is what a
 * vault created by a current plugin version uses unless the user changed them.
 */
export interface VaultFormatSettings {
    /** Whether chunk payloads and metadata are encrypted. */
    encrypt: boolean;
    /** The E2EE passphrase. Also salts chunk hashes when `encrypt` is on. */
    passphrase: string;
    /** Whether file document IDs are hashed and metadata encrypted. */
    usePathObfuscation: boolean;
    /** Legacy key-derivation speed hack. Ignored by E2EE v2. */
    useDynamicIterationCount: boolean;
    e2eeAlgorithm: E2EEAlgorithm;
    /** Whether `data` fields are deflate-compressed. */
    enableCompression: boolean;
    hashAlg: HashAlgorithm;
    chunkSplitterVersion: ChunkAlgorithm;
    /** When false (the default), document IDs are lowercased. */
    handleFilenameCaseSensitive: boolean;
    /** Lower bound on chunk size, in bytes. */
    minimumChunkSize: number;
    /** Multiplier on `MAX_DOC_SIZE_BIN` for the absolute maximum piece size. */
    customChunkSize: number;
    /** Only meaningful for the V2 splitter. */
    useSegmenter: boolean;
    /**
     * The obsolete inline-chunk optimisation. Documents in a vault with this on
     * may hold chunks only in `eden`, which this model does not read.
     */
    useEden: boolean;
}

export const DEFAULT_FORMAT_SETTINGS: VaultFormatSettings = {
    encrypt: false,
    passphrase: "",
    usePathObfuscation: false,
    useDynamicIterationCount: false,
    e2eeAlgorithm: E2EEAlgorithms.V2,
    enableCompression: false,
    hashAlg: HashAlgorithms.XXHASH64,
    chunkSplitterVersion: ChunkAlgorithms.RabinKarp,
    handleFilenameCaseSensitive: false,
    minimumChunkSize: 20,
    customChunkSize: 0,
    useSegmenter: false,
    useEden: false,
};

/**
 * Settings a self-hosted CouchDB vault typically gets from the setup wizard,
 * which differ from the bare schema defaults.
 */
export const SELF_HOSTED_PRESET: Partial<VaultFormatSettings> = {
    customChunkSize: 60,
};

/**
 * The setting keys published in the milestone document's `tweak_values`, with
 * the type each must have.
 *
 * The validation is not ceremony. This is the only function in the vault model
 * that ingests data from outside, and a string `"false"` arriving where a
 * boolean belongs is truthy — which for `handleFilenameCaseSensitive` means
 * every document ID gets the wrong casing and every write creates a duplicate,
 * silently.
 */
const TWEAK_KEYS = {
    minimumChunkSize: "number",
    encrypt: "boolean",
    usePathObfuscation: "boolean",
    enableCompression: "boolean",
    customChunkSize: "number",
    useDynamicIterationCount: "boolean",
    hashAlg: "string",
    handleFilenameCaseSensitive: "boolean",
    useSegmenter: "boolean",
    useEden: "boolean",
    E2EEAlgorithm: "string",
    chunkSplitterVersion: "string",
} as const satisfies Record<string, "string" | "number" | "boolean">;

/** Enumerated values, so an unrecognised one is reported rather than adopted. */
const TWEAK_ENUMS: Record<string, readonly string[]> = {
    hashAlg: Object.values(HashAlgorithms),
    E2EEAlgorithm: Object.values(E2EEAlgorithms),
    chunkSplitterVersion: Object.values(ChunkAlgorithms),
};

/**
 * Extract format settings from a vault's milestone document.
 *
 * Every device that has synced publishes its own tweak values. If two devices
 * disagree on a setting that changes the storage format, that is a real problem
 * in the vault — the plugin itself blocks sync on it — so this reports the
 * disagreement rather than picking a winner.
 */
export function readTweakValues(milestone: MilestoneEntry | undefined): {
    settings: Partial<VaultFormatSettings>;
    conflicts: Record<string, unknown[]>;
    /** Values present but of the wrong type or outside the known set. */
    invalid: Record<string, unknown>;
    nodeCount: number;
} {
    const settings: Record<string, unknown> = {};
    const conflicts: Record<string, unknown[]> = {};
    const invalid: Record<string, unknown> = {};
    const nodes = Object.values(milestone?.tweak_values ?? {});

    for (const [key, expectedType] of Object.entries(TWEAK_KEYS)) {
        const seen: unknown[] = [];
        for (const node of nodes) {
            const value = node?.[key];
            if (value === undefined) continue;
            if (!seen.some((v) => v === value)) seen.push(value);
        }
        if (seen.length === 0) continue;
        if (seen.length > 1) {
            conflicts[key] = seen;
            continue;
        }

        const value = seen[0];
        if (typeof value !== expectedType) {
            invalid[key] = value;
            continue;
        }
        const allowed = TWEAK_ENUMS[key];
        if (allowed && !allowed.includes(value as string)) {
            invalid[key] = value;
            continue;
        }

        // `E2EEAlgorithm` is the plugin's key; ours is camelCase.
        settings[key === "E2EEAlgorithm" ? "e2eeAlgorithm" : key] = value;
    }

    return {
        settings: settings as Partial<VaultFormatSettings>,
        conflicts,
        invalid,
        nodeCount: nodes.length,
    };
}

export function resolveSettings(overrides: Partial<VaultFormatSettings>): VaultFormatSettings {
    return { ...DEFAULT_FORMAT_SETTINGS, ...overrides };
}
