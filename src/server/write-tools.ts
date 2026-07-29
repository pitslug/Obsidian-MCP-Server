/**
 * The write tools.
 *
 * Thin, like the read tools: validate arguments, call the executor, report what
 * happened. The one piece of judgement here is how a tool gets the content it
 * is about to write, and it is worth stating because getting it wrong loses
 * somebody's work.
 *
 * **Every tool reads the note fresh from CouchDB and writes against the exact
 * revision it read.** Not the replica, which is eventually consistent, and not
 * a revision looked up separately afterwards. `read(path, { fresh: true })`
 * returns the content and its revision as one observation, and that revision is
 * what goes to the executor. If another device changed the note in the moment
 * between, CouchDB refuses the write and the user is told what happened, rather
 * than the other device's edit quietly disappearing.
 *
 * That is why `WriteRequest.expectedRev` is required rather than optional. A
 * tool that let the executor look the revision up would succeed every time and
 * lose an edit occasionally, which is the worse failure by a wide margin.
 *
 * These tools are **absent** when writes are disabled rather than present and
 * failing, for the same reason the read-only build has no stubs: a tool that
 * reports "not implemented" gets tried anyway, and the person is left believing
 * writing is a configuration away when it is a decision away.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VaultReader } from "../vault/reader.js";
import { NoteNotFoundError } from "../vault/reader.js";
import { editFrontmatter, FrontmatterUnreadableError } from "../note/frontmatter.js";
import { AmbiguousHeadingError, appendUnderHeading } from "../note/sections.js";
import { civilDateIn, fillTemplate, inferDailyFormat, TimeZoneError } from "../note/daily.js";
import type { VaultIndex } from "../index/index.js";
import {
    RevisionConflictError,
    UnwritablePathError,
    type WriteExecutor,
    type WriteReceipt,
} from "../write/index.js";
import { UnsyncablePathError } from "../vault-model/index.js";

export interface WriteToolContext {
    reader: VaultReader;
    executor: WriteExecutor;
    /** Used to work out where daily notes live. */
    index: VaultIndex;
    /** An explicit daily note template, when configured. */
    dailyNotePath: string | undefined;
    /** The zone whose civil date counts as today. */
    timeZone: string;
    /** Overridable for tests, which must not depend on the day they run. */
    now?: () => number;
}

/** A note's current text and the revision it was read at, as one observation. */
interface CurrentNote {
    text: string;
    rev: string | null;
    existed: boolean;
}

/**
 * Read a note for the purpose of writing it back.
 *
 * `fresh: true` is not optional here. The replica is typically sub-second
 * behind, and a write composed from a copy that is even briefly stale is a lost
 * update that no conflict check can catch, because the revision would be stale
 * in exactly the same way.
 */
async function readForWrite(ctx: WriteToolContext, path: string): Promise<CurrentNote> {
    try {
        const { file } = await ctx.reader.read(path, { fresh: true });
        if (file.kind === "binary") {
            throw new BinaryTargetError(path);
        }
        return { text: file.text, rev: file.rev ?? null, existed: true };
    } catch (error) {
        if (error instanceof NoteNotFoundError) return { text: "", rev: null, existed: false };
        throw error;
    }
}

class BinaryTargetError extends Error {
    constructor(path: string) {
        super(
            `"${path}" is an attachment, not a text note. These tools edit text; an attachment ` +
                `would have to be replaced wholesale, which is not something they do.`
        );
        this.name = "BinaryTargetError";
    }
}

/** Turn the errors a write can raise into something a model can act on. */
async function reporting(work: () => Promise<string>): Promise<string> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof RevisionConflictError) {
            return (
                `${error.message}\n\n` +
                `Nothing was written. Read the note again to see what it says now, then decide ` +
                `whether your change still applies.`
            );
        }
        if (
            error instanceof UnwritablePathError ||
            error instanceof UnsyncablePathError ||
            error instanceof FrontmatterUnreadableError ||
            error instanceof AmbiguousHeadingError ||
            error instanceof TimeZoneError ||
            error instanceof DailyNoteUnknownError ||
            error instanceof BinaryTargetError
        ) {
            return error.message;
        }
        throw error;
    }
}

