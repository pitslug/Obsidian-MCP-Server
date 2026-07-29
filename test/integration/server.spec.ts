/**
 * The whole server, started the way the container starts it.
 *
 * Everything below the tool layer already has tests. What this covers is the
 * wiring - that configuration reaches the replicator, that the vault's own
 * settings are read before replication decodes anything, that the bearer token
 * is actually enforced, and that the tools answer.
 *
 * The authentication tests matter most. A bearer check that silently passes
 * everything looks identical to one that works, right up until the vault is on
 * the internet.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type RunningServer } from "../../src/server/index.js";
import { composeWrite } from "../../src/vault-model/compose.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";
import type { Config } from "../../src/config.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });
const TOKEN = "a-test-bearer-token-that-is-long-enough";

let couch: FakeCouch;
let replicaDir: string;
let running: RunningServer | undefined;
let dbCounter = 0;

async function seedVault(name: string) {
    await couch.createDatabase(name);
    await couch.seed(name, [
        {
            _id: DOCID_MILESTONE,
            type: "milestoneinfo",
            created: 1,
            accepted_nodes: [],
            node_info: {},
            locked: false,
            node_chunk_info: {},
            tweak_values: {
                deviceA: {
                    encrypt: false,
                    usePathObfuscation: false,
                    enableCompression: false,
                    hashAlg: "xxhash64",
                    chunkSplitterVersion: "v3-rabin-karp",
                    handleFilenameCaseSensitive: false,
                    minimumChunkSize: 20,
                    customChunkSize: 60,
                },
            },
        },
        { _id: DOCID_VERSIONING, type: "versioninfo", version: SUPPORTED_DB_VERSION },
    ]);

    for (const [path, text] of [
        ["daily/2026-07-28.md", "# Today\n\n- [ ] a task\n"],
        ["projects/notes.md", "project body\n".repeat(200)],
    ] as [string, string][]) {
        const composed = await composeWrite(
            path,
            { kind: "text", text },
            { settings: SETTINGS, now: 1_700_000_000_000 }
        );
        await couch.seed(name, [
            ...(composed.chunks as unknown as Record<string, unknown>[]),
            composed.entry as unknown as Record<string, unknown>,
        ]);
    }
}

function configFor(db: string, port: number, overrides: Partial<Config> = {}): Config {
    return {
        couch: { url: couch.url, database: db, username: undefined, password: undefined },
        replicaPath: join(replicaDir, `replica-${db}`),
        indexPath: join(replicaDir, `index-${db}.sqlite`),
        transcriptPath: join(replicaDir, `transcripts-${db}.sqlite`),
        formatOverrides: {},
        readOnly: true,
        attachmentSizeCap: 25 * 1024 * 1024,
        planCeiling: 500,
        dailyNotePath: undefined,
        timeZone: "Australia/Brisbane",
        auth: { mode: "bearer", token: TOKEN },
        transport: { kind: "http", host: "127.0.0.1", port },
        logLevel: "error",
        ...overrides,
    };
}

/** An ephemeral port, so parallel runs do not collide. */
async function freePort(): Promise<number> {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address() as { port: number };
            s.close(() => resolve(port));
        });
    });
}

beforeAll(async () => {
    couch = await startFakeCouch();
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-server-"));
});

afterAll(async () => {
    await couch.stop();
    await rm(replicaDir, { recursive: true, force: true });
});

afterEach(async () => {
    await running?.stop().catch(() => undefined);
    running = undefined;
});

describe("startup", () => {
    it("reads the vault's settings, replicates, and serves", async () => {
        const db = `vault-${++dbCounter}`;
        await seedVault(db);
        const port = await freePort();

        running = await start(configFor(db, port));

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.status).toBe(200);
        expect(await health.text()).toBe("ok");
    }, 120_000);

    it("refuses to start when the vault is encrypted and no passphrase is set", async () => {
        const db = `encrypted-${++dbCounter}`;
        await couch.createDatabase(db);
        await couch.seed(db, [
            {
                _id: DOCID_MILESTONE,
                type: "milestoneinfo",
                created: 1,
                accepted_nodes: [],
                node_info: {},
                locked: false,
                node_chunk_info: {},
                tweak_values: { deviceA: { encrypt: true } },
            },
        ]);

        await expect(start(configFor(db, await freePort()))).rejects.toThrow(/passphrase/i);
    }, 120_000);
});

describe("authentication", () => {
    // Its own handle, not the file-level `running`: the file-level afterEach
    // stops that after every test, which would tear this server down midway
    // through the block.
    let authServer: RunningServer;
    let port: number;

    beforeAll(async () => {
        const db = `auth-${++dbCounter}`;
        await seedVault(db);
        port = await freePort();
        authServer = await start(configFor(db, port));
    }, 120_000);

    afterAll(async () => {
        await authServer?.stop().catch(() => undefined);
    });

    /**
     * A well-formed MCP initialize request.
     *
     * Streamable HTTP requires the client to accept both JSON and SSE, and the
     * first message must be `initialize`. Getting either wrong produces its own
     * error status, which would make an authentication test pass for the wrong
     * reason.
     */
    const call = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...headers,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1" },
                },
            }),
        });

    it("rejects a request with no token", async () => {
        expect((await call({})).status).toBe(401);
    });

    it("rejects a wrong token", async () => {
        expect((await call({ authorization: "Bearer not-the-token" })).status).toBe(401);
    });

    it("rejects a token that is a prefix of the real one", async () => {
        // Guards the constant-time comparison: a length-insensitive check
        // would accept this.
        expect((await call({ authorization: `Bearer ${TOKEN.slice(0, 10)}` })).status).toBe(401);
    });

    it("accepts the configured token and completes the handshake", async () => {
        const response = await call({ authorization: `Bearer ${TOKEN}` });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("protocolVersion");
    });

    it("leaves the health endpoint open, so the container can check itself", async () => {
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    });
});

describe("configuration", () => {
    it("refuses the HTTP transport with no bearer token", async () => {
        const previous = { ...process.env };
        try {
            process.env.COUCHDB_URL = "https://example.invalid";
            process.env.COUCHDB_DATABASE = "vault";
            process.env.MCP_TRANSPORT = "http";
            delete process.env.MCP_BEARER_TOKEN;

            const { loadConfig } = await import("../../src/config.js");
            expect(() => loadConfig()).toThrow(/MCP_BEARER_TOKEN/);
        } finally {
            process.env = previous;
        }
    });

    it("defaults to read-only", async () => {
        const previous = { ...process.env };
        try {
            process.env.COUCHDB_URL = "https://example.invalid/?db=vault";
            process.env.MCP_TRANSPORT = "stdio";
            delete process.env.READ_ONLY;

            const { loadConfig } = await import("../../src/config.js");
            const config = loadConfig();
            expect(config.readOnly).toBe(true);
            expect(config.couch.database).toBe("vault");
        } finally {
            process.env = previous;
        }
    });
});
