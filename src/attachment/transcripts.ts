/**
 * Transcriptions of attachments that have no text of their own.
 *
 * Handwritten PDFs produced by an Obsidian ink plugin contain no text layer,
 * so extraction finds nothing and OCR does poorly on cursive. The transcriber
 * that actually works is a model reading the page, which is a thing this server
 * cannot do by itself: it has no model. What it can do is hold the result.
 *
 * That makes the storage question the important one. A transcription is *not*
 * derivable from the vault (nothing can recompute it) so it must not live in
 * the index, which is a cache that gets dropped and rebuilt whenever the schema
 * moves. It lives in its own database, and the index reads from here when
 * building its full-text table.
 *
 * Everything in this file is written on the assumption that losing a row here
 * is permanent and expensive: a page of ink read once by a model, at a cost
 * nobody wants to pay twice. Hence the superseded-text history, the refusal to
 * open a database this code does not understand, and the journal mode chosen
 * for backups rather than for throughput.
 */

import { DatabaseSync, type StatementSync } from "../index/sqlite.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export const TRANSCRIPT_SCHEMA_VERSION = 1;

const SCHEMA = `
-- DELETE rather than WAL, deliberately, and against the usual advice.
--
-- WAL keeps committed transactions in a sidecar file until a checkpoint, so a
-- file-level backup that copies transcripts.sqlite alone gets a database
-- missing its most recent writes, and one that copies the pair at different
-- instants can get a torn one. The deployment's nightly backup is exactly that
-- kind of backup. Writes here are a few per day at most, so there is no
-- throughput to protect, and a single self-contained file is worth more than
-- concurrency this store will never use.
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
    path        TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    -- Identity of the attachment this was made from, so a later edit to the
    -- file can be detected as making this stale.
    source_size  INTEGER NOT NULL,
    source_mtime INTEGER NOT NULL,
    -- Free text: which model, which prompt, whether a human checked it.
    provenance  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Every transcription this store has ever replaced.
--
-- A correction is usually an improvement, but not always: a model that runs out
-- of room after page one of a forty-page notebook will happily overwrite a
-- complete, human-checked reading with a fragment. Superseded text is kept so
-- that is an inconvenience rather than a loss. Nothing deletes from this table.
CREATE TABLE IF NOT EXISTS transcript_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL,
    text         TEXT NOT NULL,
    source_size  INTEGER NOT NULL,
    source_mtime INTEGER NOT NULL,
    provenance   TEXT,
    created_at   INTEGER NOT NULL,
    -- When this version stopped being current.
    superseded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcript_history_path ON transcript_history (path);
`;

export interface Transcript {
    path: string;
    text: string;
    sourceSize: number;
    sourceMtime: number;
    provenance: string | undefined;
    createdAt: number;
    updatedAt: number;
}

export class TranscriptSchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TranscriptSchemaError";
    }
}

/**
 * Whether a transcription still describes the file it was made from.
 *
 * The one definition, used by everything that needs to ask. Size and
 * modification time together are cheap and sufficient: a handwritten page that
 * gains another line changes both, and a page redrawn to the same byte count
 * still changes the mtime.
 *
 * Exported because the index builder and the tool layer both ask this question,
 * and three copies of the rule would drift.
 */
export function isTranscriptStale(transcript: Transcript, size: number, mtime: number): boolean {
    return transcript.sourceSize !== size || transcript.sourceMtime !== mtime;
}

/**
 * Durable storage for transcriptions.
 *
 * `synchronous = FULL` rather than the index's `NORMAL`: this is the one store
 * in the system whose contents cannot be recreated from anything else, so
 * durability is worth more here than write throughput.
 */
export class TranscriptStore {
    private db!: DatabaseSync;
    private statements!: {
        put: StatementSync;
        archive: StatementSync;
        get: StatementSync;
        all: StatementSync;
        history: StatementSync;
        remove: StatementSync;
        movePath: StatementSync;
        moveHistoryPath: StatementSync;
        copyRow: StatementSync;
    };

