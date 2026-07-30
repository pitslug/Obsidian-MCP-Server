/**
 * The MCP tool surface.
 *
 * Contains no logic of its own beyond validating arguments and translating a
 * tool call into calls on the units below. If something here starts making
 * decisions about the vault, it belongs in the vault model or the reader.
 *
 * Read and status tools live here; the ones that change the vault live in
 * `write-tools.ts` and are registered only when writing is enabled. That split
 * is not organisational tidiness. It means the set of tools that can modify a
 * vault is a file you can read in one sitting, and that a read-only deployment
 * does not merely refuse those tools but never offers them: a tool that reports
 * "not implemented" is worse than no tool, because a model will try it and the
 * user will believe writing is a configuration away.
 */

import { z } from "zod";
import type { FastMCP } from "fastmcp";
import type { Replicator } from "../replicator/index.js";
import type { VaultReader } from "../vault/reader.js";
import { isSearchable, type ExtractionState, type VaultIndex } from "../index/index.js";
import { isTranscriptStale, type TranscriptStore } from "../attachment/transcripts.js";
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
    transcripts: TranscriptStore;
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
                // Named rather than a bare "enabled". A model that can see
                // which tools exist stops guessing whether an edit is possible,
                // and a person reading this wants to know exactly what has been
                // let through the door.
                `Writes: ${
                    ctx.readOnly
                        ? "disabled (read-only), so no registered tool can modify the vault"
                        : "enabled (create_note, append_note, edit_note, set_properties, delete_note)"
                }`,
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

/**
 * Largest PDF returned to the caller as raw bytes, rather than as text.
 *
 * Separate from, and much smaller than, `attachmentSizeCap`. That cap is about
 * what this server is willing to reassemble; this is about what a client can
 * actually receive in one tool result. Base64 adds a third again, and a 25 MiB
 * PDF would arrive as a 33 MiB string that no client will thank us for.
 */
const EMBED_SIZE_CAP = 8 * 1024 * 1024;

/**
 * Why an attachment has no searchable text, in a few words.
 *
 * Phrased for whoever is deciding what to do about it, so it says what would
 * have to change rather than naming the internal state.
 */
function describeState(state: ExtractionState | undefined): string {
    switch (state) {
        case "transcribed-stale":
            return "transcription out of date";
        case "no-text-layer":
            return "no text layer: handwriting or a scan";
        case "not-textual":
            return "not a text format; can be read as an image";
        case "skipped":
            return "too large to extract";
        case "failed":
            return "could not be parsed";
        default:
            return "not examined yet";
    }
}

