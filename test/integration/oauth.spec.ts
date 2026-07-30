/**
 * The OAuth boundary, over real HTTP.
 *
 * The unit tests prove the token verifier is right about tokens. What they
 * cannot show is whether a client would ever get far enough to present one,
 * and that is the part that fails silently: a server whose 401 lacks the
 * pointer to its metadata is not broken in any way its own logs reveal. It
 * simply never hears from the authorization server, and the client reports that
 * the server could not be reached.
 *
 * So these drive the real handshake with plain fetch, in the order a client
 * performs it: get a 401, read the challenge, fetch the metadata it names,
 * present a token, then be refused for the one thing the token does not cover.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { start, type RunningServer } from "../../src/server/index.js";
import { composeWrite } from "../../src/vault-model/compose.js";
import { resolveSettings } from "../../src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "../../src/vault-model/constants.js";
import { startFakeCouch, type FakeCouch } from "../helpers/couch-server.js";
import type { Config } from "../../src/config.js";

const SETTINGS = resolveSettings({ customChunkSize: 60 });

let couch: FakeCouch;
let replicaDir: string;
let running: RunningServer | undefined;
let issuer: Server;
let issuerUrl: string;
let privateKey: KeyObject | CryptoKey;
let publicJwk: JWK;
let mcpUrl: string;
let dbCounter = 0;

async function freePort(): Promise<number> {
    const { createServer: createNet } = await import("node:net");
    return new Promise((resolve) => {
        const s = createNet();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address() as { port: number };
            s.close(() => resolve(port));
        });
    });
}

/** A real authorization server, to the extent this server ever looks at one. */
async function startIssuer(): Promise<{ server: Server; url: string }> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;

    const server = createServer((request, response) => {
        const send = (body: unknown) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
        };
        if (request.url === "/.well-known/openid-configuration") {
            return send({ issuer: url, jwks_uri: `${url}/jwks` });
        }
        if (request.url === "/jwks") return send({ keys: [publicJwk] });
        response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return { server, url };
}

async function token(scopes: string[], audience = mcpUrl): Promise<string> {
    return new SignJWT({ scope: scopes.join(" ") })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(issuerUrl)
        .setAudience(audience)
        .setSubject("user-chris")
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(privateKey);
}

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

    const composed = await composeWrite(
        "notes/hello.md",
        { kind: "text", text: "# Hello\n\nbody\n" },
        { settings: SETTINGS, now: 1_700_000_000_000 }
    );
    await couch.seed(name, [
        ...(composed.chunks as unknown as Record<string, unknown>[]),
        composed.entry as unknown as Record<string, unknown>,
    ]);
}

/** Start the server with OAuth on, and return its base URL. */
async function startWithOAuth(overrides: Partial<Config> = {}): Promise<string> {
    const db = `oauth-${++dbCounter}`;
    await seedVault(db);
    const port = await freePort();
    mcpUrl = `http://127.0.0.1:${port}/mcp`;

    const config: Config = {
        couch: { url: couch.url, database: db, username: undefined, password: undefined },
        replicaPath: join(replicaDir, `replica-${db}`),
        indexPath: join(replicaDir, `index-${db}.sqlite`),
        transcriptPath: join(replicaDir, `transcripts-${db}.sqlite`),
        formatOverrides: {},
        readOnly: false,
        attachmentSizeCap: 25 * 1024 * 1024,
        planCeiling: 500,
        dailyNotePath: undefined,
        timeZone: "Australia/Brisbane",
        auth: { mode: "oauth", issuer: issuerUrl, resource: mcpUrl, jwksUri: undefined },
        transport: { kind: "http", host: "127.0.0.1", port },
        logLevel: "error",
        ...overrides,
    };

    running = await start(config);
    return `http://127.0.0.1:${port}`;
}

/** One MCP request, as a client makes it. */
async function callMcp(base: string, body: unknown, bearer?: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
    });
}

const INITIALIZE = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
    },
};

beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-key" };

    couch = await startFakeCouch();
    replicaDir = await mkdtemp(join(tmpdir(), "livesync-oauth-"));
    ({ server: issuer, url: issuerUrl } = await startIssuer());
}, 120_000);

afterAll(async () => {
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
    await couch.stop();
    await rm(replicaDir, { recursive: true, force: true });
});

afterEach(async () => {
    await running?.stop().catch(() => undefined);
    running = undefined;

    // Let a replication poll that was already in flight when the server
    // stopped finish failing. Without this it lands after the fake CouchDB has
    // been torn down and surfaces as an unhandled ECONNRESET, which fails the
    // run for a reason that has nothing to do with what is being tested. The
    // tests here write to the vault, so there is more in flight at teardown
    // than in the read-only specs, which is why only this one needs it.
    await new Promise((resolve) => setTimeout(resolve, 250));
});

