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
 *
 * **Deleting is soft, and `delete_note` has no option to make it otherwise.**
 * The executor takes a `hard` flag because the verifier needs one; a tool does
 * not, and the reason is not squeamishness about permanence. A soft delete
 * leaves a tombstone, and the tombstone is what tells every other device to
 * remove its copy. Erase the document instead and a device that was offline at
 * the time still holds the note, learns nothing on reconnecting, and pushes it
 * back: the delete appears to work and quietly undoes itself later. So the
 * reversible option is also the only one that actually deletes.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VaultReader } from "../vault/reader.js";
import { NoteNotFoundError } from "../vault/reader.js";
import { editFrontmatter, FrontmatterUnreadableError } from "../note/frontmatter.js";
import { AmbiguousHeadingError, appendUnderHeading, defaultSeparator } from "../note/sections.js";
import { civilDateIn, fillTemplate, inferDailyFormat, TimeZoneError } from "../note/daily.js";
import type { ResolutionImpact, VaultIndex } from "../index/index.js";
import {
    DestinationExistsError,
    LegacyDeletionError,
    RelocationIncompleteError,
    RevisionConflictError,
    UnwritablePathError,
    WriteTargetMissingError,
    type RelocateReceipt,
    type WriteExecutor,
    type WriteReceipt,
} from "../write/index.js";
import { isDeleted, MissingChunkError, UnsyncablePathError, type FileContent } from "../vault-model/index.js";
import { MissingScopeError, requireScope, SCOPE_WRITE, type SessionAuth } from "../auth/index.js";

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
 * What is at a path right now, whatever kind of file it is.
 *
 * `fresh: true` is not optional here. The replica is typically sub-second
 * behind, and a write composed from a copy that is even briefly stale is a lost
 * update that no conflict check can catch, because the revision would be stale
 * in exactly the same way. The same applies to a revision used to delete.
 */
async function readCurrent(ctx: WriteToolContext, path: string): Promise<CurrentNote & { binary: boolean }> {
    try {
        const { file } = await ctx.reader.read(path, { fresh: true });
        return {
            text: file.kind === "text" ? file.text : "",
            rev: file.rev ?? null,
            existed: true,
            binary: file.kind === "binary",
        };
    } catch (error) {
        if (error instanceof NoteNotFoundError) {
            // A deleted note is not there to read and is emphatically still
            // there to write against. The tombstone holds a revision, and a
            // write that asserts absence instead of superseding it is refused
            // by CouchDB with a conflict the caller cannot resolve: re-reading
            // the note reports nothing there, so the obvious next attempt is
            // the same failing one. Deleting a note in Obsidian is enough to
            // reach this, which is why it is handled here rather than in the
            // tool that just learned how to make tombstones.
            const tombstone = await ctx.executor.currentEntry(path);
            return { text: "", rev: tombstone?._rev ?? null, existed: false, binary: false };
        }
        throw error;
    }
}

/**
 * Read a note for the purpose of writing it back.
 *
 * Refuses an attachment, because every tool that uses this composes new text
 * and an attachment would have to be replaced wholesale.
 */
