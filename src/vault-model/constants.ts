/**
 * Constants of the Self-hosted LiveSync storage format.
 *
 * Every value here is a literal taken from the plugin's own source
 * (`@vrtmrz/livesync-commonlib` and `octagonal-wheels`). They are reproduced
 * rather than imported where importing would drag in the plugin's service
 * architecture, and each one carries the upstream location it came from so a
 * future version bump can be diffed against it.
 *
 * Upstream reference: docs/livesync-storage-contract.md
 */

// --- Document type discriminators -------------------------------------------
// commonlib: src/common/models/db.const.ts

/** Legacy note document; content is inline in `data`, not chunked. */
export const TYPE_NOTE_LEGACY = "notes";
/** Binary file document; chunks hold base64. */
export const TYPE_NOTE_BINARY = "newnote";
/** Text file document; chunks hold raw UTF-8 text. */
export const TYPE_NOTE_PLAIN = "plain";
export const TYPE_INTERNAL_FILE = "internalfile";
/** Chunk ("leaf") document. */
export const TYPE_CHUNK = "leaf";
export const TYPE_CHUNK_PACK = "chunkpack";
export const TYPE_VERSION_INFO = "versioninfo";
export const TYPE_SYNC_INFO = "syncinfo";
export const TYPE_SYNC_PARAMETERS = "sync-parameters";
export const TYPE_MILESTONE_INFO = "milestoneinfo";
export const TYPE_NODE_INFO = "nodeinfo";

/** Document types that represent a file in the vault. */
export const NOTE_TYPES = [TYPE_NOTE_LEGACY, TYPE_NOTE_BINARY, TYPE_NOTE_PLAIN] as const;
/** Document types that hold chunk payloads. */
export const CHUNK_TYPES = [TYPE_CHUNK, TYPE_CHUNK_PACK] as const;

// --- Well-known document IDs ------------------------------------------------
// The `obsydian` misspelling is upstream and load-bearing; do not "fix" it.

export const DOCID_VERSIONING = "obsydian_livesync_version";
export const DOCID_MILESTONE = "_local/obsydian_livesync_milestone";
export const DOCID_NODEINFO = "_local/obsydian_livesync_nodeinfo";
export const DOCID_SYNCINFO = "syncinfo";
/** Note: spelled correctly here, unlike the three above. Also upstream. */
export const DOCID_SYNC_PARAMETERS = "_local/obsidian_livesync_sync_parameters";

// --- ID prefixes ------------------------------------------------------------
// commonlib: src/common/models/shared.const.behabiour.ts, fileaccess.const.ts

/** Marks an obfuscated file document ID. */
export const PREFIX_OBFUSCATED = "f:";
/** Marks a chunk document ID. */
export const PREFIX_CHUNK = "h:";
/** Marks an encrypted chunk document ID (chunk prefix + the hash's `+` marker). */
export const PREFIX_ENCRYPTED_CHUNK = "h:+";
/** Appended to a chunk hash when E2EE is on. */
export const HASH_ENCRYPTED_MARKER = "+";

/** Internal data container — hidden file sync (`.obsidian/...`). */
export const PREFIX_INTERNAL = "i:";
export const PREFIX_INTERNAL_END = "i;";
/** Internal data container eXtended — customisation sync. */
export const PREFIX_INTERNAL_X = "ix:";
/** Plug-in Stored Container (obsolete). */
export const PREFIX_PLUGIN_STORE = "ps:";
export const PREFIX_PLUGIN_STORE_END = "ps;";

/** Path prefixes that may precede `f:` in a document ID. */
export const PATH_PREFIXES = [PREFIX_INTERNAL_X, PREFIX_INTERNAL, PREFIX_PLUGIN_STORE] as const;

/**
 * Upper bound of the chunk ID range. Chunk IDs sort within
 * `["h:", "h:\u{10ffff}")`, which is how the plugin excludes them when
 * enumerating file documents.
 */
