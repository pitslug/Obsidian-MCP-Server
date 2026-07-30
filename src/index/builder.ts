/**
 * Keeping the index in step with the replica.
 *
 * A full build walks every file document; after that, the replica's changes
 * feed drives incremental updates. The index is a derived artifact, so a build
 * that fails partway is not a problem to recover from - it is a reason to
 * rebuild.
 *
 * Notes that cannot be assembled are skipped and counted rather than aborting
 * the build. A vault with one unreadable note should still be searchable, and
 * the count is reported so the failure is visible rather than silent.
 */

import type { Replicator } from "../replicator/index.js";
import type { VaultReader } from "../vault/reader.js";
import type { VaultIndex } from "./index.js";
import type { Logger } from "../server/logger.js";
import { entryPath, isDeleted, isFileEntry } from "../vault-model/index.js";
import { CHUNK_ID_RANGE_END, PREFIX_CHUNK } from "../vault-model/constants.js";
import { extractAttachment } from "../attachment/extract.js";
import { isTranscriptStale, type TranscriptStore } from "../attachment/transcripts.js";

/** How long to wait before the first attempt to put the feed back. */
const FEED_RETRY_MS = 1_000;
/** And the longest it will ever wait between attempts. */
const FEED_RETRY_CAP_MS = 60_000;

const FILE_RANGES: [string, string][] = [
    ["", "_"],
    ["_\u{10ffff}", PREFIX_CHUNK],
    [CHUNK_ID_RANGE_END, "\u{10ffff}"],
];

export interface BuildResult {
    indexed: number;
    skipped: number;
    /** Index entries dropped because the note is no longer in the vault. */
    pruned: number;
    ms: number;
}

export interface IndexBuilderOptions {
    /** Skip extraction for attachments larger than this. */
    extractionSizeCap: number;
    /** Stored transcriptions, indexed in preference to extracted text. */
    transcripts?: TranscriptStore;
}

export class IndexBuilder {
    private following = false;
    private changes: { cancel(): void } | undefined;
    /** Where to resume the feed from, which a reconnection depends on. */
    private since: string | number = "now";
    /** Set by stop(), so a reconnection in flight does not undo it. */
    private stopped = false;
    private backoffMs = 0;
    private retry: ReturnType<typeof setTimeout> | undefined;
    /** Notes that failed to assemble during the last build. */
    private lastSkipped: string[] = [];

    constructor(
        private readonly replicator: Replicator,
        private readonly reader: VaultReader,
        private readonly index: VaultIndex,
        private readonly log: Logger,
        private readonly options: IndexBuilderOptions = { extractionSizeCap: 25 * 1024 * 1024 }
    ) {}

    /**
     * Index one file, extracting attachment text where there is any.
     *
     * Extraction is skipped above a size cap: a very large PDF costs real time
     * and memory to parse, and a rebuild that stalls on one file is worse than
     * a file that is listed but not searchable.
     */
    private async indexOne(path: string): Promise<void> {
        const { file } = await this.reader.read(path);

        if (file.kind !== "binary") {
            this.index.put(file);
            return;
        }

        // Consulted before the size cap and before extraction. For ink from a
        // handwriting plugin there is nothing to extract at all, so a stored
        // transcription is the only thing that ever makes those pages
        // searchable, and looking it up costs nothing however large the file.
        const transcript = this.options.transcripts?.get(path);
        if (transcript) {
            const stale = isTranscriptStale(transcript, file.size, file.mtime);
            this.index.put(file, {
                outcome: stale ? "transcribed-stale" : "transcribed",
                text: transcript.text,
                reason: stale ? "The attachment has changed since this transcription was made." : undefined,
            });
            return;
        }

        if (file.size > this.options.extractionSizeCap) {
            this.index.put(file, {
                outcome: "skipped",
                text: "",
                reason: `Larger than the ${Math.round(this.options.extractionSizeCap / (1024 * 1024))} MiB extraction cap.`,
            });
            return;
        }

        const extracted = await extractAttachment(path, file.bytes ?? new Uint8Array());
        this.index.put(file, {
            outcome: extracted.outcome,
            text: extracted.text,
            reason: extracted.reason,
        });
    }

    /**
     * Index one file now, rather than when the changes feed gets to it.
     *
     * For the one case where waiting is not merely slower but wrong: a file
     * that moves is written to its new path, which the feed picks up
     * immediately, and only then does its transcription follow. The feed
     * therefore indexes the destination while the transcription is still filed
     * under the old path, finds nothing to index for it, and never looks again.
     * A scan a model was paid to read would silently stop being findable.
     */
    async reindex(path: string): Promise<void> {
        try {
            await this.indexOne(path);
            this.index.resolveLinks();
        } catch (error) {
            this.log.warn(`Index: could not update ${path} (${(error as Error).message})`);
        }
    }

