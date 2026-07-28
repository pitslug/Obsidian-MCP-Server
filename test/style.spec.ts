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

describe("house style", () => {
    it("uses no em dashes anywhere", () => {
        const offenders: string[] = [];

        for (const path of trackedFiles()) {
            let content: string;
            try {
                content = readFileSync(join(root, path), "utf8");
            } catch {
                continue;
            }
            if (!content.includes("—")) continue;

            content.split("\n").forEach((line, i) => {
                if (line.includes("—")) offenders.push(`${path}:${i + 1}: ${line.trim().slice(0, 90)}`);
            });
        }

        expect(offenders, `Use a hyphen, parentheses, a comma or an arrow instead:\n${offenders.join("\n")}`).toEqual(
            []
        );
    });

    it("uses no en dashes in prose either", () => {
        // Less firmly ruled on, but an en dash is the same mistake wearing a
        // narrower hat, and it renders almost identically in the places this
        // text ends up.
        const offenders: string[] = [];

        for (const path of trackedFiles()) {
            let content: string;
            try {
                content = readFileSync(join(root, path), "utf8");
            } catch {
                continue;
            }
            content.split("\n").forEach((line, i) => {
                if (line.includes("–")) offenders.push(`${path}:${i + 1}`);
            });
        }

        expect(offenders).toEqual([]);
    });
});
