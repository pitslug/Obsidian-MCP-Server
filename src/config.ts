/**
 * Configuration.
 *
 * Environment variables throughout, with no config file, so nothing holding a
 * secret needs to sit on disk as a mounted file. Every sensitive value also
 * accepts a `*_FILE` form naming a file to read it from - that is how Docker
 * secrets are consumed, and it is what the deployment this targets requires.
 *
 * The E2EE passphrase, where set, means this host holds the keys to the entire
 * vault. That is inherent to the goal rather than a flaw in the design - something
 * has to decrypt the notes - but it should inform how the host is secured.
 */

import { readFileSync } from "node:fs";
import {
    ChunkAlgorithms,
    E2EEAlgorithms,
    HashAlgorithms,
    type VaultFormatSettings,
} from "./vault-model/index.js";
import { hostTimeZone, templateIsComplete } from "./note/daily.js";

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * Read a value from `NAME`, or from the file named by `NAME_FILE`.
 *
 * The file form wins when both are set, and a trailing newline is stripped - * `echo secret > file` is how these get created, and the newline would
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
     * Where transcriptions live.
     *
     * Deliberately a separate file from the index: a transcription cannot be
     * recomputed from anything, so it must survive an index rebuild.
     */
    transcriptPath: string;

    /**
     * Format settings supplied by configuration. Anything not set here is read
     * from the vault's own milestone document at startup, which is the more
     * reliable source - see `readTweakValues`.
     */
    formatOverrides: Partial<VaultFormatSettings>;

    /** Disables every write tool. On by default, and on for initial rollout. */
    readOnly: boolean;
    /** Largest attachment returned to a caller, in bytes. */
    attachmentSizeCap: number;
    /** Maximum notes a single plan may touch. */
    planCeiling: number;

    /**
     * Path template for the daily note, e.g. `daily/YYYY-MM-DD.md`.
     *
     * Left unset, the format is inferred from the dated filenames already in
     * the vault, which is usually right and is always reported. Obsidian keeps
     * the real setting in `.obsidian/`, a hidden file this vault does not sync,
     * so there is nothing authoritative to read and this is the override for
     * when the inference has nothing to work from or picks the wrong folder.
     */
    dailyNotePath: string | undefined;

    /**
     * The zone whose civil date "today" means.
     *
     * Defaults to the host's zone, which is right on a laptop and wrong in a
     * container, where it is UTC. Ten hours separate UTC from the vault owner,
     * so an unset value in deployment files every evening's capture under the
     * previous day.
     */
    timeZone: string;

    /**
     * How the HTTP transport decides who is calling.
     *
     * A union rather than a bag of optional fields, because the three modes
     * need disjoint settings and "OAuth issuer set but shared token also set"
     * is not a state worth being able to represent. Ignored entirely on stdio,
     * where the transport itself is the boundary.
     */
    auth: AuthConfig;

    transport: {
        kind: "stdio" | "http";
        host: string;
        port: number;
    };

    logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * How callers authenticate over HTTP.
 *
 * `oauth` is what Claude's custom connector flow expects and the only mode that
 * can tell one caller from another. `bearer` is a shared secret: it keeps the
 * endpoint from being open, and that is the whole of what it does. `none` exists
 * for a server reachable only from a place that has already decided who may
 * talk to it, and has to be asked for by name.
 */
export type AuthConfig =
    | { mode: "none" }
    | { mode: "bearer"; token: string }
    | {
          mode: "oauth";
          /** The authorization server's issuer identifier. */
          issuer: string;
          /**
           * This server's canonical URI, and the audience a token must name.
           *
           * The single most important value in this file. It is what the client
           * sends as the RFC 8707 `resource` parameter, what the authorization
           * server stamps into the token, and what this server checks. All
           * three have to agree exactly, so it is configured rather than
           * derived: guessing it from a request's Host header would let
           * whoever controls that header choose the audience being checked.
           */
          resource: string;
          /** Where the signing keys are, when the issuer publishes no discovery document. */
          jwksUri: string | undefined;
      };

/**
 * Read the auth mode, and refuse a half-configured one.
 *
 * Every failure here is at startup with a message naming the variable, because
 * the alternative is a server that starts, looks healthy, and is either open to
 * the world or unable to authenticate anyone.
 */
