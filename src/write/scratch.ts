/**
 * The guards that keep a write test off the real vault.
 *
 * Acceptance gate step three is a verified write against a throwaway database
 * that a real Obsidian instance is syncing to. The whole value of that step is
 * that it is not the real vault, and the whole risk of it is one mistyped
 * argument. So the refusal is code rather than care.
 *
 * These are pure functions taking the milestone document as an argument rather
 * than fetching it, which keeps this file free of any transport and lets the
 * refusals be tested exhaustively. The caller does the reading.
 *
 * Two checks, deliberately different in kind. The name check catches the
 * mistake you make while typing; the device check catches the mistake you make
 * while thinking, where the name is a scratch database you created weeks ago
 * and have since pointed all your devices at.
 */

import type { MilestoneEntry } from "../vault-model/index.js";

/**
 * Database names this refuses outright.
 *
 * The real vault is first. The rest are names a person reaches for when they
 * mean "the actual one", and none of them is a plausible scratch database.
 */
export const PROTECTED_DATABASE_NAMES = ["obsidiandb", "obsidian", "vault", "livesync", "notes"] as const;

export class ProtectedDatabaseError extends Error {
    constructor(name: string) {
        super(
            `Refusing to write to "${name}". This script writes, and that name is either the live ` +
                `vault or close enough to it to be a typo for it. Create a throwaway database, sync a ` +
                `single Obsidian instance to it, and name that.`
        );
        this.name = "ProtectedDatabaseError";
    }
}

export class MissingDatabaseError extends Error {
    constructor() {
        super(
            `No database name. Pass --db <name> naming a throwaway database. There is no default ` +
                `and there will not be one: a script that writes should not be able to guess where.`
        );
        this.name = "MissingDatabaseError";
    }
}

export class TooManyDevicesError extends Error {
    constructor(
        readonly database: string,
        readonly nodes: readonly string[],
        readonly expected: number
    ) {
        super(
            `Refusing to write to "${database}". ${nodes.length} devices have synced to it, and a ` +
                `throwaway database should have one. This looks like a vault in real use. If it ` +
                `genuinely is scratch, re-run with --expect-devices ${nodes.length}.`
        );
        this.name = "TooManyDevicesError";
    }
}

export interface ScratchCheckOptions {
    /**
     * The database's milestone document, or undefined if it has none.
     *
     * A database with no milestone has never been synced by the plugin, which
     * is not a reason to refuse: it is what a database looks like in the
     * minutes before you point Obsidian at it.
     */
    milestone: MilestoneEntry | undefined;
    /** How many devices the caller expects to have synced. Defaults to one. */
    expectedDevices?: number;
}

/**
 * Refuse a database that should not be written to by a test.
 *
 * Throws rather than returning a verdict, because every caller of this would
 * turn a falsy return into a throw, and one that forgot would be the one that
 * mattered.
 */
export function assertScratchDatabase(name: string | undefined, options: ScratchCheckOptions): void {
    if (!name || !name.trim()) throw new MissingDatabaseError();

    const normalized = name.trim().toLowerCase();
    if ((PROTECTED_DATABASE_NAMES as readonly string[]).includes(normalized)) {
        throw new ProtectedDatabaseError(name);
    }

    const nodes = options.milestone?.accepted_nodes ?? [];
    const expected = options.expectedDevices ?? 1;
    if (nodes.length > expected) throw new TooManyDevicesError(name, nodes, expected);
}
