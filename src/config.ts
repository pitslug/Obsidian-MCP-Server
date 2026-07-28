/**
 * Configuration.
 *
 * Environment variables throughout, with no config file, so nothing holding a
 * secret needs to sit on disk as a mounted file. Every sensitive value also
 * accepts a `*_FILE` form naming a file to read it from — that is how Docker
 * secrets are consumed, and it is what the deployment this targets requires.
 *
 * The E2EE passphrase, where set, means this host holds the keys to the entire
 * vault. That is inherent to the goal rather than a flaw in the design — something
 * has to decrypt the notes — but it should inform how the host is secured.
 */

import { readFileSync } from "node:fs";
import {
    ChunkAlgorithms,
    E2EEAlgorithms,
    HashAlgorithms,
    type VaultFormatSettings,
} from "./vault-model/index.js";

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * Read a value from `NAME`, or from the file named by `NAME_FILE`.
 *
 * The file form wins when both are set, and a trailing newline is stripped —
 * `echo secret > file` is how these get created, and the newline would
 * otherwise become part of the password.
 */
function env(name: string, fallback?: string): string | undefined {
    const fileVar = process.env[`${name}_FILE`];
    if (fileVar) {
        try {
            return readFileSync(fileVar, "utf8").replace(/\r?\n$/, "");
        } catch (error) {
            throw new ConfigError(
                `${name}_FILE points at "${fileVar}", which could not be read: ${(error as Error).message}`
            );
        }
    }
    return process.env[name] ?? fallback;
}

function required(name: string): string {
    const value = env(name);
    if (!value) {
        throw new ConfigError(
            `${name} is not set. Provide it as an environment variable, or as ${name}_FILE ` +
                `naming a file to read it from (for Docker secrets).`
        );
    }
    return value;
}

function bool(name: string, fallback: boolean): boolean {
    const value = env(name);
    if (value === undefined || value === "") return fallback;
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
    throw new ConfigError(`${name} must be a boolean ("true" or "false"), not "${value}".`);
}

function integer(name: string, fallback: number): number {
    const value = env(name);
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new ConfigError(`${name} must be a non-negative number, not "${value}".`);
    }
    return parsed;
}

export interface CouchConfig {
    /** Base URL, without the database name. */
    url: string;
    database: string;
    username: string | undefined;
    password: string | undefined;
}

export interface Config {
    couch: CouchConfig;
    /** Where the local PouchDB replica lives. A Docker volume in deployment. */
    replicaPath: string;
    /** Where the SQLite index will live. Both are derived and safe to destroy. */
    indexPath: string;

    /**
     * Format settings supplied by configuration. Anything not set here is read
     * from the vault's own milestone document at startup, which is the more
     * reliable source — see `readTweakValues`.
     */
    formatOverrides: Partial<VaultFormatSettings>;

    /** Disables every write tool. On by default, and on for initial rollout. */
    readOnly: boolean;
    /** Largest attachment returned to a caller, in bytes. */
    attachmentSizeCap: number;
    /** Maximum notes a single plan may touch. */
    planCeiling: number;

    transport: {
        kind: "stdio" | "http";
        host: string;
        port: number;
        /**
         * Required bearer token for the HTTP transport.
         *
         * The design calls for OAuth 2.0 with PKCE, which is what Claude's
         * custom connector flow expects; this is the interim while that is
         * unbuilt. A shared token is weaker than OAuth but far better than an
         * open endpoint, and it means the service is not relying solely on
         * whatever sits in front of it.
         */
        bearerToken: string | undefined;
    };

    logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
    const url = required("COUCHDB_URL").replace(/\/+$/, "");
    // Accept the LiveSync setup URI form, https://host/?db=name.
    const parsed = new URL(url);
    const dbFromQuery = parsed.searchParams.get("db") ?? undefined;
    parsed.search = "";

    const kind = (env("MCP_TRANSPORT", "stdio") as "stdio" | "http") ?? "stdio";
    if (kind !== "stdio" && kind !== "http") {
        throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http", not "${kind}".`);
    }

