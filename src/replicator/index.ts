/**
 * The replicator.
 *
 * Owns the local PouchDB replica and an open pull replication from CouchDB,
 * with the vault model's transform applied at the boundary so that what lands
 * locally is already decoded. Reports replication lag and health. Does not know
 * what a note is.
 *
 * Replication is **pull-only, and never pushes**. That is the load-bearing
 * decision from the design document, and it is worth restating where the code
 * lives rather than only where it was argued:
 *
 *   Replication reconciles everything that differs between two databases; it
 *   cannot be scoped to intent. A local replica that drifts for any reason — a
 *   half-completed write, a decode bug, a restored snapshot — would have that
 *   drift pushed faithfully to the vault and thence to every device. With
 *   pull-only replication plus direct writes, the only documents that can ever
 *   reach the vault are ones the write executor constructed deliberately.
 *
 * There is deliberately no code path here that replicates in the other
 * direction, and none that writes to the remote at all.
 */

import { EventEmitter } from "node:events";
import { PouchDB, type TransformableDatabase } from "./pouch.js";
import { decodeDocument, type TransformContext } from "../vault-model/index.js";

export interface ReplicatorOptions {
    /** The remote CouchDB URL, including the database and any credentials. */
    remoteUrl: string;
    /** Filesystem path for the local LevelDB-backed replica. */
    replicaPath: string;
    /** The E2EE and compression boundary. */
    transform: TransformContext;
    /** Documents per replication batch. */
    batchSize?: number;
    /** Called for each decode failure, rather than throwing into replication. */
    onDecodeError?: (id: string, error: Error) => void;
}

export type ReplicationPhase = "starting" | "initial" | "live" | "paused" | "offline" | "error" | "stopped";

export interface ReplicationStatus {
    phase: ReplicationPhase;
    /** Documents in the local replica. */
    localDocs: number;
    /** Documents written by replication since start. */
    replicated: number;
    /** Milliseconds since the last change arrived, or since start. */
    lagMs: number;
    /** When a change last arrived. */
    lastChangeAt: number | undefined;
    /** Set while the remote is unreachable or replication has failed. */
    error: string | undefined;
    /** True once the first full pass has completed. */
    initialSyncComplete: boolean;
    /** Documents that arrived but could not be decoded. */
    decodeFailures: number;
}

/**
 * Manages the local replica.
 *
 * Emits `change` when documents arrive, and `status` whenever the phase moves,
 * so the index can follow the replica without polling it.
 */
export class Replicator extends EventEmitter {
    private readonly options: ReplicatorOptions;
    private local: TransformableDatabase | undefined;
    private remote: PouchDB.Database | undefined;
    private replication: PouchDB.Replication.Replication<object> | undefined;

    private phase: ReplicationPhase = "stopped";
    private replicated = 0;
    private decodeFailures = 0;
    private lastChangeAt: number | undefined;
    private startedAt = 0;
    private lastError: string | undefined;
    private initialSyncComplete = false;

    constructor(options: ReplicatorOptions) {
        super();
        this.options = options;
    }

    /** The local replica. Reads go through this; it is never written remotely. */
    get database(): TransformableDatabase {
        if (!this.local) throw new Error("Replicator has not been started.");
        return this.local;
    }

    async start(): Promise<void> {
        if (this.local) throw new Error("Replicator is already started.");
        this.startedAt = Date.now();
        this.setPhase("starting");

        this.local = new PouchDB(this.options.replicaPath, {
            adapter: "leveldb",
            auto_compaction: true,
            revs_limit: 10,
        }) as TransformableDatabase;

        // Decode on the way out of the remote, so the replica holds plain
        // documents and every reader shares one definition of "decoded".
        this.remote = new PouchDB(this.options.remoteUrl, {
            adapter: "http",
            skip_setup: true,
        });
        (this.remote as unknown as TransformableDatabase).transform({
            outgoing: async (doc: unknown) => {
                try {
                    return await decodeDocument(doc as never, this.options.transform);
                } catch (error) {
                    // Throwing here aborts replication for the whole batch. One
                    // undecodable document should not stop the vault syncing —
                    // it is recorded, counted, and the document passes through
                    // in its wire form, where assembly will refuse it loudly.
                    this.decodeFailures++;
                    const id = String((doc as { _id?: unknown })?._id ?? "<unknown>");
                    this.options.onDecodeError?.(id, error as Error);
                    return doc;
                }
            },
        });

        this.beginReplication();
    }

