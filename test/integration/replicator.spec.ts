/**
 * The replicator, against a CouchDB-speaking server.
 *
 * The property that matters most here is negative: replication is pull-only,
 * and nothing this code does may modify the remote. That is asserted by
 * mutating the local replica and then checking the remote is untouched - the
 * failure mode being guarded against is a future edit that turns `replicate.from`
 * into `sync`, which would look harmless in review and would push local drift
 * to every device.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Replicator } from "../../src/replicator/index.js";
import { VaultReader } from "../../src/vault/reader.js";
import { composeWrite } from "../../src/vault-model/compose.js";
import { encodeDocument, transformContextFor } from "../../src/vault-model/index.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TRANSFORM = transformContextFor(SETTINGS, undefined);

let couch: FakeCouch;
let replicaDir: string;
let replicator: Replicator | undefined;

/** Write a note into the fake CouchDB the way the plugin would. */
async function seedNote(db: string, path: string, text: string) {
    const composed = await composeWrite(
        path,
        { kind: "text", text },
        { settings: SETTINGS, now: 1_700_000_000_000 }
    );
    await couch.seed(db, [
        ...(composed.chunks as unknown as Record<string, unknown>[]),
        composed.entry as unknown as Record<string, unknown>,
    ]);
    return composed;
}

async function startReplicator(db: string) {
    const r = new Replicator({
        remoteUrl: `${couch.url}/${db}`,
        replicaPath: join(replicaDir, "replica"),
        transform: TRANSFORM,
    });
    await r.start();
    await r.waitForInitialSync(30_000);
    return r;
}

// One server for the whole file; each test gets its own database. Starting a
// server per test is what surfaced the `_replicator` daemon collision, and it
// is needless work regardless.
beforeAll(async () => {
    couch = await startFakeCouch();
});

afterAll(async () => {
    await couch.stop();
});

beforeEach(async () => {
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-test-"));
});

afterEach(async () => {
    await replicator?.stop().catch(() => undefined);
    replicator = undefined;
    await rm(replicaDir, { recursive: true, force: true });
});

/** A database name unique to each test, since the server is shared. */
let dbCounter = 0;
const nextDb = (label: string) => `${label}-${++dbCounter}`;

describe("replication", () => {
    it("pulls the whole vault into the local replica", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "daily/2026-07-28.md", "# Today\n\nSome content.\n");
        await seedNote(db, "projects/big.md", "x".repeat(9000));

        replicator = await startReplicator(db);
        const count = await replicator.refreshDocCount();

        expect(count).toBeGreaterThan(2);
        expect(replicator.status().initialSyncComplete).toBe(true);
        expect(replicator.status().error).toBeUndefined();
    }, 60_000);

    it("never writes to the remote, even when the replica diverges", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "note.md", "original content");
        replicator = await startReplicator(db);

        // Corrupt the local replica, as a decode bug or bad restore would.
        const local = replicator.database;
        const doc = (await local.get("note.md")) as Record<string, unknown>;
        await local.put({ ...doc, size: 999_999, path: "tampered.md" });

        // Give any (nonexistent) push replication time to act.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const remote = await couch.get(db, "note.md");
        expect(remote?.path).toBe("note.md");
        expect(remote?.size).not.toBe(999_999);
        expect(await couch.get(db, "tampered.md")).toBeUndefined();
    }, 60_000);

    it("picks up a note added after the initial sync", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "first.md", "first");
        replicator = await startReplicator(db);

        await seedNote(db, "second.md", "second note content");

        // Live replication is asynchronous; poll rather than guess a delay.
        const deadline = Date.now() + 20_000;
        let found = false;
        while (Date.now() < deadline && !found) {
            found = await replicator.database
                .get("second.md")
                .then(() => true)
                .catch(() => false);
            if (!found) await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(found).toBe(true);
    }, 60_000);

    it("reports lag that grows while nothing changes", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "note.md", "content");
        replicator = await startReplicator(db);

        const first = replicator.status().lagMs;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const second = replicator.status().lagMs;

        expect(second).toBeGreaterThan(first);
    }, 60_000);

    it("survives an empty vault", async () => {
        const db = nextDb("empty");
        await couch.createDatabase(db);
        replicator = await startReplicator(db);
        expect(await replicator.refreshDocCount()).toBe(0);
        expect(replicator.status().error).toBeUndefined();
    }, 60_000);
});

