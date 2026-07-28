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
            "Append text to the end of a note in the Obsidian vault, creating the note if it does " +
            "not exist. Use this for capture: adding an entry to a daily note, a line to a running " +
            "list, a thought to an inbox. Existing content is never modified.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path including the .md extension."),
            content: z.string().describe("Text to add at the end of the note."),
            separator: z
                .string()
                .optional()
                .describe(
                    "Placed between the existing content and the new text when the note already " +
                        "has content. Defaults to a blank line."
                ),
        }),
        execute: async ({ path, content, separator }) =>
            reporting(async () => {
                const current = await readForWrite(ctx, path);

                // A note that does not end in a newline would otherwise have
                // the appended text run onto its last line, which is almost
                // never what someone appending a line meant.
                const existing = current.text;
                const joiner = existing.length === 0 ? "" : (separator ?? "\n\n");
                const text =
                    existing.length === 0 ? content : `${trimTrailingNewline(existing)}${joiner}${content}`;

                const receipt = await ctx.executor.write({
                    path,
                    content: { kind: "text", text },
                    expectedRev: current.rev,
                });
                return describe(receipt, current.existed ? "Appended to" : "Created");
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