describe("the unauthenticated handshake", () => {
    it("answers a request with no token with a 401 that says where to authenticate", async () => {
        const base = await startWithOAuth();
        const response = await callMcp(base, INITIALIZE);

        // 401, not 200 with a message. A WWW-Authenticate header on a 200 is
        // ignored, and the client never learns there is an issuer at all.
        expect(response.status).toBe(401);

        const challenge = response.headers.get("www-authenticate") ?? "";
        expect(challenge).toMatch(/^Bearer /);
        expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        // Both scopes, because this deployment can write and the client asks
        // once. A challenge naming only the floor gets a read-only token
        // forever, whatever the authorization server would have granted, and
        // every write tool then refuses for want of a scope nobody requested.
        expect(challenge).toContain('scope="vault:read vault:write"');
    }, 120_000);

    it("asks only for read when this deployment cannot write", async () => {
        // The other half of the same rule. Asking a person to grant a
        // permission that no registered tool could exercise is a request for
        // access this server has no use for.
        const base = await startWithOAuth({ readOnly: true });
        const response = await callMcp(base, INITIALIZE);

        const challenge = response.headers.get("www-authenticate") ?? "";
        expect(challenge).toContain('scope="vault:read"');
        expect(challenge).not.toContain("vault:write");

        const metadata = (await (
            await fetch(`${base}/.well-known/oauth-protected-resource`)
        ).json()) as Record<string, unknown>;
        expect(metadata.scopes_supported).toEqual(["vault:read"]);
    }, 120_000);

    it("serves protected resource metadata naming the issuer and this exact resource", async () => {
        const base = await startWithOAuth();
        const response = await fetch(`${base}/.well-known/oauth-protected-resource`);

        expect(response.status).toBe(200);
        const metadata = (await response.json()) as Record<string, unknown>;

        // The resource must match what the client addressed, character for
        // character, or the audience in the token it obtains will not match
        // what this server checks.
        expect(metadata.resource).toBe(mcpUrl);
        expect(metadata.authorization_servers).toEqual([issuerUrl]);
        expect(metadata.scopes_supported).toEqual(["vault:read", "vault:write"]);
        expect(metadata.bearer_methods_supported).toEqual(["header"]);
    }, 120_000);

    it("does not require a token for the metadata or the healthcheck", async () => {
        const base = await startWithOAuth();
        expect((await fetch(`${base}/.well-known/oauth-protected-resource`)).status).toBe(200);
        expect((await fetch(`${base}/health`)).status).toBe(200);
    }, 120_000);

    it("refuses a credential that is not a bearer token", async () => {
        const base = await startWithOAuth();
        const response = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: "Basic dXNlcjpwYXNz",
            },
            body: JSON.stringify(INITIALIZE),
        });

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_request"');
    }, 120_000);
});

describe("presenting a token", () => {
    it("accepts one issued for this resource", async () => {
        const base = await startWithOAuth();
        const response = await callMcp(base, INITIALIZE, await token(["vault:read"]));

        expect(response.status).toBe(200);
    }, 120_000);

    it("refuses one issued for a different service, however valid", async () => {
        const base = await startWithOAuth();
        const response = await callMcp(
            base,
            INITIALIZE,
            await token(["vault:read", "vault:write"], "https://photos.example.com")
        );

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }, 120_000);

    it("refuses one carrying no usable scope, and says which is needed", async () => {
        const base = await startWithOAuth();
        const response = await callMcp(base, INITIALIZE, await token(["openid", "profile"]));

        // 403 rather than 401: the token is fine, it just does not authorize
        // this. A 401 would send the client back for a token it already has.
        expect(response.status).toBe(403);
        const challenge = response.headers.get("www-authenticate") ?? "";
        expect(challenge).toContain('error="insufficient_scope"');
        expect(challenge).toContain('scope="vault:read vault:write"');
    }, 120_000);
});

describe("scope at the tool boundary", () => {
    /** Initialize, then call one tool, on one session. */
    async function callTool(base: string, bearer: string, name: string, args: Record<string, unknown>) {
        const init = await callMcp(base, INITIALIZE, bearer);
        expect(init.status).toBe(200);
        const sessionId = init.headers.get("mcp-session-id");

        await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${bearer}`,
                ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });

        const response = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${bearer}`,
                ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name, arguments: args },
            }),
        });

        const text = await response.text();
        return { status: response.status, text };
    }

    it("lets a read-only token read", async () => {
        const base = await startWithOAuth();
        const result = await callTool(base, await token(["vault:read"]), "read_note", {
            path: "notes/hello.md",
        });

        expect(result.text).toContain("Hello");
    }, 120_000);

    it("refuses a write on a read-only token, naming the scope it lacks", async () => {
        const base = await startWithOAuth();
        const result = await callTool(base, await token(["vault:read"]), "create_note", {
            path: "notes/should-not-exist.md",
            content: "nope",
        });

        expect(result.text).toContain("vault:write");
        // Nothing was written, and the vault says so rather than the tool.
        expect(await couch.get(`oauth-${dbCounter}`, "notes/should-not-exist.md")).toBeUndefined();
    }, 120_000);

    it("allows the same write once the token carries vault:write", async () => {
        const base = await startWithOAuth();
        const result = await callTool(base, await token(["vault:read", "vault:write"]), "create_note", {
            path: "notes/written.md",
            content: "yes",
        });

        expect(result.text).toContain("Created");
        expect(await couch.get(`oauth-${dbCounter}`, "notes/written.md")).toBeDefined();
    }, 120_000);
});
