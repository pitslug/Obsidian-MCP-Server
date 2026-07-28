/**
 * Ambient declarations for PouchDB plugins that publish no types.
 *
 * Both are plugin factories consumed only by `PouchDB.plugin(...)`, so the
 * loose typing does not escape `src/replicator/pouch.ts`.
 */

declare module "pouchdb-mapreduce" {
    const plugin: PouchDB.Plugin;
    export default plugin;
}

declare module "transform-pouch" {
    const plugin: PouchDB.Plugin;
    export default plugin;
}

declare module "pouchdb-adapter-memory" {
    const plugin: PouchDB.Plugin;
    export default plugin;
}

declare module "express-pouchdb" {
    import type { RequestHandler } from "express";
    /** Returns Express middleware serving the CouchDB API over a PouchDB. */
    const expressPouchDB: (pouch: unknown, options?: Record<string, unknown>) => RequestHandler;
    export default expressPouchDB;
}
