/**
 * Search and curation tools.
 *
 * These are what the index exists for. `property_inventory` in particular was
 * singled out in the design: it shows what property keys and value shapes
 * already exist across the vault, so a schema can be proposed from what is
 * there rather than guessed at.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { VaultIndex } from "../index/index.js";

export interface SearchToolContext {
    index: VaultIndex;
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

            if (hits.length === 0) {
                const scope = [folder ? `under "${folder}"` : "", tag ? `tagged #${tag}` : ""]
                    .filter(Boolean)
                    .join(", ");
                return `No notes match ${JSON.stringify(query)}${scope ? ` ${scope}` : ""}.`;
            }

            const lines = hits.map(
                (hit) => `${hit.path}  (${day(hit.mtime)})\n    ${hit.snippet.replace(/\s+/g, " ").trim()}`
            );
            return [...lines, "", `${hits.length} result(s).`].join("\n");
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
            const notes = ctx.index.findByProperty(key, value);
            if (notes.length === 0) {
                return value === undefined
                    ? `No notes have a "${key}" property.`
                    : `No notes have ${key} = ${JSON.stringify(value)}.`;
            }
            const lines = notes.map((n) => `${n.path}  (${formatBytes(n.size)}, ${day(n.mtime)})`);
            return [...lines, "", `${notes.length} note(s).`].join("\n");
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
            const notes = ctx.index.findByTag(tag.replace(/^#/, ""));
            if (notes.length === 0) return `No notes are tagged #${tag.replace(/^#/, "")}.`;
            const lines = notes.map((n) => `${n.path}  (${day(n.mtime)})`);
            return [...lines, "", `${notes.length} note(s).`].join("\n");
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

            if (which === "outgoing" || which === "both") {
                const links = ctx.index.outgoingLinks(path);
                sections.push(`Links from ${path} (${links.length}):`);
                if (links.length === 0) {
                    sections.push("  none");
                } else {
                    for (const link of links) {
                        const marks = [
                            link.embed ? "embed" : "",
                            link.subpath ? `#${link.subpath}` : "",
                            link.resolvedPath ? "" : "UNRESOLVED",
                        ].filter(Boolean);
                        sections.push(
                            `  ${link.resolvedPath ?? link.target}` +
                                (marks.length ? `  [${marks.join(", ")}]` : "")
                        );
                    }
                }
            }

            if (which === "backlinks" || which === "both") {
                const back = ctx.index.backlinks(path);
                sections.push("", `Links to ${path} (${back.length}):`);
                if (back.length === 0) {
                    sections.push("  none");
                } else {
                    for (const link of back) {
                        sections.push(`  ${link.path}${link.embed ? "  [embed]" : ""}`);
                    }
                }
            }

            return sections.join("\n");
        },
    });

    server.addTool({
        name: "vault_health",
        description:
            "Report curation problems across the vault: links that point at nothing, and notes " +
            "whose frontmatter could not be parsed. Use this when tidying up, or after renaming " +
            "or moving notes.",
        parameters: z.object({}),
        execute: async () => {
            const broken = ctx.index.brokenLinks();
            const errors = ctx.index.frontmatterErrors();
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

            return sections.join("\n");
        },
    });
}
