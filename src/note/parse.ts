/**
 * Parsing a note.
 *
 * Pure functions over note text: frontmatter, tags, links, headings. No
 * database, no network. Everything the index stores comes from here, so the
 * index can be rebuilt from the replica at any time.
 *
 * Obsidian's own syntax rules are the contract, not Markdown's. Where the two
 * differ this follows Obsidian, because the point is to see the vault the way
 * its owner does.
 */

import { parse as parseYaml } from "yaml";

export interface Wikilink {
    /** The target as written, before resolution. */
    target: string;
    /** A heading or block reference after `#`, if any. */
    subpath: string | undefined;
    /** Display text after `|`, if any. */
    alias: string | undefined;
    /** True for `![[embeds]]` rather than plain links. */
    embed: boolean;
}

export interface Heading {
    level: number;
    text: string;
}

export interface ParsedNote {
    /** Frontmatter as parsed, or an empty object when there is none. */
    properties: Record<string, unknown>;
    /** Whether frontmatter was present but could not be parsed. */
    frontmatterError: string | undefined;
    /** The note without its frontmatter block. */
    body: string;
    /** Tags from both `tags:` frontmatter and inline `#tag`, deduplicated. */
    tags: string[];
    links: Wikilink[];
    /** Markdown links to other vault files, excluding external URLs. */
    markdownLinks: string[];
    headings: Heading[];
}

/**
 * Frontmatter must open on the very first line.
 *
 * Obsidian is strict about this, and so is this: a `---` further down is a
 * horizontal rule, and treating it as frontmatter would silently swallow
 * content.
 */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/**
 * Regions where tag and link syntax is not syntax.
 *
 * Fenced code blocks, inline code, and math. Without this, a shell snippet
 * containing `#comment` becomes a tag, and every vault picks up junk tags
 * from its own documentation.
 */
