/**
 * The PouchDB instance this project uses.
 *
 * Assembled from the individual packages rather than the `pouchdb` bundle, so
 * that what is loaded is exactly what is needed: the LevelDB adapter for the
 * local replica, the HTTP adapter for CouchDB, replication, and the transform
 * hook the E2EE boundary attaches to.
 */

import PouchDBCore from "pouchdb-core";
import leveldbAdapter from "pouchdb-adapter-leveldb";
import httpAdapter from "pouchdb-adapter-http";
import replication from "pouchdb-replication";
import mapreduce from "pouchdb-mapreduce";
import transform from "transform-pouch";

export const PouchDB = PouchDBCore.plugin(leveldbAdapter)
    .plugin(httpAdapter)
    .plugin(replication)
    .plugin(mapreduce)
    .plugin(transform);

export type PouchDatabase = PouchDB.Database;

/**
 * A database with `transform-pouch` installed.
 *
 * The plugin's types are not published in a form that composes with the core
 * types, so this narrows it once here rather than at every call site.
 */
export interface TransformableDatabase extends PouchDB.Database {
    transform(handlers: {
        incoming?: (doc: unknown) => unknown | Promise<unknown>;
        outgoing?: (doc: unknown) => unknown | Promise<unknown>;
    }): void;
}
