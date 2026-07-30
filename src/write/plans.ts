/**
 * The plan and commit protocol.
 *
 * Any operation that touches more than one note is a two-phase dry run. The
 * first call returns a plan describing every affected path, what changes, and
 * the totals, and writes nothing. A second call commits that plan by ID.
 *
 * The reason is asymmetry of consequence. A single-note write that goes wrong
 * costs one note, and the person asking for it is looking at the result. A
 * batch that goes wrong costs as many notes as it touched, is discovered later,
 * and by then the original content is one revision back on every device. So the
 * batch path is deliberately slower to use than the single path is.
 *
 * The controls, and what each is actually for:
 *
 *  - **Recorded revisions.** Every target's revision is captured at planning
 *    time, and commit refuses outright if any of them moved. This is the real
 *    control. It makes "the plan I reviewed is the plan that runs" true rather
 *    than likely.
 *  - **Expiry.** Fifteen minutes, because a plan is a snapshot of a vault that
 *    other devices are still writing to, and an hour-old plan reviewed from
 *    memory is not a reviewed plan. Expiry is enforced on lookup, so a plan
 *    that ages out mid-conversation fails rather than runs.
 *  - **Single use.** A plan is marked used before its first operation, not
 *    after its last. A commit that fails partway through must not be
 *    repeatable: the second run would work from revisions that its own first
 *    run has already moved.
 *  - **A ceiling on plan size.** Defence in depth, not the primary control. It
 *    exists to turn a query that matched far more than intended into a refusal
 *    at planning time rather than a very well-documented disaster.
 *
 * Commit refuses everything or starts; it does not partially apply a stale
 * plan. Once it starts, a failure stops the run and reports exactly what was
 * applied and what was not. There is no rollback, because rolling back would
 * mean a second batch of writes against revisions this run has just changed,
 * which is the same risk again in the opposite direction.
 */

import { randomUUID } from "node:crypto";
import {
    composeWrite,
    isDeleted,
    normalizePrefixedPath,
    type ChunkedEntry,
    type FileContent,
} from "../vault-model/index.js";
import {
    assertWritablePath,
    DestinationExistsError,
    WriteExecutor,
    WriteTargetMissingError,
    type WriteExecutorOptions,
    type WriteReceipt,
} from "./executor.js";

/** Fifteen minutes, per the design. */
export const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;

/**
 * What a planned operation carries beyond the change itself.
 *
 * A plan is composed by a tool and read by a person, and those two want
 * different vocabularies. The plan machinery knows about bytes and chunk
 * counts, which is the right level for it and the wrong level for review:
 * nobody sanity-checks a property change by looking at how the note's byte
 * count moved. So the composing tool supplies the words.
 *
 * `notable` is the more important of the two. It marks a change as one that
 * destroys something rather than adds something, and the renderer will never
 * truncate a notable change out of the list however long that list gets. The
 * tool is the only thing that can know which those are: overwriting a property
 * that already had a different value is notable, adding one that was absent is
 * not, and by the time a plan exists both look identical.
 */
export interface PlanAnnotation {
    /** One line describing this change in the tool's own terms. */
    summary?: string;
    /** True when this change replaces or removes something that was there. */
    notable?: boolean;
    /**
     * The revision the content was composed from.
     *
     * Supply it whenever the content was derived from the note's current text.
     * Planning otherwise reads the revision itself, a moment after the tool
     * read the text, and a note that changed in between would be recorded at a
     * revision its planned content never saw. Commit would then accept the plan
     * and overwrite the change, which is the exact failure the whole revision
     * discipline exists to prevent, arriving through the one path where nobody
     * is watching the result.
     */
    expectedRev?: string | null;
}

export type PlanOperation = PlanAnnotation &
    (
        | { kind: "write"; path: string; content: FileContent }
        | { kind: "delete"; path: string; hard?: boolean }
        /**
         * One operation, not a write and a delete.
         *
         * Expressing a relocation as the two kinds either side of it would put
         * the ordering guarantee at the mercy of the order of an array, and
         * would let a plan be committed that deleted a source whose destination
         * write had failed.
         */
        | { kind: "move"; from: string; to: string; content: FileContent }
    );

/** The paths an operation touches, source first. */
function pathsOf(operation: PlanOperation): string[] {
    return operation.kind === "move" ? [operation.from, operation.to] : [operation.path];
}

/** The path an operation's recorded revision belongs to. */
function subjectOf(operation: PlanOperation): string {
    return operation.kind === "move" ? operation.from : operation.path;
}

