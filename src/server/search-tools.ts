/**
 * Search and curation tools.
 *
 * These are what the index exists for. `property_inventory` in particular was
 * singled out in the design: it shows what property keys and value shapes
 * already exist across the vault, so a schema can be proposed from what is
 * there rather than guessed at.
 *
 * Every tool here that returns paths confirms them against the replica before
 * returning them, and drops the stale ones from the index on the way past. See
 * `confirm.ts` for why that is worth a lookup: the index can outlive a deleted
 * note, and a deleted note used as context for a question is the one wrong
 * answer this server must not give.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VaultIndex } from "../index/index.js";
import type { VaultReader } from "../vault/reader.js";
import { confirmLive, staleness, type ConfirmContext } from "./confirm.js";
import { renderWikilink } from "../note/links.js";

export interface SearchToolContext extends ConfirmContext {
    index: VaultIndex;
    reader: VaultReader;
    log?: { warn(message: string): void };
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function registerSearchTools(server: FastMCP, ctx: SearchToolContext): void {
    server.addTool({
        name: "search_notes",
        description:
            "Full-text search across the vault. Supports SQLite FTS5 syntax: bare words are ANDed, " +
            '"quoted phrases" match exactly, OR and NOT combine terms, and a trailing * matches a ' +
            "prefix. Optionally narrow to a folder or a tag. Returns matching paths with an excerpt " +
            "of the matching text, not the whole note.",
        parameters: z.object({
            query: z.string().min(1).describe('Search terms, e.g. mortgage OR "home loan", or draft*'),
            folder: z.string().optional().describe("Limit to this folder and everything under it."),
            tag: z.string().optional().describe("Limit to notes carrying this tag, without the '#'."),
            limit: z.number().int().positive().max(100).optional(),
        }),
        execute: async ({ query, folder, tag, limit }) => {
            let hits;
            try {
                hits = ctx.index.search({ query, folder, tag, limit: limit ?? 20 });
            } catch (error) {
                // FTS5 rejects malformed queries; an unbalanced quote is the
                // usual cause and the message alone does not say so.
                return (
                    `That search query was rejected: ${(error as Error).message}\n\n` +
                    `Check for an unmatched quote or bracket. Bare words are ANDed, ` +
                    `"quoted phrases" match exactly, and a trailing * matches a prefix.`
                );
            }

            const confirmed = await confirmLive(ctx, hits, (hit) => hit.path);

            if (confirmed.rows.length === 0) {
                const scope = [folder ? `under "${folder}"` : "", tag ? `tagged #${tag}` : ""]
                    .filter(Boolean)
                    .join(", ");
                return [
                    `No notes match ${JSON.stringify(query)}${scope ? ` ${scope}` : ""}.`,
                    ...staleness(confirmed.dropped),
                ].join("\n");
            }

            const lines = confirmed.rows.map(
                (hit) => `${hit.path}  (${day(hit.mtime)})\n    ${hit.snippet.replace(/\s+/g, " ").trim()}`
            );
            return [
                ...lines,
                "",
                `${confirmed.rows.length} result(s).`,
                ...staleness(confirmed.dropped),
            ].join("\n");
        },
    });

    server.addTool({
        name: "property_inventory",
        description:
            "List every frontmatter property key used anywhere in the vault, with how many notes " +
            "use it, what value types have been observed, and example values. Use this before " +
            "proposing or changing a frontmatter schema, to see what already exists rather than " +
            "guessing. Also reveals near-duplicate keys such as 'status' alongside 'Status'.",
        parameters: z.object({
            min_notes: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Only keys used by at least this many notes."),
        }),
        execute: async ({ min_notes }) => {
            const inventory = ctx.index
                .propertyInventory()
                .filter((entry) => entry.noteCount >= (min_notes ?? 1));

            if (inventory.length === 0) return "No frontmatter properties found in the vault.";

            const lines = inventory.map((entry) => {
                const types = entry.types.map((t) => `${t.type}×${t.count}`).join(", ");
                const examples = entry.examples.length
                    ? `\n    e.g. ${entry.examples.map((e) => (e.length > 40 ? `${e.slice(0, 40)}…` : e)).join(" | ")}`
                    : "";
                return `${entry.key}  (${entry.noteCount} note${entry.noteCount === 1 ? "" : "s"}; ${types})${examples}`;
            });

            const inconsistent = inventory.filter((entry) => entry.types.length > 1);
            const footer = [
                "",
                `${inventory.length} distinct propert${inventory.length === 1 ? "y" : "ies"}.`,
            ];
            if (inconsistent.length > 0) {
                footer.push(
                    `${inconsistent.length} used with more than one value type: ` +
                        inconsistent.map((e) => e.key).join(", ") +
                        ". Those are the ones worth looking at first."
                );
            }

            return [...lines, ...footer].join("\n");
        },
    });

    server.addTool({
        name: "find_by_property",
        description:
            "Find notes carrying a frontmatter property, optionally with a particular value. Use " +
            "property_inventory first to see which keys and values exist. Matching is exact; for " +
            "list properties, a note matches if any item in the list matches.",
        parameters: z.object({
            key: z.string().min(1).describe("The property key, e.g. 'status'."),
            value: z.string().optional().describe("Optional exact value, e.g. 'done'."),
        }),
        execute: async ({ key, value }) => {
            const { rows: notes, dropped } = await confirmLive(
                ctx,
                ctx.index.findByProperty(key, value),
                (note) => note.path
            );
            if (notes.length === 0) {
                return [
                    value === undefined
                        ? `No notes have a "${key}" property.`
                        : `No notes have ${key} = ${JSON.stringify(value)}.`,
                    ...staleness(dropped),
                ].join("\n");
            }
            const lines = notes.map((n) => `${n.path}  (${formatBytes(n.size)}, ${day(n.mtime)})`);
            return [...lines, "", `${notes.length} note(s).`, ...staleness(dropped)].join("\n");
        },
    });

    server.addTool({
        name: "tag_inventory",
        description:
            "List every tag used in the vault with the number of notes carrying it, most used " +
            "first. Covers both frontmatter tags and inline #tags. Use this to see the vault's " +
            "actual tag vocabulary before adding to it.",
        parameters: z.object({}),
        execute: async () => {
            const tags = ctx.index.tagInventory();
            if (tags.length === 0) return "No tags found in the vault.";
            const lines = tags.map((t) => `#${t.tag}  (${t.noteCount})`);
            return [...lines, "", `${tags.length} distinct tag(s).`].join("\n");
        },
    });

    server.addTool({
        name: "find_by_tag",
        description: "List the notes carrying a given tag. Give the tag without its leading '#'.",
        parameters: z.object({ tag: z.string().min(1) }),
        execute: async ({ tag }) => {
            const bare = tag.replace(/^#/, "");
            const { rows: notes, dropped } = await confirmLive(
                ctx,
                ctx.index.findByTag(bare),
                (note) => note.path
            );
            if (notes.length === 0) {
                return [`No notes are tagged #${bare}.`, ...staleness(dropped)].join("\n");
            }
            const lines = notes.map((n) => `${n.path}  (${day(n.mtime)})`);
            return [...lines, "", `${notes.length} note(s).`, ...staleness(dropped)].join("\n");
        },
    });

    server.addTool({
        name: "note_links",
        description:
            "Show what a note links to and what links back to it. This is the vault's graph: use " +
            "it to find related notes that full-text search would miss, or to see what would break " +
            "if a note were renamed. Unresolved links are marked, since those point at nothing.",
        parameters: z.object({
            path: z.string().min(1).describe("Vault-relative path of the note."),
            direction: z
                .enum(["outgoing", "backlinks", "both"])
                .optional()
                .describe("Which direction to report. Defaults to both."),
        }),
        execute: async ({ path, direction }) => {
            const which = direction ?? "both";
            const sections: string[] = [];

            // The note itself first. Its links are its content, so answering
            // for a note the vault no longer holds would be exactly the leak
            // this file is careful about, and the index alone cannot say.
            if (!(await ctx.reader.live([path])).has(path)) {
                ctx.index.remove(path);
                return (
                    `There is no note at "${path}", so it has no links. If it was deleted, that is ` +
                    `why: its links went with it. Anything that still points at it now shows up as ` +
                    `an unresolved link in vault_health.`
                );
            }

            // Both directions print the link as the note has it. Printing only
            // where it landed answered a question nobody asks: somebody reading
            // links before a rename wants to know which words they would have
            // to change, and a note naming one file three ways came back as the
            // same path three times, ordered by a target text never shown.
            if (which === "outgoing" || which === "both") {
                const links = ctx.index.outgoingLinks(path);
                sections.push(`Links from ${path} (${links.length}):`);
                if (links.length === 0) {
                    sections.push("  none");
                } else {
                    for (const link of links) {
                        sections.push(`  ${renderWikilink(link)} -> ${link.resolvedPath ?? "UNRESOLVED"}`);
                    }
                }
            }

            if (which === "backlinks" || which === "both") {
                const { rows: back } = await confirmLive(ctx, ctx.index.backlinks(path), (link) => link.path);
                // The blank line separates two sections, so it belongs to the
                // second only when there was a first.
                if (which === "both") sections.push("");
                sections.push(`Links to ${path} (${back.length}):`);
                if (back.length === 0) {
                    sections.push("  none");
                } else {
                    for (const link of back) {
                        sections.push(`  ${link.path}: ${renderWikilink(link)}`);
                    }
                }
            }

            return sections.join("\n");
        },
    });

    server.addTool({
        name: "vault_health",
        description:
            "Report problems across the vault: links that point at nothing, notes whose " +
            "frontmatter could not be parsed, and notes that two devices changed without seeing " +
            "each other, which reads cannot show you. Use this when tidying up, and after " +
            "renaming or moving notes.",
        parameters: z.object({}),
        execute: async () => {
            // Both lists name the note the problem is in, so both are confirmed
            // before being reported. A curation report is the wrong place to
            // send someone after a note that is not there.
            const { rows: broken } = await confirmLive(ctx, ctx.index.brokenLinks(), (b) => b.source);
            const { rows: errors } = await confirmLive(ctx, ctx.index.frontmatterErrors(), (e) => e.path);
            const counts = ctx.index.count();

            const sections = [
                `Indexed: ${counts.notes} file(s): ${counts.text} text, ${counts.binary} binary`,
                "",
                `Unresolved links (${broken.length}):`,
                ...(broken.length === 0
                    ? ["  none"]
                    : broken.slice(0, 40).map((b) => `  ${b.source} -> ${b.target}`)),
            ];
            if (broken.length > 40) sections.push(`  … and ${broken.length - 40} more`);

            sections.push("", `Unparseable frontmatter (${errors.length}):`);
            sections.push(
                ...(errors.length === 0
                    ? ["  none"]
                    : errors.map((e) => `  ${e.path}: ${e.error.split("\n")[0]}`))
            );

            // The only line here that comes from the replica rather than the
            // index, and the only one that is not a curation problem. It
            // belongs in this report because it is the one state in the system
            // that is otherwise completely invisible: reads return the winning
            // revision, always the same one, and nothing anywhere mentions that
            // another version of the note exists.
            const conflicts = await ctx.reader.conflicts();
            sections.push("", `Notes two devices both changed (${conflicts.length}):`);
            if (conflicts.length === 0) {
                sections.push("  none");
            } else {
                sections.push(
                    ...conflicts
                        .slice(0, 20)
                        .map(
                            (conflict) =>
                                `  ${conflict.path}: ${conflict.losing + 1} versions, ` +
                                `${conflict.losing} of which no read will ever return`
                        )
                );
                if (conflicts.length > 20) sections.push(`  … and ${conflicts.length - 20} more`);
                sections.push(
                    `  Nothing is lost and nothing is broken. Two devices changed these without ` +
                        `having seen each other's change, so a version exists that reads do not ` +
                        `show. Resolve them in Obsidian, through the sync plugin, which is the only ` +
                        `thing that can show you both.`
                );
            }

            return sections.join("\n");
        },
    });
}
