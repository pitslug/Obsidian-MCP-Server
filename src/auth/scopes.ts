/**
 * What a caller is allowed to do, checked where the doing happens.
 *
 * The server already had two ways to stop a write: `READ_ONLY`, and the fact
 * that the write tools are not registered when it is on. Both are properties of
 * the deployment. Neither can express "this connection may read the vault but
 * not change it", because both are decided before any connection exists.
 *
 * Scopes are the per-connection version of the same question, and they are
 * worth having precisely because they are granted by someone else. The
 * authorization server decides what a token carries; this server only reads it.
 * So a connection can be given read access to the vault while writes stay off
 * for it, without redeploying anything and without trusting the client to
 * restrain itself.
 *
 * ## Checked per call, not at registration
 *
 * The tools are registered once, when the server starts, and the token arrives
 * per session. Registering the write tools only for callers holding
 * `vault:write` would mean deciding at the wrong time. So every write tool
 * checks the scope of the session making the call.
 *
 * The consequence is that a read-only caller sees the write tools listed and is
 * refused when it uses one. That is the opposite of the choice made for
 * `READ_ONLY`, where the tools are absent rather than present and failing, and
 * the difference is deliberate: `READ_ONLY` is a permanent property of the
 * deployment, where advertising a tool that can never work is a lie, while an
 * insufficient scope is a temporary property of one connection that the client
 * can fix by asking for more. The specification has a response that says
 * exactly that, and it only makes sense if the tool was offered.
 */

/** Reading notes, attachments, the index: everything that does not change the vault. */
export const SCOPE_READ = "vault:read";

/** Anything that writes to the vault, including committing a plan. */
export const SCOPE_WRITE = "vault:write";

/** Every scope this server understands, for the metadata document. */
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/**
 * What a session is allowed to do.
 *
 * `undefined` scopes mean no scope check applies, which is the case when the
 * server is running without OAuth: on stdio the transport is the boundary, and
 * with a shared bearer token there is nothing finer than "holds the token".
 * Modelled explicitly rather than as an empty set, because an empty set is what
 * a token with no scopes at all looks like and that must be refused.
 */
export interface SessionAuth {
    [key: string]: unknown;
    subject?: string;
    scopes?: ReadonlySet<string>;
}

export class MissingScopeError extends Error {
    constructor(readonly required: string) {
        super(
            `This connection is not authorized to ${required === SCOPE_WRITE ? "change" : "read"} the vault. ` +
                `It needs the "${required}" scope, which was not granted to the token it is using. ` +
                `Reconnect and approve that permission, or grant it to this client in the ` +
                `authorization server.`
        );
        this.name = "MissingScopeError";
    }
}

/**
 * Whether a session may do something, or why not.
 *
 * A session with no scope information passes: that is the un-scoped deployment
 * described above, not a token that was granted nothing. The distinction is the
 * whole reason `scopes` is optional rather than defaulted.
 */
export function requireScope(session: SessionAuth | undefined, required: string): void {
    const scopes = session?.scopes;
    if (scopes === undefined) return;
    if (scopes.has(required)) return;
    throw new MissingScopeError(required);
}

/** True when the session is scope-checked at all. */
export function isScoped(session: SessionAuth | undefined): boolean {
    return session?.scopes !== undefined;
}
