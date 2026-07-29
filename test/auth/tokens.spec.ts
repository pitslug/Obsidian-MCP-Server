/**
 * Token verification.
 *
 * The test that earns its place is "rejects a token issued for another
 * service". Every other check here fails loudly in development; that one
 * passes in development, passes in testing, and is the difference between a
 * vault only Claude can read and a vault that any application sharing the
 * identity provider can read.
 *
 * Keys are generated per run rather than checked in, so nothing here is a
 * credential and a leaked fixture cannot become a real one.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { TokenRejectedError, TokenVerifier, bearerFrom } from "../../src/auth/tokens.js";

const ISSUER = "https://auth.example.com";
const RESOURCE = "https://obsidian-mcp.example.com/mcp";

let privateKey: KeyObject | CryptoKey;
let publicJwk: JWK;
let otherPrivateKey: KeyObject | CryptoKey;

/** An issuer that answers discovery and publishes one key. */
function fakeIssuer(overrides: { jwks?: unknown; discovery?: unknown } = {}): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
            return json(
                overrides.discovery ?? { issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` }
            );
        }
        if (url === `${ISSUER}/.well-known/jwks.json`) {
            return json(overrides.jwks ?? { keys: [publicJwk] });
        }
        return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

interface TokenOptions {
    audience?: string | string[];
    issuer?: string;
    scope?: string;
    scp?: string[];
    subject?: string | undefined;
    expiresIn?: string;
    signWith?: "correct" | "other";
}

async function token(options: TokenOptions = {}): Promise<string> {
    let jwt = new SignJWT({
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.scp === undefined ? {} : { scp: options.scp }),
    })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? RESOURCE)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "10m");

    if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? "user-chris");

    return jwt.sign(options.signWith === "other" ? otherPrivateKey : privateKey);
}

const verifier = (fetchImpl: typeof fetch = fakeIssuer()) =>
    new TokenVerifier({ issuer: ISSUER, resource: RESOURCE, fetchImpl });

beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "ES256", kid: "test-key" };
    otherPrivateKey = (await generateKeyPair("ES256", { extractable: true })).privateKey;
});

describe("bearerFrom", () => {
    it("finds the token", () => {
        expect(bearerFrom("Bearer abc.def.ghi")).toBe("abc.def.ghi");
        expect(bearerFrom("bearer abc")).toBe("abc");
    });

    it("says nothing when there is no header at all", () => {
        expect(bearerFrom(undefined)).toBeUndefined();
    });

    it("refuses a credential that is not a bearer token", () => {
        expect(() => bearerFrom("Basic dXNlcjpwYXNz")).toThrow(TokenRejectedError);
    });
});

describe("TokenVerifier", () => {
    it("accepts a token issued for this resource", async () => {
        const principal = await verifier().verify(await token({ scope: "vault:read vault:write" }));

        expect(principal.subject).toBe("user-chris");
        expect([...principal.scopes].sort()).toEqual(["vault:read", "vault:write"]);
    });

    it("rejects a token issued for another service on the same issuer", async () => {
        // The whole point. This token is signed by the right key, by the right
        // issuer, has not expired, and belongs to the same person. It is a
        // token for the photo library, and it must not open the vault.
        await expect(
            verifier().verify(await token({ audience: "https://photos.example.com" }))
        ).rejects.toThrow(/not issued for https:\/\/obsidian-mcp\.example\.com\/mcp/);
    });

    it("accepts a token whose audience list includes this resource", async () => {
        const principal = await verifier().verify(
            await token({ audience: [RESOURCE, ISSUER], scope: "vault:read" })
        );
        expect(principal.subject).toBe("user-chris");
    });

    it("rejects a token with no audience at all", async () => {
        await expect(verifier().verify(await token({ audience: [] }))).rejects.toThrow(
            /no audience|not issued for/
        );
    });

    it("does not accept a resource that merely resembles this one", async () => {
        for (const near of [`${RESOURCE}/`, `${RESOURCE}x`, "https://obsidian-mcp.example.com"]) {
            await expect(verifier().verify(await token({ audience: near }))).rejects.toThrow(
                TokenRejectedError
            );
        }
    });

    it("rejects a token from a different issuer", async () => {
        await expect(verifier().verify(await token({ issuer: "https://evil.example.com" }))).rejects.toThrow(
            /not issued by the expected authorization server/
        );
    });

    it("rejects a token signed by a key the issuer does not publish", async () => {
        await expect(verifier().verify(await token({ signWith: "other" }))).rejects.toThrow(
            /not signed by a key the authorization server publishes/
        );
    });

    it("rejects an expired token, and says so", async () => {
        await expect(verifier().verify(await token({ expiresIn: "-1h" }))).rejects.toThrow(/expired/);
    });

    it("reads scopes from scp as well as scope", async () => {
        const fromArray = await verifier().verify(await token({ scp: ["vault:read", "vault:write"] }));
        expect([...fromArray.scopes].sort()).toEqual(["vault:read", "vault:write"]);

        const fromBoth = await verifier().verify(await token({ scope: "vault:read", scp: ["vault:write"] }));
        expect([...fromBoth.scopes].sort()).toEqual(["vault:read", "vault:write"]);
    });

    it("reports no scopes rather than guessing when the token carries none", async () => {
        const principal = await verifier().verify(await token());
        expect(principal.scopes.size).toBe(0);
    });

    it("discovers the keys once and reuses them", async () => {
        let discoveryCalls = 0;
        const counting = (async (input: RequestInfo | URL) => {
            if (String(input).includes("openid-configuration")) discoveryCalls++;
            return fakeIssuer()(input);
        }) as unknown as typeof fetch;

        const shared = verifier(counting);
        await shared.verify(await token());
        await shared.verify(await token());

        expect(discoveryCalls).toBe(1);
    });

    it("falls back to the OAuth metadata path when there is no OpenID document", async () => {
        const oauthOnly = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === `${ISSUER}/.well-known/openid-configuration`) {
                return new Response("nope", { status: 404 });
            }
            if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
                return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
            }
            return json({ keys: [publicJwk] });
        }) as unknown as typeof fetch;

        const principal = await verifier(oauthOnly).verify(await token());
        expect(principal.subject).toBe("user-chris");
    });

    it("refuses a discovery document that claims to be a different issuer", async () => {
        const impostor = fakeIssuer({
            discovery: { issuer: "https://evil.example.com", jwks_uri: "https://evil.example.com/jwks" },
        });

        await expect(verifier(impostor).verify(await token())).rejects.toThrow(
            /identifies itself as "https:\/\/evil\.example\.com"/
        );
    });

    it("does not cache a failed discovery", async () => {
        let attempts = 0;
        const flaky = (async (input: RequestInfo | URL) => {
            if (String(input).includes("openid-configuration")) {
                attempts++;
                if (attempts === 1) return new Response("down", { status: 503 });
            }
            return fakeIssuer()(input);
        }) as unknown as typeof fetch;

        const shared = verifier(flaky);
        await expect(shared.verify(await token())).rejects.toThrow();
        // The identity provider was restarting. The next request must not be
        // answered from a cached failure.
        await expect(shared.verify(await token())).resolves.toMatchObject({ subject: "user-chris" });
    });

    it("uses a configured JWKS URI without discovering anything", async () => {
        let discoveryCalls = 0;
        const counting = (async (input: RequestInfo | URL) => {
            if (String(input).includes("openid-configuration")) discoveryCalls++;
            return fakeIssuer()(input);
        }) as unknown as typeof fetch;

        const direct = new TokenVerifier({
            issuer: ISSUER,
            resource: RESOURCE,
            jwksUri: `${ISSUER}/.well-known/jwks.json`,
            fetchImpl: counting,
        });

        await expect(direct.verify(await token())).resolves.toMatchObject({ subject: "user-chris" });
        expect(discoveryCalls).toBe(0);
    });

    it("says which setting to reach for when the keys cannot be found", async () => {
        const nothing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
        await expect(verifier(nothing).verify(await token())).rejects.toThrow(/OAUTH_JWKS_URI/);
    });
});
