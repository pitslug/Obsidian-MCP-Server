/**
 * Notes that two devices both changed.
 *
 * The one state in this system that is invisible from the outside. CouchDB
 * picks a winner deterministically and every read returns it, so a note with a
 * second version reads exactly like a note without one, forever. Nothing is
 * lost, which is why it is easy to argue this does not matter, and nobody knows
 * the other version is there, which is why it does.
 *
 * The conflict here is made the way a real one arrives: a revision inserted
 * into the replica with `new_edits: false`, which is what replication itself
 * does when it brings back a change made on a device that had not seen ours.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Replicator } from "../../src/replicator/index.js";
import { VaultReader } from "../../src/vault/reader.js";
import { composeWrite, resolveSettings, transformContextFor } from "../../src/vault-model/index.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TRANSFORM = transformContextFor(SETTINGS, undefined);

let couch: FakeCouch;
let replicaDir: string;
let replicator: Replicator;
let reader: VaultReader;
let dbCounter = 0;

beforeAll(async () => {
    couch = await startFakeCouch();
});

afterAll(async () => {
    await couch.stop();
});

beforeEach(async () => {
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-conflicts-"));
    const db = `conflicts-${++dbCounter}`;
    await couch.createDatabase(db);

    for (const [path, text] of [
        ["notes/quiet.md", "Nobody else touched this one.\n"],
        ["notes/busy.md", "The version this device wrote.\n"],
    ]) {
        const composed = await composeWrite(
            path as string,
            { kind: "text", text: text as string },
            { settings: SETTINGS, now: 1_700_000_000_000 }
        );
        await couch.seed(db, [
            ...(composed.chunks as unknown as Record<string, unknown>[]),
            composed.entry as unknown as Record<string, unknown>,
        ]);
    }

    replicator = new Replicator({
        remoteUrl: `${couch.url}/${db}`,
        replicaPath: join(replicaDir, "replica"),
        transform: TRANSFORM,
    });
    await replicator.start();
    await replicator.waitForInitialSync(30_000);
    reader = new VaultReader({ replicator, settings: SETTINGS });
});

afterEach(async () => {
    await replicator.stop().catch(() => undefined);
    await rm(replicaDir, { recursive: true, force: true });
});

/** Insert a competing revision, the way replication brings one back. */
async function anotherDeviceWrote(path: string, text: string): Promise<void> {
    const composed = await composeWrite(
        path,
        { kind: "text", text },
        { settings: SETTINGS, now: 1_800_000_000_000 }
    );
    // Its chunks first and ordinarily: they are content-addressed, so they
    // conflict with nothing and a note whose chunks are absent cannot be read
    // at all, which would be a different failure wearing this one's clothes.
    await replicator.database.bulkDocs(composed.chunks as never);

    // The file document as a revision this device has never seen, which is what
    // makes it a branch rather than an edit.
    await replicator.database.bulkDocs(
        [
            {
                ...(composed.entry as unknown as Record<string, unknown>),
                _rev: "1-0000000000000000000000000000dead",
                _revisions: { start: 1, ids: ["0000000000000000000000000000dead"] },
            },
        ] as never,
        { new_edits: false } as never
    );
}

describe("conflicts", () => {
    it("reports none for a vault nobody has fought over", async () => {
        expect(await reader.conflicts()).toEqual([]);
    });

    it("finds the note with two versions, and says how many lost", async () => {
        await anotherDeviceWrote("notes/busy.md", "The version the other device wrote.\n");

        expect(await reader.conflicts()).toEqual([{ path: "notes/busy.md", losing: 1 }]);
    });

    it("still reads, and always the same version", async () => {
        // The reason this needs reporting at all. Both versions are there and
        // the read is not wrong, it is just not the whole truth.
        await anotherDeviceWrote("notes/busy.md", "The version the other device wrote.\n");

        const first = (await reader.read("notes/busy.md")).file;
        const second = (await reader.read("notes/busy.md")).file;
        expect(first.kind === "text" && first.text).toBe(second.kind === "text" && second.text);
    });

    it("leaves the notes nobody else touched out of it", async () => {
        await anotherDeviceWrote("notes/busy.md", "The version the other device wrote.\n");

        const paths = (await reader.conflicts()).map((conflict) => conflict.path);
        expect(paths).not.toContain("notes/quiet.md");
    });
});
