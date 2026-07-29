/**
 * Telling a client how to authenticate, in the one way it will understand.
 *
 * An MCP client discovers everything about this server's authorization from a
 * single 401, so that response is not an error page but the entry point to the
 * whole flow. Get it wrong and the symptom is not a helpful message: it is
 * Claude reporting that it could not reach the server, with no request ever
 * arriving at the authorization server, because the client never learned where
 * to send the user.
 *
 * Three details carry that weight, and each has been a documented way to break
 * the flow:
 *
 *  - **The status must be 401.** A `WWW-Authenticate` header on a 200 is
 *    ignored. A server that answers an unauthenticated tool call with a
 *    successful response saying "you need to log in" has told the model
 *    something and the client nothing.
 *  - **`resource_metadata` must point at the metadata document.** Without it a
 *    client has to guess the well-known path, which costs round trips and only
 *    works when the host serves `/.well-known/*` at its root.
 *  - **`scope` should say what this call needed.** It is how a read-only token
 *    gets upgraded when the person asks for a write, rather than the write
 *    simply failing.
 *
 * Header values are quoted strings, so anything appearing in one is checked
 * rather than escaped. A value that cannot be represented is a configuration
 * error at startup, not a header to mangle at runtime.
 */

/** The metadata document's path, fixed by RFC 9728. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** Anything that cannot be escaped into a quoted string, built by code point. */
const CONTROL_CHARACTERS = new RegExp(
    `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}]`
);

export interface ChallengeOptions {
    /** Absolute URL of the protected resource metadata document. */
    resourceMetadata: string;
    /** Scopes that would satisfy the request that was refused. */
    scope?: readonly string[];
    /** An OAuth error code, where one applies. */
    error?: "invalid_token" | "invalid_request" | "insufficient_scope";
    /** Something a person could act on. */
    description?: string;
}

/**
 * Build a `WWW-Authenticate` value.
 *
 * Parameters are emitted in the order RFC 6750 uses in its own examples. Order
 * is not significant to a parser, but it makes two challenges from this server
 * comparable by eye in a log, which is most of what reading these is for.
 */
export function challengeHeader(options: ChallengeOptions): string {
    const parameters: [string, string][] = [];
    if (options.error) parameters.push(["error", options.error]);
    if (options.description) parameters.push(["error_description", options.description]);
    if (options.scope && options.scope.length > 0) parameters.push(["scope", options.scope.join(" ")]);
    parameters.push(["resource_metadata", options.resourceMetadata]);

    return `Bearer ${parameters.map(([key, value]) => `${key}="${quotable(value)}"`).join(", ")}`;
}

/**
 * A 401 that starts the authorization flow.
 *
 * The body is plain text and says nothing about the vault. Whoever is reading
 * it has not proved they are allowed to know that this vault exists, let alone
 * what is in it.
 */
export function unauthorized(options: ChallengeOptions): Response {
    return new Response(options.description ?? "Unauthorized", {
        status: 401,
        headers: {
            "www-authenticate": challengeHeader(options),
            "content-type": "text/plain; charset=utf-8",
        },
    });
}

/**
 * A 403 asking for more scope than the presented token carries.
 *
 * Distinct from a 401 on purpose. A 401 says the token is no good and the
 * client should get one; a 403 says the token is fine and simply does not
 * authorize this, which a client answers by asking for more rather than by
 * starting again. Collapsing the two into a 401 sends a client round the
 * authorization loop to obtain exactly the token it already had.
 */
export function insufficientScope(options: ChallengeOptions & { scope: readonly string[] }): Response {
    return new Response(options.description ?? "Forbidden", {
        status: 403,
        headers: {
            "www-authenticate": challengeHeader({ ...options, error: "insufficient_scope" }),
            "content-type": "text/plain; charset=utf-8",
        },
    });
}

/**
 * Make a value safe inside a quoted header parameter.
 *
 * Quotes and backslashes are escaped rather than refused. An earlier version
 * threw on them, on the reasoning that every value here comes from
 * configuration and a quote in one means a setting is wrong. That was true of
 * the URLs and the scope names and false of `error_description`, which is
 * English prose that names scopes in quotes. The throw then escaped from inside
 * the authentication hook, the transport caught it, and the client received a
 * challenge the transport had invented: a different error code, a different
 * metadata URL, and this function's exception as the description. A malformed
 * challenge is worse than an ugly one, and an authentication path that can
 * throw while explaining why it refused is a path that will.
 *
 * Control characters are still refused, because they cannot be escaped into a
 * quoted string at all and a header split across lines is a response-splitting
 * bug rather than a formatting one.
 */
function quotable(value: string): string {
    if (CONTROL_CHARACTERS.test(value)) {
        throw new Error(
            `Cannot put ${JSON.stringify(value)} in a WWW-Authenticate header: it contains a ` +
                `control character. Check the configured issuer, resource URL and scope names.`
        );
    }
    return value.replace(/[\\"]/g, (character) => `\\${character}`);
}
