/**
 * Our document transform against the plugin's.
 *
 * The suite in `test/vault-model/transform.spec.ts` round-trips our encode
 * against our decode, which is self-consistent by construction and proves
 * nothing about wire compatibility. This is the test that does: it runs
 * documents through the plugin's real `incoming`/`outgoing` transforms and
 * checks that each side can read the other's output.
 *
 * It is also the test that catches non-idempotent encoding, which is the one
 * mistake in this area that destroys a note outright rather than failing.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf.js";
import * as upstreamEncryption from "../../node_modules/@vrtmrz/livesync-commonlib/dist/pouchdb/encryption.js";
import { decodeDocument, encodeDocument } from "../../src/vault-model/transform.js";
import type { TransformContext } from "../../src/vault-model/transform.js";
import { E2EEAlgorithms } from "../../src/vault-model/settings.js";
import { TYPE_CHUNK, TYPE_NOTE_PLAIN } from "../../src/vault-model/constants.js";
import { asDocumentID, asVaultPath } from "../../src/vault-model/types.js";

const PASSPHRASE = "correct horse battery staple";

type Transforms = {
    incoming: (doc: unknown) => Promise<Record<string, unknown>>;
    outgoing: (doc: unknown) => Promise<Record<string, unknown>>;
};

let salt: Uint8Array<ArrayBuffer>;
let ours: TransformContext;
let theirs: Transforms;

beforeAll(() => {
    salt = new Uint8Array(createPBKDF2Salt()) as Uint8Array<ArrayBuffer>;
    ours = {
        crypto: {
            passphrase: PASSPHRASE,
            pbkdf2Salt: salt,
            useDynamicIterationCount: false,
            algorithm: E2EEAlgorithms.V2,
        },
        enableCompression: false,
        encryptChunks: true,
    };
    theirs = (
        upstreamEncryption.getConfiguredFunctionsForEncryption as unknown as (
            passphrase: string,
            useDynamicIterationCount: boolean,
            migrationDecrypt: boolean,
            getPBKDF2Salt: () => Promise<Uint8Array>,
            algorithm: string
        ) => Transforms
    )(PASSPHRASE, false, false, async () => salt, "v2");
});

const chunkDoc = (data: string) => ({
    _id: asDocumentID("h:+abc123"),
    type: TYPE_CHUNK,
    data,
    e_: undefined as boolean | undefined,
});

const fileDoc = () => ({
    _id: asDocumentID("f:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    path: asVaultPath("Folder/Secret Note.md"),
    ctime: 1_700_000_000_000,
    mtime: 1_700_000_001_000,
    size: 42,
    type: TYPE_NOTE_PLAIN,
    children: ["h:+one", "h:+two"],
    eden: {},
});

describe("the plugin can read what we write", () => {
    it("reads our encrypted chunk", async () => {
        const wire = await encodeDocument(chunkDoc("our chunk content"), ours);
        const back = await theirs.outgoing(wire);
        expect(back.data).toBe("our chunk content");
    });

    it("reads our sealed metadata, every field", async () => {
        const original = fileDoc();
        const wire = await encodeDocument(original, ours);
        const back = await theirs.outgoing(wire);

        expect(back.path).toBe(original.path);
        expect(back.mtime).toBe(original.mtime);
        expect(back.ctime).toBe(original.ctime);
        expect(back.size).toBe(original.size);
        expect(back.children).toEqual(original.children);
    });
});

describe("we can read what the plugin writes", () => {
    it("reads its encrypted chunk", async () => {
        const wire = await theirs.incoming(chunkDoc("their chunk content"));
        const back = await decodeDocument(wire as never, ours);
        expect((back as { data: string }).data).toBe("their chunk content");
    });

    it("reads its sealed metadata, every field", async () => {
        const original = fileDoc();
        const wire = await theirs.incoming(original);
        const back = (await decodeDocument(wire as never, ours)) as unknown as ReturnType<typeof fileDoc>;

        expect(back.path).toBe(original.path);
        expect(back.mtime).toBe(original.mtime);
        expect(back.ctime).toBe(original.ctime);
        expect(back.size).toBe(original.size);
        expect(back.children).toEqual(original.children);
    });
});

describe("idempotence", () => {
    it("matches the plugin: encoding twice is a no-op, not a second seal", async () => {
        // Sealing an already-sealed document would encrypt the zeroed
        // timestamps and the emptied chunk list, losing the note's content
        // permanently while leaving a document that still reads cleanly.
        const wireOnce = await theirs.incoming(fileDoc());
        const wireTwice = await theirs.incoming({ ...wireOnce });
        expect(wireTwice.path).toBe(wireOnce.path);
    });

    it("refuses to re-seal rather than silently destroying the chunk list", async () => {
        const wireOnce = await encodeDocument(fileDoc(), ours);
        await expect(encodeDocument(wireOnce, ours)).rejects.toThrow(/already carries encrypted metadata/);
    });

    it("does not re-encrypt an already-encrypted chunk", async () => {
        const wireOnce = await encodeDocument(chunkDoc("content"), ours);
        const wireTwice = await encodeDocument(wireOnce, ours);
        expect(wireTwice.data).toBe(wireOnce.data);
    });
});

describe("the shape on the wire", () => {
    it("zeroes the same fields the plugin zeroes", async () => {
        const mine = await encodeDocument(fileDoc(), ours);
        const theirsWire = await theirs.incoming(fileDoc());

        for (const key of ["mtime", "ctime", "size"] as const) {
            expect(mine[key], key).toBe(theirsWire[key]);
        }
        expect(mine.children).toEqual(theirsWire.children);
        expect(mine.type).toBe(theirsWire.type);
        // The ciphertext differs — fresh salt and IV per message — but the
        // marker prefix must not.
        expect(String(mine.path).slice(0, 5)).toBe(String(theirsWire.path).slice(0, 5));
    });

    it("marks encrypted documents the same way", async () => {
        const mine = await encodeDocument(chunkDoc("x"), ours);
        const theirsWire = await theirs.incoming(chunkDoc("x"));
        expect(mine.e_).toBe(theirsWire.e_);
        expect(String(mine.data).slice(0, 2)).toBe(String(theirsWire.data).slice(0, 2));
    });
});
