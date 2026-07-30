/**
 * The index proposes, the vault decides.
 *
 * Every search and selector tool answers from the SQLite index, because that is
 * what it is for. The index is a cache of the replica, and the failure that
 * matters is not that it is a little behind: it is that it can hold a note the
 * vault no longer has. A deletion normally reaches it within the second, on the
 * changes feed. But the feed can fail, in which case it logs the error, stops
 * following, and search carries on answering from a set of notes that is
 * quietly frozen. Nothing in the answer would look wrong.
 *
 * That is the case this exists for. A deleted note surfacing as context for a
 * question is worse than a slow answer or a missing one: it is the vault
 * telling the truth and the assistant contradicting it, on the basis of
 * something the user deliberately removed.
 *
 * So results that came from the index are confirmed against the replica before
 * anyone sees them, and a path the vault no longer holds is dropped from the
 * answer and from the index. Reading repairs. The cost is one shallow lookup
 * per set of results, and the design consequence is worth stating plainly: the
 * index may lag, and it may lose a note that exists, but it can no longer
 * produce one that does not.
 */

import type { VaultIndex } from "../index/index.js";
import type { VaultReader } from "../vault/reader.js";

export interface ConfirmContext {
    index: VaultIndex;
    reader: VaultReader;
    log?: { warn(message: string): void };
}

export interface Confirmation<T> {
    /** The rows whose notes the vault still holds. */
    rows: T[];
    /** Paths that were in the index and are not in the vault. */
    dropped: string[];
}

/**
 * Keep the rows whose paths the vault still holds, and forget the rest.
 *
 * Order is preserved, because these are search results and their order is the
 * ranking. A row whose path cannot be confirmed is removed from the index here
 * rather than left for the next rebuild: this is the one moment when something
 * has both noticed the staleness and knows which path it is.
 */
export async function confirmLive<T>(
    ctx: ConfirmContext,
    rows: readonly T[],
    pathOf: (row: T) => string
): Promise<Confirmation<T>> {
    if (rows.length === 0) return { rows: [], dropped: [] };

    const paths = [...new Set(rows.map(pathOf))];
    const live = await ctx.reader.live(paths);
    const dropped = paths.filter((path) => !live.has(path));

    if (dropped.length === 0) return { rows: [...rows], dropped: [] };

    for (const path of dropped) {
        ctx.index.remove(path);
        ctx.log?.warn(
            `Index held "${path}", which the vault does not. Dropped from the results and removed ` +
                `from the index. Repeated occurrences mean the changes feed is not being applied.`
        );
    }

    return { rows: rows.filter((row) => live.has(pathOf(row))), dropped };
}

/**
 * The line a tool adds when it dropped something, or nothing at all.
 *
 * Said out loud rather than swallowed, because a result count that silently
 * disagrees with a previous answer gets blamed on the model.
 *
 * Counted, never named. The paths go to the log, where the person running the
 * server can see them, and not into the answer: naming a deleted note here
 * would hand back the one thing this whole mechanism exists to withhold, and a
 * name is enough for a model to repeat it or go looking for it.
 */
export function staleness(dropped: readonly string[]): string[] {
    if (dropped.length === 0) return [];
    const many = dropped.length !== 1;
    return [
        `Note: ${dropped.length} result${many ? "s were" : " was"} left out because the vault no ` +
            `longer holds ${many ? "those notes" : "that note"}. The index has been corrected. ` +
            `${many ? "Their paths are" : "Its path is"} in the server log rather than here, since a ` +
            `deleted note should not be named back to you.`,
    ];
}
