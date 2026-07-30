#!/usr/bin/env node
/**
 * Acceptance gate step three: a verified write, against a throwaway database.
 *
 * Steps one and two proved that this code reads what the plugin writes, and
 * that the chunk IDs it *would* write match the ones the plugin actually wrote.
 * Neither of them wrote anything. This does, and it is the last thing standing
 * between the executor and the real vault.
 *
 * What it proves, and what it cannot
 *
 * It proves that every write path composes documents CouchDB accepts and this
 * code reads back correctly: create, edit, insert under a heading, set
 * properties across several notes, plan and commit, soft delete, undelete,
 * restore from a tombstone, move, copy, and a rename committed together with
 * the link rewrites it needs. It proves chunk reuse does not orphan a chunk,
 * that a move sends no chunks at all, and that the plan protocol refuses both a
 * stale plan and content composed from a read that went stale while the plan
 * was being made.
 *
 * It also reports, read-only, what `append_daily` would infer as this vault's
 * daily note template. That is worth looking at even when every check passes:
 * a wrong inference creates notes in a folder nobody opens, which looks exactly
 * like notes that were never created.
 *
 * It cannot prove Obsidian is happy, because Obsidian is not a library this can
 * call. That part is yours: point one Obsidian instance at the same throwaway
 * database, run this, and look. The script prints exactly what should appear
 * and where, so the check is a comparison rather than a judgement.
 *
 * SAFETY
 *
 * This script writes. That is the point of it, and everything below is
 * arranged so it can only write where you said.
 *
 *   - There is no default database. `--db` is required, and a missing one is a
 *     refusal rather than a guess.
 *   - `obsidiandb` and four names close to it are refused outright.
 *   - A database more than one device has synced to is refused, because that
 *     is what a real vault looks like whatever it is called. Override with
 *     --expect-devices once you have looked at why.
 *   - Every path it touches lives under a `mcp-write-check/` folder, and it
 *     deletes what it created on the way out.
 *   - It refuses to start when that folder is not already empty, rather than
 *     writing over whatever an earlier run left behind. `--reset` clears it.
 *
 * Those checks run before a single document is composed. See
 * `src/write/scratch.ts`.
 *
 * USAGE
 *
 *   npx tsx scripts/verify-write.ts \
 *     --url https://user:password@couchdb.example.net \
 *     --db obsidian-writetest \
 *     [--passphrase '...'] \
 *     [--expect-devices 1] \
 *     [--reset] \
 *     [--keep]
 *
 * Prefer setting COUCHDB_URL in the environment over passing a password on the
 * command line, where it lands in your shell history.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
    assembleFile,
    decodeDocument,
    decodePbkdf2Salt,
    DOCID_MILESTONE,
    DOCID_SYNC_PARAMETERS,
    readTweakValues,
    resolveSettings,
    transformContextFor,
    type ChunkEntry,
    type ChunkedEntry,
    type MilestoneEntry,
    type TransformContext,
    type VaultFormatSettings,
} from "../src/vault-model/index.js";
import { Replicator } from "../src/replicator/index.js";
import { VaultReader } from "../src/vault/reader.js";
import { CouchWriter } from "../src/write/couch.js";
import { PlanningWriteExecutor } from "../src/write/plans.js";
import { PlanStaleError } from "../src/write/plans.js";
import { renderPlan } from "../src/write/render.js";
import { assertScratchDatabase } from "../src/write/scratch.js";
import { DestinationExistsError } from "../src/write/executor.js";
import { appendUnderHeading } from "../src/note/sections.js";
import { rewriteLinkTargets } from "../src/note/links.js";
import { editFrontmatter } from "../src/note/frontmatter.js";
import { civilDateIn, fillTemplate, hostTimeZone, inferDailyFormat } from "../src/note/daily.js";
import { endpointFor, databaseUrl, documentUrl, headersFor } from "../src/couch/rest.js";
import type { CouchConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
    couch: CouchConfig;
    passphrase: string | undefined;
    expectedDevices: number;
    keep: boolean;
    reset: boolean;
}

class VerificationStopped extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VerificationStopped";
    }
}

function fail(message: string): never {
    throw new VerificationStopped(message);
}

function parseArgs(argv: string[]): Options {
    const get = (name: string): string | undefined => {
        const at = argv.indexOf(`--${name}`);
        return at >= 0 ? argv[at + 1] : undefined;
    };

    const rawUrl = get("url") ?? process.env.COUCHDB_URL ?? "";
    if (!rawUrl) {
        fail(
            "No CouchDB URL. Pass --url https://host, or set COUCHDB_URL.\n" +
                "Credentials may be embedded in the URL, or given with --user/--pass."
        );
    }

    const parsed = new URL(rawUrl);
    const db = get("db") ?? parsed.searchParams.get("db") ?? process.env.COUCHDB_DB ?? "";
    const user = get("user") ?? process.env.COUCHDB_USER ?? decodeComponent(parsed.username);
    const pass = get("pass") ?? process.env.COUCHDB_PASSWORD ?? decodeComponent(parsed.password);

    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");

    return {
        couch: {
            url: parsed.toString().replace(/\/+$/, ""),
            database: db,
            username: user,
            password: pass,
        },
        passphrase: get("passphrase") ?? process.env.LIVESYNC_PASSPHRASE,
        expectedDevices: Number(get("expect-devices") ?? 1),
        keep: argv.includes("--keep"),
        reset: argv.includes("--reset"),
    };
}

function decodeComponent(value: string): string | undefined {
    if (!value) return undefined;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ok = (s: string) => `  [32m✓[0m ${s}`;
const bad = (s: string) => `  [31m✗[0m ${s}`;
const warn = (s: string) => `  [33m![0m ${s}`;
const info = (s: string) => `    ${s}`;
const heading = (s: string) => `\n[1m${s}[0m`;

/**
 * What the human is asked to look at, in two kinds.
 *
 * `expectFinal` is state that is still true when the script exits, and is
 * therefore a checklist. `expectAlong` is state that existed partway through
 * and has since been written over, which is only observable by watching
 * Obsidian while the run happens.
 *
 * Keeping them apart matters. A single list reading "second.md has disappeared"
 * and "second.md is back" is not a checklist, it is a transcript, and handing
 * someone a transcript labelled "you should see" wastes their time at exactly
 * the moment they are trying to decide whether to trust this with their vault.
 */
