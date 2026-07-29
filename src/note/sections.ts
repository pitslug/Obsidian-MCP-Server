/**
 * Appending underneath a heading rather than at the end of a note.
 *
 * Appending to the end of a note is the right thing only for a note that is a
 * list. A note with structure has an end that means something: the last section
 * of a daily note is usually the one you least want a captured thought landing
 * in, and a note ending in a "Related" or "References" section will quietly
 * accumulate content that reads as belonging to it.
 *
 * So this finds a named section and appends inside it. The rules that matter,
 * because each one is a way of getting it wrong that looks fine in a test with
 * three lines in it:
 *
 *  - **A section ends at the next heading of the same level or higher.** A
 *    subsection belongs to its parent, so appending to "Log" appends after
 *    "Log/Morning" rather than before it.
 *  - **The insertion point is the last non-blank line of the section, not its
 *    last line.** The blank line before the next heading is that heading's
 *    breathing room. Content inserted after it is visually part of the next
 *    section while structurally part of this one, which is the worst of both.
 *  - **Headings inside fenced code are not headings.** A note documenting
 *    Markdown, or holding a shell snippet full of comments, otherwise gets
 *    appended into the middle of its own code block.
 *  - **Frontmatter is not searched.** A YAML comment at the start of a line is
 *    indistinguishable from a level-one heading by shape alone.
 *
 * Where the heading does not exist it is created at the end of the note, which
 * is the one case where appending to the end is right: there is no section to
 * be inside of yet.
 */

import { maskNonContent } from "./parse.js";

/** Frontmatter must open on the very first line. Same rule as the parser. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export class AmbiguousHeadingError extends Error {
    constructor(heading: string, count: number) {
        super(
            `"${heading}" appears ${count} times as a heading, so it is not clear which section ` +
                `to append to. Nothing was changed. Use a heading that appears once, or append to ` +
                `the end of the note instead.`
        );
        this.name = "AmbiguousHeadingError";
    }
}

export interface SectionAppendResult {
    /** The whole note, frontmatter included. */
    text: string;
    /** True when the heading did not exist and was added at the end. */
    headingCreated: boolean;
    /** The level of the heading appended under, whether found or created. */
    level: number;
}

export interface SectionAppendOptions {
    /**
     * Placed between the section's existing content and the new text. Defaults
     * to a blank line, matching `append_note`.
     */
    separator?: string;
    /** Level to use if the heading has to be created. Defaults to 2. */
    level?: number;
}

interface FoundHeading {
    /** Index into the array of body lines. */
    line: number;
    level: number;
}

/**
 * Append `content` inside the section introduced by `heading`.
 *
 * Matching is tried case-sensitively first and then case-insensitively, which
 * is how Obsidian resolves a heading reference in a link. A heading matched at
 * either sensitivity by more than one line is refused rather than guessed at:
 * the whole point of naming a section is to be specific about where something
 * goes.
 */
export function appendUnderHeading(
    noteText: string,
    heading: string,
    content: string,
    options: SectionAppendOptions = {}
): SectionAppendResult {
    const match = FRONTMATTER.exec(noteText);
    const prefix = match ? match[0] : "";
    const body = match ? noteText.slice(match[0].length) : noteText;

    // Match the note's own line endings, for the same reason the frontmatter
    // editor does: a note written on Windows should not acquire lone LFs
    // because something appended a line to it.
    const eol = noteText.includes("\r\n") ? "\r\n" : "\n";
    const separator = options.separator ?? `${eol}${eol}`;

    const lines = body.split(/\r?\n/);
    const maskedLines = maskNonContent(body).split(/\r?\n/);

    const found = locate(maskedLines, heading);
    if (!found) {
        const level = options.level ?? 2;
        return {
            text: prefix + createSection(body, heading, content, level, eol),
            headingCreated: true,
            level,
        };
    }

    const end = sectionEnd(maskedLines, found);

    // Walk back over blank lines so the new content joins the section's own
    // content rather than the gap before the next heading. A section that is
    // entirely blank collapses to its heading line, which is what makes the
    // empty-section case fall out of this rather than needing its own branch.
    let at = end;
    while (at > found.line + 1 && (lines[at - 1] ?? "").trim() === "") at--;

    const sectionIsEmpty = at === found.line + 1;
    const joiner = sectionIsEmpty ? `${eol}${eol}` : separator;

    const before = lines.slice(0, at).join(eol);
    const after = lines.slice(at);
    const rest = after.length > 0 ? eol + after.join(eol) : "";

    return {
        text: `${prefix}${before}${joiner}${content}${rest}`,
        headingCreated: false,
        level: found.level,
    };
}

/** The one heading line matching `heading`, or nothing. */
function locate(maskedLines: string[], heading: string): FoundHeading | undefined {
    const wanted = heading.replace(/^#+\s*/, "").trim();

    const all: { line: number; level: number; text: string }[] = [];
    for (const [line, text] of maskedLines.entries()) {
        const match = HEADING_LINE.exec(text);
        if (match) all.push({ line, level: (match[1] ?? "").length, text: (match[2] ?? "").trim() });
    }

    const exact = all.filter((candidate) => candidate.text === wanted);
    const chosen =
        exact.length > 0 ? exact : all.filter((c) => c.text.toLowerCase() === wanted.toLowerCase());

    if (chosen.length === 0) return undefined;
    if (chosen.length > 1) throw new AmbiguousHeadingError(wanted, chosen.length);
    return { line: chosen[0]!.line, level: chosen[0]!.level };
}

/**
 * The line index one past the end of a section.
 *
 * A heading of a deeper level is part of this section. A heading of the same
 * level or shallower ends it, because that is what heading level means.
 */
function sectionEnd(maskedLines: string[], found: FoundHeading): number {
    for (let line = found.line + 1; line < maskedLines.length; line++) {
        const match = HEADING_LINE.exec(maskedLines[line] ?? "");
        if (match && (match[1] ?? "").length <= found.level) return line;
    }
    return maskedLines.length;
}

/**
 * Add the heading and its first content at the end of the note.
 *
 * The note is trimmed of trailing blank lines first, so a note that already
 * ended in whitespace does not end up with four blank lines before the new
 * section, and a note that is entirely empty gets no leading gap at all.
 */
function createSection(body: string, heading: string, content: string, level: number, eol: string): string {
    const trimmed = body.replace(/(\r?\n)+$/, "");
    const hashes = "#".repeat(Math.min(6, Math.max(1, level)));
    const opening = trimmed.length === 0 ? "" : `${trimmed}${eol}${eol}`;
    return `${opening}${hashes} ${heading}${eol}${eol}${content}${eol}`;
}
