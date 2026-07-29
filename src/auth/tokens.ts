/**
 * Verifying an access token issued by the vault's authorization server.
 *
 * The MCP authorization specification makes this server a *resource server* and
 * nothing else. It does not log anyone in, it does not issue tokens, and it does
 * not know how the person at the other end proved who they were. It receives a
 * bearer token and has to answer one question about it: was this token minted
 * for me, by the authority I trust, and is it still valid.
 *
 * ## The audience check is the point
 *
 * Everything else here is table stakes; the audience check is the control that
 * matters, and it is the one easiest to leave out because everything works
 * without it.
 *
 * The authorization server issues tokens to many clients. On the vault owner's
 * network that same Pocket-ID instance signs tokens for the photo library, the
 * recipe manager, the container dashboard. All of them are signed by the same
 * key and carry the same issuer. If this server checked only the signature and
 * the issuer, then any token any of those applications holds would open the
 * vault, and a token leaked from the least careful of them would be a key to
 * the most sensitive thing on the network. That is the confused deputy problem,
 * and it is not hypothetical: it is the default outcome of the obvious
 * implementation.
 *
 * So a token is accepted only if its `aud` names *this* resource. Pocket-ID
 * populates that from the RFC 8707 `resource` parameter, which the MCP
 * specification requires clients to send and Claude always does, against an API
 * registered in its admin interface. A token issued for anything else is
 * rejected with `invalid_token` even though it verifies perfectly.
 *
 * ## Scopes
 *
 * Granted scopes arrive in `scope` (space delimited, RFC 8693) or `scp` (an
 * array). Pocket-ID emits both. They are read here and enforced at the tool
 * boundary rather than here, because which scope a call needs depends on the
 * call, and a token good enough to read is not good enough to write.
 *
 * ## What is deliberately not cached
 *
 * Verification results are not cached against the token string. A cache keyed
 * on a bearer token is a second, weaker copy of the authorization decision that
 * outlives revocation, and the verification itself is a signature check against
 * a key already in memory. The JWKS is cached, by `jose`, because that is a
 * network fetch and rotation is handled by refetching on an unknown key ID.
 */

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/** What a verified token tells us. */
export interface Principal {
    /** The subject the authorization server identified. */
    subject: string;
    /** Scopes actually granted, which may be fewer than were asked for. */
    scopes: ReadonlySet<string>;
    /** Seconds since the epoch, as the token states it. */
    expiresAt: number | undefined;
    /** The client the token was issued to, where the server says so. */
    clientId: string | undefined;
}

/**
 * A token that will not be accepted, and the OAuth error code that says why.
 *
 * The code is not decoration. RFC 6750 defines what a client should do with
 * each: `invalid_token` means get a new one, which is a flow the user can
 * complete, while a malformed request is not. Reporting the wrong one sends
 * a client into a retry loop that cannot succeed.
 */
export class TokenRejectedError extends Error {
    constructor(
        readonly code: "invalid_token" | "invalid_request",
        readonly detail: string
    ) {
        super(detail);
        this.name = "TokenRejectedError";
    }
}

export interface TokenVerifierOptions {
    /** The authorization server's issuer identifier, exactly as it states it. */
    issuer: string;
    /** This server's canonical URI. A token must name it in `aud`. */
    resource: string;
    /** Where the signing keys live. Discovered from the issuer when absent. */
    jwksUri?: string;
    /** Injectable for tests, which have no network. */
    fetchImpl?: typeof fetch;
}

/**
 * Pulls a bearer token out of an Authorization header.
 *
 * Returns undefined for a missing header and throws for a malformed one. The
 * difference matters to the caller: no header is the ordinary first request of
 * a session and deserves a plain challenge, while a header that is present and
 * wrong is a client doing something specific and incorrect.
 */
export function bearerFrom(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
    if (!match) {
        throw new TokenRejectedError(
            "invalid_request",
            `The Authorization header is not a Bearer credential. Send "Authorization: Bearer <token>".`
        );
    }
    return match[1];
}

export class TokenVerifier {
    private keys: JWTVerifyGetKey | undefined;
    private discovering: Promise<JWTVerifyGetKey> | undefined;

    constructor(private readonly options: TokenVerifierOptions) {}

