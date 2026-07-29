/**
 * Wiring: configuration in, running server out.
 *
 * Startup order matters and is deliberate. The vault's own format settings are
 * read from CouchDB *before* replication begins, because they determine how
 * every document is decoded - starting replication first would mean decoding
 * the first batch under assumed settings.
 */

import { FastMCP } from "fastmcp";
import {
    readTweakValues,
    resolveSettings,
    decodePbkdf2Salt,
    transformContextFor,
    DOCID_MILESTONE,
    DOCID_SYNC_PARAMETERS,
    DOCID_VERSIONING,
    SUPPORTED_DB_VERSION,
    type MilestoneEntry,
    type VaultFormatSettings,
} from "../vault-model/index.js";
import { Replicator } from "../replicator/index.js";
import { VaultReader } from "../vault/reader.js";
import { registerAttachmentTool, registerTools, registerTranscriptionTools } from "./tools.js";
import { registerSearchTools } from "./search-tools.js";
import { registerWriteTools } from "./write-tools.js";
import { registerPlanTools } from "./plan-tools.js";
import { CouchWriter, PlanningWriteExecutor } from "../write/index.js";
import { VaultIndex } from "../index/index.js";
import { IndexBuilder } from "../index/builder.js";
import { TranscriptStore } from "../attachment/transcripts.js";
import { loadConfig, redactedUrl, remoteUrl, type Config } from "../config.js";
import { documentUrl, endpointFor, headersFor } from "../couch/rest.js";
import { createLogger, type Logger } from "./logger.js";
import { createAuthWiring } from "../auth/index.js";

/**
 * Read documents straight from CouchDB.
 *
 * Deliberately GET-only, and separate from the replicator's PouchDB handle:
 * the replicator's remote handle exists to replicate, and giving the read path
 * a client that *can* write would make "which code can modify the vault?" a
 * harder question than it needs to be.
 */
function createRemoteReader(config: Config, log: Logger) {
    // The URL and auth plumbing is shared with the write path, so the one
    // fiddly rule here - which slashes in a document ID are path separators and
    // which are part of the ID - has a single definition rather than two that
    // drift apart. Sharing it does not make this path able to write: the method
    // is fixed here, and `CouchWriter` is the only thing that sends anything
    // else.
    const endpoint = endpointFor(config.couch);

    return async function fetchRemote(id: string): Promise<Record<string, unknown> | undefined> {
        const response = await fetch(documentUrl(endpoint, id), {
            method: "GET",
            headers: headersFor(endpoint),
        });
        if (response.status === 404) return undefined;
        if (!response.ok) {
            log.warn(`Direct read of "${id}" failed: ${response.status} ${response.statusText}`);
            return undefined;
        }
        return (await response.json()) as Record<string, unknown>;
    };
}

/**
 * Determine the vault's storage format.
 *
 * Read from the vault rather than assumed. A disagreement between devices is a
 * real problem - the plugin blocks sync on it - so it is reported rather than
 * resolved by picking a winner, and configuration is the only way to override.
 */