function authConfig(transportKind: "stdio" | "http"): AuthConfig {
    const declared = env("AUTH_MODE");
    const issuer = env("OAUTH_ISSUER");
    const token = env("MCP_BEARER_TOKEN");

    // Inferred only when unambiguous. An operator who set both an issuer and a
    // token has two things in mind and should say which one wins.
    const mode = declared ?? (issuer ? "oauth" : token ? "bearer" : undefined);

    if (declared === undefined && issuer && token) {
        throw new ConfigError(
            `Both OAUTH_ISSUER and MCP_BEARER_TOKEN are set, so it is not clear which should apply. ` +
                `Set AUTH_MODE to "oauth" or "bearer".`
        );
    }

    if (transportKind === "stdio") return { mode: "none" };

    switch (mode) {
        case "none":
            return { mode: "none" };

        case "bearer":
            if (!token) {
                throw new ConfigError(
                    `AUTH_MODE is "bearer" but MCP_BEARER_TOKEN is not set. Set it, or ` +
                        `MCP_BEARER_TOKEN_FILE naming a file to read it from.`
                );
            }
            return { mode: "bearer", token };

        case "oauth": {
            if (!issuer) {
                throw new ConfigError(
                    `AUTH_MODE is "oauth" but OAUTH_ISSUER is not set. It is the authorization ` +
                        `server's issuer identifier, for example https://auth.example.com.`
                );
            }
            const resource = env("MCP_PUBLIC_URL");
            if (!resource) {
                throw new ConfigError(
                    `AUTH_MODE is "oauth" but MCP_PUBLIC_URL is not set. It must be this server's ` +
                        `public URL exactly as a client will address it, including the path, for ` +
                        `example https://obsidian-mcp.example.com/mcp. Tokens are accepted only ` +
                        `when they name it as their audience, so a wrong value rejects everything.`
                );
            }
            return {
                mode: "oauth",
                issuer: absoluteUrl("OAUTH_ISSUER", issuer).replace(/\/+$/, ""),
                resource: absoluteUrl("MCP_PUBLIC_URL", resource).replace(/\/+$/, ""),
                jwksUri: env("OAUTH_JWKS_URI"),
            };
        }

        case undefined:
            throw new ConfigError(
                `MCP_TRANSPORT is http but nothing says how callers should authenticate. Set ` +
                    `OAUTH_ISSUER for OAuth, or MCP_BEARER_TOKEN for a shared token. Refusing to ` +
                    `expose the vault over HTTP with no authentication of its own; if that is ` +
                    `genuinely what you want, say so with AUTH_MODE=none.`
            );

        default:
            throw new ConfigError(`AUTH_MODE must be "oauth", "bearer" or "none", not "${mode}".`);
    }
}

/**
 * A URL that is absolute, https, and carries no fragment or query.
 *
 * Checked because these values are compared as strings against what an
 * authorization server puts in a token. A value that merely looks like a URL
 * fails that comparison every time, and the failure appears as "every token is
 * rejected" rather than as anything pointing at this setting.
 */
function absoluteUrl(name: string, value: string): string {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new ConfigError(`${name} is "${value}", which is not an absolute URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        throw new ConfigError(
            `${name} is "${value}". It must use https, since a bearer token sent over http is ` +
                `readable by anything on the path.`
        );
    }
    if (parsed.hash || parsed.search) {
        throw new ConfigError(
            `${name} is "${value}". A resource identifier carries no query string or fragment; ` +
                `RFC 8707 requires the bare URL.`
        );
    }
    return value;
}

/**
 * The daily note override, checked at startup rather than at first use.
 *
 * A template missing its day is not a daily note template, and left unchecked
 * it would resolve to the same path every day and quietly append a month of
 * captures into one note. Failing at startup means it is found by whoever set
 * it, while they are still looking at it.
 */
function dailyNotePath(): string | undefined {
    const template = env("DAILY_NOTE_PATH");
    if (template === undefined) return undefined;
    if (!templateIsComplete(template)) {
        throw new ConfigError(
            `DAILY_NOTE_PATH is "${template}", which does not name a single day. It needs a year, ` +
                `a month and a day: YYYY, MM (or MMM/MMMM) and DD. For example "daily/YYYY-MM-DD.md".`
        );
    }
    if (!template.toLowerCase().endsWith(".md")) {
        throw new ConfigError(`DAILY_NOTE_PATH is "${template}", which does not end in .md.`);
    }
    return template;
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

    const auth = authConfig(kind);
    const readOnly = bool("READ_ONLY", true);

    return {
        couch: {
            url: parsed.toString().replace(/\/+$/, ""),
            database: env("COUCHDB_DATABASE") ?? dbFromQuery ?? missingDatabase(),
            // Credentials taken out of the URL arrive percent-encoded; ones
            // from their own variables are literal. Decoding here means
            // everything downstream holds the real value, and each consumer
            // encodes it the one way its own transport needs. Getting this
            // wrong is not subtle in the good case (a password with a `@` in
            // it produces 401 everywhere) and is silent in the bad one, where
            // two consumers disagree and only some requests fail.
            username: env("COUCHDB_USER") ?? decodeComponent(parsed.username),
            password: env("COUCHDB_PASSWORD") ?? decodeComponent(parsed.password),
        },
        replicaPath: env("REPLICA_PATH", "/data/replica") as string,
        indexPath: env("INDEX_PATH", "/data/index.sqlite") as string,
        transcriptPath: env("TRANSCRIPT_PATH", "/data/transcripts.sqlite") as string,
        formatOverrides: readFormatOverrides(),
        readOnly,
        attachmentSizeCap: integer("ATTACHMENT_SIZE_CAP", 25 * 1024 * 1024),
        planCeiling: integer("PLAN_CEILING", 500),
        dailyNotePath: dailyNotePath(),
        timeZone: env("VAULT_TIMEZONE") ?? hostTimeZone(),
        auth,
        transport: {
            kind,
            host: env("MCP_HOST", "0.0.0.0") as string,
            port: integer("MCP_PORT", 8080),
        },
        logLevel: (env("LOG_LEVEL", "info") as Config["logLevel"]) ?? "info",
    };
}

/**
 * Percent-decode a URL credential, tolerating one that is not encoded.
 *
 * A stray `%` in a password is a malformed escape sequence to
 * `decodeURIComponent`, which throws. Taking the value verbatim in that case is
 * better than refusing to start.
 */
function decodeComponent(value: string): string | undefined {
    if (!value) return undefined;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
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
