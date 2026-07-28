/**
 * The MCP tool surface.
 *
 * Contains no logic of its own beyond validating arguments and translating a
 * tool call into calls on the units below. If something here starts making
 * decisions about the vault, it belongs in the vault model or the reader.
 *
 * This is the thin slice: read and status only. Every write tool is absent
 * rather than disabled, because the write executor does not exist yet and a
 * tool that reports "not implemented" is worse than no tool — a model will try
 * it, and the user will believe writing is a configuration away.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { Replicator } from "../replicator/index.js";
import type { VaultReader } from "../vault/reader.js";
import type { VaultIndex } from "../index/index.js";
import type { VaultFormatSettings } from "../vault-model/index.js";
import { NoteNotFoundError } from "../vault/reader.js";
import { extractAttachment, isImage, mimeTypeFor } from "../attachment/extract.js";

export interface ToolContext {
    replicator: Replicator;
    reader: VaultReader;
    index: VaultIndex;
    settings: VaultFormatSettings;
    readOnly: boolean;
    attachmentSizeCap: number;
}

/** Human-readable lag, since a raw millisecond count invites false precision. */
function describeLag(lagMs: number): string {
    if (lagMs < 2_000) return "up to date";
    if (lagMs < 60_000) return `${Math.round(lagMs / 1000)}s since the last change`;
    if (lagMs < 3_600_000) return `${Math.round(lagMs / 60_000)}m since the last change`;
    return `${(lagMs / 3_600_000).toFixed(1)}h since the last change`;
}

