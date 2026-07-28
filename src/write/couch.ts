/**
 * The only code in this process permitted to change the vault.
 *
 * Everything else is read-only by construction: the replicator calls
 * `replicate.from` and never `to`, the direct reader issues GET and nothing
 * else, and the vault model has no network access at all. That is what reduces
 * "can this corrupt my vault?" to a question about this file.
 *
 * Three properties are load bearing here, and each is asserted by a test:
 *
 *  - With `readOnly` set, no state-changing request is issued. The refusal
 *    happens before the request is built, not by inspecting a response, so a
 *    read-only deployment cannot reach CouchDB with a PUT even if a caller
 *    tries.
 *  - A `409` is refused, never retried. Retrying a conflict means re-reading
 *    the current revision and writing over whatever changed, which is a lost
 *    update wearing the clothes of a successful write.
 *  - Errors never carry credentials, because credentials are never in the URL.
 *    See `src/couch/rest.ts`.
 */

import type { CouchConfig } from "../config.js";
import { databaseUrl, documentUrl, endpointFor, headersFor, type CouchEndpoint } from "../couch/rest.js";

export class ReadOnlyError extends Error {
    constructor(what: string) {
        super(
            `Refusing to ${what}: this server is running read-only. ` +
                `Set READ_ONLY=false to enable writing, having first satisfied the acceptance gate.`
        );
        this.name = "ReadOnlyError";
    }
}

/**
 * The document changed since it was read.
 *
 * Carries the current server-side document so the caller can report what it
 * lost to, rather than sending the user back to re-read blind.
 */
export class RevisionConflictError extends Error {
    constructor(
        readonly id: string,
        readonly expectedRev: string | undefined,
        readonly current: Record<string, unknown> | undefined
    ) {
        super(
            `"${id}" changed since it was read` +
                (expectedRev ? ` (expected revision ${expectedRev}` : ` (expected it not to exist`) +
                (current?._rev ? `, found ${String(current._rev)})` : `)`) +
                `. Refusing to write over the newer version. Re-read it and decide what to keep.`
        );
        this.name = "RevisionConflictError";
    }
}

export class CouchRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly reason?: string
    ) {
        super(message);
        this.name = "CouchRequestError";
    }
}

export interface PutResult {
    id: string;
    rev: string;
}

export interface BulkResult {
    id: string;
    rev: string | undefined;
    ok: boolean;
    /**
     * True when the document was refused as a conflict.
     *
     * For chunk documents this is benign and expected: a chunk ID is a hash of
     * its own content, so a conflict means the identical payload is already
     * there. For anything else it is a genuine lost-update refusal.
     */
    conflict: boolean;
    error: string | undefined;
}

export interface CouchWriterOptions {
    couch: CouchConfig;
    /** When true, every state-changing method refuses before issuing a request. */
    readOnly: boolean;
    /** Injectable for tests. Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
}

export class CouchWriter {
    private readonly endpoint: CouchEndpoint;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly options: CouchWriterOptions) {
        this.endpoint = endpointFor(options.couch);
        this.fetchImpl = options.fetchImpl ?? fetch;
    }

    get readOnly(): boolean {
        return this.options.readOnly;
    }

    /**
     * Fetch a document as CouchDB holds it, in wire form.
     *
     * The write path reads its own current revision rather than trusting the
     * replica, which may be behind. A read that went through the replica could
     * compose a write against a revision that is no longer current, and the
     * only thing standing between that and a lost update would be the `409`.
     * Better not to depend on the last line of defence for ordinary operation.
     */
    async get(id: string): Promise<Record<string, unknown> | undefined> {
        const response = await this.fetchImpl(documentUrl(this.endpoint, id), {
            method: "GET",
            headers: headersFor(this.endpoint),
        });
        if (response.status === 404) return undefined;
        if (!response.ok) throw await this.describe(response, `read "${id}"`);
        return (await response.json()) as Record<string, unknown>;
    }

    /** Current revision of a document, or undefined if it does not exist. */
    async revisionOf(id: string): Promise<string | undefined> {
        const doc = await this.get(id);
        const rev = doc?._rev;
        return typeof rev === "string" ? rev : undefined;
    }

    /**
     * Write one document.
     *
     * `_rev` on the document is what makes this safe: absent means "this must
     * not already exist", present means "this must still be exactly that
     * revision". Either way CouchDB, not this code, decides whether the write
     * was based on current information.
     */
    async put(doc: Record<string, unknown>): Promise<PutResult> {
        this.assertWritable(`write "${String(doc._id)}"`);

        const id = String(doc._id);
        const response = await this.fetchImpl(documentUrl(this.endpoint, id), {
            method: "PUT",
            headers: headersFor(this.endpoint, { "Content-Type": "application/json" }),
            body: JSON.stringify(doc),
        });

        if (response.status === 409) {
            // Read the winner back so the refusal can say what it lost to.
            const current = await this.get(id).catch(() => undefined);
            throw new RevisionConflictError(id, doc._rev as string | undefined, current);
        }
        if (!response.ok) throw await this.describe(response, `write "${id}"`);

        const body = (await response.json()) as { id?: string; rev?: string };
        if (!body.rev) {
            throw new CouchRequestError(`Write of "${id}" returned no revision.`, response.status);
        }
        return { id: body.id ?? id, rev: body.rev };
    }

    /**
     * Write several documents in one request.
     *
     * Used for chunks, where a conflict is not a failure. `new_edits` is left
     * at its default of true so that every document is subject to the same
     * revision checking a single PUT would get. Setting it false would let this
     * insert arbitrary revisions, which is how replication writes and is
     * emphatically not how a deliberate write should.
     */
    async bulkPut(docs: Record<string, unknown>[]): Promise<BulkResult[]> {
        if (docs.length === 0) return [];
        this.assertWritable(`write ${docs.length} document(s)`);

        const response = await this.fetchImpl(databaseUrl(this.endpoint, "_bulk_docs"), {
            method: "POST",
            headers: headersFor(this.endpoint, { "Content-Type": "application/json" }),
            body: JSON.stringify({ docs, new_edits: true }),
        });
        if (!response.ok) throw await this.describe(response, `write ${docs.length} document(s)`);

        const rows = (await response.json()) as {
            id?: string;
            rev?: string;
            ok?: boolean;
            error?: string;
            reason?: string;
        }[];

        return rows.map((row, index) => ({
            id: row.id ?? String(docs[index]?._id ?? ""),
            rev: row.rev,
            ok: row.error === undefined,
            conflict: row.error === "conflict",
            error: row.error ? `${row.error}${row.reason ? `: ${row.reason}` : ""}` : undefined,
        }));
    }

    private assertWritable(what: string): void {
        if (this.options.readOnly) throw new ReadOnlyError(what);
    }

    private async describe(response: Response, what: string): Promise<CouchRequestError> {
        let reason: string | undefined;
        try {
            const body = (await response.json()) as { error?: string; reason?: string };
            reason = body.reason ?? body.error;
        } catch {
            // A non-JSON error body is not worth a second failure mode.
        }
        return new CouchRequestError(
            `Could not ${what}: ${response.status} ${response.statusText}${reason ? ` (${reason})` : ""}.`,
            response.status,
            reason
        );
    }
}
