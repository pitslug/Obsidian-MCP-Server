/**
 * The write executor, against a CouchDB-speaking server.
 *
 * Reading a note back through the vault model is the only assertion that means
 * anything here. Checking that a PUT returned 201 proves the request was
 * well-formed, not that Obsidian will ever be able to open the result, and the
 * failure this suite exists to catch is a document that CouchDB accepts happily
 * and the plugin cannot read.
 *
 * So every write is verified by assembling it back out of the database it was
 * written to, using the same code path a real read uses.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Replicator } from "../../src/replicator/index.js";
import { VaultReader } from "../../src/vault/reader.js";
import {
    assembleFile,
    composeWrite,
    decodeDocument,
    encodeDocument,
    resolveSettings,
    transformContextFor,
    type ChunkEntry,
    type ChunkedEntry,
    type FileContent,
    type FileEntry,
    type VaultFormatSettings,
} from "../../src/vault-model/index.js";
import { CouchWriter, ReadOnlyError, RevisionConflictError } from "../../src/write/couch.js";
import { UnwritablePathError, WriteExecutor, WriteTargetMissingError } from "../../src/write/executor.js";
import { UnsyncablePathError } from "../../src/vault-model/ids.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";
import type { CouchConfig } from "../../src/config.js";

// A small chunk size, so that a note of a readable length is genuinely split
// across several chunks and chunk reuse is exercised rather than assumed.
const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TRANSFORM = transformContextFor(SETTINGS, undefined);

let couch: FakeCouch;
let replicaDir: string;
let replicator: Replicator | undefined;
let dbCounter = 0;

const nextDb = (label: string) => `${label}-${++dbCounter}`;

// The vault-wide PBKDF2 salt E2EE v2 derives keys from. Fixed rather than
// random, so a failure is reproducible.
const SALT = new Uint8Array(32).map((_unused, i) => (i * 11) % 256) as Uint8Array<ArrayBuffer>;

beforeAll(async () => {
    couch = await startFakeCouch();
});

afterAll(async () => {
    await couch.stop();
});

beforeEach(async () => {
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-write-"));
});

afterEach(async () => {
    await replicator?.stop().catch(() => undefined);
    replicator = undefined;
    await rm(replicaDir, { recursive: true, force: true });
});

function configFor(db: string): CouchConfig {
    return { url: couch.url, database: db, username: undefined, password: undefined };
}

/** The whole stack: a replicated database and an executor pointed at it. */
async function stackFor(
    db: string,
    options: { readOnly?: boolean; settings?: VaultFormatSettings; salt?: Uint8Array<ArrayBuffer> } = {}
): Promise<{ executor: WriteExecutor; reader: VaultReader; writer: CouchWriter }> {
    const settings = options.settings ?? SETTINGS;
    const transform = transformContextFor(settings, options.salt);

    await couch.createDatabase(db);
    replicator = new Replicator({
        remoteUrl: `${couch.url}/${db}`,
        replicaPath: join(replicaDir, "replica"),
        transform,
    });
    await replicator.start();
    await replicator.waitForInitialSync(30_000);

    const writer = new CouchWriter({ couch: configFor(db), readOnly: options.readOnly ?? false });
    const executor = new WriteExecutor({
        couch: writer,
        replicator,
        settings,
        transform,
        readOnly: options.readOnly ?? false,
    });
    const reader = new VaultReader({ replicator, settings });
    return { executor, reader, writer };
}

/**
 * Write the way a tool layer has to: read the current revision, then write
 * against it.
 *
 * `expectedRev` is required, so there is no shorthand for "write over whatever
 * is there". That is the point of it, and these helpers are how the tests say
 * "no concurrent editor" without quietly losing the property being tested.
 */
async function put(executor: WriteExecutor, path: string, content: FileContent, mtime?: number) {
    const existing = await executor.currentEntry(path);
    return executor.write({ path, content, expectedRev: existing?._rev ?? null, mtime });
}

async function drop(executor: WriteExecutor, path: string, options: { hard?: boolean } = {}) {
    const existing = await executor.currentEntry(path);
    return executor.remove({ path, expectedRev: existing?._rev as string, hard: options.hard });
}