export const CHUNK_ID_RANGE_END = "h:\u{10ffff}";

// --- Salts and seeds --------------------------------------------------------
// commonlib: src/common/models/shared.const.behabiour.ts

/**
 * Prepended to the truncated passphrase before deriving the chunk-hash salt.
 *
 * Note the `\u0003` — the published `dist` shows this string with the control
 * character stripped by the bundler in some builds. The value used here matches
 * the TypeScript source. Verified against the runtime by the differential tests.
 */
export const SALT_OF_ID = "a83hrf7f\u0003y7sa8g31";
export const SALT_OF_PASSPHRASE = "rHGMPtr6oWw7VSa3W3wpa8fT8U";
export const SEED_MURMURHASH = 0x12345678;

// --- Encryption wire markers ------------------------------------------------
// commonlib: src/pouchdb/encryption.ts; octagonal-wheels: src/encryption/*

/** AES-256-GCM with HKDF (E2EE algorithm "v2", the current default). */
export const ENCRYPT_HKDF_PREFIX = "%=";
/** HKDF with an ephemeral PBKDF2 salt carried in the payload (setup URIs). */
export const ENCRYPT_HKDF_EPHEMERAL_PREFIX = "%$";
/** Legacy AES-256-GCM, hex IV + hex salt + base64 (E2EE algorithm ""). */
export const ENCRYPT_LEGACY_PREFIX = "%";
/** Deprecated V3 format, decrypt-only. */
export const ENCRYPT_V3_PREFIX = "%~";
/** Oldest format: a JSON array of three strings. */
export const ENCRYPT_V1_PREFIX = "[";
/** Prefix on `path` when the whole metadata object is encrypted (E2EE v2). */
export const ENCRYPTED_META_PREFIX = "/\\:";
/** Sole key of `eden` once encrypted, per algorithm. */
export const EDEN_ENCRYPTED_KEY_HKDF = "h:++encrypted-hkdf";
export const EDEN_ENCRYPTED_KEY_V1 = "h:++encrypted";

// --- Compression ------------------------------------------------------------
// commonlib: src/pouchdb/compress.ts

/** `\u000E L Z \u001D` — marks a deflate-compressed `data` field. */
export const MARK_SHIFT_COMPRESSED = "\u000ELZ\u001D";
/** Marks that the pre-deflate payload was itself base64 and was decoded first. */
export const MARK_COMPRESSED_WAS_BASE64 = "~";

// --- Chunking ---------------------------------------------------------------
// commonlib: src/common/models/shared.const.behabiour.ts, string_and_binary/chunks.ts

export const MAX_DOC_SIZE_BIN = 102400;

/** Rabin-Karp rolling hash parameters. All are hard-coded upstream. */
export const RK_WINDOW_SIZE = 48;
export const RK_PRIME = 31;
export const RK_BOUNDARY_PATTERN = 1;
export const RK_MAX_CHUNK_COUNT = 500;
export const RK_CHUNK_UNIT_PLAIN_BASE = 64;
export const RK_CHUNK_UNIT_PLAIN_STEP = 32;
export const RK_CHUNK_UNIT_BINARY = 256 * 1024;
export const RK_ABSOLUTE_MAX_PIECE_SIZE_FLOOR = 30 * 1024;
/** Text at or above this size is chunked with binary parameters. */
export const RK_PLAIN_SPLIT_SIZE_LIMIT = 4 * 1024 * 1024;

// --- Legacy binary payload marker -------------------------------------------
// octagonal-wheels: src/binary/index.ts

/** A first chunk starting with this means encoded-UTF16, not base64. */
export const MARK_ENCODED_UTF16 = "%";

// --- Version range published to the milestone document ----------------------
// commonlib: src/replication/couchdb/LiveSyncReplicator.ts

export const CURRENT_CHUNK_VERSION_RANGE = { min: 0, max: 2400, current: 2 } as const;
/** Database schema version this client understands. */
export const SUPPORTED_DB_VERSION = 12;
