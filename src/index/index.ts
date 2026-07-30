/**
 * The index.
 *
 * Fed from the local replica's changes feed through the vault model. Because it
 * parses notes rather than reading files, the wikilink graph and backlinks are
 * available, which is the capability that ruled out an off-the-shelf
 * filesystem MCP server in the first place.
 *
 * Every write happens inside a transaction that replaces a note's rows wholly,
 * so a partially-indexed note is never visible to a query.
 */

import { DatabaseSync, type StatementSync } from "./sqlite.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { classifyProperty, parseNote, propertyValueToText } from "../note/parse.js";
import { DROP_ALL, SCHEMA, SCHEMA_VERSION } from "./schema.js";
import type { AssembledFile } from "../vault-model/index.js";

export interface IndexedNote {
    path: string;
    kind: "text" | "binary";
    size: number;
    mtime: number;
}

export interface SearchHit extends IndexedNote {
    /** A short excerpt with the match marked, from FTS5's own snippet(). */
    snippet: string;
    rank: number;
}

export interface PropertyKeySummary {
    key: string;
    noteCount: number;
    /** Observed value types, most common first. */
    types: { type: string; count: number }[];
    /** A few real values, to make the shape concrete. */
    examples: string[];
}

export interface TagSummary {
    tag: string;
    noteCount: number;
}

export interface LinkRow {
    target: string;
    resolvedPath: string | undefined;
    subpath: string | undefined;
    alias: string | undefined;
    embed: boolean;
}

/**
 * What became of an attachment's text, as recorded in `notes.extraction`.
 *
 * A union rather than `string`, because these values are compared by literal in
 * several places and a typo in any of them would compile cleanly and then
 * silently drop a file out of the transcription queue, or out of search.
 */
export type ExtractionState =
    /** A text layer was read from the file. */
    | "extracted"
    /** A model read the file, and its reading is stored. */
    | "transcribed"
    /** A transcription exists, but the file has changed since it was made. */
    | "transcribed-stale"
    /** A PDF whose pages carry no text layer: ink, or a scan without OCR. */
    | "no-text-layer"
    /** A file type with no text to extract, such as an image. */
    | "not-textual"
    /** Too large to attempt. */
    | "skipped"
    /** The file could not be parsed. */
    | "failed";

/** Whether an attachment in this state has text that a search could match. */
export function isSearchable(state: ExtractionState | undefined): boolean {
    return state === "extracted" || state === "transcribed";
}

/** Text pulled out of an attachment, for indexing alongside notes. */
export interface AttachmentText {
    outcome: ExtractionState;
    text: string;
    reason: string | undefined;
}

export interface SearchOptions {
    query: string;
    folder?: string;
    tag?: string;
    limit?: number;
}

export class VaultIndex {
    private db!: DatabaseSync;
    private statements!: Record<string, StatementSync>;

    constructor(private readonly path: string) {}

    open(): void {
        if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
        this.db = new DatabaseSync(this.path);
        this.db.exec(SCHEMA);

        const stored = this.readMeta("schema_version");
        if (stored !== String(SCHEMA_VERSION)) {
            // A cache does not need migrations; it needs to be correct.
            this.db.exec(DROP_ALL);
            this.db.exec(SCHEMA);
            this.writeMeta("schema_version", String(SCHEMA_VERSION));
        }

        this.prepare();
    }

    close(): void {
        this.db?.close();
    }