    /**
     * Verify a token, or explain why it cannot be accepted.
     *
     * Order matters only for the quality of the message: `jose` checks the
     * signature, expiry and issuer together, and the audience is checked
     * afterwards so that a token which is genuinely valid but issued for a
     * different service says so rather than reporting as unverifiable.
     */
    async verify(token: string): Promise<Principal> {
        const keys = await this.keySet();

        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(token, keys, {
                issuer: this.options.issuer,
                // Clock skew between two containers on one host is not a real
                // problem, but a small tolerance costs nothing and turns a
                // confusing intermittent failure into no failure at all.
                clockTolerance: 60,
            }));
        } catch (error) {
            throw new TokenRejectedError("invalid_token", describe(error));
        }

        if (!audienceIncludes(payload.aud, this.options.resource)) {
            throw new TokenRejectedError(
                "invalid_token",
                `This token was not issued for ${this.options.resource}. It names ` +
                    `${payload.aud === undefined ? "no audience" : JSON.stringify(payload.aud)}. ` +
                    `A token issued for another service is not accepted here, however valid it is there.`
            );
        }

        if (typeof payload.sub !== "string" || payload.sub.length === 0) {
            throw new TokenRejectedError("invalid_token", `This token identifies no subject.`);
        }

        return {
            subject: payload.sub,
            scopes: scopesFrom(payload),
            expiresAt: typeof payload.exp === "number" ? payload.exp : undefined,
            clientId: typeof payload.client_id === "string" ? payload.client_id : undefined,
        };
    }

    /**
     * The signing keys, discovered once and then reused.
     *
     * Discovery is lazy rather than done at startup. The alternative is a
     * container that refuses to start while the identity provider is
     * restarting, which turns a thirty second outage of one service into a
     * manual intervention on another.
     *
     * Concurrent first requests share one discovery, and a failure clears the
     * attempt so the next request tries again instead of caching the error.
     */
    private async keySet(): Promise<JWTVerifyGetKey> {
        if (this.keys) return this.keys;
        if (!this.discovering) {
            this.discovering = this.discover()
                .then((keys) => {
                    this.keys = keys;
                    return keys;
                })
                .finally(() => {
                    this.discovering = undefined;
                });
        }
        return this.discovering;
    }

    private async discover(): Promise<JWTVerifyGetKey> {
        const uri = this.options.jwksUri ?? (await this.discoverJwksUri());
        return createRemoteJWKSet(new URL(uri), {
            // Refetch when a token arrives signed by a key id we have not seen,
            // which is how key rotation presents. Rate limited by jose so a
            // stream of bogus key ids cannot be turned into a request flood
            // against the identity provider.
            cooldownDuration: 30_000,
            cacheMaxAge: 10 * 60_000,
            ...(this.options.fetchImpl ? { [customFetch]: this.options.fetchImpl } : {}),
        });
    }

    /**
     * Ask the issuer where its keys are, rather than assuming a path.
     *
     * OpenID Connect Discovery is tried first and OAuth 2.0 Authorization
     * Server Metadata second, because the vault's provider serves the former
     * and the specification requires clients to support both. Guessing
     * `/.well-known/jwks.json` would work against exactly one implementation.
     */
    private async discoverJwksUri(): Promise<string> {
        const fetcher = this.options.fetchImpl ?? fetch;
        const base = this.options.issuer.replace(/\/+$/, "");
        const candidates = [
            `${base}/.well-known/openid-configuration`,
            `${base}/.well-known/oauth-authorization-server`,
        ];

        const failures: string[] = [];
        for (const url of candidates) {
            try {
                const response = await fetcher(url, { headers: { accept: "application/json" } });
                if (!response.ok) {
                    failures.push(`${url} answered ${response.status}`);
                    continue;
                }
                const document = (await response.json()) as { jwks_uri?: unknown; issuer?: unknown };

                // A metadata document claiming a different issuer is either a
                // misconfiguration or someone else's server. Either way the
                // keys in it are not the keys for these tokens.
                if (typeof document.issuer === "string" && document.issuer.replace(/\/+$/, "") !== base) {
                    failures.push(`${url} identifies itself as "${document.issuer}"`);
                    continue;
                }
                if (typeof document.jwks_uri === "string") return document.jwks_uri;
                failures.push(`${url} has no jwks_uri`);
            } catch (error) {
                failures.push(`${url}: ${(error as Error).message}`);
            }
        }

        throw new Error(
            `Could not find the signing keys for "${this.options.issuer}". Tried: ${failures.join("; ")}. ` +
                `Set OAUTH_JWKS_URI to name them directly if the issuer publishes no discovery document.`
        );
    }
}

/**
 * Whether an audience claim names this resource.
 *
 * `aud` is a string or an array of strings, and comparison is exact. No
 * trailing-slash forgiveness, no prefix matching: the canonical URI is a
 * configured value on both sides, and a comparison that is lenient about how a
 * URL is written is a comparison that can be talked into accepting a URL that
 * merely resembles this one.
 */
function audienceIncludes(aud: JWTPayload["aud"], resource: string): boolean {
    if (typeof aud === "string") return aud === resource;
    if (Array.isArray(aud)) return aud.includes(resource);
    return false;
}

/** Granted scopes, from whichever claim the authorization server used. */
function scopesFrom(payload: JWTPayload): ReadonlySet<string> {
    const scopes = new Set<string>();

    const scope = payload.scope;
    if (typeof scope === "string") {
        for (const entry of scope.split(/\s+/)) if (entry) scopes.add(entry);
    }

    const scp = payload.scp;
    if (Array.isArray(scp)) {
        for (const entry of scp) if (typeof entry === "string" && entry) scopes.add(entry);
    } else if (typeof scp === "string") {
        for (const entry of scp.split(/\s+/)) if (entry) scopes.add(entry);
    }

    return scopes;
}

/**
 * A verification failure in terms the person reading the log can act on.
 *
 * `jose` uses stable error codes, and mapping the three that have an
 * operational cause is worth more than the underlying message, which describes
 * the cryptography rather than the situation.
 */
function describe(error: unknown): string {
    const code = (error as { code?: string }).code;
    switch (code) {
        case "ERR_JWT_EXPIRED":
            return "This token has expired. Refresh it and try again.";
        case "ERR_JWT_CLAIM_VALIDATION_FAILED":
            return `This token was not issued by the expected authorization server.`;
        case "ERR_JWKS_NO_MATCHING_KEY":
        case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
            // Two codes, one situation. Which one arrives depends on whether
            // the token names a key id the issuer does not publish, or names
            // none and fails against the key that was tried. Both mean the
            // signature does not come from the trusted authority, and a
            // message distinguishing them would describe the token's headers
            // rather than the problem.
            return (
                `This token is not signed by a key the authorization server publishes. ` +
                `Either it came from somewhere else, or its signing key was rotated out.`
            );
        default:
            return `This token could not be verified: ${(error as Error).message}`;
    }
}
