/**
 * What the server says about itself when a client connects.
 *
 * MCP instructions are the first thing a model reads about this vault, before
 * any tool is called and usually before anything is asked of it. So this is not
 * decoration, and a sentence in it that is out of date is worse than one that
 * is missing: for a while this file did not exist and the string was a literal
 * ending "This server is currently read-only", which stayed true in the text
 * long after it stopped being true in the deployment. Twelve write tools were
 * registered behind a description that said writing was impossible. Anything
 * reading it would reasonably decline to try.
 *
 * Two rules follow, and both are the same rule.
 *
 * **Every claim here is computed from the thing it describes.** Whether writes
 * are on comes from the configuration that turns them on. What can change the
 * vault is not listed at all: that list is built by the registrations and read
 * back by `vault_status`, and a second copy here would be a second copy.
 *
 * **The vault's own conventions come from the vault.** A note starting from
 * nothing has no schema to conform to, which inverts the job `tag_inventory`
 * and `property_inventory` were written for: the risk is not failing to match
 * an existing convention, it is inventing a different one every session. If the
 * vault holds a `CLAUDE.md`, it is where the owner has written down how their
 * notes are meant to be organised, and passing it through here means a
 * connected client follows it without being told to each time.
 */

/** Where a vault records how it wants to be treated. */
export const CONVENTIONS_NOTE = "CLAUDE.md";

/**
 * How much of that note to pass on.
 *
 * Instructions are sent on every connection and sit in context for the whole
 * session, so an unbounded note would be an unbounded cost. Generous enough
 * that a real conventions note fits whole; anything longer is a document rather
 * than a convention, and the truncation says so rather than trailing off.
 */
export const CONVENTIONS_LIMIT = 4_000;

export interface Conventions {
    path: string;
    text: string;
    /** True when the note was longer than the limit and was cut. */
    truncated: boolean;
}

export interface InstructionsInput {
    /** Whether any registered tool can change the vault. */
    readOnly: boolean;
    /** The vault's own conventions note, if it has one. */
    conventions: Conventions | undefined;
}

/** Trim a conventions note to what will be passed on. */
export function trimConventions(path: string, text: string): Conventions {
    const trimmed = text.trim();
    if (trimmed.length <= CONVENTIONS_LIMIT) return { path, text: trimmed, truncated: false };
    return { path, text: trimmed.slice(0, CONVENTIONS_LIMIT).trimEnd(), truncated: true };
}

export function serverInstructions(input: InstructionsInput): string {
    const parts = [
        "An Obsidian vault, synced by Self-hosted LiveSync and addressed by vault-relative path " +
            "(for example 'Meetings/2026-07-28 Board.md'). Reads come from a local replica that " +
            "trails the server slightly; every response says how stale it may be, and read_note " +
            "accepts fresh=true when that matters.",
    ];

    if (input.readOnly) {
        parts.push(
            "This deployment is read-only: no registered tool can change the vault, and none is " +
                "hidden behind a flag. Say so plainly rather than offering to edit."
        );
    } else {
        parts.push(
            "Writing is enabled, and vault_status names exactly which tools can change the vault. " +
                "Three things about them are worth knowing before using one. Every write reads the " +
                "note fresh and writes against the revision it read, so a tool refusing with a " +
                "conflict means another device changed it and the right response is to read it " +
                "again rather than to retry. Deleting is soft, and restore_note can usually undo " +
                "one, though not after the sync plugin has collected the pieces, so read a note " +
                "before removing it and say what is going rather than relying on that. And anything " +
                "touching more than one note goes through a plan: the planning tool writes " +
                "nothing and returns a description that is meant to be shown to the person who " +
                "asked, in full, before commit_plan is called with its ID. Committing a plan " +
                "nobody has read defeats the point of there being one."
        );
        parts.push(
            "This vault is somebody's own record rather than a working copy of something. When a " +
                "change is larger or more destructive than what was asked for, say so and ask, " +
                "rather than doing the larger thing well."
        );
    }

    if (input.conventions) {
        parts.push(
            `The vault carries its own conventions in "${input.conventions.path}", reproduced ` +
                `below. Follow it: it is how this vault is organised, and it wins over any ` +
                `general habit about how notes are usually written.` +
                (input.conventions.truncated
                    ? ` It is longer than fits here, so this is the first ${CONVENTIONS_LIMIT.toLocaleString()} ` +
                      `characters of it; read the rest with read_note before reorganising anything.`
                    : ""),
            "---",
            input.conventions.text,
            "---"
        );
    }

    return parts.join("\n\n");
}
