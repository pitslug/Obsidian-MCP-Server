/**
 * Rewriting the links that point at a file which moved.
 *
 * A rename breaks every link in this vault, because every link in it is written
 * as a basename. Obsidian rewrites them silently in the app; a rename made
 * through this server without doing the same leaves the vault quietly wrong, so
 * the rewriting has to happen here, and it has to be surgical.
 *
 * What that means in practice, and why each part is deliberate:
 *
 *  - **Only the target text changes.** The alias, the subpath, the embed
 *    marker and the whitespace inside the brackets are all left exactly as they
 *    were. A link is somebody's writing, and the smallest possible edit is the
 *    only one that can be reviewed by looking at a diff.
 *  - **A link written as a basename gets the new basename; a link written with
 *    folders in it gets the new path in full.** Anything else invents a partial
 *    path that happens to resolve today, which is how a rewrite becomes another
 *    rename's problem.
 *  - **Which links to change is not decided here.** The caller passes the exact
 *    target strings that resolve to the file, because resolution is the index's
 *    business and matching text that merely looks like a link target is how a
 *    mention in prose gets edited.
 *  - **Code blocks and frontmatter are left alone**, because the index does not
 *    read links out of them either. A rewrite that edited a fenced example
 *    would be changing documentation to suit a file move.
 */

import { MARKDOWN_LINK, WIKILINK, maskForRewriting } from "./parse.js";
import { resolveTarget } from "../index/resolve.js";

/**
 * A link as it appears in the note, from what the index recorded of it.
 *
 * One definition, because the alternative was three. Every message that names
 * an affected link was building `[[target]]` by hand, which is not the link:
 * it is the link with its embed marker and its subpath removed, so two rows
 * that differ print identically and the one detail a reader needs, that this is
 * an embed of a section, is the detail that goes. Found on 31 July 2026 by a
 * connector pass reading the messages, after a fix that corrected the count
 * above the same list and left the list alone.
 */
export function renderWikilink(link: { target: string; subpath?: string; embed?: boolean }): string {
    return `${link.embed ? "!" : ""}[[${link.target}${link.subpath ? `#${link.subpath}` : ""}]]`;
}

export interface LinkRewrite {
    text: string;
    /** How many links were rewritten. */
    changed: number;
    /**
     * Each rewrite as the note has it and as the note will have it.
     *
     * A count is not a message. `plan_move` printed "rewrites 7 link(s)" and
     * nothing else, so the one question a rename plan exists to answer, what
     * the links will say afterwards, was the one it did not answer, while the
     * refusal that sends people to `plan_move` listed every link in full.
     * Found on 31 July 2026 by the connector pass that read the messages.
     */
    rewrites: { before: string; after: string }[];
}

/** The last path segment. */
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

/**
 * What a link target becomes once the file it names has moved.
 *
 * The two questions are whether the link spelled out the extension and whether
 * it spelled out any folders, because those are the two things Obsidian lets a
 * link leave out and the two the new text has to leave out in the same way.
 *
 * Any extension, not only `.md`. That was the rule until 31 July 2026, and it
 * was right while `[[Peter Litzow]]` resolved to nothing: an omitted extension
 * could only mean a note. Now that it resolves to the PDF, answering it with
 * `[[Pete Litzow.pdf]]` writes a style into somebody's note that they did not
 * ask for, once per rename, forever.
 */
export function retarget(oldTarget: string, from: string, to: string): string {
    const lower = (value: string) => value.toLowerCase();
    const spelledOutExtension =
        lower(from) === lower(oldTarget) || lower(from).endsWith(`/${lower(oldTarget)}`);

    const next = oldTarget.includes("/") ? to : basename(to);
    if (spelledOutExtension) return next;
    return withoutExtension(next) ?? next;
}

/**
 * The new target text, chosen so that it resolves to the file it names.
 *
 * `retarget` alone is not always enough, and the case where it is not is the
 * one this vault actually has. A `[[Peter Litzow.pdf]]` link to the top-level
 * copy, moved under `Superseded/`, retargets to `Peter Litzow.pdf`: the same
 * text it already had, which now resolves to the *other* file of that name. The
 * rewrite would report success and change nothing, and the note would end up
 * meaning something else.
 *
 * So the candidate is checked against the vault as it will be, and the full
 * path is used when the short form no longer lands on the right file. Longer
 * than Obsidian would have written, and correct, which is the right way round
 * for a link nobody is going to re-read.
 *
 * The first candidate is the text the link already has, because a move that
 * changes only the folder does not change what a basename means and there is
 * then nothing to rewrite. That is also what leaves somebody's capitalisation
 * alone: `[[peter litzow]]` still resolves after the file is filed elsewhere,
 * so it stays as they typed it, and only a rename, which no spelling of the old
 * name survives, replaces their text with the vault's.
 */