    /** Walk every file document and index it. */
    async rebuild(): Promise<BuildResult> {
        const started = Date.now();
        let indexed = 0;
        let skipped = 0;
        const live = new Set<string>();
        this.lastSkipped = [];

        for (const [startkey, endkey] of FILE_RANGES) {
            const page = await this.replicator.database.allDocs({
                startkey,
                endkey,
                include_docs: true,
            });

            for (const row of page.rows) {
                const doc = (row as { doc?: unknown }).doc as Record<string, unknown> | undefined;
                if (!doc || !isFileEntry(doc)) continue;
                if (isDeleted(doc as { deleted?: boolean; _deleted?: boolean })) continue;

                const path = String(entryPath(doc as never));
                live.add(path);
                try {
                    await this.indexOne(path);
                    indexed++;
                } catch (error) {
                    skipped++;
                    if (this.lastSkipped.length < 20) this.lastSkipped.push(path);
                    this.log.warn(`Not indexed: ${path} (${(error as Error).message})`);
                }
            }
        }

        // Anything the index still holds that the vault no longer has was
        // deleted or renamed while this was not running.
        const pruned = this.index.prune(live);
        for (const path of pruned) this.log.debug(`Index: pruned ${path}`);

        // Resolution runs once at the end: a link often points at a note that
        // had not been indexed yet when the link was read.
        this.index.resolveLinks();

        const result = { indexed, skipped, pruned: pruned.length, ms: Date.now() - started };
        this.log.info(
            `Index built: ${indexed} note(s) in ${(result.ms / 1000).toFixed(1)}s` +
                (skipped > 0 ? `, ${skipped} skipped` : "") +
                (pruned.length > 0
                    ? `, ${pruned.length} stale entr${pruned.length === 1 ? "y" : "ies"} removed`
                    : "")
        );
        return result;
    }

    /**
     * Follow the replica for changes.
     *
     * A rebuild has just covered everything up to this point, so this starts
     * from where the replica is now rather than replaying the whole vault.
     * The sequence is read explicitly rather than passed as `since: "now"`,
     * because it is also what a reconnection resumes from, and "now" at that
     * moment would mean "skip whatever happened while the feed was dead".
     */
    async follow(): Promise<void> {
        if (this.following) return;
        this.following = true;
        this.stopped = false;

        try {
            const info = (await this.replicator.database.info()) as unknown as {
                update_seq?: string | number;
            };
            this.since = info.update_seq ?? "now";
        } catch {
            // Not worth failing startup over. The cost is that a feed which
            // dies before its first change resumes from "now" and misses that
            // window, which is the same behaviour this had everywhere before.
            this.since = "now";
        }

        this.subscribe();
    }

    /**
     * Attach to the feed, and put it back when it falls off.
     *
     * The failure this exists for used to be silent and permanent: on any error
     * the feed logged, set `following = false`, and stayed dead until the
     * process restarted. Reads went on working, so nothing looked wrong, while
     * every note written from then on was missing from search and every edit
     * was answered from a frozen copy. A note the vault holds and the index has
     * never heard of is invisible to search, to the tag and property
     * inventories, and to anything that selects notes for a batch.
     *
     * Backoff doubles from a second to a minute, because the usual cause is the
     * replica being briefly unavailable and the unusual cause is something that
     * will not be fixed by trying hard. It resumes from the last sequence
     * applied, so a change that arrived during the outage is picked up rather
     * than skipped.
     */
    private subscribe(): void {
        if (this.stopped) return;

        this.changes = this.replicator.database
            .changes({ since: this.since, live: true, include_docs: true, timeout: false })
            .on("change", (change) => {
                const row = change as unknown as ChangeRow;
                if (row.seq !== undefined) this.since = row.seq as string | number;
                // A change means the feed is healthy, whatever it took to get
                // here, so the next failure starts from a short wait again.
                this.backoffMs = 0;
                void this.applyChange(row);
            })
            .on("error", (error: unknown) => {
                this.changes = undefined;
                if (this.stopped) return;

                this.backoffMs =
                    this.backoffMs === 0 ? FEED_RETRY_MS : Math.min(this.backoffMs * 2, FEED_RETRY_CAP_MS);
                this.log.warn(
                    `Index changes feed dropped (${String(error)}). Reconnecting in ` +
                        `${Math.round(this.backoffMs / 1000)}s from sequence ${String(this.since)}. ` +
                        `Until it is back, notes written or edited elsewhere will not appear in search.`
                );

                this.retry = setTimeout(() => {
                    this.retry = undefined;
                    this.subscribe();
                }, this.backoffMs);
                // A pending reconnection must not hold the process open: it is
                // a cache catching up, not work anybody is waiting for.
                this.retry.unref?.();
            }) as unknown as { cancel(): void };
    }

    private async applyChange(change: ChangeRow): Promise<void> {
        const doc = change.doc as Record<string, unknown> | undefined;

        // Chunks vastly outnumber notes on the feed; skipping them by ID keeps
        // this cheap.
        if (change.id.startsWith(PREFIX_CHUNK) || change.id.startsWith("_")) return;
        if (!doc || !isFileEntry(doc)) return;

        const path = String(entryPath(doc as never));

        if (change.deleted || isDeleted(doc as { deleted?: boolean; _deleted?: boolean })) {
            this.index.remove(path);
            // Resolution changes when a path disappears, and not only by
            // breaking: a vault holding two files of the same name has the
            // other one take over, which is what Obsidian does and what a move
            // depends on, since the tombstone for the old path arrives after
            // the new one is already indexed. Without this the links to a
            // moved file stay unresolved until the next restart.
            this.index.resolveLinks();
            this.log.debug(`Index: removed ${path}`);
            return;
        }

        try {
            await this.indexOne(path);
            // Cheap at this vault's size, and it keeps backlinks correct when a
            // note that was previously a broken link target appears.
            this.index.resolveLinks();
            this.log.debug(`Index: updated ${path}`);
        } catch (error) {
            this.log.warn(`Index: could not update ${path} (${(error as Error).message})`);
        }
    }

    stop(): void {
        this.stopped = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = undefined;
        this.changes?.cancel();
        this.changes = undefined;
        this.following = false;
    }

    /** Whether the feed is attached right now. Used by vault_status. */
    get feedAttached(): boolean {
        return this.changes !== undefined;
    }

    /** Paths skipped by the last build, for the status tool. */
    get skippedPaths(): readonly string[] {
        return this.lastSkipped;
    }
}

interface ChangeRow {
    id: string;
    seq?: string | number;
    deleted?: boolean;
    doc?: unknown;
}
