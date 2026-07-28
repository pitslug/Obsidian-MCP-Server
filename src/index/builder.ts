/**
 * Keeping the index in step with the replica.
 *
 * A full build walks every file document; after that, the replica's changes
 * feed drives incremental updates. The index is a derived artifact, so a build
 * that fails partway is not a problem to recover from — it is a reason to
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

export class IndexBuilder {
    private following = false;
    private changes: { cancel(): void } | undefined;
    /** Notes that failed to assemble during the last build. */
    private lastSkipped: string[] = [];

    constructor(
        private readonly replicator: Replicator,
        private readonly reader: VaultReader,
        private readonly index: VaultIndex,
        private readonly log: Logger
    ) {}

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
                    const { file } = await this.reader.read(path);
                    this.index.put(file);
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
     * `since: "now"` because a rebuild has just covered everything before this
     * point; replaying from zero would index the whole vault twice.
     */
    follow(): void {
        if (this.following) return;
        this.following = true;

        this.changes = this.replicator.database
            .changes({ since: "now", live: true, include_docs: true, timeout: false })
            .on("change", (change) => {
                void this.applyChange(change as unknown as ChangeRow);
            })
            .on("error", (error: unknown) => {
                this.log.error(`Index changes feed error: ${String(error)}`);
                this.following = false;
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
            this.log.debug(`Index: removed ${path}`);
            return;
        }

        try {
            const { file } = await this.reader.read(path);
            this.index.put(file);
            // Cheap at this vault's size, and it keeps backlinks correct when a
            // note that was previously a broken link target appears.
            this.index.resolveLinks();
            this.log.debug(`Index: updated ${path}`);
        } catch (error) {
            this.log.warn(`Index: could not update ${path} (${(error as Error).message})`);
        }
    }

    stop(): void {
        this.changes?.cancel();
        this.changes = undefined;
        this.following = false;
    }

    /** Paths skipped by the last build, for the status tool. */
    get skippedPaths(): readonly string[] {
        return this.lastSkipped;
    }
}

interface ChangeRow {
    id: string;
    deleted?: boolean;
    doc?: unknown;
}
