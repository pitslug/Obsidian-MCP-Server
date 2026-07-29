/**
 * Batch property setting, and the plan protocol it runs behind.
 *
 * Setting one property on one note is a write tool. Setting it on everything
 * matching a query is a different kind of act, and the difference is not the
 * number of notes. It is that nobody sees the result. A single edit is checked
 * by the person who asked for it, in the reply. A batch is checked by nobody:
 * it succeeds, reports a number, and the notes it was wrong about are found
 * weeks later, by which time the original values are one revision back on every
 * device that has synced.
 *
 * So the batch path is deliberately slower to use. `plan_set_properties`
 * resolves the selection, works out what would change, and writes nothing. What
 * it returns is meant to be read by a person before `commit_plan` is called
 * with the ID.
 *
 * ## Why the selection is a query and not a list of paths
 *
 * The alternative was to make the caller pass paths it had already looked up.
 * That sounds safer and is not, for a reason worth writing down: it moves the
 * selection into a place nobody can check it. A list of forty paths in a tool
 * call is unreviewable by construction, and a model that assembled it from an
 * earlier search result may have dropped one, or kept one that had scrolled out
 * of its context. A selector is a statement of intent, short enough to read.
 *
 * The plan then lists every path the selector resolved to, so the intent and
 * the consequence are both visible and can be compared. That comparison is the
 * whole review, and it is only possible when both halves are present.
 *
 * ## What is refused rather than guessed
 *
 * A note whose frontmatter cannot be parsed is excluded from the plan and named
 * in the output, rather than failing the batch. Frontmatter breaks one note at
 * a time, usually years ago, and a tidy-up across forty notes should not be
 * blocked by one of them. Excluding silently would be the real error, so the
 * exclusions are printed with their reasons.
 *
 * A selection with no selectors at all is refused outright. "Everything" is a
 * plausible thing to mean and an implausible thing to have meant.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VaultIndex, IndexedNote } from "../index/index.js";
import type { VaultReader } from "../vault/reader.js";
import { NoteNotFoundError } from "../vault/reader.js";
import { editFrontmatter, FrontmatterUnreadableError } from "../note/frontmatter.js";
import { renderPlan } from "../write/render.js";
import {
    PlanAlreadyUsedError,
    PlanCeilingError,
    PlanCommitError,
    PlanExpiredError,
    PlanNotFoundError,
    PlanStaleError,
    type PlanningWriteExecutor,
    type PlanOperation,
} from "../write/index.js";
import { UnsyncablePathError } from "../vault-model/index.js";
import { UnwritablePathError } from "../write/executor.js";

export interface PlanToolContext {
    reader: VaultReader;
    index: VaultIndex;
    executor: PlanningWriteExecutor;
}

/** A selector, expressed the way the read tools express the same thing. */
const SELECTION = {
    tag: z
        .string()
        .optional()
        .describe("Notes carrying this tag, without the '#'. Use tag_inventory to see what exists."),
    property_key: z
        .string()
        .optional()
        .describe("Notes carrying this frontmatter property. Use property_inventory to see what exists."),
    property_value: z
        .string()
        .optional()
        .describe("Narrows property_key to notes where it has exactly this value."),
    folder: z.string().optional().describe("Notes under this folder and everything below it."),
    query: z
        .string()
        .optional()
        .describe("Full-text search, same syntax as search_notes. Notes matching it."),
};

interface Selection {
    tag?: string;
    property_key?: string;
    property_value?: string;
    folder?: string;
    query?: string;
}

/** How the selection reads back, so the plan can restate what was asked for. */
function describeSelection(selection: Selection): string {
    const parts = [
        selection.tag ? `tagged #${selection.tag}` : "",
        selection.property_key
            ? selection.property_value === undefined
                ? `having a "${selection.property_key}" property`
                : `where ${selection.property_key} = ${JSON.stringify(selection.property_value)}`
            : "",
        selection.folder ? `under "${selection.folder}"` : "",
        selection.query ? `matching ${JSON.stringify(selection.query)}` : "",
    ].filter(Boolean);
    return parts.join(" and ");
}

class EmptySelectionError extends Error {
    constructor() {
        super(
            `No selection was given, which would mean every note in the vault. Give at least one ` +
                `of tag, property_key, folder or query. If you really do mean the whole vault, say ` +
                `so with a folder of "/" and expect the plan to be long.`
        );
        this.name = "EmptySelectionError";
    }
}

