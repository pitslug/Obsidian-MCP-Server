/**
 * Editing a note's frontmatter without disturbing anything else.
 *
 * Parsing frontmatter and rewriting it are different problems. The parser in
 * `parse.ts` only has to understand what a note means, so it can afford to
 * reduce frontmatter to a plain object. Rewriting cannot: a note is something a
 * person wrote, and the round trip through a plain object loses comments, key
 * order, quoting style and block scalars. Setting one property should not
 * silently reformat the other six.
 *
 * So this edits the YAML document in place through `yaml`'s document API, which
 * preserves everything it is not asked to change, and touches the body not at
 * all.
 *
 * The other half of the job is refusing. Frontmatter that does not parse, or
 * that is not a mapping, is frontmatter this cannot edit without guessing what
 * the author meant. Guessing there means destroying the only copy.
 */

import { parseDocument, type Document } from "yaml";

/** Frontmatter must open on the very first line. Same rule as the parser. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

export class FrontmatterUnreadableError extends Error {
    constructor(path: string, detail: string) {
        super(
            `The frontmatter of "${path}" cannot be edited: ${detail} ` +
                `Rewriting it would mean guessing what it was meant to say. Fix it in Obsidian first.`
        );
        this.name = "FrontmatterUnreadableError";
    }
}

export interface PropertyEdit {
    /** Properties to add or overwrite. */
    set?: Record<string, unknown>;
    /** Property names to remove. Absent names are not an error. */
    remove?: readonly string[];
}

export interface FrontmatterEditResult {
    text: string;
    /** Properties that were added, changed, removed, or left alone. */
    added: string[];
    changed: string[];
    removed: string[];
    unchanged: string[];
}

/**
 * Apply property edits to a note, returning the whole new note.
 *
 * `path` is only used to make errors legible.
 */
export function editFrontmatter(path: string, text: string, edit: PropertyEdit): FrontmatterEditResult {
    const match = FRONTMATTER.exec(text);
    const raw = match?.[1] ?? "";
    const body = match ? text.slice(match[0].length) : text;

    // Match the note's own line endings. A note written on Windows should not
    // acquire a lone LF block at the top because something edited a property.
    const eol = (match?.[0] ?? text).includes("\r\n") ? "\r\n" : "\n";

    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
        throw new FrontmatterUnreadableError(path, `it is not valid YAML (${doc.errors[0]?.message}).`);
    }

    const existing = doc.contents === null ? {} : doc.toJS();
    if (existing !== null && (typeof existing !== "object" || Array.isArray(existing))) {
        throw new FrontmatterUnreadableError(
            path,
            `it is ${Array.isArray(existing) ? "a list" : typeof existing}, not a set of properties.`
        );
    }

    const before = (existing ?? {}) as Record<string, unknown>;
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    for (const [key, value] of Object.entries(edit.set ?? {})) {
        const had = Object.prototype.hasOwnProperty.call(before, key);
        if (!had) {
            doc.set(key, value);
            added.push(key);
        } else if (!sameValue(before[key], value)) {
            doc.set(key, value);
            changed.push(key);
        } else {
            // Setting a property to what it already is would rewrite its
            // formatting for no reason, so it is skipped rather than applied.
            unchanged.push(key);
        }
    }

    for (const key of edit.remove ?? []) {
        if (!Object.prototype.hasOwnProperty.call(before, key)) continue;
        doc.delete(key);
        removed.push(key);
    }

    return {
        text: rebuild(doc, body, eol),
        added,
        changed,
        removed,
        unchanged,
    };
}

/**
 * Reassemble the note.
 *
 * A block that has become empty is dropped rather than left as `---\n---`. An
 * empty block is what the `yaml` serialiser produces as the literal `{}`, which
 * would be worse, and a note whose last property was removed should look like a
 * note with no properties.
 */
function rebuild(doc: Document, body: string, eol: string): string {
    const empty = doc.contents === null || (doc.toJS() ?? undefined) === undefined || isEmptyMap(doc);

    if (empty) return body;

    const yaml = String(doc).replace(/\r?\n$/, "");
    // The closing `---` ends with a line break, so the body already starts on
    // its own line whether or not there was a block here before. Nothing needs
    // inserting between them, and inserting a blank line would be an edit
    // nobody asked for.
    return `---${eol}${yaml.replace(/\r?\n/g, eol)}${eol}---${eol}${body}`;
}

function isEmptyMap(doc: Document): boolean {
    const items = (doc.contents as { items?: unknown[] } | null)?.items;
    return Array.isArray(items) && items.length === 0;
}

/** Structural equality, so setting a property to its current value is a no-op. */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
