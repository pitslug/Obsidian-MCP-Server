/**
 * A house style rule, enforced rather than remembered.
 *
 * The vault this serves has one hard formatting rule of its own: no em dashes,
 * anywhere. It applies to note content and to everything written about the
 * project. Left to discipline it does not hold - a sweep of this repository
 * found over 150 of them across source, tests, docs and deployment files, all
 * added by people and tools that meant well.
 *
 * So it is a test. Use a hyphen, parentheses, a comma, or an arrow.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The characters, built from their code points rather than written out.
 *
 * If this file contained them as literals it would flag itself, which is
 * exactly what happened the first time: the check passed while it was still
 * untracked, then failed the moment it was committed and `git ls-files` began
 * returning it. Naming a code point is also clearer about which character is
 * meant, since the two are near-indistinguishable in most editors.
 */
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);

/**
 * Every file git tracks, which is exactly the set this rule covers.
 *
 * Asking git rather than walking the tree keeps `node_modules`, build output
 * and scratch files out of it without maintaining a second ignore list.
 */
function trackedFiles(): string[] {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
        .filter((path) => /\.(ts|mts|js|md|yml|yaml|json|example)$/.test(path) || !path.includes("."));
}

/** Every tracked line containing `character`, as "path:line: text". */
function occurrences(character: string): string[] {
    const found: string[] = [];

    for (const path of trackedFiles()) {
        let content: string;
        try {
            content = readFileSync(join(root, path), "utf8");
        } catch {
            // Unreadable or binary. Not this test's business.
            continue;
        }
        if (!content.includes(character)) continue;

        content.split("\n").forEach((line, i) => {
            if (line.includes(character)) found.push(`${path}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }

    return found;
}

describe("house style", () => {
    it("uses no em dashes anywhere", () => {
        const offenders = occurrences(EM_DASH);
        expect(offenders, `Use a hyphen, parentheses, a comma or an arrow:\n${offenders.join("\n")}`).toEqual([]);
    });

    it("uses no en dashes either", () => {
        // Less firmly ruled on, but an en dash is the same mistake wearing a
        // narrower hat, and it is near-indistinguishable in most of the places
        // this text ends up.
        const offenders = occurrences(EN_DASH);
        expect(offenders, `Use a hyphen or the word "to":\n${offenders.join("\n")}`).toEqual([]);
    });
});