async function resolveVaultSettings(
    config: Config,
    fetchRemote: ReturnType<typeof createRemoteReader>,
    log: Logger
): Promise<{ settings: VaultFormatSettings; salt: Uint8Array<ArrayBuffer> | undefined }> {
    const milestone = (await fetchRemote(DOCID_MILESTONE)) as MilestoneEntry | undefined;
    const { settings: published, conflicts, invalid, nodeCount } = readTweakValues(milestone);

    for (const [key, values] of Object.entries(conflicts)) {
        log.error(
            `Devices disagree on "${key}": ${values.map((v) => JSON.stringify(v)).join(", ")}. ` +
                `Set it explicitly in configuration, or resolve it in Obsidian.`
        );
    }
    for (const [key, value] of Object.entries(invalid)) {
        log.warn(`Ignoring unrecognised value for "${key}": ${JSON.stringify(value)}`);
    }

    const version = (await fetchRemote(DOCID_VERSIONING)) as { version?: number } | undefined;
    if (version?.version !== undefined && version.version !== SUPPORTED_DB_VERSION) {
        log.warn(
            `Vault schema version is ${version.version}; this was built against ` +
                `${SUPPORTED_DB_VERSION}. Reads may be wrong. Verify before trusting them.`
        );
    }

    // Configuration wins over what the vault publishes, so a vault with
    // conflicting devices can still be operated.
    const settings = resolveSettings({ ...published, ...config.formatOverrides });

    const syncParams = (await fetchRemote(DOCID_SYNC_PARAMETERS)) as { pbkdf2salt?: string } | undefined;
    const salt = syncParams?.pbkdf2salt ? decodePbkdf2Salt(syncParams.pbkdf2salt) : undefined;

    if (settings.encrypt && !settings.passphrase) {
        throw new Error(
            "This vault is encrypted but no passphrase is configured. Set E2EE_PASSPHRASE " +
                "(or E2EE_PASSPHRASE_FILE for a Docker secret)."
        );
    }

    log.info(
        `Vault format from ${nodeCount} device(s): ` +
            `encrypt=${settings.encrypt} obfuscation=${settings.usePathObfuscation} ` +
            `compression=${settings.enableCompression} hash=${settings.hashAlg} ` +
            `splitter=${settings.chunkSplitterVersion}`
    );

    return { settings, salt };
}

export interface RunningServer {
    stop(): Promise<void>;
}