    constructor(private readonly path: string) {}

    open(): void {
        if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
        this.db = new DatabaseSync(this.path);

        // Checked before the schema is applied, and a mismatch refuses to open
        // rather than migrating or rebuilding. The index answers this question
        // by dropping everything and recomputing, which is exactly the one
        // response unavailable here: there is nothing to recompute from. A
        // server that will not start is recoverable; a store silently opened by
        // code that misunderstands its columns may not be.
        const found = this.storedVersion();
        if (found !== undefined && found !== TRANSCRIPT_SCHEMA_VERSION) {
            this.db.close();
            throw new TranscriptSchemaError(
                `The transcript store at "${this.path}" has schema version ${found}, but this ` +
                    `build understands version ${TRANSCRIPT_SCHEMA_VERSION}. Refusing to open it: ` +
                    `transcriptions cannot be regenerated, so a wrong guess about their layout is ` +
                    `not recoverable. Back the file up, then use a build that matches.`
            );
        }

        this.db.exec(SCHEMA);
        this.db
            .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT DO NOTHING`)
            .run(String(TRANSCRIPT_SCHEMA_VERSION));

        this.statements = {
            put: this.db.prepare(
                `INSERT INTO transcripts (path, text, source_size, source_mtime, provenance, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET
                   text = excluded.text,
                   source_size = excluded.source_size,
                   source_mtime = excluded.source_mtime,
                   provenance = excluded.provenance,
                   updated_at = excluded.updated_at`
            ),
            // Copies the current row aside before it is overwritten. Runs in
            // the same transaction as the upsert, so there is no instant at
            // which the old text exists nowhere.
            archive: this.db.prepare(
                `INSERT INTO transcript_history
                     (path, text, source_size, source_mtime, provenance, created_at, superseded_at)
                 SELECT path, text, source_size, source_mtime, provenance, created_at, ?
                 FROM transcripts WHERE path = ?`
            ),
            get: this.db.prepare(`SELECT * FROM transcripts WHERE path = ?`),
            all: this.db.prepare(`SELECT * FROM transcripts ORDER BY path`),
            history: this.db.prepare(
                `SELECT * FROM transcript_history WHERE path = ? ORDER BY superseded_at DESC, id DESC`
            ),
            remove: this.db.prepare(`DELETE FROM transcripts WHERE path = ?`),
            movePath: this.db.prepare(`UPDATE transcripts SET path = ? WHERE path = ?`),
            moveHistoryPath: this.db.prepare(`UPDATE transcript_history SET path = ? WHERE path = ?`),
            // created_at is carried across rather than set to now: a copy of a
            // file is byte-identical, so the reading is the same reading, made
            // when it was made.
            copyRow: this.db.prepare(
                `INSERT INTO transcripts (path, text, source_size, source_mtime, provenance, created_at, updated_at)
                 SELECT ?, text, source_size, source_mtime, provenance, created_at, ?
                 FROM transcripts WHERE path = ?`
            ),
        };
    }

    /** The version recorded in an existing file, or undefined if it is new. */
    private storedVersion(): number | undefined {
        try {
            const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
                { value?: string } | undefined;
            return row?.value === undefined ? undefined : Number(row.value);
        } catch {
            // No meta table: a database this code has not written to yet.
            return undefined;
        }
    }

    close(): void {
        this.db?.close();
    }

    /**
     * Store a transcription, keeping whatever it replaced.
     *
     * `createdAt` survives a rewrite: it records when this page was first
     * transcribed, and a correction should not make it look newly done.
     */
    put(entry: Omit<Transcript, "createdAt" | "updatedAt">, now = Date.now()): void {
        const existing = this.get(entry.path);
        this.db.exec("BEGIN");
        try {
            if (existing) this.statements.archive.run(now, entry.path);
            this.statements.put.run(
                entry.path,
                entry.text,
                entry.sourceSize,
                entry.sourceMtime,
                entry.provenance ?? null,
                existing?.createdAt ?? now,
                now
            );
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    get(path: string): Transcript | undefined {
        const row = this.statements.get.get(path) as Record<string, unknown> | undefined;
        return row ? toTranscript(row) : undefined;
    }

    all(): Transcript[] {
        return (this.statements.all.all() as Record<string, unknown>[]).map(toTranscript);
    }

    /** Superseded versions for one path, most recently replaced first. */
    history(path: string): (Transcript & { supersededAt: number })[] {
        return (this.statements.history.all(path) as Record<string, unknown>[]).map((row) => ({
            ...toTranscript(row),
            // History rows have no updated_at of their own; the moment they
            // stopped being current is the useful timestamp.
            updatedAt: Number(row.superseded_at),
            supersededAt: Number(row.superseded_at),
        }));
    }

    /**
     * Forget the current transcription for a path.
     *
     * The history is left alone, so this hides a transcription rather than
     * destroying it. Nothing calls this automatically: a file disappearing from
     * the vault is not a reason to throw away the reading of it, since the file
     * may simply have been renamed.
     */
    remove(path: string): void {
        this.statements.remove.run(path);
    }

    /**
     * Follow a file that moved.
     *
     * A transcription is keyed by path, so filing an Interact PDF into
     * `Superseded/` would otherwise orphan the one thing in this system that
     * nothing can recompute. The history moves with it, because the history
     * exists so that a bad rewrite cannot destroy a good reading, and a history
     * left behind under the old path is a history nobody will find.
     *
     * A missing source is not an error. Most files have no transcription, and
     * every move would otherwise have to ask first.
     *
     * Anything already stored at the destination is archived rather than
     * overwritten. The move tools refuse a destination that exists, so this
     * should not arise; if it does, the reading that was there is worth more
     * than the tidiness of refusing, and this step runs after the vault write
     * where a refusal helps nobody.
     */
    rename(from: string, to: string, now = Date.now()): boolean {
        if (from === to) return false;
        const source = this.get(from);
        const history = this.history(from);
        if (!source && history.length === 0) return false;

        this.db.exec("BEGIN");
        try {
            if (this.get(to)) {
                this.statements.archive.run(now, to);
                this.statements.remove.run(to);
            }
            this.statements.movePath.run(to, from);
            this.statements.moveHistoryPath.run(to, from);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return source !== undefined;
    }

    /**
     * Give a copy of a file the same transcription.
     *
     * The content is byte-identical, so the reading is valid, and the
     * alternative is paying a model to read a 4 MiB scan a second time. The
     * history stays with the original: it is the record of how that file's
     * reading was arrived at, not a property of the bytes.
     */
    copy(from: string, to: string, now = Date.now()): boolean {
        if (from === to) return false;
        if (!this.get(from)) return false;

        this.db.exec("BEGIN");
        try {
            if (this.get(to)) {
                this.statements.archive.run(now, to);
                this.statements.remove.run(to);
            }
            this.statements.copyRow.run(to, now, from);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
        return true;
    }

    /** Transcriptions whose path is no longer in the vault, usually renames. */
    orphans(livePaths: Set<string>): Transcript[] {
        return this.all().filter((transcript) => !livePaths.has(transcript.path));
    }

    /** Whether a stored transcription still describes the file it was made from. */
    isStale(path: string, size: number, mtime: number): boolean {
        const existing = this.get(path);
        if (!existing) return false;
        return isTranscriptStale(existing, size, mtime);
    }
}

function toTranscript(row: Record<string, unknown>): Transcript {
    return {
        path: String(row.path),
        text: String(row.text),
        sourceSize: Number(row.source_size),
        sourceMtime: Number(row.source_mtime),
        provenance: row.provenance == null ? undefined : String(row.provenance),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at ?? row.superseded_at),
    };
}
