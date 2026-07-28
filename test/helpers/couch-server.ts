/**
 * A CouchDB-speaking server for integration tests.
 *
 * The design calls for tests against an ephemeral CouchDB in Compose. Docker is
 * not available in the environment this is developed in, so `express-pouchdb`
 * stands in: it serves the CouchDB HTTP API over an in-memory PouchDB, which is
 * enough for replication, the changes feed and document CRUD.
 *
 * It is not CouchDB. Where behaviour could plausibly differ — validation rules,
 * conflict semantics at scale, `_bulk_docs` edge cases — a test passing here is
 * evidence, not proof, and the same suite should be run against real CouchDB
 * before anything writes to a vault that matters.
 */

import express from "express";
import expressPouchDB from "express-pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import type { Server } from "node:http";
import { PouchDB } from "../../src/replicator/pouch.js";

// PouchDB plugins register on the shared core, so applying replication or
// mapreduce a second time throws "Cannot redefine property". Reuse the
// project's already-assembled constructor and add only the memory adapter.
const MemoryPouch = PouchDB.plugin(memoryAdapter).defaults({ adapter: "memory" });

export interface FakeCouch {
    /** Base URL, without a database name. */
    url: string;
    /** Create a database and return its URL. */
    createDatabase(name: string): Promise<string>;
    /** Write documents directly, bypassing any transform. */
    seed(name: string, docs: Record<string, unknown>[]): Promise<void>;
    /** Read a document back, to assert on wire form. */
    get(name: string, id: string): Promise<Record<string, unknown> | undefined>;
    stop(): Promise<void>;
}

export async function startFakeCouch(): Promise<FakeCouch> {
    const app = express();
    // "minimumForPouchDB" omits Fauxton, the `_users` database and — the one
    // that matters — the `_replicator` daemon, which registers globally and
    // throws "already_active" the moment a second instance starts. We only
    // need the document and replication-target endpoints.
    app.use(
        "/",
        expressPouchDB(MemoryPouch, {
            inMemoryConfig: true,
            logPath: "/dev/null",
            mode: "minimumForPouchDB",
        })
    );

    const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;

    const handles = new Map<string, InstanceType<typeof MemoryPouch>>();
    const handle = (name: string) => {
        let db = handles.get(name);
        if (!db) {
            db = new MemoryPouch(name);
            handles.set(name, db);
        }
        return db;
    };

    return {
        url,
        async createDatabase(name: string) {
            await handle(name).info();
            return `${url}/${name}`;
        },
        async seed(name: string, docs: Record<string, unknown>[]) {
            await handle(name).bulkDocs(docs as never);
        },
        async get(name: string, id: string) {
            try {
                return (await handle(name).get(id)) as unknown as Record<string, unknown>;
            } catch (error) {
                if ((error as { status?: number }).status === 404) return undefined;
                throw error;
            }
        },
        async stop() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            for (const db of handles.values()) await db.destroy().catch(() => undefined);
            handles.clear();
        },
    };
}