export async function start(config: Config = loadConfig()): Promise<RunningServer> {
    const log = createLogger(config.logLevel);
    log.info(`Connecting to ${redactedUrl(config.couch)}`);

    const fetchRemote = createRemoteReader(config, log);
    const { settings, salt } = await resolveVaultSettings(config, fetchRemote, log);
    const transform = transformContextFor(settings, salt);

    const replicator = new Replicator({
        remoteUrl: remoteUrl(config.couch),
        replicaPath: config.replicaPath,
        transform,
        onDecodeError: (id, error) => log.error(`Could not decode "${id}": ${error.message}`),
    });

    replicator.on("status", (status) => log.debug(`Replication ${status.phase} (lag ${status.lagMs}ms)`));
    replicator.on("replication-error", (error) => log.error(`Replication error: ${String(error)}`));

    await replicator.start();
    log.info("Replicating. Waiting for the first pass to complete…");
    await replicator.waitForInitialSync();
    const docs = await replicator.refreshDocCount();
    log.info(`Initial replication complete: ${docs.toLocaleString()} documents locally.`);

    const reader = new VaultReader({ replicator, settings, fetchRemote });

    // The index is derived from the replica, so it is built after the first
    // replication pass and then follows the changes feed. Destroying it costs
    // nothing but the rebuild.
    const index = new VaultIndex(config.indexPath);
    index.open();

    // Separate from the index, and deliberately so: a transcription cannot be
    // recomputed from the vault, so it must outlive an index rebuild.
    const transcripts = new TranscriptStore(config.transcriptPath);
    transcripts.open();

    const builder = new IndexBuilder(replicator, reader, index, log, {
        extractionSizeCap: config.attachmentSizeCap,
        transcripts,
    });
    await builder.rebuild();
    builder.follow();

    const auth = createAuthWiring(config.auth, {
        onReject: (reason) => log.warn(`Rejected a request: ${reason}`),
    });

    const server = new FastMCP({
        name: "obsidian-vault",
        version: "0.1.0",
        instructions:
            "Read access to an Obsidian vault synced by Self-hosted LiveSync. Notes are addressed " +
            "by vault-relative path. Reads come from a local replica that trails the server " +
            "slightly; every response says how stale it may be, and read_note accepts fresh=true " +
            "when that matters. This server is currently read-only.",

        // `authenticate` is only consulted for the HTTP transport; on stdio the
        // transport itself is the boundary, and `createAuthWiring` returns
        // nothing to install. The OAuth block is what publishes the protected
        // resource metadata a client discovers from the 401.
        ...(auth.authenticate ? { authenticate: auth.authenticate } : {}),
        ...(auth.oauth ? { oauth: auth.oauth } : {}),

        // Used by the container healthcheck. Deliberately not authenticated,
        // and deliberately says nothing about the vault.
        health: { enabled: true, path: "/health", message: "ok", status: 200 },

        // Roots are a client telling a server which directories are in scope.
        // This server addresses notes by vault path against CouchDB, so there
        // is nothing for a root to scope, and asking costs something: FastMCP
        // sends `roots/list` whenever the client advertises the capability, and
        // a client that advertises it without answering leaves the request
        // pending until it times out, logging a stack trace per session.
        // Claude's connector does exactly that. Declining the capability is
        // honest as well as quieter: we would ignore the answer.
        roots: { enabled: false },
    });

    const toolContext = {
        replicator,
        reader,
        index,
        settings,
        readOnly: config.readOnly,
        attachmentSizeCap: config.attachmentSizeCap,
        transcripts,
    };
    registerTools(server, toolContext);
    registerAttachmentTool(server, toolContext);
    registerTranscriptionTools(server, toolContext);
    registerSearchTools(server, { index });

    // The write tools are registered only when writing is enabled, rather than
    // registered and refusing. A tool that answers "read-only mode" is a tool a
    // model will try, and the person on the other end is then left believing
    // that writing is a configuration away when it is a decision away.
    //
    // The executor is constructed here regardless of the toggle so that the
    // read-only path exercises the same wiring, and because CouchWriter refuses
    // a state-changing request before building it when it is read-only. Two
    // independent switches on the same door.
    const executor = new PlanningWriteExecutor({
        couch: new CouchWriter({ couch: config.couch, readOnly: config.readOnly }),
        replicator,
        settings,
        transform,
        readOnly: config.readOnly,
        planCeiling: config.planCeiling,
        onWarning: (message) => log.warn(message),
    });

    if (!config.readOnly) {
        registerWriteTools(server, {
            reader,
            executor,
            index,
            dailyNotePath: config.dailyNotePath,
            timeZone: config.timeZone,
        });
        registerPlanTools(server, { reader, index, executor });
        log.warn(
            `Writes are ENABLED against ${redactedUrl(config.couch)}. ` +
                `Six tools can modify this vault directly: create_note, append_note, append_daily, ` +
                `edit_note, set_properties and commit_plan. Batch property changes go through ` +
                `plan_set_properties first and write nothing until a plan is committed.`
        );
        log.info(
            `Today, for append_daily, is ${new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date())} ` +
                `in ${config.timeZone}.`
        );
    }

    if (config.transport.kind === "stdio") {
        await server.start({ transportType: "stdio" });
        log.info("Serving on stdio.");
    } else {
        await server.start({
            transportType: "httpStream",
            httpStream: { host: config.transport.host, port: config.transport.port },
        });
        log.info(`Serving on http://${config.transport.host}:${config.transport.port}/mcp`);
        log.info(auth.describe());
    }

    if (config.readOnly) {
        // Worded carefully. save_transcription is registered and does write, so
        // "no write tools" would be false; what is true, and what the setting
        // is for, is that nothing registered can modify the vault.
        log.info("Read-only mode: no tool that can modify the vault is registered.");
    }

    const orphans = transcripts.orphans(new Set(index.allPaths()));
    if (orphans.length > 0) {
        log.warn(
            `${orphans.length} stored transcription(s) do not match any file in the vault, ` +
                `probably renamed: ${orphans
                    .slice(0, 5)
                    .map((o) => o.path)
                    .join(", ")}${orphans.length > 5 ? ", …" : ""}. ` +
                `They are kept; list_untranscribed reports them.`
        );
    }

    return {
        async stop() {
            await server.stop();
            builder.stop();
            index.close();
            transcripts.close();
            await replicator.stop();
        },
    };
}