export interface PlannedChange extends PlanAnnotation {
    /** What the operation does to a path that may or may not already exist. */
    effect: "create" | "update" | "delete" | "move";
    /** For a move, the destination. Otherwise the note being changed. */
    path: string;
    /** Where a moved file is now. Absent for everything else. */
    from?: string;
    id: string;
    /** The target's revision when the plan was made. Undefined for a create. */
    rev: string | undefined;
    sizeBefore: number | undefined;
    sizeAfter: number | undefined;
    chunksBefore: number | undefined;
    chunksAfter: number | undefined;
    /** True when the content is byte-identical to what is already there. */
    unchanged: boolean;
}

export interface Plan {
    id: string;
    createdAt: number;
    expiresAt: number;
    changes: PlannedChange[];
    totals: {
        creates: number;
        updates: number;
        deletes: number;
        moves: number;
        unchanged: number;
        bytesBefore: number;
        bytesAfter: number;
    };
}

export interface CommitResult {
    planId: string;
    applied: WriteReceipt[];
}

export class PlanNotFoundError extends Error {
    constructor(id: string) {
        super(`No plan with ID "${id}". Plans are single-use and expire; make a new one.`);
        this.name = "PlanNotFoundError";
    }
}

export class PlanExpiredError extends Error {
    constructor(id: string, ageMs: number) {
        super(
            `Plan "${id}" was made ${Math.round(ageMs / 60_000)} minutes ago and has expired. ` +
                `Make a new one, so what you review is what runs.`
        );
        this.name = "PlanExpiredError";
    }
}

export class PlanAlreadyUsedError extends Error {
    constructor(id: string) {
        super(
            `Plan "${id}" has already been committed. Plans are single-use: re-running one would ` +
                `work from revisions its own first run has already changed.`
        );
        this.name = "PlanAlreadyUsedError";
    }
}

export class PlanCeilingError extends Error {
    constructor(count: number, ceiling: number) {
        super(
            `This plan would touch ${count} notes, above the ceiling of ${ceiling}. ` +
                `Narrow the selection, or raise PLAN_CEILING deliberately.`
        );
        this.name = "PlanCeilingError";
    }
}

export class PlanStaleError extends Error {
    constructor(
        readonly paths: string[],
        when: "made" | "being made" = "made"
    ) {
        super(
            `${paths.length} note(s) changed ${when === "made" ? "since this plan was made" : "while this plan was being made"}: ` +
                `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}. ` +
                `Nothing was written. Make a new plan against the current state.`
        );
        this.name = "PlanStaleError";
    }
}

export class DuplicatePlanTargetError extends Error {
    constructor(path: string) {
        super(
            `"${path}" appears more than once in this plan. Two operations on one note would ` +
                `have the second working from a revision the first has already replaced.`
        );
        this.name = "DuplicatePlanTargetError";
    }
}

/**
 * A commit that started and then stopped.
 *
 * Carries what was applied, because "some of it happened" is the one outcome
 * where the caller genuinely needs the detail rather than an apology.
 */
export class PlanCommitError extends Error {
    constructor(
        readonly planId: string,
        readonly applied: WriteReceipt[],
        readonly failedPath: string,
        readonly remaining: string[],
        override readonly cause: Error
    ) {
        super(
            `Plan "${planId}" stopped at "${failedPath}": ${cause.message} ` +
                `${applied.length} note(s) were written, ${remaining.length} were not. ` +
                `Nothing was rolled back; the notes listed as written hold their new content.`
        );
        this.name = "PlanCommitError";
    }
}

interface StoredPlan {
    plan: Plan;
    operations: PlanOperation[];
    /** Frozen at planning time, so commit composes exactly what was previewed. */
    now: number;
    used: boolean;
}

export interface PlanningExecutorOptions {
    /** Maximum notes a single plan may touch. */
    planCeiling: number;
    /** How long a plan stays committable. */
    planTtlMs?: number;
}

/**
 * The write executor with the plan protocol on top.
 *
 * Kept as a subclass rather than a separate unit because the single-note path
 * and the batch path must share one definition of how a write is composed and
 * how a conflict is refused. Two implementations of that would eventually
 * disagree, and the batch one is the one nobody is watching.
 */
export class PlanningWriteExecutor extends WriteExecutor {
    private readonly plans = new Map<string, StoredPlan>();
    private readonly ceiling: number;
    private readonly ttlMs: number;

    constructor(options: WriteExecutorOptions & PlanningExecutorOptions) {
        super(options);
        this.ceiling = options.planCeiling;
        this.ttlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
    }

