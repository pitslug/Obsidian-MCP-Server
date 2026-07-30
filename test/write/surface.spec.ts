/**
 * The claim that makes this whole design defensible, checked mechanically.
 *
 * The design says one unit is permitted to make a state-changing outbound
 * request, and everything else is read-only by construction. That reduces "can
 * this corrupt my vault?" to a question about `src/write/`. It is also exactly
 * the kind of claim that quietly stops being true: a future change adds a POST
 * to the index builder for a good reason, review sees a small diff, and the
 * property is gone without anyone deciding to give it up.
 *
 * So it is a test rather than a paragraph. If this fails, the honest options
 * are to move the code into `src/write/` or to change the design document.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Source files git tracks, since untracked scratch files are not the product. */
function sourceFiles(): string[] {
    return execFileSync("git", ["ls-files", "-z", "src"], { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter((path) => path.endsWith(".ts"));
}

const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Files outside the one unit allowed to change the vault. */
const readOnlyUnits = () => sourceFiles().filter((path) => !path.startsWith("src/write/"));

describe("the write surface", () => {
    it("names a state-changing HTTP method nowhere but src/write", () => {
        // Deliberately a text match rather than anything cleverer. A grep is
        // what a reviewer would run, and matching that keeps the test honest
        // about what it does and does not prove.
        const pattern = /method:\s*"(?!GET")[A-Z]+"/;
        const offenders = readOnlyUnits().filter((path) => pattern.test(read(path)));

        expect(offenders, `These files issue something other than GET:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("replicates in one direction only, everywhere", () => {
        // `replicate.to` and `sync` are the two ways a local replica's drift
        // reaches the vault and thence every device. Neither belongs anywhere
        // in this project, including in the unit that is allowed to write:
        // deliberate writes go document by document, not by reconciliation.
        const offenders = sourceFiles().filter((path) => {
            const source = read(path);
            return /\breplicate\.to\b/.test(source) || /\.sync\s*\(/.test(source);
        });

        expect(offenders, `These files could push to the vault:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("keeps the write client the only importer-visible way to send a write", () => {
        // `src/write/couch.ts` is where PUT and _bulk_docs live. Nothing else
        // in the unit should be building requests of its own; it should be
        // calling that client.
        const inUnit = sourceFiles().filter(
            (path) => path.startsWith("src/write/") && path !== "src/write/couch.ts"
        );
        const offenders = inUnit.filter((path) => /\bfetch\s*\(/.test(read(path)));

        expect(offenders, `These build their own requests:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("checks the write scope in every tool that changes the vault", () => {
        // The check is per call, inside the tool, because the token arrives per
        // session. That makes omitting one a single missing line with no
        // visible symptom until a connection holding only vault:read deletes
        // something. A tool added here without it should fail this test rather
        // than pass review.
        const source = read("src/server/write-tools.ts");
        const blocks = source.split("addTool({").slice(1);

        // A floor, because the split above is a text match on a call this file
        // does not own. Renaming or wrapping the registration helper would
        // otherwise leave this finding nothing and passing while testing
        // nothing, which is the failure mode a structural test has to guard
        // against first. It happened: the helper was wrapped an hour after this
        // test was written.
        expect(
            blocks.length,
            "found no tool registrations, so this test proves nothing"
        ).toBeGreaterThanOrEqual(6);

        const unchecked = blocks
            .filter(
                (block) => !block.includes("requireScope(session as SessionAuth | undefined, SCOPE_WRITE)")
            )
            .map((block) => /name:\s*"([^"]+)"/.exec(block)?.[1] ?? "an unnamed tool");

        expect(unchecked, `These write tools do not check vault:write:\n${unchecked.join("\n")}`).toEqual([]);
    });
});