    private beginReplication(): void {
        if (!this.local || !this.remote) return;

        // `to`/`from` are explicit: this replicates FROM the remote TO the
        // local replica, and nothing here ever reverses that.
        this.replication = this.local.replicate.from(this.remote, {
            live: true,
            retry: true,
            batch_size: this.options.batchSize ?? 100,
        }) as PouchDB.Replication.Replication<object>;

        this.setPhase("initial");

        this.replication
            .on("change", (info) => {
                this.replicated += info.docs_written ?? 0;
                this.lastChangeAt = Date.now();
                this.setPhase(this.initialSyncComplete ? "live" : "initial");
                this.emit("change", info);
            })
            .on("paused", (error?: unknown) => {
                // `paused` fires both when caught up and when the connection
                // drops; the argument is what distinguishes them.
                if (error) {
                    this.lastError = describeError(error);
                    this.setPhase("offline");
                } else {
                    this.initialSyncComplete = true;
                    this.lastError = undefined;
                    this.setPhase("live");
                }
            })
            .on("active", () => {
                this.lastError = undefined;
                this.setPhase(this.initialSyncComplete ? "live" : "initial");
            })
            .on("denied", (error: unknown) => {
                // A document the remote refused. With pull-only replication
                // this should be impossible, so it is worth surfacing.
                this.lastError = `Replication denied: ${describeError(error)}`;
                this.emit("denied", error);
            })
            .on("error", (error: unknown) => {
                this.lastError = describeError(error);
                this.setPhase("error");
                this.emit("replication-error", error);
            })
            .on("complete", () => {
                this.initialSyncComplete = true;
                this.setPhase("stopped");
            });
    }

    private setPhase(phase: ReplicationPhase): void {
        if (this.phase === phase) return;
        this.phase = phase;
        this.emit("status", this.status());
    }

    /**
     * Current replication state.
     *
     * `lagMs` measures time since the last change arrived, which on a quiet
     * vault grows without anything being wrong. It answers "how stale could
     * this be", not "how far behind is it" — the latter is not knowable
     * without asking the remote, which is what a read's `fresh` flag is for.
     */
    status(): ReplicationStatus {
        const since = this.lastChangeAt ?? this.startedAt;
        return {
            phase: this.phase,
            localDocs: this.knownDocCount,
            replicated: this.replicated,
            lagMs: this.startedAt === 0 ? 0 : Date.now() - since,
            lastChangeAt: this.lastChangeAt,
            error: this.lastError,
            initialSyncComplete: this.initialSyncComplete,
            decodeFailures: this.decodeFailures,
        };
    }

    private knownDocCount = 0;

    /** Refresh the document count. Separate because it costs a database call. */
    async refreshDocCount(): Promise<number> {
        if (!this.local) return 0;
        const info = await this.local.info();
        this.knownDocCount = info.doc_count;
        return this.knownDocCount;
    }

    /**
     * Wait until the first full replication pass has finished.
     *
     * Resolves as soon as replication reports itself caught up. Rejects on a
     * fatal replication error, and on timeout — a caller that waited forever
     * would present as a hung startup with no explanation.
     */
    async waitForInitialSync(timeoutMs = 300_000): Promise<void> {
        if (this.initialSyncComplete) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Initial replication did not complete within ${Math.round(timeoutMs / 1000)}s. ` +
                            `Last state: ${this.phase}${this.lastError ? ` (${this.lastError})` : ""}.`
                    )
                );
            }, timeoutMs);

            const onStatus = (status: ReplicationStatus) => {
                if (status.initialSyncComplete) {
                    cleanup();
                    resolve();
                } else if (status.phase === "error") {
                    cleanup();
                    reject(new Error(status.error ?? "Replication failed."));
                }
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.off("status", onStatus);
            };

            this.on("status", onStatus);
            if (this.initialSyncComplete) {
                cleanup();
                resolve();
            }
        });
    }

    /** Stop replicating. The replica is left in place. */
    async stop(): Promise<void> {
        this.replication?.cancel();
        this.replication = undefined;
        this.setPhase("stopped");
        await this.local?.close();
        this.local = undefined;
        this.remote = undefined;
    }

    /**
     * Destroy the local replica.
     *
     * Safe: the replica is derived data and rebuilds from CouchDB on next
     * start. Nothing here touches the remote.
     */
    async destroyReplica(): Promise<void> {
        this.replication?.cancel();
        this.replication = undefined;
        await this.local?.destroy();
        this.local = undefined;
        this.remote = undefined;
        this.setPhase("stopped");
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        const e = error as { message?: string; reason?: string; status?: number };
        return e.message ?? e.reason ?? `status ${e.status ?? "unknown"}`;
    }
    return String(error);
}