/** One line describing what a write did, so the caller is not left guessing. */
function describe(receipt: WriteReceipt, what: string): string {
    return (
        `${what} "${receipt.path}".\n` +
        `Revision ${receipt.rev}, ${receipt.size.toLocaleString()} bytes, ` +
        `${receipt.chunksWritten} chunk(s) written and ${receipt.chunksReused} reused.` +
        (receipt.replicaPatchError ? `\n\nNote: ${receipt.replicaPatchError}` : "")
    );
}

export function registerWriteTools(server: FastMCP, ctx: WriteToolContext): void {
    server.addTool({
        name: "create_note",
        description:
            "Create a new note in the Obsidian vault at a given path, with optional frontmatter " +
            "properties. Fails if a note already exists there, so it can never overwrite one by " +
            "accident. Use append_note or edit_note to change an existing note.",
        parameters: z.object({
            path: z
                .string()
                .describe("Vault-relative path including the .md extension, e.g. 'ideas/kaizen.md'."),
            content: z.string().describe("The note body, without frontmatter."),
            properties: z
                .record(z.unknown())
                .optional()
                .describe('Frontmatter properties, e.g. {"tags": ["idea"], "status": "draft"}.'),
        }),
        execute: async ({ path, content, properties }) =>
            reporting(async () => {
                const current = await readForWrite(ctx, path);
                if (current.existed) {
                    return (
                        `"${path}" already exists. Refusing to overwrite it. ` +
                        `Use append_note to add to it, or edit_note to change part of it.`
                    );
                }

                const text = properties ? editFrontmatter(path, content, { set: properties }).text : content;

                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text },
                    expectedRev: null,
                });
                return describe(receipt, "Created");
            }),
    });

    server.addTool({
        name: "append_note",
        description:
            "Append text to a note in the Obsidian vault, creating the note if it does not exist. " +
            "Use this for capture: adding an entry to a daily note, a line to a running list, a " +
            "thought to an inbox. Existing content is never modified. Give a heading to append " +
            "inside that section rather than at the end of the note, which is what you want on any " +
            "note that has a structure.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path including the .md extension."),
            content: z.string().describe("Text to add."),
            heading: z
                .string()
                .optional()
                .describe(
                    "Append at the end of this heading's section instead of the end of the note. " +
                        "The heading is created at the end of the note if it does not exist."
                ),
            separator: z
                .string()
                .optional()
                .describe(
                    "Placed between the existing content and the new text when there is already " +
                        "content to follow. Defaults to a blank line."
                ),
        }),
        execute: async ({ path, content, heading, separator }) =>
            reporting(async () => {
                const current = await readForWrite(ctx, path);
                const { text, where } = appended(current.text, content, heading, separator);

                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text },
                    expectedRev: current.rev,
                });
                return (
                    describe(receipt, current.existed ? "Appended to" : "Created") +
                    (where ? `\n${where}` : "")
                );
            }),
    });

    server.addTool({
        name: "append_daily",
        description:
            "Append text to today's daily note in the Obsidian vault, creating the note if today " +
            "does not have one yet. This is the capture tool: use it for a thought, a log entry, a " +
            "task, anything that belongs to today rather than to a particular note. Works out " +
            "where daily notes live from the vault itself, and says which path it used. Give a " +
            "heading to file the text under a section of the note.",
        parameters: z.object({
            content: z.string().min(1).describe("Text to add to the daily note."),
            heading: z
                .string()
                .optional()
                .describe(
                    "Append inside this section of the daily note, creating the heading if the " +
                        "note does not have it yet. Use it to keep captures out of whatever " +
                        "section happens to be last."
                ),
            date: z
                .string()
                .optional()
                .describe(
                    "A different day, as YYYY-MM-DD. Defaults to today in the vault's configured " +
                        "time zone, which is not necessarily the server's."
                ),
            separator: z
                .string()
                .optional()
                .describe(
                    "Placed before the new text when there is already content. Defaults to a blank line."
                ),
        }),
        execute: async ({ content, heading, date, separator }) =>
            reporting(async () => {
                const target = dailyTarget(ctx, date);
                const current = await readForWrite(ctx, target.path);
                const { text, where } = appended(current.text, content, heading, separator);

                const receipt = await ctx.executor.write({
                    path: target.path,
                    content: { kind: "text", text },
                    expectedRev: current.rev,
                });

                return [
                    describe(receipt, current.existed ? "Appended to" : "Created"),
                    where,
                    target.provenance,
                ]
                    .filter(Boolean)
                    .join("\n");
            }),
    });

    server.addTool({
        name: "edit_note",
        description:
            "Replace an exact piece of text in a note in the Obsidian vault. Use this for a " +
            "targeted change: fixing a line, updating a value, rewording a paragraph. The text to " +
            "find must appear exactly once, so the edit is unambiguous. Read the note first to get " +
            "the text right.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path including the .md extension."),
            find: z
                .string()
                .min(1)
                .describe("The exact text to replace. Must appear exactly once in the note."),
            replace: z.string().describe("What to put in its place. May be empty to delete the text."),
        }),
        execute: async ({ path, find, replace }) =>
            reporting(async () => {
                const current = await readForWrite(ctx, path);
                if (!current.existed) {
                    return `There is no note at "${path}". Use create_note to make one.`;
                }

                // Counted rather than replaced-first, because `replace` on a
                // string replaces only the first occurrence, and silently
                // editing the first of several matches is the kind of wrong
                // that is discovered weeks later.
                const occurrences = countOccurrences(current.text, find);
                if (occurrences === 0) {
                    return (
                        `That text does not appear in "${path}". Nothing was changed. ` +
                        `Read the note to see its exact current wording, including whitespace.`
                    );
                }
                if (occurrences > 1) {
                    return (
                        `That text appears ${occurrences} times in "${path}", so this edit is ` +
                        `ambiguous. Nothing was changed. Include more surrounding context to ` +
                        `identify the one you mean.`
                    );
                }

                const text = current.text.replace(find, () => replace);
                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text },
                    expectedRev: current.rev,
                });
                return describe(receipt, "Edited");
            }),
    });

    server.addTool({
        name: "set_properties",
        description:
            "Add, change or remove frontmatter properties on a note in the Obsidian vault, " +
            "leaving the note's body and its other properties untouched. Use property_inventory " +
            "first to see what property names and value shapes the vault already uses, so a new " +
            "note fits the existing scheme rather than inventing a parallel one.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path including the .md extension."),
            set: z
                .record(z.unknown())
                .optional()
                .describe('Properties to add or overwrite, e.g. {"status": "done"}.'),
            remove: z.array(z.string()).optional().describe("Property names to remove."),
        }),
        execute: async ({ path, set, remove }) =>
            reporting(async () => {
                if (!set && !remove) return "Nothing to do: give set, remove, or both.";

                const current = await readForWrite(ctx, path);
                if (!current.existed) {
                    return `There is no note at "${path}". Use create_note to make one.`;
                }

                const edit = editFrontmatter(path, current.text, { set, remove });
                const touched = [...edit.added, ...edit.changed, ...edit.removed];
                if (touched.length === 0) {
                    return (
                        `"${path}" already has exactly those properties. Nothing was written, ` +
                        `so its modification time is unchanged.`
                    );
                }

                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text: edit.text },
                    expectedRev: current.rev,
                });

                const parts = [
                    edit.added.length > 0 ? `added ${edit.added.join(", ")}` : "",
                    edit.changed.length > 0 ? `changed ${edit.changed.join(", ")}` : "",
                    edit.removed.length > 0 ? `removed ${edit.removed.join(", ")}` : "",
                ].filter(Boolean);

                return `${describe(receipt, "Updated properties on")}\nProperties ${parts.join("; ")}.`;
            }),
    });
}

