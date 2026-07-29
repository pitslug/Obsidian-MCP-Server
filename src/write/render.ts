/**
 * Rendering a plan so that reviewing it is a real act.
 *
 * The plan protocol is only worth its cost if the review in the middle actually
 * happens. What defeats a review is not too little detail, it is too much: a
 * wall of two hundred near-identical lines gets scrolled past, and the one line
 * in it that says something surprising goes with it. A plan that is not read is
 * a confirmation prompt, and a confirmation prompt is a way of getting consent
 * without informing anyone.
 *
 * So this does not print the changes. It sorts them by consequence and spends
 * the reader's attention accordingly:
 *
 *  - **The totals come first**, in one sentence, because that is what catches
 *    the selection that matched four hundred notes when it should have matched
 *    four. Most bad plans are visible from the totals alone.
 *  - **Notable changes are never truncated.** A notable change is one that
 *    replaces or removes something, as judged by the tool that composed the
 *    plan. However long the plan is, every one of those is listed. This is the
 *    part that must survive a large plan, because it is the part that cannot be
 *    undone by running the opposite operation afterwards.
 *  - **Routine changes are counted and sampled.** Adding a property that was
 *    not there is recoverable and repetitive, so a few examples and a count
 *    carry the same information as the full list.
 *  - **No-ops are stated, not listed.** A plan that reports touching 400 notes
 *    when it will change three teaches people that the numbers are noise.
 *
 * The truncation is always announced with its exact count. A plan that quietly
 * showed the first twenty of something would be worse than one that showed
 * nothing, because it reads as complete.
 */

import type { Plan, PlannedChange } from "./plans.js";

/** How many routine changes to show before summarising the rest. */
const ROUTINE_SAMPLE = 8;

export interface RenderOptions {
    /** For "expires in N minutes". Defaults to the current time. */
    now?: number;
    /** Name of the tool that commits a plan, quoted in the footer. */
    commitTool?: string;
    /** Name of the tool that discards one. */
    discardTool?: string;
    /** Paths the tool declined to include, with the reason. */
    excluded?: { path: string; reason: string }[];
}

export function renderPlan(plan: Plan, options: RenderOptions = {}): string {
    const now = options.now ?? Date.now();
    const commitTool = options.commitTool ?? "commit_plan";
    const discardTool = options.discardTool ?? "discard_plan";

    const effective = plan.changes.filter((change) => !change.unchanged);
    const notable = effective.filter((change) => change.notable);
    const routine = effective.filter((change) => !change.notable);

    const sections: string[] = [headline(plan, effective.length)];

    if (notable.length > 0) {
        sections.push(
            "",
            `Replaces or removes existing content (${notable.length}, all listed):`,
            ...notable.map((change) => `  ${line(change)}`)
        );
    }

    if (routine.length > 0) {
        const shown = routine.slice(0, ROUTINE_SAMPLE);
        sections.push("", `Adds without replacing anything (${routine.length}):`);
        sections.push(...shown.map((change) => `  ${line(change)}`));
        if (routine.length > shown.length) {
            sections.push(`  and ${routine.length - shown.length} more, all of the same shape.`);
        }
    }

    const unchanged = plan.changes.filter((change) => change.unchanged);
    if (unchanged.length > 0) {
        sections.push(
            "",
            `${unchanged.length} note(s) already say exactly this and will be skipped, so their ` +
                `modification times do not move.`
        );
    }

    if (options.excluded && options.excluded.length > 0) {
        sections.push("", `Excluded (${options.excluded.length}):`);
        sections.push(...options.excluded.map((entry) => `  ${entry.path}: ${entry.reason}`));
    }

    if (effective.length === 0) {
        sections.push("", `Nothing to do. This plan changes no notes, so there is no need to commit it.`);
        return sections.join("\n");
    }

    const minutes = Math.max(0, Math.round((plan.expiresAt - now) / 60_000));
    sections.push(
        "",
        `Plan ${plan.id}`,
        `Expires in ${minutes} minute(s), and is single use. Nothing has been written.`,
        `Show this to the person who asked for it before committing. To apply it, call ` +
            `${commitTool} with this ID. To throw it away, call ${discardTool}.`
    );

    return sections.join("\n");
}

/**
 * The one sentence most bad plans are caught by.
 *
 * Byte movement is included only when it is large enough to mean something. On
 * a property change it is a handful of bytes per note and reporting it invites
 * the reader to work out whether that is the right handful, which is attention
 * spent on the least informative number in the plan.
 */
function headline(plan: Plan, effective: number): string {
    const { creates, updates, deletes } = plan.totals;
    const parts = [
        creates > 0 ? `${creates} to create` : "",
        updates > 0 ? `${updates} to change` : "",
        deletes > 0 ? `${deletes} to delete` : "",
    ].filter(Boolean);

    if (effective === 0) return `This plan touches ${plan.changes.length} note(s) and changes none of them.`;

    const delta = plan.totals.bytesAfter - plan.totals.bytesBefore;
    const sizeNote =
        Math.abs(delta) >= 1024
            ? `, ${delta > 0 ? "adding" : "removing"} about ${formatBytes(Math.abs(delta))}`
            : "";

    return `This plan will change ${effective} note(s): ${parts.join(", ")}${sizeNote}.`;
}

/**
 * One change, in the composing tool's words where it supplied any.
 *
 * Falling back to sizes rather than omitting the line, because a plan entry
 * with no description is still a note that is about to be written, and leaving
 * it out to keep the output tidy is how a plan comes to under-report itself.
 */
function line(change: PlannedChange): string {
    if (change.summary) return `${change.path}: ${change.summary}`;

    if (change.effect === "delete") return `${change.path}: delete`;
    if (change.effect === "create") return `${change.path}: create, ${formatBytes(change.sizeAfter ?? 0)}`;

    const before = change.sizeBefore ?? 0;
    const after = change.sizeAfter ?? 0;
    return `${change.path}: ${formatBytes(before)} to ${formatBytes(after)}`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
