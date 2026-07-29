import { describe, expect, it } from "vitest";
import { challengeHeader, insufficientScope, unauthorized } from "../../src/auth/challenge.js";
import { MissingScopeError, requireScope, SCOPE_READ, SCOPE_WRITE } from "../../src/auth/scopes.js";

const METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource";

describe("challengeHeader", () => {
    it("always points at the metadata document", () => {
        expect(challengeHeader({ resourceMetadata: METADATA })).toBe(
            `Bearer resource_metadata="${METADATA}"`
        );
    });

    it("carries the error, the description and the scopes", () => {
        const header = challengeHeader({
            resourceMetadata: METADATA,
            error: "insufficient_scope",
            description: "needs more",
            scope: [SCOPE_READ, SCOPE_WRITE],
        });

        expect(header).toBe(
            `Bearer error="insufficient_scope", error_description="needs more", ` +
                `scope="vault:read vault:write", resource_metadata="${METADATA}"`
        );
    });

    it("escapes a description containing quotes rather than throwing", () => {
        // This is the bug the integration tests caught: a throw from here
        // escaped the authentication hook and the transport replaced the whole
        // challenge with one of its own invention.
        const header = challengeHeader({
            resourceMetadata: METADATA,
            description: 'It must carry at least "vault:read".',
        });

        expect(header).toContain(String.raw`error_description="It must carry at least \"vault:read\"."`);
    });

    it("escapes a backslash", () => {
        const header = challengeHeader({ resourceMetadata: METADATA, description: "a\\b" });
        expect(header).toContain(String.raw`error_description="a\\b"`);
    });

    it("refuses a control character, which cannot be escaped into a header", () => {
        expect(() =>
            challengeHeader({
                resourceMetadata: METADATA,
                description: `line one${String.fromCodePoint(10)}Set-Cookie: x`,
            })
        ).toThrow(/control character/);
    });

    it("omits an empty scope list rather than emitting an empty parameter", () => {
        expect(challengeHeader({ resourceMetadata: METADATA, scope: [] })).not.toContain("scope=");
    });
});

describe("responses", () => {
    it("challenges with 401 and says nothing about the vault", async () => {
        const response = unauthorized({ resourceMetadata: METADATA, scope: [SCOPE_READ] });

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
        expect(await response.text()).toBe("Unauthorized");
    });

    it("uses 403 for a token that is valid but does not cover this", () => {
        const response = insufficientScope({ resourceMetadata: METADATA, scope: [SCOPE_WRITE] });

        expect(response.status).toBe(403);
        expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
        expect(response.headers.get("www-authenticate")).toContain('scope="vault:write"');
    });
});

describe("requireScope", () => {
    it("allows a session holding the scope", () => {
        expect(() => requireScope({ scopes: new Set([SCOPE_READ, SCOPE_WRITE]) }, SCOPE_WRITE)).not.toThrow();
    });

    it("refuses a session that does not", () => {
        expect(() => requireScope({ scopes: new Set([SCOPE_READ]) }, SCOPE_WRITE)).toThrow(MissingScopeError);
    });

    it("refuses a token granted nothing at all", () => {
        expect(() => requireScope({ scopes: new Set() }, SCOPE_READ)).toThrow(MissingScopeError);
    });

    it("allows a deployment that does not use scopes at all", () => {
        // stdio, or a shared bearer token. An absent scope set is not the same
        // as an empty one, and conflating them would break both of those.
        expect(() => requireScope({}, SCOPE_WRITE)).not.toThrow();
        expect(() => requireScope(undefined, SCOPE_WRITE)).not.toThrow();
    });

    it("names the scope, so the message says what to grant", () => {
        expect(() => requireScope({ scopes: new Set() }, SCOPE_WRITE)).toThrow(/vault:write/);
    });
});