async function readForWrite(ctx: WriteToolContext, path: string): Promise<CurrentNote> {
    const current = await readCurrent(ctx, path);
    if (current.binary) throw new BinaryTargetError(path);
    return { text: current.text, rev: current.rev, existed: current.existed };
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

/** A file and the revision it was read at, ready to be written somewhere else. */
interface RelocationSource {
    content: FileContent;
    rev: string;
    kind: "text" | "binary";
    size: number;
}

/**
 * Read a file for the purpose of putting it at another path.
 *
 * Unlike `readForWrite` this accepts an attachment, because filing an Interact
 * PDF into `Superseded/` is the most likely move in this vault and an
 * attachment is what it is. Fresh, for the usual reason: the revision handed to
 * the executor has to be the one the content came from.
 */
async function readForRelocate(ctx: WriteToolContext, path: string): Promise<RelocationSource | undefined> {
    try {
        const { file } = await ctx.reader.read(path, { fresh: true });
        return {
            content:
                file.kind === "text"
                    ? { kind: "text", text: file.text }
                    : { kind: "binary", bytes: file.bytes },
            rev: file.rev as string,
            kind: file.kind,
            size: file.size,
        };
    } catch (error) {
        if (error instanceof NoteNotFoundError) return undefined;
        throw error;
    }
}

/**
 * The refusal a link check produces, or nothing when the move is clear.
 *
 * Both kinds are refused here and both are handed to `plan_move`, which can
 * rewrite the links and show its work first. The distinction between them is
 * still worth making in the message: a break is something the person will see
 * in Obsidian, and a repoint is something they will not.
 */
function linkRefusal(impact: ResolutionImpact, from: string, to: string, planTool: string): string {
    if (impact.breaks.length === 0 && impact.repoints.length === 0) return "";

    const lines: string[] = [
        `Nothing was written. Moving "${from}" to "${to}" would change what ` + `links mean.`,
    ];

    if (impact.breaks.length > 0) {
        lines.push(
            "",
            `${impact.breaks.length} link(s) would stop resolving:`,
            ...impact.breaks.slice(0, 10).map((link) => `  ${link.source}: [[${link.target}]]`),
            ...(impact.breaks.length > 10 ? [`  and ${impact.breaks.length - 10} more`] : [])
        );
    }

    if (impact.repoints.length > 0) {
        lines.push(
            "",
            // Listed second and described at length because this is the one
            // nobody would otherwise notice: nothing breaks, nothing looks
            // wrong, and the note now names a different file.
            `${impact.repoints.length} link(s) would quietly name a different file:`,
            ...impact.repoints
                .slice(0, 10)
                .map((link) => `  ${link.source}: ${asWritten(link)} would mean ${link.becomes}`),
            ...(impact.repoints.length > 10 ? [`  and ${impact.repoints.length - 10} more`] : [])
        );
    }

    lines.push(
        "",
        `Use ${planTool}, which rewrites the affected links and shows you the whole plan before ` +
            `anything is written. It may report more than the count above: a note that uses the ` +
            `same link text twice is one entry here and two rewrites there.`
    );
    return lines.join("\n");
}

/** A link the way it appears in the note, so a reader can find it. */
function asWritten(link: { target: string; subpath?: string; embed?: boolean }): string {
    return `${link.embed ? "!" : ""}[[${link.target}${link.subpath ? `#${link.subpath}` : ""}]]`;
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
            error instanceof MissingScopeError ||
            error instanceof TimeZoneError ||
            error instanceof DailyNoteUnknownError ||
            error instanceof BinaryTargetError ||
            error instanceof WriteTargetMissingError ||
            error instanceof LegacyDeletionError ||
            error instanceof DestinationExistsError ||
            // Carries the fact that the destination exists and the source was
            // not removed, which is the one thing the caller has to be told.
            error instanceof RelocationIncompleteError
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

/**
 * What a delete did, and what can still be done about it.
 *
 * `describe` would report zero chunks written and zero reused, which for a
 * deletion reads as though something went wrong. What matters instead is that
 * the note is gone from every device, and that a tombstone is what made that
 * happen.
 *
 * Whether the undo exists is asked of the registrations rather than stated,
 * because this sentence used to say that restoring the text was not something
 * this server could do, and went on saying it after `restore_note` was built to
 * do exactly that. That is worse than an out-of-date sentence elsewhere: a
 * model reading it will not offer the undo, so the tool that exists to make a
 * delete recoverable is invisible at the one moment it is wanted.
 */
function describeDeletion(receipt: WriteReceipt, canRestore: boolean): string {
    return (
        `Deleted "${receipt.path}".\n` +
        `Revision ${receipt.rev}, ${receipt.size.toLocaleString()} bytes removed. Marked deleted ` +
        `rather than erased, which is how the sync plugin does it: every device removes its copy ` +
        `on the next sync and the document stays behind as the record of that. ` +
        (canRestore
            ? `That record is also what makes this reversible: restore_note reads the text back ` +
              `out of it. Not forever, though. The sync plugin eventually collects the pieces no ` +
              `live note refers to, and after that the note is gone for good.`
            : `Restoring the text is not something this server can do.`) +
        (receipt.replicaPatchError ? `\n\nNote: ${receipt.replicaPatchError}` : "")
    );
}

export function registerWriteTools(server: FastMCP, ctx: WriteToolContext): string[] {
    // Names collected as the tools are registered, and returned, so that
    // anything wanting to say which tools can change the vault reads them from
    // the registrations rather than from a second list written by hand. There
    // was such a list, in the startup warning, and it was missing delete_note
    // for a day: the log said six tools when there were seven, which is the
    // worst kind of wrong for a warning whose whole job is to tell an operator
    // what has been let through the door.
    const registered: string[] = [];
    const addTool: typeof server.addTool = (tool) => {
        registered.push(tool.name);
        server.addTool(tool);
    };

    addTool({
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
        execute: async ({ path, content, properties }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                const current = await readForWrite(ctx, path);
                if (current.existed) {
                    return (
                        `"${path}" already exists. Refusing to overwrite it. ` +
                        `Use append_note to add to it, or edit_note to change part of it.`
                    );
                }

                const text = properties ? editFrontmatter(path, content, { set: properties }).text : content;

                // The revision read above, not a hardcoded null. They differ in
                // exactly one case: a path whose note was deleted still has a
                // tombstone, and asserting absence against it is a conflict
                // rather than a create. The guard above is what keeps this from
                // overwriting a live note; the revision is what lets a path be
                // used again after something was deleted from it.
                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text },
                    expectedRev: current.rev,
                });
                return describe(receipt, "Created");
            }),
    });

    addTool({
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
                        "content to follow. Defaults to a blank line, or to a single newline when " +
                        "a list item is being added to a list, so the list is not split in two."
                ),
        }),
        execute: async ({ path, content, heading, separator }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
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

    addTool({
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
                    "Placed before the new text when there is already content. Defaults to a blank " +
                        "line, or to a single newline when a list item is being added to a list."
                ),
        }),
        execute: async ({ content, heading, date, separator }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
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

    addTool({
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
        execute: async ({ path, find, replace }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
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

    addTool({
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
        execute: async ({ path, set, remove }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
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

    addTool({
        name: "delete_note",
        description:
            "Delete a note from the Obsidian vault. Use this for a note that should not exist: " +
            "one created here by mistake, or a draft that has been folded into another note. The " +
            "note is marked deleted, the way the sync plugin does it, so every device removes its " +
            "copy on the next sync. restore_note can usually bring it back afterwards, but not " +
            "always and not forever, and the vault is the user's own record, so read the note " +
            "first and say what is being removed rather than deleting on an assumption.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path including the .md extension."),
        }),
        execute: async ({ path }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                const current = await readCurrent(ctx, path);

                if (!current.existed) {
                    return (
                        `There is no note at "${path}", so there is nothing to delete. ` +
                        `Check the path with list_notes or search_notes.`
                    );
                }
                if (current.binary) {
                    return (
                        `"${path}" is an attachment, not a text note, and this tool does not remove ` +
                        `attachments. A transcription of one is the only thing in this vault that ` +
                        `cannot be recomputed, so removing the file it belongs to is a decision to ` +
                        `make in Obsidian.`
                    );
                }
                if (!current.rev) {
                    return (
                        `Could not establish the current revision of "${path}", so nothing was ` +
                        `deleted. Read the note again and retry.`
                    );
                }

                const receipt = await ctx.executor.remove({ path, expectedRev: current.rev });
                // Asked of the list the registrations built, not assumed.
                return describeDeletion(receipt, registered.includes("restore_note"));
            }),
    });

    addTool({
        name: "restore_note",
        description:
            "Bring back a note that was deleted, from the record the deletion left behind. Use " +
            "this when something was removed by mistake, including by delete_note. It works " +
            "because deleting is soft: the note's content is usually still recoverable, though " +
            "not always, and this says which. Refuses if something has since been written at the " +
            "same path, rather than replacing it.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path of the deleted note, including the extension."),
        }),
        execute: async ({ path }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);

                const live = await readCurrent(ctx, path);
                if (live.existed) {
                    return (
                        `"${path}" is not deleted, so there is nothing to restore. Read it if you ` +
                        `want to see what it says now.`
                    );
                }

                let deleted;
                try {
                    deleted = await ctx.reader.readDeleted(path);
                } catch (error) {
                    if (error instanceof MissingChunkError) {
                        // The one outcome worth explaining properly, because it
                        // is permanent and it is nobody's mistake: the sync
                        // plugin collects chunks a tombstone still references,
                        // which is correct behaviour and is also what makes a
                        // deletion eventually final.
                        return (
                            `"${path}" was deleted and its content can no longer be recovered: ` +
                            `${error.missing.length} of the pieces it was stored in have since ` +
                            `been collected, which the sync plugin does to anything no live note ` +
                            `refers to. Nothing was written. If the note matters, look for it in ` +
                            `a backup or on a device that has been offline since.`
                        );
                    }
                    throw error;
                }

                if (!deleted) {
                    return (
                        `There is nothing at "${path}", deleted or otherwise. Check the path with ` +
                        `list_notes or search_notes; a note deleted from a different path is not ` +
                        `reachable from this one.`
                    );
                }

                const content: FileContent =
                    deleted.file.kind === "text"
                        ? { kind: "text", text: deleted.file.text }
                        : { kind: "binary", bytes: deleted.file.bytes };

                const receipt = await ctx.executor.write({
                    path,
                    content,
                    // The tombstone's own revision. Asserting absence would be
                    // refused as a conflict: a deleted note is not a path with
                    // nothing at it, it is a path with a record of a deletion.
                    expectedRev: deleted.rev,
                    ctime: deleted.file.ctime,
                });

                return (
                    `${describe(receipt, "Restored")}\n` +
                    `The content came from the deletion record itself, which is why this was ` +
                    `possible; it is byte-for-byte what was there when the note was deleted, and ` +
                    `not a version from any backup.` +
                    (deleted.file.kind === "binary"
                        ? ` Any transcription of this attachment is still stored under this path ` +
                          `and becomes searchable again.`
                        : "")
                );
            }),
    });

    addTool({
        name: "move_file",
        description:
            "Move or rename one file in the Obsidian vault, without touching any other note. Use " +
            "this for reorganising: filing a document into a folder, giving a note a better name. " +
            "Give the whole destination path including the extension. Refuses, writing nothing, if " +
            "anything is already at the destination or if the move would change what any link in " +
            "the vault points at; use plan_move for those, which rewrites the links and shows you " +
            "the plan first. Accepts attachments as well as notes.",
        parameters: z.object({
            path: z.string().describe("The file to move, as a vault-relative path with its extension."),
            to: z
                .string()
                .describe(
                    "Where it should end up: a full vault-relative path including the filename and " +
                        "extension. Folders are implied by the path and do not have to exist."
                ),
        }),
        execute: async ({ path, to }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                return relocateOne(ctx, path, to, { keepSource: false });
            }),
    });

    addTool({
        name: "copy_file",
        description:
            "Copy one file in the Obsidian vault to another path, leaving the original where it " +
            "is. Use it to start a note from an existing one, or to keep a version of a document " +
            "before it is changed. Give the whole destination path including the extension. " +
            "Refuses if anything is already there, or if the copy would take inbound links away " +
            "from the file it was copied from. Accepts attachments as well as notes.",
        parameters: z.object({
            path: z.string().describe("The file to copy, as a vault-relative path with its extension."),
            to: z.string().describe("The full vault-relative path for the copy, including the extension."),
        }),
        execute: async ({ path, to }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                return relocateOne(ctx, path, to, { keepSource: true });
            }),
    });

    return registered;
}

