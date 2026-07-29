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
 * properties across several notes, plan and commit, soft delete, undelete. It
 * proves chunk reuse does not orphan a chunk, and that the plan protocol
 * refuses both a stale plan and content composed from a read that went stale
 * while the plan was being made.
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
import { CouchWriter } from "../src/write/couch.js";
import { PlanningWriteExecutor } from "../src/write/plans.js";
import { PlanStaleError } from "../src/write/plans.js";
import { renderPlan } from "../src/write/render.js";
import { assertScratchDatabase } from "../src/write/scratch.js";
import { appendUnderHeading } from "../src/note/sections.js";
import { editFrontmatter } from "../src/note/frontmatter.js";
import { civilDateIn, fillTemplate, hostTimeZone, inferDailyFormat } from "../src/note/daily.js";
import { endpointFor, documentUrl, headersFor } from "../src/couch/rest.js";
import type { CouchConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
    couch: CouchConfig;
    passphrase: string | undefined;
    expectedDevices: number;
    keep: boolean;
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

/** Everything the human is asked to confirm in Obsidian, collected as it goes. */
const expectations: string[] = [];
const expect = (s: string) => expectations.push(s);

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
    if (nodes.length === 0) {
        console.log(
            warn(
                "No device has synced to this database yet. The write path will still be verified, " +
                    "but the half of this that matters is seeing the result in Obsidian."
            )
        );
    }

    // --- Settings, read from the database itself ----------------------------

    const { settings: published, conflicts } = readTweakValues(milestone);
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
        expect(`"${notePath}" exists and opens, ending in "Line 79, ...".`);

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
        expect(`"${notePath}" now ends with "Appended by the second write."`);

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
        expect(`"${secondPath}" exists, containing "Created by a committed plan."`);
        expect(`"${notePath}" now also ends with "Added by a committed plan."`);

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
        expect(`"${secondPath}" says "Edited by something else entirely."`);

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
        expect(`"${secondPath}" has disappeared from the vault.`);

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
        expect(`"${secondPath}" is back, saying "Written over a tombstone."`);

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
            withAction.text.includes("- action 39\n\n- inserted by verify:write\n\n## Attendees"),
            "The new line landed at the end of the section, above the next heading",
            "It went somewhere else in the note, which is what appending to the end would have done."
        );
        expect(
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
        expect(`The three "${FOLDER}/batch-*.md" notes all have status: checked, bodies unchanged.`);

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
            (await verifier.text(dailyAppend.id, ctx)) === "## Log\n\n- first capture\n\n- second capture\n",
            "Two captures land under one heading, in order",
            "A second capture into a fresh daily note is the commonest thing this tool will ever do."
        );
        expect(`"${dailyPath}" exists, with both captures listed under a "Log" heading.`);

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
            console.log(info(`--keep was passed. Delete ${FOLDER}/ from Obsidian when you are done.`));
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
    console.log(
        info(
            options.keep
                ? "With the Obsidian instance synced to this database, you should see:"
                : "Run again with --keep, then in the Obsidian instance synced to this database:"
        )
    );
    for (const line of expectations) console.log(info(`  - ${line}`));
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
