/**
 * Where a link points.
 *
 * One implementation, used by everything that needs the answer: the index when
 * it fills `links.resolved_path`, and `resolutionImpact` when it asks what the
 * answer would be if a file were somewhere else. That second question is
 * hypothetical, so it cannot be answered by a table, and for two days the rule
 * therefore existed twice: four `UPDATE` passes in SQL and a mirror of them
 * here, with a test asserting the two agreed. They did agree. Keeping them
 * agreeing was the tax, and the mirror is gone now: the SQL passes were deleted
 * and `resolveLinks` calls this.
 *
 * ## The rule
 *
 * A link may name a file by its whole path, or by any tail of that path
 * beginning at a folder boundary, which is what lets `[[Attachments/Deck.pptx]]`
 * and `[[Deck.pptx]]` both find `Meetings/RLT/Attachments/Deck.pptx`. Call any
 * of those a name for the file. The extension may be left off. So, most
 * specific first:
 *
 *  1. A file one of whose names is exactly the target.
 *  2. A note one of whose names, with `.md` left off, is the target.
 *  3. Any other file, one of whose names with its extension left off is the target.
 *
 * The third pass is why this file was rewritten. Without it `[[Anthony
 * Chaytors]]` finds nothing when the vault holds `Interacts/Anthony
 * Chaytors.pdf`, which Obsidian opens without hesitating. That was not merely
 * an unhelpful answer: `vault_health` called the link broken, and
 * `resolutionImpact` could not see it, so moving that PDF reported that no link
 * would break and then broke one. A vault of PDFs named after people is exactly
 * the shape that invites a link written without the extension.
 *
 * `.md` is preferred over any other extension, which is what the second pass
 * buys by sitting above the third: a vault holding `Peter Litzow.md` and `Peter
 * Litzow.pdf` answers `[[Peter Litzow]]` with the note.
 *
 * ## Ties
 *
 * Within a pass, a match that reproduces the file's own capitalisation wins,
 * then the shortest path, then alphabetical order. Shortest is Obsidian's own
 * behaviour, and the other two are tie-breaks so that asking twice gives the
 * same answer: a vault with two equally short candidates would otherwise
 * resolve by whatever order the rows came back in.
 *
 * Matching is otherwise case-insensitive. The SQL this replaced was
 * case-sensitive in its first two passes and insensitive in the other two,
 * because `=` and `LIKE` differ in SQLite, and that asymmetry was documented
 * here as a wart to leave alone. It is gone: Obsidian is case-insensitive, and
 * having the rule in one place is what made fixing it a one-line decision
 * rather than a schema question.
 */

/** A file's name, without any folders. */
function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/** A path with its last extension removed, or undefined when it has none. */
function withoutExtension(path: string): string | undefined {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return undefined;
    return path.slice(0, path.length - (name.length - dot));
}

function isNote(path: string): boolean {
    return path.toLowerCase().endsWith(".md");
}

/** The path itself, then each tail of it starting after a folder boundary. */
function names(path: string): string[] {
    const found = [path];
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
        const tail = path.slice(at + 1);
        if (tail !== "") found.push(tail);
    }
    return found;
}

/**
 * The vault's paths, arranged so a link can be resolved without walking them.
 *
 * Built once per resolution sweep rather than once per link. The changes feed
 * re-resolves the whole table on every change, which was affordable at this
 * vault's size when it was four SQL statements and would stop being affordable
 * as a nested loop over every path for every link.
 */
export class LinkResolver {
    /** One map per pass, in the order the passes are tried. */
    private readonly passes: Map<string, string[]>[];

    constructor(paths: Iterable<string>) {
        const exact = new Map<string, string[]>();
        const noteStems = new Map<string, string[]>();
        const otherStems = new Map<string, string[]>();

        const add = (map: Map<string, string[]>, key: string, path: string): void => {
            if (key === "") return;
            const lower = key.toLowerCase();
            const found = map.get(lower);
            if (found) found.push(path);
            else map.set(lower, [path]);
        };

        for (const path of paths) {
            const stems = isNote(path) ? noteStems : otherStems;
            for (const name of names(path)) {
                add(exact, name, path);
                const stem = withoutExtension(name);
                if (stem !== undefined) add(stems, stem, path);
            }
        }

        this.passes = [exact, noteStems, otherStems];
    }

    /**
     * Where this target points, or undefined when it points at nothing.
     *
     * An empty target is a link to a heading inside the same note. It has no
     * target to resolve, which is why the index skips those too.
     */
    resolve(target: string): string | undefined {
        if (target === "") return undefined;
        const lower = target.toLowerCase();

        for (const pass of this.passes) {
            const candidates = pass.get(lower);
            if (candidates === undefined) continue;
            if (candidates.length === 1) return candidates[0];
            return best(candidates, target);
        }
        return undefined;
    }
}

/**
 * The winner among several candidates in one pass.
 *
 * Exact case first, because a vault that has bothered to distinguish `readme`
 * from `README` means something by it. Then the shortest path, which is
 * Obsidian's rule and reads as "the least buried one". Then alphabetical, which
 * decides nothing anybody cares about and decides it the same way every time.
 */
function best(candidates: readonly string[], target: string): string {
    let winner = candidates[0] as string;
    for (const candidate of candidates.slice(1)) {
        const exact = matchesCase(candidate, target);
        if (exact !== matchesCase(winner, target)) {
            if (exact) winner = candidate;
            continue;
        }
        if (candidate.length < winner.length) winner = candidate;
        else if (candidate.length === winner.length && candidate < winner) winner = candidate;
    }
    return winner;
}

/** Whether the part of the path the target named matches it character for character. */
function matchesCase(path: string, target: string): boolean {
    if (path === target || path.endsWith(`/${target}`)) return true;
    const stem = withoutExtension(path);
    if (stem === undefined) return false;
    return stem === target || stem.endsWith(`/${target}`);
}

/** Where a link target points, given the paths a vault holds. */
export function resolveTarget(target: string, paths: Iterable<string>): string | undefined {
    return new LinkResolver(paths).resolve(target);
}

/**
 * Every link target text that could resolve to this path.
 *
 * The inverse of the passes above, and the reason a move does not have to
 * re-resolve every link in the vault: a link whose target is not in this list
 * for either the old path or the new one cannot change its meaning, because no
 * pass would have looked at those paths in the first place.
 *
 * For `Interacts/Anthony Chaytors.pdf` that is the full path and each tail of
 * it beginning at a folder boundary, with and without the extension. The
 * extension comes off whatever it is, not only `.md`, which is the half that
 * was missing: without it `resolutionImpact` never asked about `[[Anthony
 * Chaytors]]`, and a move of that file reported no links affected.
 */
export function candidateTargets(path: string): string[] {
    const found = new Set<string>();
    for (const name of names(path)) {
        found.add(name);
        const stem = withoutExtension(name);
        if (stem !== undefined && stem !== "") found.add(stem);
    }
    return [...found];
}