/**
 * The body of `move_file` and `copy_file`, which differ in one flag.
 *
 * Shared rather than written twice: the checks are the interesting part and a
 * second copy of them would be the one that fell behind. What the flag changes
 * is which question the link check asks, and that difference is `keepSource`
 * on `resolutionImpact`, which is the whole reason that parameter exists.
 *
 * The link check reads the index, which is a cache and can be behind the vault
 * by a moment. That is the right trade here: a stale index can only be wrong
 * about a link that changed in the last second, and the alternative is parsing
 * every note in the vault before every move.
 */
async function relocateOne(
    ctx: WriteToolContext,
    path: string,
    to: string,
    options: { keepSource: boolean }
): Promise<string> {
    const what = options.keepSource ? "copy" : "move";
    if (path === to) return `"${path}" is already where it is. Nothing was written.`;

    const source = await readForRelocate(ctx, path);
    if (!source) {
        return (
            `There is nothing at "${path}" to ${what}. Check the path with list_notes or ` +
            `search_notes; a note that was deleted is not there to move either.`
        );
    }

    const destination = await ctx.executor.currentEntry(to);
    if (destination && !isDeleted(destination)) {
        return (
            `"${to}" already exists, so nothing was written. Choose another destination, or deal ` +
            `with the file that is there first.`
        );
    }

    const impact = ctx.index.resolutionImpact(path, to, { keepSource: options.keepSource });
    const refusal = options.keepSource
        ? copyRefusal(impact, path, to)
        : linkRefusal(impact, path, to, "plan_move");
    if (refusal) return refusal;

    const receipt = await ctx.executor.relocate({
        from: path,
        to,
        content: source.content,
        expectedRev: source.rev,
        keepSource: options.keepSource,
    });

    return describeRelocation(receipt, source, options.keepSource);
}