/** Attachment retrieval, registered alongside the read tools. */
export function registerAttachmentTool(server: FastMCP, ctx: ToolContext): void {
    server.addTool({
        name: "get_attachment",
        description:
            "Retrieve an attachment from the vault by path. PDFs with a text layer come back as " +
            "extracted text. Handwritten or scanned PDFs come back as the PDF itself, so it can be " +
            "read directly and the reading stored with save_transcription. Images come back as " +
            "images, to be looked at. Use this after list_notes, search_notes or list_untranscribed " +
            "has shown you a non-markdown file.",
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
            const transcript = ctx.transcripts.get(file.path);

            if (bytes.length > ctx.attachmentSizeCap) {
                // Refused with its size reported, rather than reassembled into
                // memory and then discarded. A transcription is still served
                // though: it is already in hand, it costs nothing to return,
                // and it is the only text this file will ever have. The size
                // cap is about shipping bytes, not about withholding text.
                const refusal =
                    `"${file.path}" is ${formatBytes(bytes.length)}, above the ` +
                    `${formatBytes(ctx.attachmentSizeCap)} limit for retrieval.`;
                return transcript
                    ? `${refusal} Its stored transcription follows.\n\n---\n\n${transcript.text}`
                    : refusal;
            }

            if (isImage(file.path)) {
                // An image is returned as an image even when a transcription
                // exists, because the picture is the better source and the
                // caller can read it again. The transcription is mentioned so
                // that a caller about to re-transcribe knows it need not.
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `${file.path} (${formatBytes(bytes.length)})` +
                                (transcript
                                    ? `\n\nAlready transcribed${transcript.provenance ? ` by ${transcript.provenance}` : ""}; ` +
                                      `its text is searchable. Only call save_transcription again to correct it.`
                                    : ""),
                        },
                        {
                            type: "image" as const,
                            data: Buffer.from(bytes).toString("base64"),
                            mimeType: mimeTypeFor(file.path),
                        },
                    ],
                };
            }

            // A stored transcription is the best text this file has, and it is
            // better than anything extraction would find; serving the apology
            // instead would be actively wrong once someone has done the work.
            if (transcript) {
                const stale = isTranscriptStale(transcript, file.size, file.mtime);
                return (
                    [
                        `Path: ${file.path}`,
                        `Size: ${formatBytes(bytes.length)}`,
                        `Source: transcription${transcript.provenance ? ` (${transcript.provenance})` : ""}`,
                        stale
                            ? `WARNING: the attachment has changed since this was transcribed. ` +
                              `Retrieve the file again and re-transcribe it.`
                            : "",
                    ]
                        .filter(Boolean)
                        .join("\n") + `\n\n---\n\n${transcript.text}`
                );
            }

            const extracted = await extractAttachment(file.path, bytes);

            // No text layer: the words on this page are pictures. Text cannot
            // convey them, so hand over the file. This is the step that makes
            // handwriting reachable at all - without it, list_untranscribed
            // names a file that nothing can then read.
            if (extracted.outcome === "no-text-layer" && bytes.length <= EMBED_SIZE_CAP) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                `"${file.path}" (${formatBytes(bytes.length)}, ${extracted.pages} page(s)) ` +
                                `has no text layer, so there is nothing to extract. The file itself ` +
                                `follows. Read it, then call save_transcription with what it says so ` +
                                `that it becomes searchable. This does not modify the vault.`,
                        },
                        {
                            type: "resource" as const,
                            resource: {
                                uri: `obsidian-vault:///${file.path}`,
                                mimeType: mimeTypeFor(file.path),
                                blob: Buffer.from(bytes).toString("base64"),
                            },
                        },
                    ],
                };
            }

            if (extracted.outcome !== "extracted") {
                const tooBig = extracted.outcome === "no-text-layer" && bytes.length > EMBED_SIZE_CAP;
                return (
                    `No text could be read from "${file.path}" (${formatBytes(bytes.length)}).\n\n` +
                    `${extracted.reason ?? "Unknown reason."}` +
                    (tooBig
                        ? `\n\nIt is also too large (over ${formatBytes(EMBED_SIZE_CAP)}) to hand over ` +
                          `for reading directly. Split it, or transcribe it outside this server and ` +
                          `store the result with save_transcription.`
                        : "")
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

/**
 * Transcription tools.
 *
 * These exist because the transcriber that works on handwriting is a model
 * reading the page, and this server has no model. So it holds the pages up and
 * stores what comes back.
 *
 * `save_transcription` writes, but **not to the vault**. It writes to a local
 * store beside the index, and there is no code path from it to CouchDB. That is
 * why it stays available when READ_ONLY is set: the read-only toggle is about
 * the vault, and nothing here can reach it.
 */
export function registerTranscriptionTools(server: FastMCP, ctx: ToolContext): void {
    server.addTool({
        name: "list_untranscribed",
        description:
            "List attachments that have no searchable text: handwritten or scanned PDFs with no " +
            "text layer, images, files too large or too damaged to extract, and any whose " +
            "transcription is out of date because the file has since changed. Use this to find " +
            "what still needs transcribing.",
        parameters: z.object({}),
        execute: async () => {
            const report = ctx.index.extractionReport();
            if (report.length === 0) return "No attachments in the vault.";

            // Anything not searchable belongs on this list, which means the
            // test is `!isSearchable` rather than a list of the states thought
            // of at the time. Naming the states that need transcribing is how
            // an image, a file over the extraction cap, or one that failed to
            // parse ends up silently reported as fine: all three have no text
            // and all three can be read by a model.
            const needing = report.filter((row) => !isSearchable(row.outcome));

            if (needing.length === 0) {
                return `All ${report.length} attachment(s) have searchable text.`;
            }

            const lines = needing.map((row) => `${row.path}  [${describeState(row.outcome)}]`);
            const sections = [
                ...lines,
                "",
                `${needing.length} of ${report.length} attachment(s) have no searchable text.`,
                `Use get_attachment to read one, then save_transcription to store the result.`,
            ];

            // Renaming a file in Obsidian is a delete and a create, so a
            // transcription keyed on the old path comes unattached. Nothing
            // deletes it, which is right, but nothing surfaced it either: the
            // page reappeared above as untranscribed and the reading already
            // paid for sat in the store unreachable. Reported here because this
            // is where someone looks before spending on it a second time.
            const orphans = ctx.transcripts.orphans(new Set(ctx.index.allPaths()));
            if (orphans.length > 0) {
                sections.push(
                    "",
                    `${orphans.length} stored transcription(s) no longer match a file in the vault, ` +
                        `usually because it was renamed or moved:`,
                    ...orphans.map((o) => `  ${o.path} (${o.text.length} characters)`),
                    `Re-save one against its new path to reattach it. Nothing has been deleted.`
                );
            }

            return sections.join("\n");
        },
    });

    server.addTool({
        name: "save_transcription",
        description:
            "Store a transcription of an attachment so that its contents become searchable. Use " +
            "after reading a handwritten or scanned attachment that has no text layer. This does " +
            "NOT modify the vault: the transcription is kept locally alongside the search index, " +
            "and the original file is untouched.",
        parameters: z.object({
            path: z.string().min(1).describe("Vault-relative path of the attachment transcribed."),
            text: z.string().min(1).describe("The transcription."),
            provenance: z
                .string()
                .optional()
                .describe("How this was produced, e.g. the model used, or 'checked by hand'."),
        }),
        execute: async ({ path, text, provenance }) => {
            let file;
            try {
                file = (await ctx.reader.read(path)).file;
            } catch (error) {
                if (error instanceof NoteNotFoundError) {
                    return `${error.message} A transcription must belong to a file that exists.`;
                }
                throw error;
            }

            if (file.kind !== "binary") {
                return (
                    `"${file.path}" is a text note; its contents are already searchable. ` +
                    `Transcriptions are for attachments.`
                );
            }

            ctx.transcripts.put({
                path: file.path,
                text,
                sourceSize: file.size,
                sourceMtime: file.mtime,
                provenance,
            });

            // Reindex immediately, so the transcription is searchable now
            // rather than after the next restart.
            ctx.index.put(file, { outcome: "transcribed", text, reason: undefined });

            return (
                `Stored a ${text.length}-character transcription of "${file.path}". ` +
                `It is now searchable. The vault file itself was not modified.`
            );
        },
    });
}