    private prepare(): void {
        this.statements = {
            upsertNote: this.db.prepare(
                `INSERT INTO notes (path, doc_id, rev, kind, size, ctime, mtime, chunk_count,
                                    frontmatter_error, extraction, extraction_reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET
                   doc_id = excluded.doc_id, rev = excluded.rev, kind = excluded.kind,
                   size = excluded.size, ctime = excluded.ctime, mtime = excluded.mtime,
                   chunk_count = excluded.chunk_count,
                   frontmatter_error = excluded.frontmatter_error,
                   extraction = excluded.extraction,
                   extraction_reason = excluded.extraction_reason`
            ),
            deleteNote: this.db.prepare(`DELETE FROM notes WHERE path = ?`),
            deleteFts: this.db.prepare(`DELETE FROM notes_fts WHERE path = ?`),
            insertFts: this.db.prepare(`INSERT INTO notes_fts (path, title, body) VALUES (?, ?, ?)`),
            deleteProperties: this.db.prepare(`DELETE FROM properties WHERE path = ?`),
            insertProperty: this.db.prepare(
                `INSERT INTO properties (path, key, value_text, value_json, value_type) VALUES (?, ?, ?, ?, ?)`
            ),
            deleteTags: this.db.prepare(`DELETE FROM tags WHERE path = ?`),
            insertTag: this.db.prepare(`INSERT INTO tags (path, tag) VALUES (?, ?)`),
            deleteLinks: this.db.prepare(`DELETE FROM links WHERE source_path = ?`),
            unresolveLinksTo: this.db.prepare(
                `UPDATE links SET resolved_path = NULL WHERE resolved_path = ?`
            ),
            insertLink: this.db.prepare(
                `INSERT INTO links (source_path, target, resolved_path, subpath, alias, embed)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ),
        };
    }

    private readMeta(key: string): string | undefined {
        try {
            const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
                { value: string } | undefined;
            return row?.value;
        } catch {
            return undefined;
        }
    }

    private writeMeta(key: string, value: string): void {
        this.db
            .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`)
            .run(key, value, value);
    }

    // --- Writing -----------------------------------------------------------

    /**
     * Index one file, replacing everything previously known about it.
     *
     * Binary files get a row and nothing else: no body to tokenise, no
     * frontmatter, no links. They still belong in the index so that listings
     * and link resolution can see them.
     */
    put(file: AssembledFile, attachment?: AttachmentText): void {
        this.db.exec("BEGIN");
        try {
            this.statements.upsertNote?.run(
                file.path,
                String(file.id),
                file.rev ?? null,
                file.kind,
                file.size,
                file.ctime,
                file.mtime,
                file.children.length,
                null,
                attachment?.outcome ?? null,
                attachment?.reason ?? null
            );
            this.statements.deleteFts?.run(file.path);
            this.statements.deleteProperties?.run(file.path);
            this.statements.deleteTags?.run(file.path);
            this.statements.deleteLinks?.run(file.path);

            if (file.kind === "text") this.indexText(file);
            // Extracted attachment text goes into the same full-text table, so
            // one search covers notes and attachments alike.
            else if (attachment?.text) {
                const title = (file.path.split("/").pop() ?? file.path).replace(/\.[^.]+$/, "");
                this.statements.insertFts?.run(file.path, title, attachment.text);
            }

            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    private indexText(file: AssembledFile): void {
        const parsed = parseNote(file.text ?? "");

        if (parsed.frontmatterError) {
            this.statements.upsertNote?.run(
                file.path,
                String(file.id),
                file.rev ?? null,
                file.kind,
                file.size,
                file.ctime,
                file.mtime,
                file.children.length,
                parsed.frontmatterError,
                null,
                null
            );
        }

        // The title is the filename without extension, which is what Obsidian
        // shows and what people search for.
        const title = (file.path.split("/").pop() ?? file.path).replace(/\.md$/i, "");
        this.statements.insertFts?.run(file.path, title, parsed.body);

        for (const [key, value] of Object.entries(parsed.properties)) {
            // A list property becomes one row per item, so that "which notes
            // have status=done" works whether status is a scalar or a list.
            const values = Array.isArray(value) ? value : [value];
            for (const item of values) {
                this.statements.insertProperty?.run(
                    file.path,
                    key,
                    propertyValueToText(item),
                    JSON.stringify(item ?? null),
                    classifyProperty(item)
                );
            }
            if (Array.isArray(value) && value.length === 0) {
                this.statements.insertProperty?.run(file.path, key, "", "[]", "empty");
            }
        }

        for (const tag of parsed.tags) this.statements.insertTag?.run(file.path, tag);

        const seen = new Set<string>();
        for (const link of parsed.links) {
            if (!link.target) continue;
            const key = `${link.target}|${link.subpath ?? ""}|${link.embed}`;
            if (seen.has(key)) continue;
            seen.add(key);
            this.statements.insertLink?.run(
                file.path,
                link.target,
                null,
                link.subpath ?? null,
                link.alias ?? null,
                link.embed ? 1 : 0
            );
        }
        for (const target of parsed.markdownLinks) {
            const key = `${target}||false`;
            if (seen.has(key)) continue;
            seen.add(key);
            this.statements.insertLink?.run(file.path, target, null, null, null, 0);
        }
    }

    /** Every path currently in the index. */
    allPaths(): string[] {
        return (this.db.prepare(`SELECT path FROM notes`).all() as unknown as { path: string }[]).map(
            (row) => row.path
        );
    }

    /**
     * Drop everything not in `live`.
     *
     * A rebuild adds and updates but has no way to notice absence, so without
     * this a note deleted or renamed while the server was down stays in the
     * index indefinitely: searchable, listed, and gone. Deletions that happen
     * while the server is running arrive on the changes feed and are handled
     * there; this covers the gap around a restart.
     */
    prune(live: ReadonlySet<string>): string[] {
        const removed = this.allPaths().filter((path) => !live.has(path));
        for (const path of removed) this.remove(path);
        return removed;
    }

    /**
     * Forget a file.
     *
     * The note's properties, tags and outgoing links go with it through
     * `ON DELETE CASCADE`, so this deletes two rows and gets five tables. The
     * full-text row is the exception because an FTS5 virtual table cannot carry
     * a foreign key.
     *
     * Links *pointing at* this path are kept, with their resolution cleared.
     * They belong to notes that still exist, so deleting them would lose real
     * content, and leaving them resolved is worse than either: the link would
     * keep naming a note the vault no longer holds, `note_links` would report it
     * as resolved, and `vault_health` would not report it at all. Cleared, it
     * shows up as the broken link it now is, which is what someone who deleted a
     * note three others point at needs to be told.
     */
    remove(path: string): void {
        this.db.exec("BEGIN");
        try {
            this.statements.deleteNote?.run(path);
            this.statements.deleteFts?.run(path);
            this.statements.unresolveLinksTo?.run(path);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    /**
     * Resolve link targets to paths.
     *
     * Obsidian resolves `[[Target]]` by looking for an exact path first, then
     * for a file whose name matches, preferring `.md`. Run after a batch rather
     * than per note, because a link often points at a note that has not been
     * indexed yet.
     */
    resolveLinks(): void {
        // Four passes, most specific first, each filling only what is still
        // unresolved. Expressing the precedence as an ORDER BY inside one
        // correlated subquery would be neater, but SQLite rejects an outer
        // reference there ("no such column: links.target") even though it
        // allows one in the WHERE. Passes also read more plainly than a
        // nested CASE.
        //
        // Ties within a pass go to the shortest path, which is Obsidian's
        // behaviour: a note at the vault root wins over a deeply nested one.
        const passes = [
            `n.path = links.target`, // exact path, including extension
            `n.path = links.target || '.md'`, // path without the extension
            `n.path LIKE '%/' || links.target`, // basename, with extension
            `n.path LIKE '%/' || links.target || '.md'`, // basename, without
        ];

        this.db.exec("BEGIN");
        try {
            this.db.exec(`UPDATE links SET resolved_path = NULL`);
            for (const match of passes) {
                this.db.exec(`
                    UPDATE links SET resolved_path = (
                        SELECT n.path FROM notes n
                        WHERE ${match}
                        ORDER BY LENGTH(n.path)
                        LIMIT 1
                    )
                    WHERE resolved_path IS NULL AND target <> ''
                `);
            }
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    // --- Reading -----------------------------------------------------------

    count(): { notes: number; text: number; binary: number } {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS notes,
                        SUM(kind = 'text')   AS text,
                        SUM(kind = 'binary') AS binary
                 FROM notes`
            )
            .get() as { notes: number; text: number | null; binary: number | null };
        return { notes: row.notes, text: row.text ?? 0, binary: row.binary ?? 0 };
    }

    search(options: SearchOptions): SearchHit[] {
        const limit = options.limit ?? 20;
        const clauses: string[] = ["notes_fts MATCH ?"];
        const params: unknown[] = [options.query];

        if (options.folder) {
            clauses.push("(n.path = ? OR n.path LIKE ? || '/%')");
            params.push(options.folder, options.folder);
        }
        if (options.tag) {
            clauses.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND t.tag = ?)");
            params.push(options.tag);
        }

        const rows = this.db
            .prepare(
                `SELECT n.path, n.kind, n.size, n.mtime,
                        snippet(notes_fts, 2, '«', '»', ' … ', 16) AS snippet,
                        bm25(notes_fts) AS rank
                 FROM notes_fts
                 JOIN notes n ON n.path = notes_fts.path
                 WHERE ${clauses.join(" AND ")}
                 ORDER BY rank
                 LIMIT ?`
            )
            .all(...(params as never[]), limit) as unknown as SearchHit[];

        return rows;
    }

    /**
     * Every frontmatter key in the vault, with how it is used.
     *
     * This is the tool the design singled out: it shows what property keys and
     * value shapes already exist before anyone proposes a schema, rather than
     * guessing.
     */
    propertyInventory(): PropertyKeySummary[] {
        const keys = this.db
            .prepare(
                `SELECT key, COUNT(DISTINCT path) AS noteCount
                 FROM properties GROUP BY key ORDER BY noteCount DESC, key`
            )
            .all() as unknown as { key: string; noteCount: number }[];

        return keys.map((row) => {
            const types = this.db
                .prepare(
                    `SELECT value_type AS type, COUNT(*) AS count
                     FROM properties WHERE key = ? GROUP BY value_type ORDER BY count DESC`
                )
                .all(row.key) as unknown as { type: string; count: number }[];

            const examples = (
                this.db
                    .prepare(
                        `SELECT DISTINCT value_text FROM properties
                         WHERE key = ? AND value_text <> '' ORDER BY value_text LIMIT 5`
                    )
                    .all(row.key) as unknown as { value_text: string }[]
            ).map((e) => e.value_text);

            return { key: row.key, noteCount: row.noteCount, types, examples };
        });
    }

    /** Notes carrying a property, optionally with a particular value. */
    findByProperty(key: string, value?: string): IndexedNote[] {
        const sql =
            value === undefined
                ? `SELECT DISTINCT n.path, n.kind, n.size, n.mtime FROM properties p
                   JOIN notes n ON n.path = p.path WHERE p.key = ? ORDER BY n.path`
                : `SELECT DISTINCT n.path, n.kind, n.size, n.mtime FROM properties p
                   JOIN notes n ON n.path = p.path WHERE p.key = ? AND p.value_text = ? ORDER BY n.path`;
        const params = value === undefined ? [key] : [key, value];
        return this.db.prepare(sql).all(...(params as never[])) as unknown as IndexedNote[];
    }

    tagInventory(): TagSummary[] {
        return this.db
            .prepare(
                `SELECT tag, COUNT(DISTINCT path) AS noteCount
                 FROM tags GROUP BY tag ORDER BY noteCount DESC, tag`
            )
            .all() as unknown as TagSummary[];
    }

    findByTag(tag: string): IndexedNote[] {
        return this.db
            .prepare(
                `SELECT n.path, n.kind, n.size, n.mtime FROM tags t
                 JOIN notes n ON n.path = t.path WHERE t.tag = ? ORDER BY n.path`
            )
            .all(tag) as unknown as IndexedNote[];
    }

    /**
     * Every file under a folder, or the whole vault when no folder is given.
     *
     * The prefix carries its own separator, so asking for `daily` does not also
     * return `daily-review/monday.md`. That folder would otherwise be included
     * silently in a batch, and a batch is exactly where nobody is checking the
     * membership of the list by eye.
     */
    notesUnder(folder?: string): IndexedNote[] {
        const trimmed = folder?.replace(/^\/+|\/+$/g, "");
        if (!trimmed) {
            return this.db
                .prepare(`SELECT path, kind, size, mtime FROM notes ORDER BY path`)
                .all() as unknown as IndexedNote[];
        }
        return this.db
            .prepare(
                // A folder called `report_2026` holds an underscore, which LIKE
                // reads as "any character". Escaped, or the batch quietly
                // widens to `report-2026` as well.
                `SELECT path, kind, size, mtime FROM notes
                 WHERE path LIKE ? ESCAPE '\\' ORDER BY path`
            )
            .all(`${trimmed.replace(/[%_\\]/g, "\\$&")}/%`) as unknown as IndexedNote[];
    }

    outgoingLinks(path: string): LinkRow[] {
        const rows = this.db
            .prepare(
                `SELECT target, resolved_path, subpath, alias, embed
                 FROM links WHERE source_path = ? ORDER BY target`
            )
            .all(path) as unknown as {
            target: string;
            resolved_path: string | null;
            subpath: string | null;
            alias: string | null;
            embed: number;
        }[];

        return rows.map((row) => ({
            target: row.target,
            resolvedPath: row.resolved_path ?? undefined,
            subpath: row.subpath ?? undefined,
            alias: row.alias ?? undefined,
            embed: row.embed === 1,
        }));
    }

    backlinks(path: string): { path: string; target: string; embed: boolean }[] {
        const rows = this.db
            .prepare(
                `SELECT source_path, target, embed FROM links
                 WHERE resolved_path = ? ORDER BY source_path`
            )
            .all(path) as unknown as { source_path: string; target: string; embed: number }[];
        return rows.map((row) => ({ path: row.source_path, target: row.target, embed: row.embed === 1 }));
    }

    /** Links that point at nothing. Useful; also a sign of a rename gone wrong. */
    brokenLinks(limit = 100): { source: string; target: string }[] {
        return this.db
            .prepare(
                `SELECT source_path AS source, target FROM links
                 WHERE resolved_path IS NULL AND target <> ''
                 ORDER BY source_path LIMIT ?`
            )
            .all(limit) as unknown as { source: string; target: string }[];
    }

    /** Attachments and what came of trying to extract their text. */
    extractionReport(): { path: string; outcome: ExtractionState | undefined; reason: string | undefined }[] {
        const rows = this.db
            .prepare(
                `SELECT path, extraction AS outcome, extraction_reason AS reason
                 FROM notes WHERE kind = 'binary' ORDER BY path`
            )
            .all() as unknown as { path: string; outcome: string | null; reason: string | null }[];
        return rows.map((row) => ({
            path: row.path,
            // Undefined rather than a stand-in string, so a caller has to decide
            // what "never attempted" means to it instead of pattern-matching a
            // sentence. It is not the same as any of the known outcomes.
            outcome: (row.outcome as ExtractionState | null) ?? undefined,
            reason: row.reason ?? undefined,
        }));
    }

    /** Notes whose frontmatter could not be parsed. */
    frontmatterErrors(): { path: string; error: string }[] {
        return this.db
            .prepare(
                `SELECT path, frontmatter_error AS error FROM notes
                 WHERE frontmatter_error IS NOT NULL ORDER BY path`
            )
            .all() as unknown as { path: string; error: string }[];
    }
}
