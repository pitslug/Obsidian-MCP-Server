/**
 * Link resolution, in code rather than in SQL.
 *
 * `VaultIndex.resolveLinks` does this in four UPDATE passes over the whole
 * links table, which is the right shape for filling a column and the wrong
 * shape for the question moving a file asks: what would resolution look like if
 * this path were that one instead? That is hypothetical, so it cannot be
 * answered by a table the vault has not been written to yet.
 *
 * So the rule exists twice, and the second copy is the liability. The passes
 * below mirror the SQL exactly, including the parts that look like accidents:
 *
 *  - The first two passes compare with `=`, which SQLite makes case-sensitive,
 *    and the last two with `LIKE`, which it makes case-insensitive over ASCII.
 *    Obsidian resolves links case-insensitively, so the LIKE passes are the
 *    ones that behave; the asymmetry is left alone here because changing it
 *    would change which note real links point at, which is not a thing to do
 *    inside a change about moving files.
 *  - Ties within a pass go to the shortest path, which is Obsidian's own
 *    behaviour: a note at the root wins over a deeply nested one.
 *
 * `test/index/resolve.spec.ts` runs both implementations over the same vault
 * and asserts they agree, because a mirror nobody checks is just a fork.
 */

/**
 * Lowercase the way SQLite's LIKE does, which is ASCII only.
 *
 * `toLowerCase()` would fold characters SQLite leaves alone, so a vault holding
 * two notes differing only outside ASCII would resolve differently here than in
 * the index. Rare, and free to get right.
 */
function asciiLower(text: string): string {
    return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** Whether `path` matches `target` under pass `pass`, counting from zero. */
function matchesPass(path: string, target: string, pass: number): boolean {
    switch (pass) {
        case 0:
            return path === target;
        case 1:
            return path === `${target}.md`;
        case 2:
            return asciiLower(path).endsWith(`/${asciiLower(target)}`);
        default:
            return asciiLower(path).endsWith(`/${asciiLower(target)}.md`);
    }
}

/**
 * Where a link target points, given the paths a vault holds.
 *
 * Undefined means the link is broken. An empty target is a link to a heading
 * within the same note and has no target to resolve, which is why the index
 * skips those too.
 */
export function resolveTarget(target: string, paths: Iterable<string>): string | undefined {
    if (target === "") return undefined;

    const all = [...paths];
    for (let pass = 0; pass < 4; pass++) {
        let best: string | undefined;
        for (const path of all) {
            if (!matchesPass(path, target, pass)) continue;
            // Shortest wins, then alphabetical. The second half is not
            // Obsidian's rule, it is a tie-break for paths of equal length so
            // that two runs of the same question give the same answer.
            if (
                best === undefined ||
                path.length < best.length ||
                (path.length === best.length && path < best)
            ) {
                best = path;
            }
        }
        if (best !== undefined) return best;
    }
    return undefined;
}

/**
 * Every link target text that could resolve to this path.
 *
 * The inverse of the passes above, and the reason a move does not have to
 * re-resolve every link in the vault: a link whose target is not in this list
 * for either the old path or the new one cannot change its meaning, because
 * neither pass would have looked at those paths in the first place.
 *
 * For `Meetings/RLT/Notes.md` that is the full path, the path without its
 * extension, and each suffix beginning at a folder boundary with and without
 * the extension: `RLT/Notes.md`, `RLT/Notes`, `Notes.md`, `Notes`.
 */
export function candidateTargets(path: string): string[] {
    const found = new Set<string>();
    const add = (value: string): void => {
        if (value === "") return;
        found.add(value);
        // Only `.md` can be left off a link, because only the `.md` passes
        // append an extension of their own.
        if (value.toLowerCase().endsWith(".md")) found.add(value.slice(0, -3));
    };

    add(path);
    for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
        add(path.slice(at + 1));
    }

    return [...found];
}