describe("decoding at the boundary", () => {
    it("stores encrypted documents in plain form locally", async () => {
        const encrypted = resolveSettings({
            customChunkSize: 60,
            encrypt: true,
            passphrase: "correct horse battery staple",
            e2eeAlgorithm: "",
        });
        const ctx = transformContextFor(encrypted, undefined);

        const db = nextDb("secure");
        await couch.createDatabase(db);
        const composed = await composeWrite(
            "secret.md",
            { kind: "text", text: "sensitive content here" },
            { settings: encrypted, now: 1_700_000_000_000 }
        );
        // Write in wire form, as the plugin's transform would.
        const wire = [
            ...(await Promise.all(composed.chunks.map((c) => encodeDocument(c, ctx)))),
            composed.entry,
        ];
        await couch.seed(db, wire as unknown as Record<string, unknown>[]);

        // Confirm the fixture really is encrypted on the wire.
        const onWire = await couch.get(db, composed.children[0] as string);
        expect(onWire?.e_).toBe(true);
        expect(String(onWire?.data)).not.toContain("sensitive");

        replicator = new Replicator({
            remoteUrl: `${couch.url}/${db}`,
            replicaPath: join(replicaDir, "replica"),
            transform: ctx,
        });
        await replicator.start();
        await replicator.waitForInitialSync(30_000);

        const reader = new VaultReader({ replicator, settings: encrypted });
        const { file } = await reader.read("secret.md");
        expect(file.text).toBe("sensitive content here");
    }, 60_000);

    it("counts a document it cannot decode instead of stopping replication", async () => {
        const ctx = transformContextFor(
            resolveSettings({ encrypt: true, passphrase: "the wrong passphrase", e2eeAlgorithm: "" }),
            undefined
        );

        const db = nextDb("broken");
        await couch.createDatabase(db);
        await couch.seed(db, [
            { _id: "h:+undecodable", type: "leaf", data: "%not-real-ciphertext", e_: true },
            { _id: "fine.md", type: "plain", path: "fine.md", children: [], ctime: 1, mtime: 1, size: 0 },
        ]);

        replicator = new Replicator({
            remoteUrl: `${couch.url}/${db}`,
            replicaPath: join(replicaDir, "replica"),
            transform: ctx,
        });
        await replicator.start();
        await replicator.waitForInitialSync(30_000);

        // Replication completed despite the bad document.
        expect(replicator.status().initialSyncComplete).toBe(true);
        expect(replicator.status().decodeFailures).toBeGreaterThan(0);
        // And the healthy document still arrived.
        await expect(replicator.database.get("fine.md")).resolves.toBeTruthy();
    }, 60_000);
});

describe("reading through the replica", () => {
    it("returns a note assembled from its chunks", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        const text = "# Heading\n\n" + "body text\n".repeat(500);
        await seedNote(db, "notes/long.md", text);
        replicator = await startReplicator(db);

        const reader = new VaultReader({ replicator, settings: SETTINGS });
        const { file, lagMs } = await reader.read("notes/long.md");

        expect(file.text).toBe(text);
        expect(file.path).toBe("notes/long.md");
        expect(lagMs).toBeGreaterThanOrEqual(0);
    }, 60_000);

    it("lists notes without their content", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "a.md", "first");
        await seedNote(db, "folder/b.md", "second");
        await seedNote(db, "folder/c.md", "third");
        replicator = await startReplicator(db);

        const reader = new VaultReader({ replicator, settings: SETTINGS });
        const all = await reader.list();
        expect(all.notes.map((n) => n.path)).toEqual(["a.md", "folder/b.md", "folder/c.md"]);

        const scoped = await reader.list({ folder: "folder" });
        expect(scoped.notes.map((n) => n.path)).toEqual(["folder/b.md", "folder/c.md"]);
    }, 60_000);

    it("reports a missing note rather than an empty one", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        await seedNote(db, "exists.md", "content");
        replicator = await startReplicator(db);

        const reader = new VaultReader({ replicator, settings: SETTINGS });
        await expect(reader.read("does-not-exist.md")).rejects.toThrow(/No note at/);
    }, 60_000);

    it("fetches a chunk the replica is missing rather than failing the read", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        const composed = await seedNote(db, "note.md", "y".repeat(9000));
        replicator = await startReplicator(db);

        // Remove a chunk locally, as a mid-replication read would see.
        const missing = composed.children[0] as string;
        const local = await replicator.database.get(missing);
        await replicator.database.remove(local as { _id: string; _rev: string });

        const reader = new VaultReader({
            replicator,
            settings: SETTINGS,
            fetchRemote: async (id) => couch.get(db, id),
        });

        const { file } = await reader.read("note.md");
        expect(file.text).toBe("y".repeat(9000));
    }, 60_000);

    it("fails the read when the chunk is missing everywhere", async () => {
        const db = nextDb("vault");
        await couch.createDatabase(db);
        const composed = await seedNote(db, "note.md", "z".repeat(9000));
        replicator = await startReplicator(db);

        const missing = composed.children[0] as string;
        const local = await replicator.database.get(missing);
        await replicator.database.remove(local as { _id: string; _rev: string });

        const reader = new VaultReader({
            replicator,
            settings: SETTINGS,
            fetchRemote: async () => undefined,
        });

        await expect(reader.read("note.md")).rejects.toThrow(/missing from the supplied set/);
    }, 60_000);
});