/**
 * Read a file back out of CouchDB itself, not the replica.
 *
 * The replica is patched by the executor, so reading through it would test the
 * patch rather than the write. This goes to the database every other device
 * syncs from.
 */
async function readFromCouch(
    db: string,
    id: string,
    settings: VaultFormatSettings = SETTINGS,
    salt?: Uint8Array<ArrayBuffer>
): Promise<{ entry: FileEntry; text: string }> {
    const transform = transformContextFor(settings, salt);
    const raw = await couch.get(db, id);
    if (!raw) throw new Error(`No document "${id}" in ${db}.`);
    const entry = (await decodeDocument(raw as never, transform)) as unknown as ChunkedEntry;

    const chunks = new Map<string, ChunkEntry>();
    for (const child of entry.children ?? []) {
        const chunkRaw = await couch.get(db, child);
        if (!chunkRaw) continue;
        chunks.set(child, (await decodeDocument(chunkRaw as never, transform)) as unknown as ChunkEntry);
    }

    const file = assembleFile(entry, chunks);
    return { entry, text: file.kind === "text" ? file.text : "" };
}

describe("writing a note", () => {
    it("creates a note that reads back byte-identical", async () => {
        const db = nextDb("write");
        const { executor } = await stackFor(db);
        const text = "# Today\n\nSomething worth keeping.\n\n- one\n- two\n";

        const receipt = await put(executor, "daily/2026-07-28.md", { kind: "text", text });

        expect(receipt.created).toBe(true);
        expect(receipt.previousRev).toBeUndefined();
        expect(receipt.chunksWritten).toBeGreaterThan(0);
        expect(receipt.replicaPatchError).toBeUndefined();

        const stored = await readFromCouch(db, receipt.id);
        expect(stored.text).toBe(text);
        expect(stored.entry.size).toBe(Buffer.byteLength(text, "utf8"));
    }, 60_000);

    it("makes the new content readable immediately, without waiting for replication", async () => {
        const db = nextDb("patch");
        const { executor, reader } = await stackFor(db);

        await put(executor, "note.md", { kind: "text", text: "first version" });

        // No polling and no delay. If the replica were not patched, this would
        // be a race the test would sometimes win, so the absence of a wait is
        // the assertion.
        const { file } = await reader.read("note.md");
        expect(file.text).toBe("first version");
    }, 60_000);

    it("reuses the chunks an edit did not touch", async () => {
        const db = nextDb("reuse");
        const { executor } = await stackFor(db);
        // Distinct lines, so the note splits into distinct chunks. Repeating
        // one line would collapse to a single chunk and the test would pass
        // without proving anything about reuse.
        const original = Array.from(
            { length: 200 },
            (_unused, i) => `line ${i} alpha bravo charlie delta echo foxtrot golf hotel india\n`
        ).join("");

        await put(executor, "long.md", { kind: "text", text: original });
        const second = await put(executor, "long.md", { kind: "text", text: original + "kilo lima mike\n" });

        expect(second.created).toBe(false);
        expect(second.chunksReused).toBeGreaterThan(0);
        expect(second.chunksWritten).toBeLessThan(second.chunksReused);

        const stored = await readFromCouch(db, second.id);
        expect(stored.text).toBe(original + "kilo lima mike\n");
    }, 60_000);

    it("keeps the original creation time through an edit", async () => {
        const db = nextDb("ctime");
        const { executor } = await stackFor(db);

        const first = await put(executor, "note.md", { kind: "text", text: "one" }, 1_700_000_000_000);
        const before = (await readFromCouch(db, first.id)).entry.ctime;

        await put(executor, "note.md", { kind: "text", text: "two" }, 1_800_000_000_000);
        const after = await readFromCouch(db, first.id);

        expect(after.entry.ctime).toBe(before);
        expect(after.entry.mtime).toBe(1_800_000_000_000);
    }, 60_000);

    it("round-trips binary content", async () => {
        const db = nextDb("binary");
        const { executor } = await stackFor(db);
        const bytes = new Uint8Array(3000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;

        const receipt = await put(executor, "assets/blob.bin", { kind: "binary", bytes });

        const transform = TRANSFORM;
        const raw = await couch.get(db, receipt.id);
        const entry = (await decodeDocument(raw as never, transform)) as unknown as ChunkedEntry;
        const chunks = new Map<string, ChunkEntry>();
        for (const child of entry.children) {
            const chunkRaw = await couch.get(db, child);
            chunks.set(child, (await decodeDocument(chunkRaw as never, transform)) as unknown as ChunkEntry);
        }
        const file = assembleFile(entry, chunks);

        expect(file.kind).toBe("binary");
        expect(Buffer.from(file.bytes as Uint8Array)).toEqual(Buffer.from(bytes));
    }, 60_000);

    it("writes a readable note into an encrypted vault", async () => {
        const encrypted = resolveSettings({
            customChunkSize: 60,
            encrypt: true,
            passphrase: "correct horse battery staple",
            e2eeAlgorithm: "",
        });
        const db = nextDb("secure");
        const { executor } = await stackFor(db, { settings: encrypted });

        const receipt = await put(executor, "secret.md", { kind: "text", text: "sensitive content here" });

        // The wire form must actually be ciphertext, or the round trip below
        // would pass for the wrong reason.
        const stored = await readFromCouch(db, receipt.id, encrypted);
        const firstChunk = await couch.get(db, (stored.entry as ChunkedEntry).children[0] as string);
        expect(firstChunk?.e_).toBe(true);
        expect(String(firstChunk?.data)).not.toContain("sensitive");

        expect(stored.text).toBe("sensitive content here");
    }, 60_000);
});

describe("refusing a write", () => {
    it("refuses everything when read-only, and sends nothing", async () => {
        const db = nextDb("readonly");
        const { executor } = await stackFor(db, { readOnly: true });

        await expect(put(executor, "note.md", { kind: "text", text: "nope" })).rejects.toBeInstanceOf(
            ReadOnlyError
        );
        await expect(drop(executor, "note.md")).rejects.toBeInstanceOf(ReadOnlyError);

        expect(await couch.get(db, "note.md")).toBeUndefined();
    }, 60_000);

    it("refuses to write over a note that changed since it was read", async () => {
        const db = nextDb("conflict");
        const { executor } = await stackFor(db);

        const first = await put(executor, "note.md", { kind: "text", text: "mine" });
        // Someone else, on another device, gets there first.
        await put(executor, "note.md", { kind: "text", text: "theirs" });

        const error = await executor
            .write({ path: "note.md", content: { kind: "text", text: "stale" }, expectedRev: first.rev })
            .then(() => undefined)
            .catch((e: Error) => e);

        expect(error).toBeInstanceOf(RevisionConflictError);
        expect((await readFromCouch(db, first.id)).text).toBe("theirs");
    }, 60_000);

    it("refuses a create when something is already there", async () => {
        const db = nextDb("exists");
        const { executor } = await stackFor(db);
        await put(executor, "note.md", { kind: "text", text: "original" });

        await expect(
            executor.write({
                path: "note.md",
                content: { kind: "text", text: "clobber" },
                expectedRev: null,
            })
        ).rejects.toBeInstanceOf(RevisionConflictError);

        expect((await readFromCouch(db, "note.md")).text).toBe("original");
    }, 60_000);

    it("refuses to write Obsidian's own configuration", async () => {
        const db = nextDb("internal");
        const { executor } = await stackFor(db);

        await expect(
            executor.write({
                path: "i:.obsidian/app.json",
                content: { kind: "text", text: "{}" },
                expectedRev: null,
            })
        ).rejects.toBeInstanceOf(UnwritablePathError);
        await expect(
            put(executor, "ix:.obsidian/plugins/x/main.js", { kind: "text", text: "x" })
        ).rejects.toBeInstanceOf(UnwritablePathError);
    }, 60_000);

    it("refuses a path the plugin would never sync", async () => {
        const db = nextDb("colon");
        const { executor } = await stackFor(db);

        await expect(
            put(executor, "notes/12:30 meeting.md", { kind: "text", text: "x" })
        ).rejects.toBeInstanceOf(UnsyncablePathError);
    }, 60_000);

    it("refuses to delete something that is not there", async () => {
        const db = nextDb("absent");
        const { executor } = await stackFor(db);
        await expect(drop(executor, "never-existed.md")).rejects.toBeInstanceOf(WriteTargetMissingError);
    }, 60_000);
});

describe("deleting a note", () => {
    it("soft-deletes by default, keeping the chunk list", async () => {
        const db = nextDb("delete");
        const { executor, reader } = await stackFor(db);
        const created = await put(executor, "doomed.md", { kind: "text", text: "here today" });

        const receipt = await drop(executor, "doomed.md");
        expect(receipt.deleted).toBe(true);

        const raw = await couch.get(db, created.id);
        expect(raw).toBeDefined();
        expect(raw?.deleted).toBe(true);
        expect(raw?._deleted).toBeUndefined();
        expect((raw?.children as string[]).length).toBeGreaterThan(0);

        // And the reader stops returning it, without any wait.
        await expect(reader.read("doomed.md")).rejects.toThrow();
    }, 60_000);

    it("hard-deletes only when asked", async () => {
        const db = nextDb("hard");
        const { executor } = await stackFor(db);
        const created = await put(executor, "gone.md", { kind: "text", text: "bye" });

        await drop(executor, "gone.md", { hard: true });

        const raw = await couch.get(db, created.id);
        expect(raw === undefined || raw._deleted === true).toBe(true);
    }, 60_000);

    it("writes a note back over a deleted one, as a create", async () => {
        const db = nextDb("undelete");
        const { executor } = await stackFor(db);
        await put(executor, "note.md", { kind: "text", text: "first life" });
        await drop(executor, "note.md");

        const receipt = await put(executor, "note.md", { kind: "text", text: "second life" });

        expect(receipt.created).toBe(true);
        const stored = await readFromCouch(db, receipt.id);
        expect(stored.text).toBe("second life");
        expect(stored.entry.deleted).toBeFalsy();
    }, 60_000);
});

describe("interoperating with what the plugin writes", () => {
    it("edits a note the plugin created, rather than duplicating it", async () => {
        const db = nextDb("interop");
        await couch.createDatabase(db);

        // Seeded exactly as the plugin would, before the executor exists.
        const seeded = await composeWrite(
            "existing.md",
            { kind: "text", text: "written by Obsidian\n" },
            { settings: SETTINGS, now: 1_700_000_000_000 }
        );
        await couch.seed(db, [
            ...(await Promise.all(seeded.chunks.map((c) => encodeDocument(c, TRANSFORM)))),
            seeded.entry,
        ] as unknown as Record<string, unknown>[]);

        const { executor } = await stackFor(db);
        const receipt = await put(executor, "existing.md", {
            kind: "text",
            text: "written by Obsidian\nappended by the executor\n",
        });

        expect(receipt.created).toBe(false);
        expect(receipt.id).toBe(String(seeded.entry._id));
        const stored = await readFromCouch(db, receipt.id);
        expect(stored.text).toBe("written by Obsidian\nappended by the executor\n");
    }, 60_000);
});

/**
 * Cases where a chunk that looks present upstream is not.
 *
 * Each of these would produce a note document referencing chunks that exist
 * nowhere, which is unreadable on every device and loses the previous content
 * with it. The fix in each case is the same: send everything.
 */
describe("not trusting chunks that may not be there", () => {
    it("re-sends every chunk when the existing document carries eden data", async () => {
        const db = nextDb("eden");
        await couch.createDatabase(db);

        const seeded = await composeWrite(
            "eden.md",
            { kind: "text", text: "content that came from a useEden vault\n" },
            { settings: SETTINGS, now: 1_700_000_000_000 }
        );
        // A chunk referenced by `children` may live only inside `eden`, so its
        // presence in `children` is not evidence that a chunk document exists.
        await couch.seed(db, [
            ...(await Promise.all(seeded.chunks.map((c) => encodeDocument(c, TRANSFORM)))),
            { ...seeded.entry, eden: { "h:inline": { data: "inline payload", epoch: 1 } } },
        ] as unknown as Record<string, unknown>[]);

        const { executor } = await stackFor(db);
        const receipt = await put(executor, "eden.md", {
            kind: "text",
            text: "content that came from a useEden vault\nplus a line\n",
        });

        expect(receipt.chunksReused).toBe(0);
        expect((await readFromCouch(db, receipt.id)).text).toBe(
            "content that came from a useEden vault\nplus a line\n"
        );
    }, 60_000);

    it("re-sends every chunk when writing over a deleted note", async () => {
        const db = nextDb("tombstone-chunks");
        const { executor } = await stackFor(db);
        const text = "a body long enough to be worth reusing chunks from\n".repeat(4);

        await put(executor, "note.md", { kind: "text", text });
        await drop(executor, "note.md");

        // A tombstone's chunks are exactly what the plugin's orphan cleanup is
        // entitled to collect, so none of them may be assumed present.
        const receipt = await put(executor, "note.md", { kind: "text", text });

        expect(receipt.created).toBe(true);
        expect(receipt.chunksReused).toBe(0);
        expect((await readFromCouch(db, receipt.id)).text).toBe(text);
    }, 60_000);
});

describe("the local replica after a write", () => {
    it("stays on one revision branch, however many times a note is edited", async () => {
        const db = nextDb("branches");
        const { executor } = await stackFor(db);

        await put(executor, "note.md", { kind: "text", text: "one" });
        await put(executor, "note.md", { kind: "text", text: "two" });
        await put(executor, "note.md", { kind: "text", text: "three" });

        // Patching the replica without revision ancestry silently starts a new
        // branch per write. Reads still return the right winner, which is what
        // makes it easy to miss, so the conflict list is what gets asserted.
        const doc = (await replicator?.database.get("note.md", { conflicts: true })) as {
            _conflicts?: string[];
        };
        expect(doc._conflicts ?? []).toEqual([]);
    }, 60_000);
});

describe("encrypted vaults", () => {
    const V2 = resolveSettings({
        customChunkSize: 60,
        encrypt: true,
        passphrase: "correct horse battery staple",
        e2eeAlgorithm: "v2",
        usePathObfuscation: true,
    });

    it("writes a note that reads back, with the path and metadata sealed", async () => {
        const db = nextDb("v2");
        const { executor } = await stackFor(db, { settings: V2, salt: SALT });

        const receipt = await put(executor, "private/thoughts.md", {
            kind: "text",
            text: "the metadata sealing path zeroes mtime, size and children on the wire",
        });

        // The wire form must genuinely be sealed, or the round trip below would
        // pass for the wrong reason. This is the branch where a mistake gives a
        // document CouchDB accepts and Obsidian opens as an empty note.
        const wire = await couch.get(db, receipt.id);
        expect(String(wire?._id)).toContain("f:");
        expect(String(wire?.path)).not.toContain("thoughts");
        expect(wire?.size).toBe(0);
        expect(wire?.children).toEqual([]);

        const stored = await readFromCouch(db, receipt.id, V2, SALT);
        expect(stored.text).toBe("the metadata sealing path zeroes mtime, size and children on the wire");
    }, 60_000);

    it("refuses to soft-delete a pre-chunking note, rather than publishing its plaintext", async () => {
        const db = nextDb("legacy");
        await couch.createDatabase(db);
        // A legacy note keeps its content inline in `data`. `composeDeletion`
        // spreads the decoded document, and nothing on the write path
        // re-encrypts a file document's `data`, so the tombstone would replace
        // ciphertext with plaintext permanently.
        await couch.seed(db, [
            {
                _id: "old.md",
                path: "old.md",
                type: "notes",
                data: "content from before chunking existed",
                ctime: 1_600_000_000_000,
                mtime: 1_600_000_000_000,
                size: 36,
            },
        ]);

        const encrypted = resolveSettings({
            customChunkSize: 60,
            encrypt: true,
            passphrase: "correct horse battery staple",
            e2eeAlgorithm: "",
        });
        const { executor } = await stackFor(db, { settings: encrypted });

        await expect(drop(executor, "old.md")).rejects.toThrow(/pre-chunking/);
        expect((await couch.get(db, "old.md"))?.data).toBe("content from before chunking existed");
    }, 60_000);
});
