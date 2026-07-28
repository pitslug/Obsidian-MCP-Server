/**
 * The plumbing shared by everything that speaks HTTP to CouchDB.
 *
 * Only the pieces that are the same whichever direction the request goes: how
 * a document ID becomes a URL path segment, and how credentials become a
 * header. The rule that only one unit may issue a state-changing request lives
 * a level up, in `src/write/couch.ts`; nothing here sends anything.
 *
 * Credentials are carried in an `Authorization` header rather than in the URL.
 * That is not a style preference. A URL with a password in it ends up in error
 * messages, logs and stack traces the moment anything goes wrong, and the
 * places that would need to redact it are exactly the places written in a
 * hurry. Keeping the URL clean means it is safe to print by construction.
 */

import type { CouchConfig } from "../config.js";

export interface CouchEndpoint {
    /** Base URL including the database name, and carrying no credentials. */
    databaseUrl: string;
    /** Ready-made `Authorization` header value, or undefined for an open database. */
    authHeader: string | undefined;
}

export function endpointFor(couch: CouchConfig): CouchEndpoint {
    const url = new URL(`${couch.url}/${couch.database}`);
    url.username = "";
    url.password = "";
    url.search = "";

    const authHeader = couch.username
        ? "Basic " + Buffer.from(`${couch.username}:${couch.password ?? ""}`).toString("base64")
        : undefined;

    return { databaseUrl: url.toString().replace(/\/+$/, ""), authHeader };
}

/**
 * Encode a document ID as a URL path segment.
 *
 * `_local/` and `_design/` are literal path segments in CouchDB's API, so the
 * slash that follows them must survive; every other slash in an ID is part of
 * the ID and must not. Getting this backwards produces a 404 on a document
 * that exists, which reads as "the note is gone" rather than "the URL was
 * built wrong".
 */
export function encodeDocumentId(id: string): string {
    if (/^(_local|_design)\//.test(id)) {
        return id.replace(
            /^([^/]+)\/(.*)$/,
            (_match, prefix, rest) => `${prefix}/${encodeURIComponent(rest)}`
        );
    }
    return encodeURIComponent(id);
}

/** The URL of a single document, with optional query parameters. */
export function documentUrl(endpoint: CouchEndpoint, id: string, query: Record<string, string> = {}): URL {
    const url = new URL(endpoint.databaseUrl);
    url.pathname = `${url.pathname}/${encodeDocumentId(id)}`;
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
}

/** The URL of a database-level endpoint such as `_bulk_docs`. */
export function databaseUrl(endpoint: CouchEndpoint, suffix: string): URL {
    const url = new URL(endpoint.databaseUrl);
    url.pathname = `${url.pathname}/${suffix}`;
    return url;
}

/** Request headers, with the auth header added when there is one. */
export function headersFor(endpoint: CouchEndpoint, extra: Record<string, string> = {}): HeadersInit {
    return {
        Accept: "application/json",
        ...extra,
        ...(endpoint.authHeader ? { Authorization: endpoint.authHeader } : {}),
    };
}