const finalState: string[] = [];
const alongTheWay: string[] = [];
const expectFinal = (s: string) => finalState.push(s);
const expectAlong = (s: string) => alongTheWay.push(s);

// ---------------------------------------------------------------------------
// Reading back, independently of the executor
// ---------------------------------------------------------------------------

/**
 * A GET-only reader, used to check the executor's work.
 *
 * Deliberately not the executor's own client and deliberately not the replica.
 * Checking a write by asking the thing that made it, or by asking a cache it
 * populated, would pass just as happily if the write never left the process.
 */
class Verifier {
    private readonly endpoint;

    constructor(couch: CouchConfig) {
        this.endpoint = endpointFor(couch);
    }

    async raw(id: string): Promise<Record<string, unknown> | undefined> {
        const response = await fetch(documentUrl(this.endpoint, id), {
            method: "GET",
            headers: headersFor(this.endpoint),
        });
        if (response.status === 404) return undefined;
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `GET ${id} returned ${response.status} ${response.statusText}` +
                    (body ? `\n    ${body.slice(0, 300)}` : "")
            );
        }
        return (await response.json()) as Record<string, unknown>;
    }

    /** Assemble a file from CouchDB, through the vault model, as a device would. */
    async text(id: string, ctx: TransformContext): Promise<string | undefined> {
        const rawEntry = await this.raw(id);
        if (!rawEntry) return undefined;
        const entry = (await decodeDocument(rawEntry as never, ctx)) as unknown as ChunkedEntry;

        const chunks = new Map<string, ChunkEntry>();
        for (const child of entry.children ?? []) {
            const rawChunk = await this.raw(child);
            if (!rawChunk) continue;
            chunks.set(child, (await decodeDocument(rawChunk as never, ctx)) as unknown as ChunkEntry);
        }

        const file = assembleFile(entry, chunks);
        return file.kind === "text" ? file.text : undefined;
    }
}

// ---------------------------------------------------------------------------
// The scratch folder, between runs
// ---------------------------------------------------------------------------

interface Leftover {
    id: string;
    rev: string;
}

/**
 * Whatever is currently sitting under the scratch folder.
 *
 * A range over `_all_docs` rather than a GET per path this run knows about: a
 * run that failed partway leaves whatever it had reached, and an older version
 * of this script used names this one does not. The question worth asking is
 * "is the folder empty", not "are the seven documents I am about to write
 * absent".
 *
 * Soft-deleted documents are included, and that is the point. LiveSync deletes
 * by writing `deleted: true` and keeping the document, so a folder deleted in
 * Obsidian still has a document at every path, a plain GET still returns 200,
 * and a create asserting absence still fails. Only a hard delete is invisible
 * here, which is what this script's own cleanup does.
 */
async function leftoversUnder(couch: CouchConfig, folder: string): Promise<Leftover[]> {
    const endpoint = endpointFor(couch);
    const url = databaseUrl(endpoint, "_all_docs");
    url.searchParams.set("startkey", JSON.stringify(`${folder}/`));
    // U+FFF0 sorts after anything a vault path contains, which is CouchDB's
    // own idiom for "every key with this prefix".
    url.searchParams.set("endkey", JSON.stringify(`${folder}/\uFFF0`));

    const response = await fetch(url, { method: "GET", headers: headersFor(endpoint) });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `Could not list "${folder}/" in "${couch.database}": ` +
                `${response.status} ${response.statusText}` +
                (body ? `\n    ${body.slice(0, 300)}` : "")
        );
    }

    const body = (await response.json()) as { rows?: { id: string; value?: { rev?: string } }[] };
    return (body.rows ?? [])
        .filter((row) => typeof row.value?.rev === "string")
        .map((row) => ({ id: row.id, rev: row.value?.rev as string }));
}

/**
 * Remove leftovers properly, which means `_deleted` rather than `deleted`.
 *
 * A soft delete would leave exactly the problem it was called to solve.
 */