    /**
     * Work out what a set of operations would do, and write nothing.
     *
     * Every target is read from CouchDB, not the replica, for the same reason
     * the write path is: the revisions recorded here are what commit checks
     * against, and a revision read from a lagging replica would be stale before
     * it was written down.
     */
    async plan(operations: PlanOperation[]): Promise<Plan> {
        this.assertWritable(`plan ${operations.length} change(s)`);

        if (operations.length > this.ceiling) {
            throw new PlanCeilingError(operations.length, this.ceiling);
        }

        const normalized = operations.map((op) =>
            op.kind === "move"
                ? { ...op, from: normalizePrefixedPath(op.from), to: normalizePrefixedPath(op.to) }
                : { ...op, path: normalizePrefixedPath(op.path) }
        );
        const seen = new Set<string>();
        for (const op of normalized) {
            // Both ends of a move, because a plan that also edits the note it
            // is moving, or writes to the path it is moving onto, would have
            // the second operation working from a revision the first replaced.
            for (const path of pathsOf(op)) {
                assertWritablePath(path);
                if (seen.has(path)) throw new DuplicatePlanTargetError(path);
                seen.add(path);
            }
        }

        const now = this.now();
        const changes: PlannedChange[] = [];
        const movedSinceComposed: string[] = [];

        for (const op of normalized) {
            const subject = subjectOf(op);
            const id = await this.idFor(subject);
            const existing = await this.currentEntry(subject);
            const present = existing !== undefined && !isDeleted(existing);
            const before = present ? (existing as ChunkedEntry) : undefined;

            // Where the caller composed content from a read of its own, the
            // revision it read is the one this plan must record. Reading a
            // fresher one here would paper over a change that landed in
            // between, and the plan would commit happily over the top of it.
            if (op.expectedRev !== undefined && (op.expectedRev ?? null) !== (existing?._rev ?? null)) {
                movedSinceComposed.push(subject);
                continue;
            }

            const annotation: PlanAnnotation = {
                summary: op.summary,
                notable: op.notable,
                expectedRev: op.expectedRev,
            };

            if (op.kind === "move") {
                // A move of something that is not there is not a plan with one
                // useless line in it, it is a plan about nothing. Refused here
                // rather than at commit, where the review has already happened.
                if (!present) throw new WriteTargetMissingError(op.from);

                const destination = await this.currentEntry(op.to);
                if (destination && !isDeleted(destination)) throw new DestinationExistsError(op.to);

                changes.push({
                    ...annotation,
                    // Always. A relocation is the operation the plan exists
                    // for, and the renderer never truncates a notable change
                    // however long the plan gets.
                    notable: true,
                    effect: "move",
                    path: op.to,
                    from: op.from,
                    id,
                    rev: before?._rev,
                    sizeBefore: before?.size,
                    sizeAfter: before?.size,
                    chunksBefore: before?.children?.length,
                    chunksAfter: before?.children?.length,
                    unchanged: false,
                });
                continue;
            }

            if (op.kind === "delete") {
                if (!present) {
                    // A delete of something absent is not an error worth
                    // failing the whole plan over, but it must be visible.
                    changes.push({
                        ...annotation,
                        effect: "delete",
                        path: op.path,
                        id,
                        rev: existing?._rev,
                        sizeBefore: undefined,
                        sizeAfter: undefined,
                        chunksBefore: undefined,
                        chunksAfter: undefined,
                        unchanged: true,
                    });
                    continue;
                }
                changes.push({
                    ...annotation,
                    // A delete always destroys something, whatever the tool
                    // that composed it thought to say.
                    notable: true,
                    effect: "delete",
                    path: op.path,
                    id,
                    rev: before?._rev,
                    sizeBefore: before?.size,
                    sizeAfter: 0,
                    chunksBefore: before?.children?.length,
                    chunksAfter: 0,
                    unchanged: false,
                });
                continue;
            }

            // Composing is pure and touches nothing. It is how the preview
            // knows the real chunk count and byte size rather than estimating.
            const composed = await composeWrite(op.path, op.content, {
                settings: this.settings,
                now,
                mtime: now,
                ctime: present ? before?.ctime : now,
            });

            const sameContent = before !== undefined && sameChildren(before.children, composed.children);

            changes.push({
                ...annotation,
                effect: present ? "update" : "create",
                path: op.path,
                id,
                rev: existing?._rev,
                sizeBefore: before?.size,
                sizeAfter: composed.entry.size,
                chunksBefore: before?.children?.length,
                chunksAfter: composed.children.length,
                unchanged: sameContent,
            });
        }

        // Refused before the plan is stored, so there is no ID to commit and
        // nothing to review. A plan is a promise about a state of the vault,
        // and this one was already out of date before it was written down.
        if (movedSinceComposed.length > 0) throw new PlanStaleError(movedSinceComposed, "being made");

        const plan: Plan = {
            id: randomUUID(),
            createdAt: now,
            expiresAt: now + this.ttlMs,
            changes,
            totals: {
                creates: changes.filter((c) => c.effect === "create").length,
                updates: changes.filter((c) => c.effect === "update").length,
                deletes: changes.filter((c) => c.effect === "delete" && !c.unchanged).length,
                moves: changes.filter((c) => c.effect === "move").length,
                unchanged: changes.filter((c) => c.unchanged).length,
                bytesBefore: changes.reduce((sum, c) => sum + (c.sizeBefore ?? 0), 0),
                bytesAfter: changes.reduce((sum, c) => sum + (c.sizeAfter ?? 0), 0),
            },
        };

        this.plans.set(plan.id, { plan, operations: normalized, now, used: false });
        this.prune();
        return plan;
    }