/**
 * Resolve a selector to a set of notes.
 *
 * Every selector given must match, so adding one can only ever narrow the
 * result. The alternative, matching any of them, reads the same in a tool call
 * and does the opposite thing, and the failure is silent: a batch meant for the
 * eleven notes both tagged and in a folder runs against the four hundred that
 * are either.
 */
function resolve(index: VaultIndex, selection: Selection): IndexedNote[] {
    const given = [
        selection.tag,
        selection.property_key,
        selection.query,
        selection.folder === "/" ? undefined : selection.folder,
    ].filter((value) => value !== undefined && value !== "");

    if (given.length === 0 && selection.folder !== "/") throw new EmptySelectionError();

    const sets: IndexedNote[][] = [];
    if (selection.tag) sets.push(index.findByTag(selection.tag.replace(/^#/, "")));
    if (selection.property_key) {
        sets.push(index.findByProperty(selection.property_key, selection.property_value));
    }
    if (selection.query) {
        sets.push(index.search({ query: selection.query, folder: selection.folder, limit: 1000 }));
    }
    if (sets.length === 0 || (selection.folder && selection.folder !== "/")) {
        sets.push(index.notesUnder(selection.folder === "/" ? undefined : selection.folder));
    }

    const [first, ...rest] = sets;
    const keep = rest.reduce(
        (survivors, next) => {
            const allowed = new Set(next.map((note) => note.path));
            return survivors.filter((note) => allowed.has(note.path));
        },
        (first ?? []).slice()
    );

    // Attachments have no frontmatter to set, and including them would put
    // lines in the plan for notes that could never change.
    const unique = new Map<string, IndexedNote>();
    for (const note of keep) {
        if (note.kind !== "text") continue;
        unique.set(note.path, note);
    }
    return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Turn the errors the plan protocol raises into something a model can act on. */
async function reporting(work: () => Promise<string>): Promise<string> {
    try {
        return await work();
    } catch (error) {
        if (
            error instanceof EmptySelectionError ||
            error instanceof PlanNotFoundError ||
            error instanceof PlanExpiredError ||
            error instanceof PlanAlreadyUsedError ||
            error instanceof PlanCeilingError ||
            error instanceof PlanStaleError ||
            error instanceof PlanCommitError ||
            error instanceof UnwritablePathError ||
            error instanceof UnsyncablePathError
        ) {
            return error.message;
        }
        throw error;
    }
}

export function registerPlanTools(server: FastMCP, ctx: PlanToolContext): void {
    server.addTool({
        name: "plan_set_properties",
        description:
            "Work out what setting frontmatter properties across a set of notes would do, and " +
            "write nothing. Selects notes by tag, property, folder or search, and returns a plan " +
            "listing every note it would change and how. Show that plan to the person who asked " +
            "before calling commit_plan with its ID. This is the tool for changing a property " +
            "across many notes at once; use set_properties for a single note.",
        parameters: z.object({
            ...SELECTION,
            set: z
                .record(z.unknown())
                .optional()
                .describe(
                    'Properties to add or overwrite on every selected note, e.g. {"status": "archived"}.'
                ),
            remove: z
                .array(z.string())
                .optional()
                .describe("Property names to remove from every selected note."),
        }),
        execute: async ({ set, remove, ...selection }) =>
            reporting(async () => {
                if (!set && !remove) return "Nothing to do: give set, remove, or both.";

                const selected = resolve(ctx.index, selection);
                if (selected.length === 0) {
                    return `No notes are ${describeSelection(selection)}. Nothing to plan.`;
                }

                const operations: PlanOperation[] = [];
                const excluded: { path: string; reason: string }[] = [];

                for (const note of selected) {
                    let current;
                    try {
                        // Fresh, and its revision recorded alongside, for the
                        // same reason the single-note tools read fresh: the
                        // content this plan holds and the revision it will be
                        // committed against have to be one observation.
                        const read = await ctx.reader.read(note.path, { fresh: true });
                        if (read.file.kind === "binary") continue;
                        current = read.file;
                    } catch (error) {
                        if (error instanceof NoteNotFoundError) {
                            // Indexed but no longer there. The index lags the
                            // vault by design; this is that lag, not an error.
                            excluded.push({ path: note.path, reason: "no longer in the vault" });
                            continue;
                        }
                        throw error;
                    }

                    let edit;
                    try {
                        edit = editFrontmatter(note.path, current.text, { set, remove });
                    } catch (error) {
                        if (error instanceof FrontmatterUnreadableError) {
                            excluded.push({ path: note.path, reason: shortReason(error.message) });
                            continue;
                        }
                        throw error;
                    }

                    if (edit.added.length + edit.changed.length + edit.removed.length === 0) continue;

                    operations.push({
                        kind: "write",
                        path: note.path,
                        content: { kind: "text", text: edit.text },
                        expectedRev: current.rev ?? null,
                        summary: summarise(edit, set),
                        // Adding a property that was absent is recoverable by
                        // removing it again. Overwriting one, or removing one,
                        // destroys a value that existed and that nothing in
                        // this system has a copy of. Only the second kind has
                        // to survive truncation.
                        notable: edit.changed.length > 0 || edit.removed.length > 0,
                    });
                }

                if (operations.length === 0) {
                    return (
                        `${selected.length} note(s) are ${describeSelection(selection)}, and every one ` +
                        `already has exactly those properties. Nothing to do.` +
                        (excluded.length > 0 ? `\n\n${excludedBlock(excluded)}` : "")
                    );
                }

                const plan = await ctx.executor.plan(operations);

                return [
                    `Selection: notes ${describeSelection(selection)} (${selected.length} matched).`,
                    "",
                    renderPlan(plan, { excluded }),
                ].join("\n");
            }),
    });

    server.addTool({
        name: "commit_plan",
        description:
            "Apply a plan made by plan_set_properties, by its ID. Refuses in full, writing nothing, " +
            "if any of the notes changed since the plan was made. Only call this after the plan has " +
            "been shown to the person who asked for it and they have agreed to it.",
        parameters: z.object({
            plan_id: z.string().min(1).describe("The ID printed at the end of the plan."),
        }),
        execute: async ({ plan_id }) =>
            reporting(async () => {
                const result = await ctx.executor.commit(plan_id);
                if (result.applied.length === 0) {
                    return `Plan ${plan_id} committed, and every note in it already said exactly that. Nothing was written.`;
                }
                const bytes = result.applied.reduce((sum, receipt) => sum + receipt.size, 0);
                const paths = result.applied.slice(0, 10).map((receipt) => `  ${receipt.path}`);
                const more =
                    result.applied.length > paths.length
                        ? [`  and ${result.applied.length - paths.length} more`]
                        : [];
                return [
                    `Committed plan ${plan_id}: ${result.applied.length} note(s) written, ${bytes.toLocaleString()} bytes.`,
                    ...paths,
                    ...more,
                ].join("\n");
            }),
    });

    server.addTool({
        name: "discard_plan",
        description:
            "Throw away a plan without applying it. Plans expire on their own, so this is a " +
            "courtesy rather than a requirement; use it when a plan turned out to be wrong.",
        parameters: z.object({ plan_id: z.string().min(1) }),
        execute: async ({ plan_id }) =>
            ctx.executor.discard(plan_id)
                ? `Plan ${plan_id} discarded. Nothing was written.`
                : `There is no plan with ID "${plan_id}". It may have expired or already been committed.`,
    });
}

/**
 * One note's property change, in the words a reviewer would use.
 *
 * Names the properties rather than counting them, because the question a
 * reviewer is actually asking is "is it touching the right property", and a
 * line reading "3 properties changed" cannot answer it.
 */
function summarise(
    edit: { added: string[]; changed: string[]; removed: string[] },
    set: Record<string, unknown> | undefined
): string {
    const value = (key: string) => {
        const raw = set?.[key];
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        return text !== undefined && text.length > 30 ? `${text.slice(0, 30)}...` : text;
    };
    return [
        edit.changed.length > 0
            ? `overwrites ${edit.changed.map((key) => `${key} (to ${value(key)})`).join(", ")}`
            : "",
        edit.removed.length > 0 ? `removes ${edit.removed.join(", ")}` : "",
        edit.added.length > 0 ? `adds ${edit.added.map((key) => `${key} = ${value(key)}`).join(", ")}` : "",
    ]
        .filter(Boolean)
        .join("; ");
}

function excludedBlock(excluded: { path: string; reason: string }[]): string {
    return [`Excluded (${excluded.length}):`, ...excluded.map((e) => `  ${e.path}: ${e.reason}`)].join("\n");
}

/** The first sentence of a frontmatter error, which is the part that says what is wrong. */
function shortReason(message: string): string {
    const match = /cannot be edited: (.*?\.)\s/.exec(message);
    return match?.[1] ?? message;
}