/**
 * The refusal for a copy, which cannot break a link and can steal one.
 *
 * Adding a path never unresolves anything, so `breaks` is empty by
 * construction here; what a copy can do is land on a shorter path than the file
 * it was copied from and take that file's inbound links with it, silently.
 * There is no plan tool to send this to, because the fix is a different
 * destination rather than a set of edits.
 */
function copyRefusal(impact: ResolutionImpact, from: string, to: string): string {
    if (impact.repoints.length === 0 && impact.breaks.length === 0) return "";
    return [
        `Nothing was written. A copy of "${from}" at "${to}" would take ${impact.repoints.length} ` +
            `link(s) away from the file they point at now, because the copy would be the shorter ` +
            `path and nothing in any note would have changed:`,
        ...impact.repoints
            .slice(0, 10)
            .map(
                (link) =>
                    `  ${link.source}: [[${link.target}]] would mean ${link.becomes} instead of ${link.was}`
            ),
        ...(impact.repoints.length > 10 ? [`  and ${impact.repoints.length - 10} more`] : []),
        "",
        `Copy it somewhere deeper, or give the copy a different name.`,
    ].join("\n");
}

/**
 * What a move did, including the checks that passed.
 *
 * Naming the checks rather than implying them, because "no links were affected"
 * is the claim the caller is relying on and it should be visible that something
 * actually asked the question.
 */
function describeRelocation(receipt: RelocateReceipt, source: RelocationSource, copied: boolean): string {
    const renamed = basenameOf(receipt.from) !== basenameOf(receipt.to);
    const lines = [
        `${copied ? "Copied" : renamed ? "Renamed" : "Moved"} "${receipt.from}" to "${receipt.to}".`,
        `Revision ${receipt.written.rev}, ${source.size.toLocaleString()} bytes, ` +
            `${receipt.written.chunksWritten} chunk(s) written and ${receipt.written.chunksReused} reused.`,
        `No link in the vault would break or come to mean a different file, which was checked ` +
            `before anything was written.`,
    ];

    if (receipt.transcriptMoved) {
        lines.push(
            `The stored transcription of this file ${copied ? "was copied to" : "moved with"} it, so ` +
                `it is still searchable at the new path.`
        );
    }
    if (receipt.transcriptError) lines.push(receipt.transcriptError);
    if (receipt.written.replicaPatchError) lines.push(`Note: ${receipt.written.replicaPatchError}`);

    return lines.join("\n");
}

function basenameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
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
    const joiner = existing.length === 0 ? "" : (separator ?? defaultSeparator(existing, content));
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