    const bearerToken = env("MCP_BEARER_TOKEN");
    if (kind === "http" && !bearerToken) {
        throw new ConfigError(
            "MCP_TRANSPORT is http but MCP_BEARER_TOKEN is not set. Refusing to expose the vault " +
                "over HTTP with no authentication of its own. Set MCP_BEARER_TOKEN (or " +
                "MCP_BEARER_TOKEN_FILE for a Docker secret)."
        );
    }

    const readOnly = bool("READ_ONLY", true);

    return {
        couch: {
            url: parsed.toString().replace(/\/+$/, ""),
            database: env("COUCHDB_DATABASE") ?? dbFromQuery ?? missingDatabase(),
            username: env("COUCHDB_USER") ?? (parsed.username || undefined),
            password: env("COUCHDB_PASSWORD") ?? (parsed.password || undefined),
        },
        replicaPath: env("REPLICA_PATH", "/data/replica") as string,
        indexPath: env("INDEX_PATH", "/data/index.sqlite") as string,
        formatOverrides: readFormatOverrides(),
        readOnly,
        attachmentSizeCap: integer("ATTACHMENT_SIZE_CAP", 25 * 1024 * 1024),
        planCeiling: integer("PLAN_CEILING", 500),
        transport: {
            kind,
            host: env("MCP_HOST", "0.0.0.0") as string,
            port: integer("MCP_PORT", 8080),
            bearerToken,
        },
        logLevel: (env("LOG_LEVEL", "info") as Config["logLevel"]) ?? "info",
    };
}

function missingDatabase(): never {
    throw new ConfigError(
        "COUCHDB_DATABASE is not set, and COUCHDB_URL carries no ?db= parameter. " +
            "One of the two must name the database."
    );
}

/**
 * Format settings from the environment.
 *
 * Only the passphrase normally needs setting; the rest are read from the vault
 * itself. They exist here as an escape hatch for a vault whose devices disagree,
 * or whose milestone document is missing.
 */
function readFormatOverrides(): Partial<VaultFormatSettings> {
    const overrides: Partial<VaultFormatSettings> = {};

    const passphrase = env("E2EE_PASSPHRASE");
    if (passphrase !== undefined) overrides.passphrase = passphrase;

    const encrypt = env("E2EE_ENABLED");
    if (encrypt !== undefined) overrides.encrypt = bool("E2EE_ENABLED", false);

    const obfuscate = env("PATH_OBFUSCATION");
    if (obfuscate !== undefined) overrides.usePathObfuscation = bool("PATH_OBFUSCATION", false);

    const hashAlg = env("HASH_ALG");
    if (hashAlg !== undefined) {
        if (!Object.values(HashAlgorithms).includes(hashAlg as never)) {
            throw new ConfigError(`HASH_ALG "${hashAlg}" is not a hash algorithm this understands.`);
        }
        overrides.hashAlg = hashAlg as VaultFormatSettings["hashAlg"];
    }

    const splitter = env("CHUNK_SPLITTER");
    if (splitter !== undefined) {
        if (!Object.values(ChunkAlgorithms).includes(splitter as never)) {
            throw new ConfigError(`CHUNK_SPLITTER "${splitter}" is not a splitter this understands.`);
        }
        overrides.chunkSplitterVersion = splitter as VaultFormatSettings["chunkSplitterVersion"];
    }

    const algorithm = env("E2EE_ALGORITHM");
    if (algorithm !== undefined) {
        if (!Object.values(E2EEAlgorithms).includes(algorithm as never)) {
            throw new ConfigError(`E2EE_ALGORITHM "${algorithm}" is not an algorithm this understands.`);
        }
        overrides.e2eeAlgorithm = algorithm as VaultFormatSettings["e2eeAlgorithm"];
    }

    return overrides;
}

/** The CouchDB URL with credentials embedded, for PouchDB's HTTP adapter. */
export function remoteUrl(couch: CouchConfig): string {
    const url = new URL(`${couch.url}/${couch.database}`);
    if (couch.username) url.username = encodeURIComponent(couch.username);
    if (couch.password) url.password = encodeURIComponent(couch.password);
    return url.toString();
}

/** The same URL with the password replaced, for logs and error messages. */
export function redactedUrl(couch: CouchConfig): string {
    const url = new URL(`${couch.url}/${couch.database}`);
    if (couch.username) url.username = encodeURIComponent(couch.username);
    if (couch.password) url.password = "***";
    return url.toString();
}