export function retargetWithin(oldTarget: string, from: string, to: string, paths: Iterable<string>): string {
    const all = [...paths];
    const candidates = [oldTarget, retarget(oldTarget, from, to)];
    if (to.toLowerCase().endsWith(".md")) candidates.push(to.slice(0, -3));
    candidates.push(to);

    for (const candidate of candidates) {
        if (resolveTarget(candidate, all) === to) return candidate;
    }
    return to;
}

/**
 * Percent-encode a path for a markdown link.
 *
 * A markdown target cannot contain a space, so a path with one in it has to be
 * encoded whatever the original looked like. Parentheses go too: unencoded they
 * close the link early, which turns a rewrite into a broken sentence.
 */
function forMarkdown(path: string): string {
    return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Point every link naming `from` at `to` instead.
 *
 * `targets` is the set of target strings, exactly as written in this note, that
 * currently resolve to `from`.
 */
export function rewriteLinkTargets(
    text: string,
    options: { from: string; to: string; targets: readonly string[]; paths?: Iterable<string> }
): LinkRewrite {
    const wanted = new Set(options.targets);
    if (wanted.size === 0) return { text, changed: 0, rewrites: [] };

    // Given the vault's paths, the new target is checked rather than assumed.
    // Without them this is the shortest form that would have been right in a
    // vault holding no other file of that name.
    const paths = options.paths === undefined ? undefined : [...options.paths];
    const nextFor = (target: string) =>
        paths === undefined
            ? retarget(target, options.from, options.to)
            : retargetWithin(target, options.from, options.to, paths);

    const masked = maskForRewriting(text);
    const edits: {
        start: number;
        end: number;
        replacement: string;
        before: string;
        after: string;
    }[] = [];

    for (const match of masked.matchAll(WIKILINK)) {
        const at = match.index ?? 0;
        // Read the inner text from the original, since the masked copy has
        // nothing in it but the positions.
        const inner = text.slice(at + (match[1] ?? "").length + 2, at + match[0].length - 2);

        const pipeAt = inner.indexOf("|");
        const beforeAlias = pipeAt >= 0 ? inner.slice(0, pipeAt) : inner;
        const alias = pipeAt >= 0 ? inner.slice(pipeAt) : "";
        const hashAt = beforeAlias.indexOf("#");
        const rawTarget = hashAt >= 0 ? beforeAlias.slice(0, hashAt) : beforeAlias;
        const subpath = hashAt >= 0 ? beforeAlias.slice(hashAt) : "";

        const target = rawTarget.trim();
        if (!wanted.has(target)) continue;

        // Whitespace inside the brackets is somebody's typing, not syntax.
        const leading = rawTarget.slice(0, rawTarget.length - rawTarget.trimStart().length);
        const trailing = rawTarget.slice(rawTarget.trimEnd().length);
        const replacement = `${leading}${nextFor(target)}${trailing}${subpath}${alias}`;
        if (replacement === inner) continue;

        const start = at + (match[1] ?? "").length + 2;
        const end = at + match[0].length - 2;
        edits.push({
            start,
            end,
            replacement,
            before: text.slice(at, at + match[0].length),
            after: text.slice(at, start) + replacement + text.slice(end, at + match[0].length),
        });
    }

    for (const match of masked.matchAll(MARKDOWN_LINK)) {
        const raw = match[2] ?? "";
        // The target starts immediately after "](", and the label cannot hold
        // a "]", so the first one is the right one. Searching for the target
        // text itself would find it in the label of `[foo.md](foo.md)`.
        const at = (match.index ?? 0) + match[0].indexOf("](") + 2;
        const [pathPart = "", ...fragment] = raw.split("#");

        let decoded: string;
        try {
            decoded = decodeURI(pathPart).trim();
        } catch {
            // A target that is not valid percent-encoding is not a link this
            // can reason about, and guessing at it is worse than leaving it.
            continue;
        }
        if (!wanted.has(decoded)) continue;

        const next = forMarkdown(nextFor(decoded));
        const replacement = fragment.length > 0 ? `${next}#${fragment.join("#")}` : next;
        if (replacement === raw) continue;

        const whole = match[0];
        const from = match.index ?? 0;
        edits.push({
            start: at,
            end: at + raw.length,
            replacement,
            before: text.slice(from, from + whole.length),
            after: text.slice(from, at) + replacement + text.slice(at + raw.length, from + whole.length),
        });
    }

    if (edits.length === 0) return { text, changed: 0, rewrites: [] };

    // Reported in the order somebody reads the note, and applied back to front
    // so an earlier edit does not move a later one.
    const rewrites = [...edits]
        .sort((a, b) => a.start - b.start)
        .map(({ before, after }) => ({ before, after }));

    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const edit of edits) {
        out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    }

    return { text: out, changed: edits.length, rewrites };
}