export function maskNonContent(text: string): string {
    return (
        text
            // Fenced code blocks, ``` or ~~~, keeping newlines so offsets and
            // line counts still line up.
            .replace(/^([ \t]*)(```|~~~)[\s\S]*?^\1\2[ \t]*$/gm, (block) => block.replace(/[^\n]/g, " "))
            // Inline code.
            .replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length))
            // Display and inline math.
            .replace(/\$\$[\s\S]*?\$\$/g, (span) => span.replace(/[^\n]/g, " "))
            .replace(/\$[^$\n]+\$/g, (span) => " ".repeat(span.length))
    );
}

/**
 * An Obsidian tag.
 *
 * Must contain at least one non-numeric character, so `#1` and `#2026` are not
 * tags. May contain letters, digits, underscores, hyphens and slashes. Must be
 * preceded by whitespace or start of line, so `colour#3` is not a tag either.
 */
export const INLINE_TAG = /(^|[\s(\[{>])#([\p{L}\p{N}_/-]*[\p{L}_-][\p{L}\p{N}_/-]*)/gu;

export const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
export const MARKDOWN_LINK = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

/**
 * The note with everything that is not editable body blanked, offsets kept.
 *
 * What anything rewriting a note in place needs: the same view of it the parser
 * had, so that a match found here is a match the index also saw, and at the
 * same offset, so the edit can be made against the original text. Frontmatter
 * goes as well as code and math, because the parser reads properties out of it
 * rather than reading tags and links, and an edit there is a different kind of
 * edit.
 *
 * Shared by the link rewriter and the tag rewriter rather than written twice.
 * Two definitions of "where syntax counts" would eventually disagree, and the
 * one that drifted would be editing the inside of a code fence.
 */
export function maskForRewriting(text: string): string {
    const frontmatter = FRONTMATTER.exec(text);
    if (!frontmatter) return maskNonContent(text);
    const head = frontmatter[0].replace(/[^\n]/g, " ");
    return head + maskNonContent(text.slice(frontmatter[0].length));
}

export function parseNote(text: string): ParsedNote {
    const { properties, frontmatterError, body } = splitFrontmatter(text);
    const masked = maskNonContent(body);

    return {
        properties,
        frontmatterError,
        body,
        tags: collectTags(properties, masked),
        links: collectWikilinks(masked),
        markdownLinks: collectMarkdownLinks(masked),
        headings: collectHeadings(masked),
    };
}

function splitFrontmatter(text: string): {
    properties: Record<string, unknown>;
    frontmatterError: string | undefined;
    body: string;
} {
    const match = FRONTMATTER.exec(text);
    if (!match) return { properties: {}, frontmatterError: undefined, body: text };

    const body = text.slice(match[0].length);
    const raw = match[1] ?? "";

    // Empty frontmatter is legitimate and common; YAML parses it as null.
    if (raw.trim() === "") return { properties: {}, frontmatterError: undefined, body };

    try {
        const parsed = parseYaml(raw) as unknown;
        if (parsed === null || parsed === undefined) {
            return { properties: {}, frontmatterError: undefined, body };
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            return {
                properties: {},
                frontmatterError: `Frontmatter is ${Array.isArray(parsed) ? "an array" : typeof parsed}, not a mapping.`,
                body,
            };
        }
        return { properties: parsed as Record<string, unknown>, frontmatterError: undefined, body };
    } catch (error) {
        // Reported rather than thrown: one malformed note should not make the
        // vault unindexable, and the error is worth surfacing to whoever wrote
        // it.
        return { properties: {}, frontmatterError: (error as Error).message, body };
    }
}

/**
 * Tags from frontmatter and from the body.
 *
 * Obsidian accepts `tags:` as a list or as a space- or comma-separated string,
 * and treats `tag` as an alias of `#tag`. It also accepts the legacy singular
 * `tag:`. All of those normalise to the same thing here.
 *
 * A leading `#` only survives inside a quoted string: unquoted, YAML reads it
 * as the start of a comment, so `tags: one #two` really is just `one`. That is
 * YAML's rule rather than a choice made here, and it bites people writing
 * frontmatter by hand.
 */
function collectTags(properties: Record<string, unknown>, maskedBody: string): string[] {
    const found = new Set<string>();

    const add = (value: unknown): void => {
        if (typeof value === "string") {
            for (const part of value.split(/[,\s]+/)) {
                const tag = part.replace(/^#/, "").trim();
                if (tag) found.add(tag);
            }
        } else if (Array.isArray(value)) {
            for (const item of value) add(item);
        } else if (typeof value === "number") {
            found.add(String(value));
        }
    };

    add(properties.tags);
    add(properties.tag);

    for (const match of maskedBody.matchAll(INLINE_TAG)) {
        const tag = match[2];
        if (tag) found.add(tag);
    }

    return [...found].sort();
}

function collectWikilinks(maskedBody: string): Wikilink[] {
    const links: Wikilink[] = [];

    for (const match of maskedBody.matchAll(WIKILINK)) {
        const embed = match[1] === "!";
        const inner = match[2] ?? "";

        const [beforeAlias, ...aliasParts] = inner.split("|");
        const alias = aliasParts.length > 0 ? aliasParts.join("|").trim() : undefined;

        // `#` separates a heading or block reference. A leading `#` means a
        // link within the same note, which has no target.
        const hashAt = (beforeAlias ?? "").indexOf("#");
        const target = hashAt >= 0 ? (beforeAlias ?? "").slice(0, hashAt).trim() : (beforeAlias ?? "").trim();
        const subpath = hashAt >= 0 ? (beforeAlias ?? "").slice(hashAt + 1).trim() : undefined;

        links.push({
            target,
            subpath: subpath || undefined,
            alias: alias || undefined,
            embed,
        });
    }

    return links;
}

/** Markdown links to vault files. External URLs are not vault links. */
function collectMarkdownLinks(maskedBody: string): string[] {
    const links: string[] = [];
    for (const match of maskedBody.matchAll(MARKDOWN_LINK)) {
        const target = match[2] ?? "";
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, obsidian:
        if (target.startsWith("#")) continue; // same-note anchor
        links.push(decodeURI(target.split("#")[0] ?? target).trim());
    }
    return links.filter(Boolean);
}

function collectHeadings(maskedBody: string): Heading[] {
    const headings: Heading[] = [];
    for (const match of maskedBody.matchAll(HEADING)) {
        headings.push({ level: (match[1] ?? "").length, text: (match[2] ?? "").trim() });
    }
    return headings;
}

/**
 * Classify a property value for the property inventory.
 *
 * The inventory's purpose is to show what shapes already exist across the vault
 * before proposing a schema, so the categories are the ones a person would use
 * when deciding that, not JavaScript's.
 */
export type PropertyType = "text" | "number" | "checkbox" | "date" | "datetime" | "list" | "empty";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export function classifyProperty(value: unknown): PropertyType {
    if (value === null || value === undefined || value === "") return "empty";
    if (Array.isArray(value)) return "list";
    if (typeof value === "boolean") return "checkbox";
    if (typeof value === "number") return "number";
    if (value instanceof Date) return "datetime";
    if (typeof value === "string") {
        if (DATE_TIME.test(value)) return "datetime";
        if (DATE_ONLY.test(value)) return "date";
        return "text";
    }
    return "text";
}

/** A property value rendered for display and for exact-match search. */
export function propertyValueToText(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(propertyValueToText).join(", ");
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