/**
 * The note as it will be after appending, and a line saying where it went.
 *
 * The two appending tools share this rather than each having their own, because
 * the difference between them is which note they choose and nothing else. Two
 * implementations of "append" would drift, and the one that drifted would be
 * the one appending to a daily note unattended.
 */
function appended(
    existing: string,
    content: string,
    heading: string | undefined,
    separator: string | undefined
): { text: string; where: string } {
    if (heading) {
        const result = appendUnderHeading(existing, heading, content, { separator });
        return {
            text: result.text,
            where: result.headingCreated
                ? `There was no "${heading}" heading, so one was added at the end of the note.`
                : `Added at the end of the "${heading}" section.`,
        };
    }

    // A note that does not end in a newline would otherwise have the appended
    // text run onto its last line, which is almost never what someone
    // appending a line meant.
    const joiner = existing.length === 0 ? "" : (separator ?? "\n\n");
    const text = existing.length === 0 ? content : `${trimTrailingNewline(existing)}${joiner}${content}`;
    return { text, where: "" };
}

export class DailyNoteUnknownError extends Error {
    constructor(detail: string) {
        super(
            `Cannot work out where this vault's daily notes live. ${detail} ` +
                `Obsidian keeps that setting in a hidden file this vault does not sync, so it is ` +
                `inferred from the dated filenames already in the vault. Set DAILY_NOTE_PATH to a ` +
                `template such as "daily/YYYY-MM-DD.md", or use append_note with an explicit path.`
        );
        this.name = "DailyNoteUnknownError";
    }
}

