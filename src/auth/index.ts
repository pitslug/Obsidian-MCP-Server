/**
 * The authentication layer, assembled.
 *
 * Everything the transport needs to decide who is calling, built from one
 * configuration value so that the three modes cannot be half-applied. The
 * server wires in whatever this returns and does not branch on the mode itself:
 * a mode handled in two places is a mode that will eventually be handled
 * differently in each.
 */

import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthConfig } from "../config.js";
import { PROTECTED_RESOURCE_PATH, insufficientScope, unauthorized } from "./challenge.js";
import { SCOPE_READ, SUPPORTED_SCOPES, type SessionAuth } from "./scopes.js";
import { TokenRejectedError, TokenVerifier, bearerFrom } from "./tokens.js";

export * from "./challenge.js";
export * from "./scopes.js";
export * from "./tokens.js";

/** What the server needs from this module, in the shape FastMCP wants it. */
export interface AuthWiring {
    /** Consulted per HTTP request. Absent when nothing is checked. */
    authenticate?: (request: IncomingMessage) => Promise<SessionAuth>;
    /** Discovery metadata FastMCP publishes for us. Absent unless using OAuth. */
    oauth?: {
        enabled: boolean;
        protectedResource: {
            resource: string;
            authorizationServers: string[];
            scopesSupported: string[];
            bearerMethodsSupported: string[];
        };
    };
    /** One line for the startup log, so the running mode is never a guess. */
    describe(): string;
}

export interface AuthWiringOptions {
    /** Injectable for tests, which reach a fake issuer rather than the network. */
    fetchImpl?: typeof fetch;
    onReject?: (reason: string) => void;
    /**
     * Whether any registered tool can change the vault.
     *
     * This decides which scopes the server asks a client to obtain, and it has
     * to, because the client only ever asks once. A connecting client reads the
     * `scope` on the 401 challenge and requests exactly that; there is no
     * second prompt when it later calls a tool that needs more, because the
     * tool-level refusal is a tool result rather than another challenge.
     *
     * So a server that names only `vault:read` on the challenge gets a
     * read-only token forever, however the authorization server is configured,
     * and every write tool refuses for want of a scope nobody was ever asked
     * for. That is not hypothetical: it is what happened on 30 July 2026, and
     * from the outside it looks like a Pocket-ID misconfiguration.
     */
    writeEnabled?: boolean;
}

export function createAuthWiring(auth: AuthConfig, options: AuthWiringOptions = {}): AuthWiring {
    const reject = options.onReject ?? (() => undefined);

    // What this deployment can actually use, which is what a client should be
    // asking its authorization server for. Narrowed when writes are off, for
    // the same reason the tools are absent then: advertising a permission that
    // no registered tool could exercise is a request for access this server has
    // no use for.
    const offered: string[] = options.writeEnabled ? [...SUPPORTED_SCOPES] : [SCOPE_READ];

    if (auth.mode === "none") {
        return {
            describe: () =>
                "Callers are not authenticated by this server. Whatever sits in front of it is the " +
                "only thing deciding who may reach the vault.",
        };
    }

    if (auth.mode === "bearer") {
        return {
            authenticate: async (request) => {
                const presented = request.headers.authorization;
                const expected = `Bearer ${auth.token}`;
                // Constant time: a naive comparison leaks the token's prefix to
                // anyone able to time the responses.
                if (!presented || !timingSafeEqual(presented, expected)) {
                    reject("presented no valid shared token");
                    throw new Response("Unauthorized", {
                        status: 401,
                        headers: { "www-authenticate": "Bearer" },
                    });
                }
                // No scopes: a shared token has no finer grain than holding it,
                // and an empty set would read as a token granted nothing.
                return {};
            },
            describe: () =>
                "Callers authenticate with a shared bearer token. Every caller holding it is the " +
                "same caller as far as this server can tell.",
        };
    }

    const verifier = new TokenVerifier({
        issuer: auth.issuer,
        resource: auth.resource,
        ...(auth.jwksUri ? { jwksUri: auth.jwksUri } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    // Absolute, because a client reads it out of a header and fetches it
    // directly. The path is fixed by RFC 9728 and appended to the origin: the
    // resource URL may carry a path, and the document does not live under it.
    const resourceMetadata = new URL(PROTECTED_RESOURCE_PATH, auth.resource).toString();

    return {
        authenticate: async (request) => {
            let token: string | undefined;
            try {
                token = bearerFrom(request.headers.authorization);
            } catch (error) {
                const rejected = error as TokenRejectedError;
                reject(rejected.detail);
                throw unauthorized({
                    resourceMetadata,
                    error: rejected.code,
                    description: rejected.detail,
                    scope: offered,
                });
            }

            if (!token) {
                // The ordinary first request of a session, not a failure. It is
                // answered rather than logged as a rejection, because a client
                // that has never been told where to authenticate cannot have
                // done anything else.
                throw unauthorized({ resourceMetadata, scope: offered });
            }

            let principal;
            try {
                principal = await verifier.verify(token);
            } catch (error) {
                if (error instanceof TokenRejectedError) {
                    reject(error.detail);
                    throw unauthorized({
                        resourceMetadata,
                        error: error.code,
                        description: error.detail,
                        scope: offered,
                    });
                }
                // Discovery failed, or the keys could not be fetched. That is
                // this server's problem rather than the caller's, and saying
                // "invalid token" would send them to re-authenticate over and
                // over against a service that is not going to accept anything.
                reject(`could not verify a token: ${(error as Error).message}`);
                throw new Response("The authorization server could not be reached.", { status: 503 });
            }

            // Read is the floor. A token carrying neither scope authenticates
            // somebody but authorizes nothing, and answering that with a 403
            // naming the scope is what lets a client ask for more rather than
            // conclude the server is broken.
            if (!principal.scopes.has(SCOPE_READ)) {
                reject(`subject ${principal.subject} holds no ${SCOPE_READ} scope`);
                throw insufficientScope({
                    resourceMetadata,
                    scope: offered,
                    description:
                        `This token grants none of the permissions this server needs. It must carry ` +
                        `at least "${SCOPE_READ}".`,
                });
            }

            return { subject: principal.subject, scopes: principal.scopes };
        },

        oauth: {
            enabled: true,
            protectedResource: {
                resource: auth.resource,
                authorizationServers: [auth.issuer],
                scopesSupported: offered,
                // Header only. A token in a query string ends up in the access
                // log of every proxy on the path, and this server sits behind
                // one that logs.
                bearerMethodsSupported: ["header"],
            },
        },

        describe: () =>
            `Callers authenticate with OAuth 2.1 against ${auth.issuer}. Tokens are accepted only ` +
            `when they name ${auth.resource} as their audience.`,
    };
}

/** Constant-time string comparison, tolerant of unequal lengths. */
function timingSafeEqual(a: string, b: string): boolean {
    const left = new Uint8Array(Buffer.from(a));
    const right = new Uint8Array(Buffer.from(b));
    if (left.length !== right.length) {
        // Still do the work, so the reject path costs the same either way.
        nodeTimingSafeEqual(left, left);
        return false;
    }
    return nodeTimingSafeEqual(left, right);
}