async function hardDelete(couch: CouchConfig, docs: readonly Leftover[]): Promise<void> {
    const endpoint = endpointFor(couch);
    for (const doc of docs) {
        const response = await fetch(documentUrl(endpoint, doc.id, { rev: doc.rev }), {
            method: "DELETE",
            headers: headersFor(endpoint),
        });
        if (!response.ok && response.status !== 404) {
            const body = await response.text().catch(() => "");
            throw new Error(
                `Could not remove "${doc.id}": ${response.status} ${response.statusText}` +
                    (body ? `\n    ${body.slice(0, 300)}` : "")
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Everything this creates lives here, so a failed run is trivial to clean up. */
const FOLDER = "mcp-write-check";

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const verifier = new Verifier(options.couch);
    let failures = 0;
    const check = (condition: boolean, description: string, detail?: string) => {
        if (condition) {
            console.log(ok(description));
        } else {
            failures++;
            console.log(bad(description));
            if (detail) console.log(info(detail));
        }
    };

    // --- Refusals, before anything is composed ------------------------------

    console.log(heading("Target"));
    const milestone = (await verifier.raw(DOCID_MILESTONE).catch(() => undefined)) as
        MilestoneEntry | undefined;

    try {
        assertScratchDatabase(options.couch.database, {
            milestone,
            expectedDevices: options.expectedDevices,
        });
    } catch (error) {
        fail((error as Error).message);
    }

    const nodes = milestone?.accepted_nodes ?? [];
    console.log(ok(`Writing to "${options.couch.database}", which ${nodes.length} device(s) have synced`));

    // --- Settings, read from the database itself ----------------------------

    const { settings: published, conflicts, nodeCount } = readTweakValues(milestone);

    // A database no device has published settings to is not a database this
    // may write to, and the reason is not obvious enough to leave as a warning.
    //
    // Settings live in the milestone document, which is a `_local` document,
    // and `_local` documents do not replicate. So a scratch database made by
    // copying a real one arrives with none, and every setting falls back to a
    // default. `customChunkSize` defaulting to 0 turns `absoluteMaxPieceSize`
    // into 100 KiB, which is below the 256 KiB unit the binary path uses, so
    // every attachment gets sliced at exactly 100 KiB while text is unaffected
    // (its own maximum is 1 KiB, far below the cap either way).
    //
    // The result is a write that succeeds, reads back correctly, and is chunked
    // unlike every other document in the vault. Nothing downstream would notice,
    // and the test would have proved the opposite of what it set out to.
    if (nodeCount === 0) {
        fail(
            `No device has published settings to "${options.couch.database}", so the vault's own ` +
                `chunk parameters are unknown and this would write with defaults.\n\n` +
                `  If you made this database by replicating another one, that is expected: the ` +
                `milestone document is a _local document and does not replicate.\n\n` +
                `  Point one Obsidian instance at this database and let it sync, then run this again. ` +
                `Confirm with:\n` +
                `    npm run verify -- --url '...' --db ${options.couch.database}`
        );
    }

    for (const [key, values] of Object.entries(conflicts)) {
        fail(
            `Devices disagree on "${key}": ${values.map((v) => JSON.stringify(v)).join(", ")}. ` +
                `Resolve that in Obsidian before writing anything.`
        );
    }

    const settings: VaultFormatSettings = resolveSettings({
        ...published,
        ...(options.passphrase ? { passphrase: options.passphrase } : {}),
    });
    if (settings.encrypt && !settings.passphrase) {
        fail("This database is encrypted. Re-run with --passphrase, or set LIVESYNC_PASSPHRASE.");
    }
    if (settings.useEden) {
        fail(
            "useEden is on for this database. The write path refuses to reuse chunks from an eden " +
                "document, so writing would work, but this is not a representative test of the vault."
        );
    }

    const syncParams = (await verifier.raw(DOCID_SYNC_PARAMETERS)) as { pbkdf2salt?: string } | undefined;
    const salt = syncParams?.pbkdf2salt ? decodePbkdf2Salt(syncParams.pbkdf2salt) : undefined;
    const ctx = transformContextFor(settings, salt);
    console.log(
        info(
            `encrypt=${settings.encrypt} obfuscation=${settings.usePathObfuscation} ` +
                `compression=${settings.enableCompression} splitter=${settings.chunkSplitterVersion}`
        )
    );

    // --- The scratch folder, before anything is written ---------------------
    //
    // Last of the refusals, and first of the things that costs a request. It
    // has to happen here rather than at the first write: replicating the whole
    // database takes a minute or two, and discovering afterwards that the run
    // was never going to start is a minute spent for nothing.

    const leftovers = await leftoversUnder(options.couch, FOLDER);
    if (leftovers.length > 0 && !options.reset) {
        fail(
            `"${FOLDER}/" is not empty in "${options.couch.database}": ` +
                `${leftovers.length} document(s) are already there.\n\n` +
                leftovers.map((doc) => `    ${doc.id}`).join("\n") +
                `\n\n  A previous run with --keep left them. The first thing this script does is ` +
                `create a note asserting nothing is at its path, so it would stop at the first ` +
                `write rather than overwrite one of them.\n\n` +
                `  Deleting the folder in Obsidian does not clear this. LiveSync deletes by ` +
                `writing "deleted: true" and keeping the document, so every path still has one ` +
                `and a plain GET still returns it.\n\n` +
                `  Re-run with --reset to remove them properly first.`
        );
    }
    if (leftovers.length > 0) {
        console.log(heading("Clearing the scratch folder"));
        await hardDelete(options.couch, leftovers);
        console.log(ok(`Removed ${leftovers.length} document(s) left by an earlier run`));
    }

    // --- The stack ----------------------------------------------------------

    console.log(heading("Replicating"));
    const replicaDir = await mkdtemp(join(tmpdir(), "livesync-writecheck-"));
    const replicator = new Replicator({
        remoteUrl: remoteUrlFor(options.couch),
        replicaPath: join(replicaDir, "replica"),
        transform: ctx,
    });

    const executor = new PlanningWriteExecutor({
        couch: new CouchWriter({ couch: options.couch, readOnly: false }),
        replicator,
        settings,
        transform: ctx,
        readOnly: false,
        planCeiling: 500,
        onWarning: (message) => console.log(warn(message)),
    });

    // For the one check that has to read a note the vault says is not there.
    // Given the same GET-only client the checks use, so a tombstone is read
    // from CouchDB rather than from the replica.
    const reader = new VaultReader({
        replicator,
        settings,
        fetchRemote: (id) => verifier.raw(id),
    });

    const created: string[] = [];

    try {
        await replicator.start();
        await replicator.waitForInitialSync(300_000);
        console.log(ok(`Replica ready: ${(await replicator.refreshDocCount()).toLocaleString()} documents`));

        // --- Create --------------------------------------------------------

        console.log(heading("Creating a note"));
        const notePath = `${FOLDER}/first.md`;
        const body =
            `# Write check\n\n` +
            `Written by scripts/verify-write.ts. Safe to delete.\n\n` +
            Array.from(
                { length: 80 },
                (_unused, i) => `Line ${i}, here to make the note worth chunking.`
            ).join("\n") +
            `\n`;

        const createReceipt = await executor.write({
            path: notePath,
            content: text(body),
            expectedRev: null,
        });
        created.push(notePath);
        check(createReceipt.created, `Created "${notePath}" as revision ${createReceipt.rev}`);
        check(
            (await verifier.text(createReceipt.id, ctx)) === body,
            "Reads back byte-identical from CouchDB",
            "The note was written but does not reassemble to what was sent."
        );
        expectAlong(`"${notePath}" appears, ending in "Line 79, ...".`);

        // --- Edit, reusing chunks ------------------------------------------

        console.log(heading("Editing it"));
        const appended = `${body}\nAppended by the second write.\n`;
        const editReceipt = await executor.write({
            path: notePath,
            content: text(appended),
            expectedRev: createReceipt.rev,
        });

        check(!editReceipt.created, `Updated to revision ${editReceipt.rev}`);
        check(
            editReceipt.chunksReused > 0,
            `Reused ${editReceipt.chunksReused} chunk(s), sent ${editReceipt.chunksWritten}`,
            "No chunk was reused, which means an edit rewrites the whole note. Not fatal, but wrong."
        );
        check(
            (await verifier.text(editReceipt.id, ctx)) === appended,
            "The edit reads back correctly, including the reused chunks",
            "This is the failure that matters: a reused chunk is missing or wrong upstream."
        );
        expectAlong(`"${notePath}" gains "Appended by the second write."`);

        // --- A stale write is refused --------------------------------------

        console.log(heading("Refusing a stale write"));
        const stale = await executor
            .write({
                path: notePath,
                content: text("this should never land"),
                expectedRev: createReceipt.rev,
            })
            .then(() => undefined)
            .catch((error: Error) => error);

        check(stale !== undefined, "A write against the previous revision is refused");
        check(
            (await verifier.text(editReceipt.id, ctx)) === appended,
            "The refused write changed nothing",
            "A refusal that still wrote is worse than no refusal at all."
        );

        // --- Plan and commit ------------------------------------------------

        console.log(heading("Planning and committing"));
        const secondPath = `${FOLDER}/second.md`;
        const plan = await executor.plan([
            { kind: "write", path: notePath, content: text(`${appended}\nAdded by a committed plan.\n`) },
            { kind: "write", path: secondPath, content: text("# Second\n\nCreated by a committed plan.\n") },
        ]);

        check(plan.changes.length === 2, `Planned 2 change(s): ${describeTotals(plan.totals)}`);
        check(
            (await verifier.raw(await executor.idFor(secondPath))) === undefined,
            "Planning wrote nothing",
            "The planned note already exists, so the dry run was not dry."
        );

        const committed = await executor.commit(plan.id);
        created.push(secondPath);
        check(committed.applied.length === 2, "Committed both changes");
        check(
            (await verifier.text(await executor.idFor(secondPath), ctx)) ===
                "# Second\n\nCreated by a committed plan.\n",
            "The note the plan created reads back correctly"
        );
        expectAlong(`"${secondPath}" appears, containing "Created by a committed plan."`);
        expectFinal(`"${notePath}" ends with "Added by a committed plan."`);

        // --- A stale plan is refused ----------------------------------------

        console.log(heading("Refusing a stale plan"));
        const stalePlan = await executor.plan([
            { kind: "write", path: secondPath, content: text("planned, and never written\n") },
        ]);
        // Move the target out from under the plan, as another device would.
        const moved = await executor.currentEntry(secondPath);
        await executor.write({
            path: secondPath,
            content: text("# Second\n\nEdited by something else entirely.\n"),
            expectedRev: moved?._rev ?? null,
        });

        const refusal = await executor
            .commit(stalePlan.id)
            .then(() => undefined)
            .catch((error: Error) => error);

        check(refusal instanceof PlanStaleError, "A plan whose target moved is refused");
        check(
            (await verifier.text(await executor.idFor(secondPath), ctx)) ===
                "# Second\n\nEdited by something else entirely.\n",
            "The refused plan changed nothing"
        );
        expectAlong(`"${secondPath}" changes to "Edited by something else entirely."`);

        // --- Delete and undelete --------------------------------------------

        console.log(heading("Deleting"));
        const toDelete = await executor.currentEntry(secondPath);
        const deleteReceipt = await executor.remove({
            path: secondPath,
            expectedRev: toDelete?._rev as string,
        });

        const tombstone = await verifier.raw(deleteReceipt.id);
        check(tombstone !== undefined, "The document survives the delete, as a tombstone");
        check(tombstone?.deleted === true, "It is marked deleted in the body");
        check(
            tombstone?._deleted === undefined,
            "It is not hard-deleted, so the record other devices reconcile against remains"
        );
        expectAlong(`"${secondPath}" disappears from the vault.`);

        console.log(heading("Writing over the deleted note"));
        const revived = await executor.write({
            path: secondPath,
            content: text("# Second, again\n\nWritten over a tombstone.\n"),
            expectedRev: (await executor.currentEntry(secondPath))?._rev ?? null,
        });
        check(revived.created, "A write over a tombstone counts as a create");
        check(
            revived.chunksReused === 0,
            "It reused no chunks from the tombstone",
            "Reusing a tombstone's chunks risks referencing ones the plugin has collected."
        );
        check(
            (await verifier.text(revived.id, ctx)) === "# Second, again\n\nWritten over a tombstone.\n",
            "The revived note reads back correctly"
        );
        expectFinal(`"${secondPath}" is back, saying "Written over a tombstone."`);

        // --- Restoring from the tombstone itself ------------------------------
        //
        // The claim `restore_note` rests on: a soft delete keeps the document
        // and its chunk list, so the text is usually still assemblable from the
        // deletion record. Usually and not always, which is why it is worth
        // checking against a real database rather than a fixture: the plugin's
        // orphan cleanup is entitled to collect a tombstone's chunks, and no
        // test with its own in-memory CouchDB can tell you whether it has.

        console.log(heading("Restoring a deleted note"));
        const restorePath = `${FOLDER}/deleted-then-restored.md`;
        const restoreBody =
            `# Deleted on purpose\n\n` +
            Array.from({ length: 60 }, (_unused, i) => `Line ${i}, so this spans several chunks.`).join(
                "\n"
            ) +
            `\n`;

        const restoreCreate = await executor.write({
            path: restorePath,
            content: text(restoreBody),
            expectedRev: null,
        });
        created.push(restorePath);
        await executor.remove({ path: restorePath, expectedRev: restoreCreate.rev });

        const recovered = await reader.readDeleted(restorePath);
        check(
            recovered !== undefined && recovered.file.kind === "text" && recovered.file.text === restoreBody,
            "A deleted note still assembles, out of its own deletion record",
            "The tombstone's chunks are gone or wrong, so nothing could restore this note."
        );

        if (recovered) {
            const restored = await executor.write({
                path: restorePath,
                content: text(restoreBody),
                expectedRev: recovered.rev,
                ctime: recovered.file.ctime,
            });
            check(
                (await verifier.text(restored.id, ctx)) === restoreBody,
                "Restoring it writes back exactly what was deleted"
            );
            check(
                (await verifier.raw(restored.id))?.ctime === (await verifier.raw(restoreCreate.id))?.ctime,
                "The restored note keeps the creation time it always had",
                "A restored note that dates from its restoration is a different note."
            );
        }
        expectFinal(`"${restorePath}" exists, having been deleted and brought back.`);
        expectAlong(`"${restorePath}" appeared, vanished, and came back with the same text.`);

        // --- Appending under a heading ---------------------------------------
        //
        // Every edit above appended at the end of a note. This one inserts in
        // the middle, which is the case where chunk reuse has something to get
        // wrong: the chunks after the insertion point shift, and a splitter
        // that reuses the wrong ones produces a note that assembles into
        // plausible nonsense rather than failing.

        console.log(heading("Appending under a heading"));
        const structuredPath = `${FOLDER}/structured.md`;
        const structured =
            `# Meeting\n\n## Actions\n\n` +
            Array.from({ length: 40 }, (_unused, i) => `- action ${i}`).join("\n") +
            `\n\n## Attendees\n\n- Chris\n`;

        const structuredCreate = await executor.write({
            path: structuredPath,
            content: text(structured),
            expectedRev: null,
        });
        created.push(structuredPath);

        const withAction = appendUnderHeading(structured, "Actions", "- inserted by verify:write");
        const insertReceipt = await executor.write({
            path: structuredPath,
            content: text(withAction.text),
            expectedRev: structuredCreate.rev,
        });

        check(!withAction.headingCreated, `Found the "Actions" section rather than creating one`);
        check(
            (await verifier.text(insertReceipt.id, ctx)) === withAction.text,
            "An insertion in the middle of a note reads back byte-identical",
            "This is the one that matters here: the chunks after the insertion point moved, " +
                "and what reassembles is not what was sent."
        );
        check(
            withAction.text.includes("- action 39\n- inserted by verify:write\n\n## Attendees"),
            "The new line landed at the end of the section, above the next heading",
            "It went somewhere else in the note, which is what appending to the end would have done."
        );
        expectFinal(
            `"${structuredPath}" has "- inserted by verify:write" as the last line under Actions, ` +
                `above the Attendees heading.`
        );

        // --- Setting properties across several notes --------------------------

        console.log(heading("Setting properties across several notes"));
        const batchPaths = [`${FOLDER}/batch-a.md`, `${FOLDER}/batch-b.md`, `${FOLDER}/batch-c.md`];
        const bodies = new Map<string, string>();

        for (const [index, path] of batchPaths.entries()) {
            // One already carries the property, with a different value, so the
            // plan has an overwrite to mark notable as well as two additions.
            const front = index === 0 ? `---\nstatus: active\n---\n\n` : `---\ntags:\n  - check\n---\n\n`;
            const body = `${front}Body of ${path}, which must survive untouched.\n`;
            bodies.set(path, body);
            await executor.write({ path, content: text(body), expectedRev: null });
            created.push(path);
        }

        // Composed the way plan_set_properties composes it: read each note
        // fresh, edit its frontmatter, and carry the revision it was read at.
        const operations = [];
        for (const path of batchPaths) {
            const entry = await executor.currentEntry(path);
            const current = (await verifier.text(await executor.idFor(path), ctx)) as string;
            const edit = editFrontmatter(path, current, { set: { status: "checked" } });
            operations.push({
                kind: "write" as const,
                path,
                content: text(edit.text),
                expectedRev: entry?._rev ?? null,
                summary: edit.changed.length > 0 ? "overwrites status (to checked)" : "adds status = checked",
                notable: edit.changed.length > 0,
            });
        }

        const batchPlan = await executor.plan(operations);
        check(batchPlan.changes.length === 3, `Planned 3 change(s): ${describeTotals(batchPlan.totals)}`);
        check(
            batchPlan.changes.filter((change) => change.notable).length === 1,
            "One change is marked as replacing an existing value, two as additions",
            "The plan cannot tell an overwrite from an addition, so the review cannot either."
        );

        // Printed rather than asserted. Whether a plan is reviewable is a
        // judgement a person makes by looking at one, and this is the only
        // place in the process where a real plan against real notes exists.
        console.log(heading("The plan, as a person would see it"));
        for (const line of renderPlan(batchPlan, { commitTool: "commit_plan" }).split("\n")) {
            console.log(info(line));
        }

        const batchCommitted = await executor.commit(batchPlan.id);
        check(batchCommitted.applied.length === 3, "Committed all three");

        let bodiesIntact = true;
        for (const path of batchPaths) {
            const after = (await verifier.text(await executor.idFor(path), ctx)) as string;
            if (!after.includes("status: checked")) bodiesIntact = false;
            if (!after.endsWith(`Body of ${path}, which must survive untouched.\n`)) bodiesIntact = false;
        }
        check(
            bodiesIntact,
            "Every note carries status: checked, and every body is unchanged",
            "A property edit rewrote something other than the frontmatter."
        );
        check(
            ((await verifier.text(await executor.idFor(batchPaths[1] as string), ctx)) as string).includes(
                "- check"
            ),
            "The properties that were already there survived the edit",
            "Editing one property rewrote the others, which is what a round trip through a plain " +
                "object does."
        );
        expectFinal(`The three "${FOLDER}/batch-*.md" notes all have status: checked, bodies unchanged.`);

        // --- A plan composed from a stale read --------------------------------
        //
        // Distinct from the stale plan above. That one moved after planning;
        // this one moved between the tool reading the note and the plan
        // recording a revision. Without the check, planning would record the
        // newer revision, commit would be accepted, and the other write would
        // be silently overwritten.

        console.log(heading("Refusing a plan composed from a stale read"));
        const racedPath = batchPaths[0] as string;
        const readAt = (await executor.currentEntry(racedPath))?._rev as string;
        await executor.write({
            path: racedPath,
            content: text(`${bodies.get(racedPath) as string}\nChanged by another device.\n`),
            expectedRev: readAt,
        });

        const racedRefusal = await executor
            .plan([
                {
                    kind: "write",
                    path: racedPath,
                    content: text("composed from a read that is now stale\n"),
                    expectedRev: readAt,
                },
            ])
            .then(() => undefined)
            .catch((error: Error) => error);

        check(
            racedRefusal instanceof PlanStaleError,
            "Planning refuses content composed from a revision that has since moved"
        );
        check(
            ((await verifier.text(await executor.idFor(racedPath), ctx)) as string).includes(
                "Changed by another device."
            ),
            "The other device's write survived",
            "The plan overwrote a change it never saw, which is the failure this check exists for."
        );

        // --- Moving, renaming and copying -------------------------------------
        //
        // New write behaviour, so it belongs in the gate. The part worth
        // proving against a real database is not that the destination appears.
        // It is that the destination is written before the source is removed,
        // so no interruption can leave a hole, and that the chunks are not
        // re-sent, which is the difference between moving a 4 MiB scan and
        // uploading one.

        console.log(heading("Moving a file"));
        const movingFrom = `${FOLDER}/to-move.md`;
        const movingTo = `${FOLDER}/moved/to-move.md`;
        const movingBody =
            `# Moving\n\n` +
            Array.from({ length: 80 }, (_unused, i) => `Line ${i}, here to make this worth chunking.`).join(
                "\n"
            ) +
            `\n`;

        const beforeMove = await executor.write({
            path: movingFrom,
            content: text(movingBody),
            expectedRev: null,
        });
        created.push(movingFrom);
        const movedCtime = (await verifier.raw(beforeMove.id))?.ctime;

        const moveReceipt = await executor.relocate({
            from: movingFrom,
            to: movingTo,
            content: text(movingBody),
            expectedRev: beforeMove.rev,
        });
        created.push(movingTo);

        check(
            (await verifier.text(moveReceipt.written.id, ctx)) === movingBody,
            `Moved to "${movingTo}", byte-identical`,
            "The destination does not reassemble to what was sent."
        );
        check(
            moveReceipt.written.chunksWritten === 0 && moveReceipt.written.chunksReused > 0,
            `Sent no chunks: reused all ${moveReceipt.written.chunksReused} of them`,
            "The move re-sent chunks CouchDB already held, which for an attachment is the whole file."
        );
        check(
            moveReceipt.removed?.deleted === true,
            "The old path is a tombstone, so every device removes its copy",
            "The source was not removed, which leaves the file at both paths."
        );
        check(
            (await verifier.raw(moveReceipt.written.id))?.ctime === movedCtime,
            "The creation time came across",
            "The moved file records the move as its creation, so it sorts as newly written."
        );
        expectFinal(`"${movingTo}" exists, and nothing is left at "${FOLDER}/to-move.md".`);

        console.log(heading("Refusing a move onto something"));
        const occupiedRefusal = await executor
            .relocate({
                from: movingTo,
                to: notePath,
                content: text(movingBody),
                expectedRev: moveReceipt.written.rev,
            })
            .then(() => undefined)
            .catch((error: Error) => error);

        check(
            occupiedRefusal instanceof DestinationExistsError,
            "Refuses to move a file onto one that already exists"
        );
        check(
            ((await verifier.text(await executor.idFor(notePath), ctx)) as string).includes(
                "Appended by the second write."
            ),
            "The file that was in the way is untouched",
            "The refusal came after the destination had already been written over."
        );

        console.log(heading("Copying a file"));
        const copyTo = `${FOLDER}/moved/a-copy.md`;
        const copyReceipt = await executor.relocate({
            from: movingTo,
            to: copyTo,
            content: text(movingBody),
            expectedRev: moveReceipt.written.rev,
            keepSource: true,
        });
        created.push(copyTo);

        check(
            copyReceipt.removed === undefined &&
                (await verifier.text(copyReceipt.written.id, ctx)) === movingBody &&
                (await verifier.text(moveReceipt.written.id, ctx)) === movingBody,
            "A copy leaves the original where it is, and both read back",
            "One of the two paths is missing or wrong after a copy."
        );
        expectFinal(`"${copyTo}" holds the same text as "${movingTo}".`);

        // --- A rename, with the links rewritten -------------------------------
        //
        // The case move_file refuses, because a rename breaks every basename
        // link pointing at the file. Composed here the way plan_move composes
        // it: the relocation plus one edit per linking note, in one plan
        // committed as a unit.

        console.log(heading("Renaming, and rewriting the links"));
        const renameFrom = `${FOLDER}/linked.md`;
        const renameTo = `${FOLDER}/renamed.md`;
        const linkerPath = `${FOLDER}/linker.md`;
        const linkerBody = `See [[linked]], and ![[linked#Detail]] too.\n`;
        const linkedBody = `# Linked\n\n## Detail\n\nSomething.\n`;

        const linkedWrite = await executor.write({
            path: renameFrom,
            content: text(linkedBody),
            expectedRev: null,
        });
        const linkerWrite = await executor.write({
            path: linkerPath,
            content: text(linkerBody),
            expectedRev: null,
        });
        created.push(renameFrom, renameTo, linkerPath);

        const rewritten = rewriteLinkTargets(linkerBody, {
            from: renameFrom,
            to: renameTo,
            targets: ["linked"],
            paths: [renameTo, linkerPath],
        });

        const renamePlan = await executor.plan([
            {
                kind: "move",
                from: renameFrom,
                to: renameTo,
                content: text(linkedBody),
                expectedRev: linkedWrite.rev,
            },
            {
                kind: "write",
                path: linkerPath,
                content: text(rewritten.text),
                expectedRev: linkerWrite.rev,
                notable: true,
                summary: `rewrites ${rewritten.changed} link(s)`,
            },
        ]);

        console.log(info("The plan, as plan_move would return it:\n"));
        console.log(renderPlan(renamePlan));
        console.log("");

        await executor.commit(renamePlan.id);

        check(
            (await verifier.text(await executor.idFor(renameTo), ctx)) === linkedBody,
            `Renamed "${renameFrom}" to "${renameTo}" as one operation in the plan`
        );
        check(
            (await verifier.raw(await executor.idFor(renameFrom)))?.deleted === true,
            "The old path is a tombstone rather than a document that never existed",
            "A rename that hard-deletes the source leaves an offline device able to push it back."
        );
        check(
            (await verifier.text(await executor.idFor(linkerPath), ctx)) ===
                `See [[renamed]], and ![[renamed#Detail]] too.\n`,
            "Both links were rewritten, keeping the embed marker and the subpath",
            "A rewrite that drops an embed or a heading reference has changed what the note says."
        );
        expectFinal(
            `"${linkerPath}" links to [[renamed]] twice, the second an embed of its "Detail" heading.`
        );

        // --- Where daily notes would go ---------------------------------------
        //
        // Read-only, and the most useful thing in this script for a vault that
        // is not this scratch one: it says what append_daily would infer from
        // the filenames actually present. A wrong inference creates notes in a
        // folder nobody opens, which looks exactly like notes never created.

        console.log(heading("Where daily notes would go"));
        if (settings.usePathObfuscation) {
            console.log(
                warn("Path obfuscation is on, so document IDs are not paths. Inference not attempted.")
            );
        } else {
            const all = await replicator.database.allDocs({});
            const paths = all.rows
                .map((row) => String(row.id))
                .filter((id) => id.toLowerCase().endsWith(".md") && !id.startsWith("_"));

            const inferred = inferDailyFormat(paths);
            if (!inferred) {
                console.log(
                    warn(
                        `No folder here holds two or more date-shaped filenames, so append_daily would ` +
                            `refuse and ask for DAILY_NOTE_PATH. Expected on a scratch database; check ` +
                            `this against the real vault before relying on it.`
                    )
                );
            } else {
                const zone = hostTimeZone();
                const today = fillTemplate(inferred.template, civilDateIn(zone, Date.now()));
                console.log(ok(`Would infer "${inferred.template}" from ${inferred.matches} note(s)`));
                console.log(info(`e.g. ${inferred.examples.slice(0, 3).join(", ")}`));
                console.log(info(`Today, in ${zone}, that is "${today}"`));
                if (inferred.assumedDayFirst) {
                    console.log(
                        warn(
                            "Nothing in those filenames settles day-first against month-first, so " +
                                "day-first was assumed. Set DAILY_NOTE_PATH if that is wrong."
                        )
                    );
                }
                if (inferred.alternatives.length > 0) {
                    console.log(
                        warn(
                            `Other folders also hold dated notes: ` +
                                `${inferred.alternatives.map((a) => `${a.folder || "the vault root"} (${a.matches})`).join(", ")}. ` +
                                `If the wrong one won, set DAILY_NOTE_PATH.`
                        )
                    );
                }
            }
        }

        // The write itself goes to a dated note inside the scratch folder,
        // under an explicit template. Writing into whatever folder inference
        // picked would put this script's output in the middle of real notes,
        // which is exactly what FOLDER exists to prevent.
        console.log(heading("Appending to a dated note"));
        const dailyTemplate = `${FOLDER}/daily/YYYY-MM-DD.md`;
        const dailyPath = fillTemplate(dailyTemplate, civilDateIn(hostTimeZone(), Date.now()));

        const firstCapture = appendUnderHeading("", "Log", "- first capture");
        const dailyCreate = await executor.write({
            path: dailyPath,
            content: text(firstCapture.text),
            expectedRev: null,
        });
        created.push(dailyPath);

        const secondCapture = appendUnderHeading(firstCapture.text, "Log", "- second capture");
        const dailyAppend = await executor.write({
            path: dailyPath,
            content: text(secondCapture.text),
            expectedRev: dailyCreate.rev,
        });

        check(firstCapture.headingCreated, `Created the "Log" heading in a note that had none`);
        check(!secondCapture.headingCreated, "Reused it for the second capture");
        check(
            (await verifier.text(dailyAppend.id, ctx)) === "## Log\n\n- first capture\n- second capture\n",
            "Two captures land under one heading, in order",
            "A second capture into a fresh daily note is the commonest thing this tool will ever do."
        );
        expectFinal(`"${dailyPath}" exists, with both captures listed under a "Log" heading.`);

        // --- The replica ----------------------------------------------------

        console.log(heading("The local replica"));
        const replicated = (await replicator.database.get(createReceipt.id, {
            conflicts: true,
        })) as { _conflicts?: string[] };
        check(
            (replicated._conflicts ?? []).length === 0,
            "No conflict branches after every write in this run",
            `The replica holds ${(replicated._conflicts ?? []).length} conflicting revision(s). ` +
                `The revision ancestry on the replica patch is wrong.`
        );
    } finally {
        if (!options.keep) {
            console.log(heading("Cleaning up"));
            for (const path of [...new Set(created)]) {
                try {
                    const entry = await executor.currentEntry(path);
                    if (!entry) continue;
                    await executor.remove({ path, expectedRev: entry._rev as string, hard: true });
                    console.log(ok(`Removed "${path}"`));
                } catch (error) {
                    console.log(warn(`Could not remove "${path}": ${(error as Error).message}`));
                }
            }
        } else {
            console.log(heading("Left in place"));
            console.log(
                info(
                    `--keep was passed, so ${FOLDER}/ is still there to look at. Delete it in ` +
                        `Obsidian when you are done, and run this again with --reset when you ` +
                        `next need the gate: an Obsidian delete is a soft one, and leaves a ` +
                        `document at every path that a fresh run would refuse to write over.`
                )
            );
        }

        await replicator.stop().catch(() => undefined);
        await rm(replicaDir, { recursive: true, force: true });
    }

    // --- What to look at ----------------------------------------------------

    if (failures > 0) {
        console.log(bad(`\n${failures} check(s) failed. The acceptance gate is not met.\n`));
        process.exitCode = 1;
        return;
    }

    console.log(ok("\nEvery check passed."));
    console.log(heading("Now confirm it in Obsidian"));

    if (!options.keep) {
        console.log(
            info(
                "Everything above was removed on the way out, so there is nothing left to look at. " +
                    "Run again with --keep to leave it in place."
            )
        );
        return;
    }

    console.log(info(`In the vault synced to "${options.couch.database}", ${FOLDER}/ should contain:`));
    for (const line of finalState) console.log(info(`  - ${line}`));
    console.log(
        info(
            `\nAnd nothing else. Every one of them readable, and ending as described. ` +
                `If a note is empty, truncated, or full of what looks like base64, that is the ` +
                `failure this whole gate exists to catch.`
        )
    );

    console.log(info("\nThese happened along the way and are no longer visible:"));
    for (const line of alongTheWay) console.log(info(`  - ${line}`));
    console.log(
        info(
            "Worth watching live if you re-run with Obsidian open, since a note appearing, " +
                "changing, vanishing and returning is the clearest sign the vault is really syncing."
        )
    );

    console.log(
        info(
            "\nThat is the half of gate step three this script cannot do for you. Until you have " +
                "looked, nothing should point at the real vault.\n"
        )
    );
}

function text(value: string) {
    return { kind: "text" as const, text: value };
}

function describeTotals(totals: { creates: number; updates: number; deletes: number }): string {
    return `${totals.creates} create(s), ${totals.updates} update(s), ${totals.deletes} delete(s)`;
}

/** The URL PouchDB's HTTP adapter needs, with credentials embedded. */
function remoteUrlFor(couch: CouchConfig): string {
    const url = new URL(`${couch.url}/${couch.database}`);
    if (couch.username) url.username = encodeURIComponent(couch.username);
    if (couch.password) url.password = encodeURIComponent(couch.password);
    return url.toString();
}

/** Only run when invoked directly, so a test importing from here does not. */
function isEntrypoint(): boolean {
    const invoked = process.argv[1];
    if (!invoked) return false;
    try {
        return resolvePath(invoked) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
}

if (isEntrypoint()) {
    main()
        .catch((error) => {
            const message = (error as Error).message ?? String(error);
            const operational = error instanceof VerificationStopped || /^GET /.test(message);
            console.error(`\n  ${operational ? message : ((error as Error).stack ?? message)}\n`);
            process.exitCode = 1;
        })
        .finally(() => {
            // Same reason as the read-only verifier: the HTTP client keeps
            // sockets alive, and `process.exit` mid-flight truncates output.
            setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
        });
}
