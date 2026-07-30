/**
 * Renaming and removing tags in a note.
 *
 * A tag in an Obsidian vault lives in two places that look nothing alike: a
 * `tags:` list in frontmatter, and `#tag` written in the body. The index reads
 * both and `find_by_tag` returns notes tagged either way, so a rename that
 * handled only one of them would leave the vault half-renamed and the tool
 * reporting success. This file does the body half; the frontmatter half is
 * `editFrontmatter`, given a value computed per note.
 *
 * Two decisions are worth stating.
 *
 * **A rename takes the nested tags with it.** Obsidian treats `#work/client` as
 * living under `#work`, so renaming `work` to `client` and leaving
 * `#work/client` behind would strand it under a parent that no longer exists.
 * A removal does not do the same thing in reverse: removing `#work` when
 * `#work/client` exists is ambiguous enough that guessing is worse than
 * refusing, so the caller is told and decides.
 *
 * **The tag rule comes from the parser.** `INLINE_TAG` is the same regular
 * expression the index reads tags with, imported rather than restated, because
 * a second definition of what counts as a tag would eventually disagree and the
 * disagreement would be silent: text edited here that the index never saw as a
 * tag, or a tag left behind that it did.
 */

import { INLINE_TAG, maskForRewriting } from "./parse.js";

export interface TagRewrite {
    text: string;
    /** How many inline tags were changed. */
    changed: number;
}

/** Whether `tag` is `parent` or lives under it. */
export function isUnder(tag: string, parent: string): boolean {
    return tag === parent || tag.startsWith(`${parent}/`);
}

/** What a tag becomes under a rename, keeping whatever was nested below it. */
export function renamed(tag: string, from: string, to: string): string {
    return `${to}${tag.slice(from.length)}`;
}

/**
 * Rename or remove a tag in a note's body.
 *
 * `to` of `undefined` removes it. A removal also takes one space before the
 * tag, so that a line reading "todo #work now" does not end up with a double
 * space in the middle of it. Nothing else moves: a tag alone on its line leaves
 * the line behind, empty, because deleting a line is a bigger edit than was
 * asked for and an empty line is at least visible.
 */
export function rewriteInlineTag(
    text: string,
    options: { from: string; to: string | undefined }
): TagRewrite {
    const masked = maskForRewriting(text);
    const edits: { start: number; end: number; replacement: string }[] = [];
    // Where the previous edit finished, so two adjacent tags cannot both claim
    // the one space between them and produce overlapping edits.
    let taken = 0;

    for (const match of masked.matchAll(INLINE_TAG)) {
        const tag = match[2] ?? "";
        if (!isUnder(tag, options.from)) continue;

        // The rule captures the character before the "#", so the tag itself
        // starts that many characters into the match.
        const start = (match.index ?? 0) + (match[1] ?? "").length;
        const end = start + 1 + tag.length;

        if (options.to !== undefined) {
            edits.push({ start, end, replacement: `#${renamed(tag, options.from, options.to)}` });
            taken = end;
            continue;
        }

        // Take a single space with it, so "todo #work now" does not end up with
        // a gap in the middle. The one before for preference, and the one after
        // when there is nothing before or the previous removal already had it,
        // which is what a run of tags on one line looks like. Spaces only:
        // two at the end of a line are a line break in Markdown, and a newline
        // is what keeps the next line where it is.
        const before = text[start - 1] === " " && start - 1 >= taken;
        const after = !before && text[end] === " ";
        const edit = { start: before ? start - 1 : start, end: after ? end + 1 : end, replacement: "" };
        edits.push(edit);
        taken = edit.end;
    }

    if (edits.length === 0) return { text, changed: 0 };

    edits.sort((a, b) => b.start - a.start);
    let out = text;
    for (const edit of edits) out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    return { text: out, changed: edits.length };
}

/** Every inline tag in a note's body, in the order they appear, with repeats. */
export function inlineTags(text: string): string[] {
    return [...maskForRewriting(text).matchAll(INLINE_TAG)].map((match) => match[2] ?? "");
}

/**
 * A frontmatter `tags` value with one tag renamed or removed.
 *
 * Returns undefined when nothing in it matched, so the caller can leave the
 * property alone rather than rewriting it to the value it already had.
 *
 * The shape survives. Obsidian accepts a list, a single string, or several tags
 * in one space-separated string, and a note written one way should not silently
 * become the other because something renamed a tag in it. An empty result is
 * reported as an empty list, which the caller turns into removing the property.
 */
export function retagProperty(
    value: unknown,
    options: { from: string; to: string | undefined }
): unknown | undefined {
    const asList = (input: unknown): string[] | undefined => {
        if (typeof input === "string") return input.split(/[,\s]+/).filter(Boolean);
        if (Array.isArray(input)) return input.map((item) => String(item));
        return undefined;
    };

    const before = asList(value);
    if (!before) return undefined;

    let touched = false;
    const after: string[] = [];
    // Only the values this rename produced. A note that already listed the same
    // tag twice keeps both: collapsing those would be a second change nobody
    // asked for, on a note they are only looking at because of the first.
    const produced = new Set<string>();

    for (const raw of before) {
        // A leading "#" survives here only inside a quoted string, but it does
        // happen, and it is part of the value rather than part of the tag.
        const hash = raw.startsWith("#") ? "#" : "";
        const tag = hash ? raw.slice(1) : raw;

        if (!isUnder(tag, options.from)) {
            // A rename onto a tag the note already carries is a merge, and a
            // note listing one tag twice is not what anybody meant by it.
            if (produced.has(raw)) touched = true;
            else after.push(raw);
            continue;
        }
        touched = true;
        if (options.to === undefined) continue;

        const next = `${hash}${renamed(tag, options.from, options.to)}`;
        if (after.includes(next)) continue;
        after.push(next);
        produced.add(next);
    }

    if (!touched) return undefined;
    if (typeof value === "string") return after.join(" ");
    return after;
}
