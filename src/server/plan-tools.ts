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
import type { FastMCP, FastMCPSessionAuth, Tool, ToolParameters } from "fastmcp";
import type { VaultIndex, IndexedNote } from "../index/index.js";
import type { VaultReader } from "../vault/reader.js";
import { NoteNotFoundError } from "../vault/reader.js";
import { editFrontmatter, FrontmatterUnreadableError } from "../note/frontmatter.js";
import { renderWikilink, rewriteLinkTargets } from "../note/links.js";
import { parseNote } from "../note/parse.js";
import { isUnder, retagProperty, rewriteInlineTag } from "../note/tags.js";
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
import { isDeleted, UnsyncablePathError } from "../vault-model/index.js";
import { DestinationExistsError, UnwritablePathError, WriteTargetMissingError } from "../write/executor.js";
import { MissingScopeError, requireScope, SCOPE_WRITE, type SessionAuth } from "../auth/index.js";

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
            error instanceof MissingScopeError ||
            error instanceof PlanNotFoundError ||
            error instanceof PlanExpiredError ||
            error instanceof PlanAlreadyUsedError ||
            error instanceof PlanCeilingError ||
            error instanceof PlanStaleError ||
            error instanceof PlanCommitError ||
            error instanceof UnwritablePathError ||
            error instanceof UnsyncablePathError ||
            error instanceof DestinationExistsError ||
            error instanceof WriteTargetMissingError
        ) {
            return error.message;
        }
        throw error;
    }
}