    /** A plan by ID, if it is still valid. Does not consume it. */
    getPlan(id: string): Plan {
        return this.lookup(id).plan;
    }

    /**
     * Apply a plan.
     *
     * Refuses entirely if anything moved, then applies in order. The revision
     * recorded at planning time is passed through to each write, so the check
     * happens twice: once here against every target at once, and again at
     * CouchDB per document. The first gives a clean refusal that writes
     * nothing; the second closes the window between them.
     */
    async commit(id: string): Promise<CommitResult> {
        this.assertWritable(`commit plan "${id}"`);

        const stored = this.lookup(id);
        const { plan, operations } = stored;

        const stale: string[] = [];
        for (const change of plan.changes) {
            const currentRev = await this.couch.revisionOf(change.id);
            if (currentRev !== change.rev) stale.push(change.path);
        }
        if (stale.length > 0) throw new PlanStaleError(stale);

        // Marked used before the first write, so a run that fails partway
        // cannot be repeated against revisions it has already moved.
        stored.used = true;

        const applied: WriteReceipt[] = [];
        for (const [index, op] of operations.entries()) {
            const change = plan.changes[index];
            try {
                if (op.kind === "move") {
                    const receipt = await this.relocate({
                        from: op.from,
                        to: op.to,
                        content: op.content,
                        // Recorded at planning time, checked twice: once above
                        // against every target at once, and again inside
                        // relocate against CouchDB.
                        expectedRev: change?.rev as string,
                        mtime: stored.now,
                    });
                    applied.push(receipt.written);
                    if (receipt.removed) applied.push(receipt.removed);
                } else if (op.kind === "delete") {
                    // Nothing to delete, whether the path never existed or is
                    // already a tombstone. Re-deleting a tombstone would look
                    // free and would not be: it writes a new revision that
                    // replicates to every device, on a plan that previewed no
                    // deletions at all.
                    if (change?.unchanged || !change?.rev) continue;
                    applied.push(
                        await this.remove({ path: op.path, expectedRev: change.rev, hard: op.hard })
                    );
                } else if (change?.unchanged) {
                    // The content is already exactly this. Writing it anyway
                    // would bump the modification time on every device for no
                    // change, and a batch that reports touching 400 notes when
                    // it changed three teaches people to stop reading plans.
                    continue;
                } else {
                    applied.push(
                        await this.write({
                            path: op.path,
                            content: op.content,
                            expectedRev: change?.rev ?? null,
                            mtime: stored.now,
                        })
                    );
                }
            } catch (error) {
                const remaining = operations.slice(index + 1).map((rest) => subjectOf(rest));
                throw new PlanCommitError(id, applied, subjectOf(op), remaining, error as Error);
            }
        }

        return { planId: id, applied };
    }

    /** Forget a plan without running it. */
    discard(id: string): boolean {
        return this.plans.delete(id);
    }

    private get settings() {
        return this.options.settings;
    }

    /**
     * Find a plan, or explain precisely why it cannot be used.
     *
     * The lookup happens before the sweep of expired plans, so that a plan
     * which has aged out reports having expired rather than never having
     * existed. The difference matters to whoever is reading the failure: one
     * says make a new plan, the other says you are looking at the wrong ID.
     */
    private lookup(id: string): StoredPlan {
        const stored = this.plans.get(id);
        if (!stored) {
            this.prune();
            throw new PlanNotFoundError(id);
        }
        if (stored.used) throw new PlanAlreadyUsedError(id);
        const now = this.now();
        if (now > stored.plan.expiresAt) {
            this.plans.delete(id);
            throw new PlanExpiredError(id, now - stored.plan.createdAt);
        }
        this.prune();
        return stored;
    }

    /** Drop expired plans, so a long-running server does not accumulate them. */
    private prune(): void {
        const now = this.now();
        for (const [id, stored] of this.plans) {
            if (now > stored.plan.expiresAt) this.plans.delete(id);
        }
    }
}

/** Whether two chunk lists are the same sequence, which means the same content. */
function sameChildren(before: readonly string[] | undefined, after: readonly string[]): boolean {
    // A document with no `children` at all is a legacy note holding its
    // content inline, or an eden document. Coercing that to an empty list
    // would make it compare equal to empty content, so a plan that blanked
    // such a note would preview as "unchanged" and commit would skip it while
    // reporting success. Not comparable is the honest answer.
    if (before === undefined) return false;
    return before.length === after.length && before.every((id, index) => id === after[index]);
}
