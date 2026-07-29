/**
 * Reading the auth mode out of the environment.
 *
 * Worth its own tests because every failure here is a deployment that starts
 * and looks healthy. A server that silently falls back to no authentication is
 * indistinguishable from a working one until somebody finds it, and a server
 * that rejects every token because a URL has a trailing slash reports nothing
 * that points at the URL.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

const BASE = {
    COUCHDB_URL: "https://couch.example.com",
    COUCHDB_DATABASE: "vault",
    MCP_TRANSPORT: "http",
};

let saved: NodeJS.ProcessEnv;

/** Replace the environment wholesale, so a stray variable cannot leak in. */
function withEnv(vars: Record<string, string | undefined>) {
    for (const key of Object.keys(process.env)) {
        if (
            /^(COUCHDB|MCP|OAUTH|AUTH|E2EE|READ_ONLY|DAILY|VAULT|PLAN|ATTACHMENT|REPLICA|INDEX|TRANSCRIPT|LOG|PATH_OBF|HASH_ALG|CHUNK_)/.test(
                key
            )
        ) {
            delete process.env[key];
        }
    }
    for (const [key, value] of Object.entries(vars)) {
        if (value !== undefined) process.env[key] = value;
    }
}

beforeEach(() => {
    saved = { ...process.env };
});

afterEach(() => {
    process.env = saved;
});

describe("choosing a mode", () => {
    it("infers oauth from an issuer alone", () => {
        withEnv({
            ...BASE,
            OAUTH_ISSUER: "https://auth.example.com",
            MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
        });

        expect(loadConfig().auth).toEqual({
            mode: "oauth",
            issuer: "https://auth.example.com",
            resource: "https://mcp.example.com/mcp",
            jwksUri: undefined,
        });
    });

    it("infers bearer from a token alone", () => {
        withEnv({ ...BASE, MCP_BEARER_TOKEN: "shhh" });
        expect(loadConfig().auth).toEqual({ mode: "bearer", token: "shhh" });
    });

    it("refuses to guess when both are set", () => {
        withEnv({
            ...BASE,
            OAUTH_ISSUER: "https://auth.example.com",
            MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
            MCP_BEARER_TOKEN: "shhh",
        });

        expect(() => loadConfig()).toThrow(/not clear which should apply/);
    });

    it("takes AUTH_MODE as the tiebreak", () => {
        withEnv({
            ...BASE,
            AUTH_MODE: "bearer",
            OAUTH_ISSUER: "https://auth.example.com",
            MCP_BEARER_TOKEN: "shhh",
        });

        expect(loadConfig().auth).toEqual({ mode: "bearer", token: "shhh" });
    });

    it("refuses to serve HTTP with no authentication unless told to in words", () => {
        withEnv(BASE);
        expect(() => loadConfig()).toThrow(/Refusing to expose the vault over HTTP/);

        withEnv({ ...BASE, AUTH_MODE: "none" });
        expect(loadConfig().auth).toEqual({ mode: "none" });
    });

    it("ignores all of it on stdio, where the transport is the boundary", () => {
        withEnv({ COUCHDB_URL: BASE.COUCHDB_URL, COUCHDB_DATABASE: "vault" });
        expect(loadConfig().auth).toEqual({ mode: "none" });
    });

    it("rejects a mode it does not know", () => {
        withEnv({ ...BASE, AUTH_MODE: "mtls" });
        expect(() => loadConfig()).toThrow(/must be "oauth", "bearer" or "none"/);
    });
});

describe("the OAuth settings", () => {
    const oauth = (extra: Record<string, string | undefined>) =>
        withEnv({ ...BASE, AUTH_MODE: "oauth", OAUTH_ISSUER: "https://auth.example.com", ...extra });

    it("insists on the public URL, because it is the audience", () => {
        oauth({});
        expect(() => loadConfig()).toThrow(/MCP_PUBLIC_URL is not set/);
    });

    it("insists on an issuer", () => {
        withEnv({ ...BASE, AUTH_MODE: "oauth", MCP_PUBLIC_URL: "https://mcp.example.com/mcp" });
        expect(() => loadConfig()).toThrow(/OAUTH_ISSUER is not set/);
    });

    it("refuses a plaintext URL, since a bearer token would be readable on the wire", () => {
        oauth({ MCP_PUBLIC_URL: "http://mcp.example.com/mcp" });
        expect(() => loadConfig()).toThrow(/must use https/);
    });

    it("allows loopback, so it can be run and tested locally", () => {
        oauth({ MCP_PUBLIC_URL: "http://127.0.0.1:8080/mcp" });
        expect(loadConfig().auth).toMatchObject({ resource: "http://127.0.0.1:8080/mcp" });
    });

    it("refuses a resource carrying a query or a fragment", () => {
        oauth({ MCP_PUBLIC_URL: "https://mcp.example.com/mcp?v=1" });
        expect(() => loadConfig()).toThrow(/no query string or fragment/);

        oauth({ MCP_PUBLIC_URL: "https://mcp.example.com/mcp#x" });
        expect(() => loadConfig()).toThrow(/no query string or fragment/);
    });

    it("refuses something that is not a URL at all", () => {
        oauth({ MCP_PUBLIC_URL: "mcp.example.com" });
        expect(() => loadConfig()).toThrow(/not an absolute URL/);
    });

    it("strips a trailing slash, which would otherwise fail every audience check", () => {
        oauth({ MCP_PUBLIC_URL: "https://mcp.example.com/mcp/", OAUTH_ISSUER: "https://auth.example.com/" });
        expect(loadConfig().auth).toMatchObject({
            resource: "https://mcp.example.com/mcp",
            issuer: "https://auth.example.com",
        });
    });

    it("carries an explicit JWKS URI through", () => {
        oauth({
            MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
            OAUTH_JWKS_URI: "https://auth.example.com/keys",
        });
        expect(loadConfig().auth).toMatchObject({ jwksUri: "https://auth.example.com/keys" });
    });
});

describe("the bearer settings", () => {
    it("insists on a token", () => {
        withEnv({ ...BASE, AUTH_MODE: "bearer" });
        expect(() => loadConfig()).toThrow(/MCP_BEARER_TOKEN is not set/);
    });
});

describe("ConfigError", () => {
    it("is what all of these are", () => {
        withEnv(BASE);
        expect(() => loadConfig()).toThrow(ConfigError);
    });
});
