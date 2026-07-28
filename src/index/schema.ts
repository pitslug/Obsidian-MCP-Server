/**
 * The index schema.
 *
 * SQLite on a Docker volume, fed from the local replica through the vault
 * model. It knows nothing about CouchDB or chunks; it consumes assembled notes.
 *
 * The whole thing is a derived artifact and can be rebuilt from the replica at
 * any time without touching CouchDB, which is why `SCHEMA_VERSION` can simply
 * be bumped: a mismatch drops everything and rebuilds rather than migrating.
 * Migrations would be a liability for a cache.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per file in the vault, text or binary.
CREATE TABLE IF NOT EXISTS notes (
    path          TEXT PRIMARY KEY,
    doc_id        TEXT NOT NULL,
    rev           TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('text', 'binary')),
    size          INTEGER NOT NULL,
    ctime         INTEGER NOT NULL,
    mtime         INTEGER NOT NULL,
    chunk_count   INTEGER NOT NULL DEFAULT 0,
    -- For attachments: what became of their text, and why. The domain is the
    -- ExtractionState union in index.ts, which is the authority:
    --   'extracted' | 'transcribed' | 'transcribed-stale' | 'no-text-layer'
    --   'not-textual' | 'skipped' | 'failed'
    -- NULL means never attempted; for a text note it means nothing at all.
    extraction        TEXT,
    extraction_reason TEXT,
    -- Set when frontmatter was present but unparseable. Surfaced rather than
    -- swallowed: it is the author's problem to fix, but only if they see it.
    frontmatter_error TEXT
);

CREATE INDEX IF NOT EXISTS notes_mtime ON notes (mtime DESC);
CREATE INDEX IF NOT EXISTS notes_kind  ON notes (kind);

-- Full text over note bodies. A standalone FTS5 table rather than an external
-- content table: the body is not otherwise stored, and duplicating it would
-- cost more than it saves.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Frontmatter, one row per key per note. value_text is the rendered form,
-- used for exact matching and display; value_json keeps the original shape.
CREATE TABLE IF NOT EXISTS properties (
    path       TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value_text TEXT NOT NULL,
    value_json TEXT,
    value_type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS properties_key  ON properties (key);
CREATE INDEX IF NOT EXISTS properties_path ON properties (path);
CREATE INDEX IF NOT EXISTS properties_kv   ON properties (key, value_text);

CREATE TABLE IF NOT EXISTS tags (
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    tag  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tags_tag  ON tags (tag);
CREATE INDEX IF NOT EXISTS tags_path ON tags (path);

-- Wikilinks and vault-internal markdown links. The target column is as
-- written; resolved_path is where it points, or NULL when nothing matches.
-- An unresolved link is a broken link, and worth being able to ask about.
CREATE TABLE IF NOT EXISTS links (
    source_path   TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    target        TEXT NOT NULL,
    resolved_path TEXT,
    subpath       TEXT,
    alias         TEXT,
    embed         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS links_source   ON links (source_path);
CREATE INDEX IF NOT EXISTS links_resolved ON links (resolved_path);
CREATE INDEX IF NOT EXISTS links_target   ON links (target);
`;

/** Dropped in this order so foreign keys never block the rebuild. */
export const DROP_ALL = `
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS notes_fts;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS meta;
`;
