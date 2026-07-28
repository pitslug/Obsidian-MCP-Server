/**
 * The write verification script, against a fake CouchDB.
 *
 * This is the one script in the repository that writes, so the tests that
 * matter most are the ones proving it refuses. Those run first and assert not
 * only the exit code but that nothing was created, because a script that
 * refuses after writing has not refused.
 *
 * The happy path is then run end to end, so that the thing Chris points at a
 * real database has itself been run rather than merely compiled.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";
import { DOCID_MILESTONE } from "../../src/vault-model/constants.js";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const scriptPath = resolve(root, "scripts/verify-write.ts");

let couch: FakeCouch;
let dbCounter = 0;

const nextDb = (label: string) => `${label}-${++dbCounter}`;

/** A milestone document naming `nodes` devices, as the plugin publishes it. */
function milestone(nodes: string[]) {
    return {
        _id: DOCID_MILESTONE,
        type: "milestoneinfo",
        created: 1_700_000_000_000,
        accepted_nodes: nodes,
        locked: false,
        node_chunk_info: {},
        tweak_values: Object.fromEntries(
            nodes.map((node) => [node, { customChunkSize: 60, minimumChunkSize: 20 }])
        ),
    };
}

async function runScript(args: string[]) {
    try {
        // `process.execPath` with `--import tsx`, never `npx`: on Windows npx
        // is a batch file and execFile does not go through a shell, and on
        // Linux it leaves a grandchild that hangs teardown.
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            ["--import", "tsx", scriptPath, ...args],
            { cwd: root, timeout: 180_000 }
        );
        return { code: 0, out: stdout + stderr };
    } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
        return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "") };
    }
}

beforeAll(async () => {
    couch = await startFakeCouch();
}, 60_000);

afterAll(async () => {
    await couch.stop();
});

describe("refusing to run", () => {
    it("refuses the live vault by name, and creates nothing", async () => {
        const db = "obsidiandb";
        await couch.createDatabase(db);

        const result = await runScript(["--url", couch.url, "--db", db]);

        expect(result.code).toBe(1);
        expect(result.out).toContain("Refusing to write");
        expect(await couch.get(db, "mcp-write-check/first.md")).toBeUndefined();
    }, 120_000);

    it("refuses to guess a database", async () => {
        const result = await runScript(["--url", couch.url]);
        expect(result.code).toBe(1);
        expect(result.out).toContain("No database name");
    }, 120_000);

    it("refuses a database several devices have synced to", async () => {
        const db = nextDb("busy");
        await couch.createDatabase(db);
        await couch.seed(db, [milestone(["laptop", "phone", "tablet"])]);

        const result = await runScript(["--url", couch.url, "--db", db]);

        expect(result.code).toBe(1);
        expect(result.out).toMatch(/3 devices have synced/);
        expect(result.out).toContain("--expect-devices 3");
        expect(await couch.get(db, "mcp-write-check/first.md")).toBeUndefined();
    }, 120_000);

    it("proceeds against that same database when told to expect them", async () => {
        const db = nextDb("busy-allowed");
        await couch.createDatabase(db);
        await couch.seed(db, [milestone(["laptop", "phone", "tablet"])]);

        const result = await runScript(["--url", couch.url, "--db", db, "--expect-devices", "3", "--keep"]);

        expect(result.out).toContain("Every check passed");
        expect(result.code).toBe(0);
    }, 180_000);
});

describe("a full run", () => {
    let result: { code: number; out: string };
    let db: string;

    beforeAll(async () => {
        db = nextDb("writecheck");
        await couch.createDatabase(db);
        await couch.seed(db, [milestone(["laptop"])]);
        result = await runScript(["--url", couch.url, "--db", db, "--keep"]);
    }, 180_000);

    it("passes every check", () => {
        expect(result.out).toContain("Every check passed");
        expect(result.code).toBe(0);
    });

    it("verifies the note it created reads back byte-identical", () => {
        expect(result.out).toContain("Reads back byte-identical from CouchDB");
    });

    it("reuses chunks on an edit", () => {
        expect(result.out).toMatch(/Reused [1-9]\d* chunk\(s\)/);
    });

    it("proves the dry run wrote nothing", () => {
        expect(result.out).toContain("Planning wrote nothing");
    });

    it("refuses a stale write and a stale plan without changing anything", () => {
        expect(result.out).toContain("A write against the previous revision is refused");
        expect(result.out).toContain("The refused write changed nothing");
        expect(result.out).toContain("A plan whose target moved is refused");
        expect(result.out).toContain("The refused plan changed nothing");
    });

    it("soft-deletes rather than hard-deletes", () => {
        expect(result.out).toContain("The document survives the delete, as a tombstone");
        expect(result.out).toContain("It is not hard-deleted");
    });

    it("leaves the local replica without conflict branches", () => {
        expect(result.out).toContain("No conflict branches after six writes");
    });

    it("tells the human exactly what to look for in Obsidian", () => {
        expect(result.out).toContain("Now confirm it in Obsidian");
        expect(result.out).toMatch(/mcp-write-check\/first\.md/);
        expect(result.out).toMatch(/mcp-write-check\/second\.md/);
    });

    it("actually left the notes there, since --keep was passed", async () => {
        expect(await couch.get(db, "mcp-write-check/first.md")).toBeDefined();
    });
});

describe("cleaning up after itself", () => {
    it("removes what it created when --keep is not passed", async () => {
        const db = nextDb("tidy");
        await couch.createDatabase(db);
        await couch.seed(db, [milestone(["laptop"])]);

        const result = await runScript(["--url", couch.url, "--db", db]);
        expect(result.code).toBe(0);

        const first = await couch.get(db, "mcp-write-check/first.md");
        expect(first === undefined || first._deleted === true).toBe(true);
    }, 180_000);
});