interface DailyTarget {
    path: string;
    /** How the template was arrived at, for the tool to say out loud. */
    provenance: string;
}

/**
 * Where today's note is, and why this tool thinks so.
 *
 * The provenance is not decoration. An inferred path that is wrong creates a
 * note in a folder nobody opens, which looks exactly like a note that was never
 * created. Saying which template was used and where it came from is what makes
 * that visible on the first append rather than the fiftieth.
 */
function dailyTarget(ctx: WriteToolContext, date: string | undefined): DailyTarget {
    const civil = date ? parseIsoDate(date) : civilDateIn(ctx.timeZone, (ctx.now ?? Date.now)());

    if (ctx.dailyNotePath) {
        return {
            path: fillTemplate(ctx.dailyNotePath, civil),
            provenance: `DAILY_NOTE_PATH is set to "${ctx.dailyNotePath}".`,
        };
    }

    const inferred = inferDailyFormat(ctx.index.allPaths());
    if (!inferred) {
        throw new DailyNoteUnknownError(
            `No folder in the vault holds two or more notes with date-shaped filenames.`
        );
    }

    const caveats = [
        inferred.assumedDayFirst
            ? `The filenames are day-month-year or month-day-year and none of them settles which, ` +
              `so day-first was assumed.`
            : "",
        inferred.alternatives.length > 0
            ? `Other folders also hold dated notes: ` +
              `${inferred.alternatives.map((alt) => `${alt.folder || "the vault root"} (${alt.matches})`).join(", ")}.`
            : "",
    ].filter(Boolean);

    return {
        path: fillTemplate(inferred.template, civil),
        provenance: [
            `Inferred the template "${inferred.template}" from ${inferred.matches} existing note(s), ` +
                `for example ${inferred.examples.slice(0, 2).join(" and ")}.`,
            ...caveats,
        ].join(" "),
    };
}

function parseIsoDate(text: string): { year: number; month: number; day: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
    if (!match) {
        throw new DailyNoteUnknownError(`"${text}" is not a date. Give it as YYYY-MM-DD.`);
    }
    const [, year, month, day] = match.map(Number) as [number, number, number, number];
    return { year, month, day };
}

/** Strip a single trailing newline, so appending does not accumulate blank lines. */
function trimTrailingNewline(text: string): string {
    return text.replace(/\r?\n$/, "");
}

function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let at = haystack.indexOf(needle);
    while (at !== -1) {
        count++;
        at = haystack.indexOf(needle, at + needle.length);
    }
    return count;
}