export function registerPlanTools(server: FastMCP, ctx: PlanToolContext): string[] {
    // Returned for the same reason as in write-tools.ts: nothing outside this
    // file should be keeping its own list of which tools can change the vault.
    // Only one of these three can, which is the point of the protocol and is
    // recorded here, next to the tool, rather than in a sentence elsewhere.
    const mutating: string[] = [];
    const addTool = <Params extends ToolParameters>(
        tool: Tool<FastMCPSessionAuth, Params>,
        options: { mutates?: boolean } = {}
    ) => {
        if (options.mutates) mutating.push(tool.name);
        server.addTool(tool);
    };

    addTool({
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
        execute: async ({ set, remove, ...selection }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
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

    addTool({
        name: "plan_retag",
        description:
            "Work out what renaming, merging or removing a tag across the whole vault would do, " +
            "and write nothing. Covers both places a tag lives: the frontmatter list and #tags " +
            "written in the body. Renaming takes nested tags with it, so renaming 'work' also " +
            "moves 'work/acme'. Renaming onto a tag that already exists merges them. Omit 'to' to " +
            "remove the tag instead. Show the plan to the person who asked before calling " +
            "commit_plan with its ID. Use tag_inventory first to see what the vault actually uses.",
        parameters: z.object({
            tag: z
                .string()
                .min(1)
                .describe("The tag as it exists now, without the '#'. Nested tags use '/'."),
            to: z
                .string()
                .optional()
                .describe(
                    "What it should become, without the '#'. Leave this out to remove the tag " +
                        "from every note instead."
                ),
            folder: z
                .string()
                .optional()
                .describe(
                    "Limit to notes under this folder. Leave it out for the whole vault, which " +
                        "is what renaming a tag usually means."
                ),
        }),
        execute: async ({ tag, to, folder }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);

                const from = tag.replace(/^#/, "").trim();
                const target = to?.replace(/^#/, "").trim();
                if (!from) return "Give the tag to rename, without the '#'.";
                if (target !== undefined && !target) {
                    return `Give a new name, or leave "to" out entirely to remove #${from}.`;
                }
                if (target === from) return `#${from} is already called that. Nothing to plan.`;

                const known = ctx.index.tagInventory().filter((entry) => isUnder(entry.tag, from));
                if (known.length === 0) {
                    return (
                        `No note carries #${from}. Nothing to plan. Use tag_inventory to see what ` +
                        `tags this vault actually uses; a tag written only inside a code block is ` +
                        `not a tag.`
                    );
                }

                const nested = known.filter((entry) => entry.tag !== from);
                if (target === undefined && nested.length > 0) {
                    // Renaming a parent has an obvious meaning for its children
                    // and removing one does not: whether #work/acme should go
                    // with #work is a judgement about what those tags mean.
                    return (
                        `#${from} has ${nested.length} tag(s) nested under it: ` +
                        `${nested.map((entry) => `#${entry.tag}`).join(", ")}. Removing #${from} ` +
                        `might mean removing those too or might mean leaving them, and guessing ` +
                        `is worse than asking. Remove them first if they should go, or say which ` +
                        `exact tag you meant.`
                    );
                }

                const selected = new Map<string, IndexedNote>();
                for (const entry of known) {
                    for (const note of ctx.index.findByTag(entry.tag)) {
                        if (note.kind !== "text") continue;
                        if (folder && !underFolder(note.path, folder)) continue;
                        selected.set(note.path, note);
                    }
                }
                if (selected.size === 0) {
                    return `No note under "${folder}" carries #${from}. Nothing to plan.`;
                }

                const operations: PlanOperation[] = [];
                const excluded: { path: string; reason: string }[] = [];

                for (const path of [...selected.keys()].sort()) {
                    let current;
                    try {
                        const read = await ctx.reader.read(path, { fresh: true });
                        if (read.file.kind !== "text") continue;
                        current = read.file;
                    } catch (error) {
                        if (error instanceof NoteNotFoundError) {
                            excluded.push({ path, reason: "no longer in the vault" });
                            continue;
                        }
                        throw error;
                    }

                    let retagged;
                    try {
                        retagged = retagNote(path, current.text, from, target);
                    } catch (error) {
                        if (error instanceof FrontmatterUnreadableError) {
                            excluded.push({ path, reason: shortReason(error.message) });
                            continue;
                        }
                        throw error;
                    }

                    if (retagged.text === current.text) continue;

                    operations.push({
                        kind: "write",
                        path,
                        content: { kind: "text", text: retagged.text },
                        expectedRev: current.rev ?? null,
                        // Every one of these replaces text that is already
                        // there, so none of them may be truncated out of the
                        // plan however many notes carry the tag.
                        notable: true,
                        summary: retagged.summary,
                    });
                }

                if (operations.length === 0) {
                    return (
                        `${selected.size} note(s) are indexed under #${from}, and none of them ` +
                        `changes: the tag is in a place this cannot edit, such as inside a code ` +
                        `block.` +
                        (excluded.length > 0 ? `\n\n${excludedBlock(excluded)}` : "")
                    );
                }

                const merges = target !== undefined && ctx.index.findByTag(target).length > 0;
                const plan = await ctx.executor.plan(operations);

                return [
                    target === undefined
                        ? `Removing #${from} from ${operations.length} note(s).`
                        : `Renaming #${from} to #${target} across ${operations.length} note(s)` +
                          `${nested.length > 0 ? `, taking ${nested.length} nested tag(s) with it` : ""}.` +
                          (merges
                              ? ` #${target} already exists, so this merges the two: notes that ` +
                                `carried both end up carrying it once.`
                              : ""),
                    "",
                    renderPlan(plan, { excluded }),
                ].join("\n");
            }),
    });

    addTool({
        name: "plan_move",
        description:
            "Work out what moving or renaming a file would do to the links pointing at it, and " +
            "write nothing. Returns a plan that relocates the file and rewrites every link that " +
            "would otherwise break or come to mean a different file. Show that plan to the person " +
            "who asked before calling commit_plan with its ID. Use move_file instead when nothing " +
            "links to the file; it will tell you to come here if something does.",
        parameters: z.object({
            path: z.string().describe("The file to move, as a vault-relative path with its extension."),
            to: z
                .string()
                .describe("The full vault-relative path it should end up at, including the extension."),
        }),
        execute: async ({ path, to }, { session }) =>
            reporting(async () => {
                requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                if (path === to) return `"${path}" is already where it is. Nothing to plan.`;

                let source;
                try {
                    source = (await ctx.reader.read(path, { fresh: true })).file;
                } catch (error) {
                    if (error instanceof NoteNotFoundError) {
                        return (
                            `There is nothing at "${path}" to move. Check the path with list_notes ` +
                            `or search_notes.`
                        );
                    }
                    throw error;
                }

                const destination = await ctx.executor.currentEntry(to);
                if (destination && !isDeleted(destination)) {
                    return `"${to}" already exists, so there is nothing to plan. Choose another destination.`;
                }

                // The vault as it will be, so a rewritten link can be checked
                // against it rather than assumed to resolve.
                const after = new Set(ctx.index.allPaths());
                after.delete(path);
                after.add(to);

                const impact = ctx.index.resolutionImpact(path, to);
                const operations: PlanOperation[] = [
                    {
                        kind: "move",
                        from: path,
                        to,
                        content:
                            source.kind === "text"
                                ? { kind: "text", text: source.text }
                                : { kind: "binary", bytes: source.bytes },
                        expectedRev: source.rev ?? null,
                        notable: true,
                    },
                ];

                const excluded: { path: string; reason: string }[] = [];
                for (const [note, targets] of linkingNotes(ctx.index, path)) {
                    let current;
                    try {
                        current = (await ctx.reader.read(note, { fresh: true })).file;
                    } catch (error) {
                        if (error instanceof NoteNotFoundError) {
                            excluded.push({ path: note, reason: "no longer in the vault" });
                            continue;
                        }
                        throw error;
                    }
                    if (current.kind !== "text") continue;

                    const rewritten = rewriteLinkTargets(current.text, {
                        from: path,
                        to,
                        targets,
                        paths: after,
                    });
                    if (rewritten.changed === 0) {
                        // The index says this note links to the file and the
                        // rewriter could not find the link to change. Naming it
                        // is the only honest thing to do: the alternative is a
                        // plan that quietly leaves a broken link behind.
                        excluded.push({
                            path: note,
                            reason: "links to it in a form this cannot rewrite; check it by hand",
                        });
                        continue;
                    }

                    operations.push({
                        kind: "write",
                        path: note,
                        content: { kind: "text", text: rewritten.text },
                        expectedRev: current.rev ?? null,
                        // Every rewrite replaces text somebody wrote, so none of
                        // them may be truncated out of the plan.
                        notable: true,
                        summary: `rewrites ${rewritten.changed} link(s) to point at ${to}`,
                    });
                }

                const plan = await ctx.executor.plan(operations);
                const stolen = impact.repoints.filter((repoint) => repoint.was !== path);

                return [
                    `Moving "${path}" to "${to}", and rewriting the ${operations.length - 1} note(s) ` +
                        `that link to it.`,
                    ...(stolen.length > 0
                        ? [
                              "",
                              `Read this part carefully. ${stolen.length} link(s) point at a different ` +
                                  `file today and would come to mean the moved one, with nothing in ` +
                                  `any note changed. Rewriting them is not this tool's business, ` +
                                  `because they are not links to the file being moved:`,
                              ...stolen
                                  .slice(0, 10)
                                  .map(
                                      (repoint) =>
                                          `  ${repoint.source}: ${renderWikilink(repoint)} means ` +
                                          `${repoint.was} and would mean ${repoint.becomes}`
                                  ),
                          ]
                        : []),
                    "",
                    renderPlan(plan, { excluded }),
                ].join("\n");
            }),
    });

    addTool(
        {
            name: "commit_plan",
            description:
                "Apply a plan made by plan_set_properties, by its ID. Refuses in full, writing nothing, " +
                "if any of the notes changed since the plan was made. Only call this after the plan has " +
                "been shown to the person who asked for it and they have agreed to it.",
            parameters: z.object({
                plan_id: z.string().min(1).describe("The ID printed at the end of the plan."),
            }),
            execute: async ({ plan_id }, { session }) =>
                reporting(async () => {
                    requireScope(session as SessionAuth | undefined, SCOPE_WRITE);
                    const result = await ctx.executor.commit(plan_id);
                    if (result.applied.length === 0) {
                        return `Plan ${plan_id} committed, and every note in it already said exactly that. Nothing was written.`;
                    }
                    // Counted apart, because a relocation produces two receipts
                    // and one of them is a deletion. Reporting "3 notes
                    // written" for a rename that moved one file and edited one
                    // note, and then listing the old path among the notes
                    // written, is the kind of small lie that teaches people the
                    // numbers are noise.
                    const written = result.applied.filter((receipt) => !receipt.deleted);
                    const removed = result.applied.filter((receipt) => receipt.deleted);
                    const bytes = written.reduce((sum, receipt) => sum + receipt.size, 0);
                    const paths = result.applied
                        .slice(0, 10)
                        .map((receipt) => `  ${receipt.path}${receipt.deleted ? " (removed)" : ""}`);
                    const more =
                        result.applied.length > paths.length
                            ? [`  and ${result.applied.length - paths.length} more`]
                            : [];
                    return [
                        `Committed plan ${plan_id}: ${written.length} note(s) written` +
                            (removed.length > 0 ? `, ${removed.length} removed` : "") +
                            `, ${bytes.toLocaleString()} bytes.`,
                        ...paths,
                        ...more,
                    ].join("\n");
                }),
        },
        { mutates: true }
    );

    addTool({
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

    return mutating;
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

/** Whether a path sits under a folder, on a separator so `a` misses `ab/c`. */
function underFolder(path: string, folder: string): boolean {
    const trimmed = folder.replace(/^\/+|\/+$/g, "");
    if (!trimmed) return true;
    return path === trimmed || path.startsWith(`${trimmed}/`);
}

/**
 * One note with a tag renamed or removed, in both of the places it can live.
 *
 * The frontmatter first, then the body, because the body rewriter works on the
 * whole note and skips the frontmatter block: doing it the other way round
 * would have the frontmatter editor reformat text the body rewriter had just
 * placed. The summary counts them separately, since "3 in the body" and "1 in
 * frontmatter" are different kinds of change to look at.
 */
function retagNote(
    path: string,
    text: string,
    from: string,
    to: string | undefined
): { text: string; summary: string } {
    const { properties } = parseNote(text);

    const set: Record<string, unknown> = {};
    const remove: string[] = [];
    let inFrontmatter = 0;

    // `tag` as well as `tags`: Obsidian accepts the singular as a legacy
    // spelling, and the index reads both, so a rename that skipped it would
    // leave find_by_tag still returning the note.
    for (const key of ["tags", "tag"]) {
        const next = retagProperty(properties[key], { from, to });
        if (next === undefined) continue;
        inFrontmatter++;
        if (Array.isArray(next) && next.length === 0) remove.push(key);
        else if (typeof next === "string" && next === "") remove.push(key);
        else set[key] = next;
    }

    const edited =
        inFrontmatter === 0
            ? text
            : editFrontmatter(path, text, {
                  ...(Object.keys(set).length > 0 ? { set } : {}),
                  ...(remove.length > 0 ? { remove } : {}),
              }).text;

    const body = rewriteInlineTag(edited, { from, to });

    const verb = to === undefined ? `removes #${from}` : `renames #${from} to #${to}`;
    const where = [
        body.changed > 0 ? `${body.changed} in the body` : "",
        inFrontmatter > 0 ? `${inFrontmatter} frontmatter propert${inFrontmatter === 1 ? "y" : "ies"}` : "",
    ].filter(Boolean);

    return { text: body.text, summary: `${verb}: ${where.join(", ")}` };
}

/**
 * The notes that link to a path, each with the target strings it uses.
 *
 * The targets come from the index because resolution is what decides which
 * links are affected, and the rewriter is deliberately incapable of deciding it
 * for itself: given a search term rather than a resolved set it would edit the
 * word in a sentence.
 *
 * A note that links to itself is skipped. Its links are moving with it, and
 * they still resolve, since a basename link does not care which folder its
 * target sits in and a path link inside the moved note names the same file it
 * always did.
 */
function linkingNotes(index: VaultIndex, path: string): Map<string, string[]> {
    const byNote = new Map<string, string[]>();
    for (const link of index.backlinks(path)) {
        if (link.path === path) continue;
        const targets = byNote.get(link.path) ?? [];
        targets.push(link.target);
        byNote.set(link.path, targets);
    }
    return byNote;
}

function excludedBlock(excluded: { path: string; reason: string }[]): string {
    return [`Excluded (${excluded.length}):`, ...excluded.map((e) => `  ${e.path}: ${e.reason}`)].join("\n");
}

/** The first sentence of a frontmatter error, which is the part that says what is wrong. */
function shortReason(message: string): string {
    const match = /cannot be edited: (.*?\.)\s/.exec(message);
    return match?.[1] ?? message;
}