export function registerTools(server: FastMCP, ctx: ToolContext): void {
    server.addTool({
        name: "vault_status",
        description:
            "Report the health of the connection to the Obsidian vault: replication phase, how " +
            "stale the local replica may be, document counts, and whether writes are enabled. " +
            "Use this when a read looks wrong or out of date, or to confirm the vault is reachable.",
        parameters: z.object({}),
        execute: async () => {
            const status = ctx.replicator.status();
            const docs = await ctx.replicator.refreshDocCount();
            const indexed = ctx.index.count();

            const lines = [
                `Replication: ${status.phase}${status.initialSyncComplete ? "" : " (initial sync in progress)"}`,
                `Staleness: ${describeLag(status.lagMs)}`,
                `Local replica: ${docs.toLocaleString()} documents, ${status.replicated.toLocaleString()} replicated this session`,
                `Index: ${indexed.notes} file(s): ${indexed.text} text, ${indexed.binary} binary`,
                `Writes: ${ctx.readOnly ? "disabled (read-only)" : "enabled"}`,
                `Encryption: ${ctx.settings.encrypt ? "on" : "off"}` +
                    (ctx.settings.usePathObfuscation ? ", path obfuscation on" : ""),
            ];

            if (status.decodeFailures > 0) {
                lines.push(
                    `WARNING: ${status.decodeFailures} document(s) could not be decoded. ` +
                        `Notes depending on them will fail to read rather than return wrong content.`
                );
            }
            if (status.error) lines.push(`Error: ${status.error}`);

            return lines.join("\n");
        },
    });

    server.addTool({
        name: "read_note",
        description:
            "Read a single note from the Obsidian vault by its path, e.g. 'daily/2026-07-28.md'. " +
            "Returns the note's full text. Set fresh=true to verify against the server first when " +
            "you need the very latest version rather than the replica's copy.",
        parameters: z.object({
            path: z.string().describe("Vault-relative path, including the extension."),
            fresh: z
                .boolean()
                .optional()
                .describe("Verify against CouchDB before answering. Slower; use when currency matters."),
        }),
        execute: async ({ path, fresh }) => {
            try {
                const { file, lagMs, verified } = await ctx.reader.read(path, { fresh: fresh ?? false });

                if (file.kind === "binary") {
                    return (
                        `"${file.path}" is an attachment (${formatBytes(file.size)}), not a text note. ` +
                        `Use get_attachment to read it.`
                    );
                }

                const header = [
                    `Path: ${file.path}`,
                    `Modified: ${new Date(file.mtime).toISOString()}`,
                    `Size: ${formatBytes(file.size)}`,
                    verified ? "Verified against the server." : `Replica: ${describeLag(lagMs)}.`,
                ].join("\n");

                return `${header}\n\n---\n\n${file.text}`;
            } catch (error) {
                if (error instanceof NoteNotFoundError) {
                    return `${error.message} Use list_notes to see what exists.`;
                }
                throw error;
            }
        },
    });

    server.addTool({
        name: "list_notes",
        description:
            "List notes and attachments in the Obsidian vault, optionally limited to one folder. " +
            "Use this to discover what exists before reading. Returns paths with sizes and " +
            "modification times, not content.",
        parameters: z.object({
            folder: z
                .string()
                .optional()
                .describe("Limit to this folder and everything under it, e.g. 'daily'."),
            include_internal: z
                .boolean()
                .optional()
                .describe("Include plugin and configuration files that are not vault notes."),
            limit: z.number().int().positive().max(5000).optional().describe("Maximum entries."),
        }),
        execute: async ({ folder, include_internal, limit }) => {
            const result = await ctx.reader.list({
                folder,
                includeInternal: include_internal ?? false,
                limit: limit ?? 500,
            });

            if (result.notes.length === 0) {
                return folder ? `No notes found under "${folder}".` : "The vault appears to be empty.";
            }

            const rows = result.notes.map(
                (note) =>
                    `${note.path}  (${formatBytes(note.size)}, ${new Date(note.mtime).toISOString().slice(0, 10)})`
            );

            const footer = [
                "",
                `${result.notes.length} entr${result.notes.length === 1 ? "y" : "ies"}` +
                    (result.truncated ? " (truncated, raise limit for more)" : ""),
                `Replica: ${describeLag(result.lagMs)}.`,
            ];

            return [...rows, ...footer].join("\n");
        },
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Attachment retrieval, registered alongside the read tools. */
export function registerAttachmentTool(server: FastMCP, ctx: ToolContext): void {
    server.addTool({
        name: "get_attachment",
        description:
            "Retrieve an attachment from the vault by path. PDFs are returned as extracted text. " +
            "Images are returned so they can be looked at directly. Use this after list_notes or " +
            "search_notes has shown you a non-markdown file.",
        parameters: z.object({
            path: z.string().min(1).describe("Vault-relative path of the attachment."),
            max_characters: z
                .number()
                .int()
                .positive()
                .max(200_000)
                .optional()
                .describe("Truncate extracted text to this length."),
        }),
        execute: async ({ path, max_characters }) => {
            let file;
            try {
                file = (await ctx.reader.read(path)).file;
            } catch (error) {
                if (error instanceof NoteNotFoundError) {
                    return `${error.message} Use list_notes to see what exists.`;
                }
                throw error;
            }

            if (file.kind === "text") {
                return `"${file.path}" is a text note, not an attachment. Use read_note.`;
            }

            const bytes = file.bytes ?? new Uint8Array();
            if (bytes.length > ctx.attachmentSizeCap) {
                // Refused with its size reported, rather than reassembled into
                // memory and then discarded.
                return (
                    `"${file.path}" is ${formatBytes(bytes.length)}, above the ` +
                    `${formatBytes(ctx.attachmentSizeCap)} limit for retrieval.`
                );
            }

            if (isImage(file.path)) {
                return {
                    content: [
                        { type: "text" as const, text: `${file.path} (${formatBytes(bytes.length)})` },
                        {
                            type: "image" as const,
                            data: Buffer.from(bytes).toString("base64"),
                            mimeType: mimeTypeFor(file.path),
                        },
                    ],
                };
            }

            const extracted = await extractAttachment(file.path, bytes);

            if (extracted.outcome !== "extracted") {
                return (
                    `No text could be read from "${file.path}" (${formatBytes(bytes.length)}).\n\n` +
                    `${extracted.reason ?? "Unknown reason."}`
                );
            }

            const limit = max_characters ?? 50_000;
            const truncated = extracted.text.length > limit;
            const body = truncated ? extracted.text.slice(0, limit) : extracted.text;

            const header = [
                `Path: ${file.path}`,
                `Pages: ${extracted.pages}`,
                `Size: ${formatBytes(bytes.length)}`,
                truncated ? `Showing the first ${limit} of ${extracted.text.length} characters.` : "",
            ]
                .filter(Boolean)
                .join("\n");

            return `${header}\n\n---\n\n${body}`;
        },
    });
}
