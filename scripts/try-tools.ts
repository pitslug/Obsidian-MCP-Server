#!/usr/bin/env node
/**
 * Exercise the MCP tools as a client would.
 *
 * `node dist/index.js` starts a server that waits for a client to speak MCP
 * over stdin, which from a terminal looks indistinguishable from a hang. This
 * spawns that same server and acts as the client: lists the tools, calls each
 * one, and prints what came back.
 *
 * It goes through the real protocol rather than calling the tool functions
 * directly, so it exercises the transport, the schemas and the serialisation - * the parts that only fail once something is actually connected.
 *
 * Read-only, like everything else pointed at the vault so far.
 *
 * USAGE
 *
 *   COUCHDB_URL='https://user:pass@host/?db=name' npm run try
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const heading = (s: string) => `\n[1m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;

/** Print a tool result, trimmed - a whole note would drown the output. */
function show(result: unknown, maxLines = 20): void {
    const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
    const text = content
        .map((part) => (part.type === "text" ? (part.text ?? "") : `<${part.type}>`))
        .join("\n");
    const lines = text.split("\n");
    for (const line of lines.slice(0, maxLines)) console.log(`  ${line}`);
    if (lines.length > maxLines) console.log(dim(`  … ${lines.length - maxLines} more line(s)`));
}

async function main() {
    if (!process.env.COUCHDB_URL) {
        console.error(
            "\n  COUCHDB_URL is not set. For example:\n\n" +
                "    COUCHDB_URL='https://user:pass@couchdb.example.net/?db=obsidiandb' npm run try\n"
        );
        process.exit(1);
    }

    const entry = existsSync(resolve(root, "dist/index.js"))
        ? { command: process.execPath, args: [resolve(root, "dist/index.js")] }
        : { command: process.execPath, args: ["--import", "tsx", resolve(root, "src/index.ts")] };

    console.log(heading("Starting the server"));
    console.log(dim("  Replicating the vault; the first run takes a moment."));

    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: {
            ...(process.env as Record<string, string>),
            MCP_TRANSPORT: "stdio",
            REPLICA_PATH: process.env.REPLICA_PATH ?? resolve(root, "tmp/replica"),
            // Pinned alongside the replica. Left at its default, the index
            // would be shared with any other run on this machine, and a
            // different vault's notes would appear in the results.
            INDEX_PATH: process.env.INDEX_PATH ?? resolve(root, "tmp/index.sqlite"),
            // Pinned too, but for the opposite reason: transcriptions are the
            // one thing here that cannot be recreated from the vault, so a
            // scratch run must not open a real store and must not be able to
            // damage one.
            TRANSCRIPT_PATH: process.env.TRANSCRIPT_PATH ?? resolve(root, "tmp/transcripts.sqlite"),
            // The server's own logs go to stderr and would interleave with
            // this output; keep them to real problems.
            LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
        },
        stderr: "inherit",
    });

    const client = new Client({ name: "try-tools", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.log(heading(`Tools (${tools.length})`));
    for (const tool of tools) console.log(`  ${tool.name}`);

    console.log(heading("vault_status"));
    show(await client.callTool({ name: "vault_status", arguments: {} }));

    console.log(heading("list_notes"));
    const listed = await client.callTool({ name: "list_notes", arguments: { limit: 10 } });
    show(listed, 15);

    // Read whichever note the listing put first, so this works on any vault.
    const listing = ((listed as { content?: { text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
    const firstPath = listing
        .split("\n")
        .map((line) => /^(\S.*?)\s{2}\(/.exec(line)?.[1])
        .find((path): path is string => Boolean(path) && path.endsWith(".md"));

    if (firstPath) {
        console.log(heading(`read_note: ${firstPath}`));
        show(await client.callTool({ name: "read_note", arguments: { path: firstPath } }), 25);
    } else {
        console.log(heading("read_note"));
        console.log(dim("  No markdown note found in the listing to read."));
    }

    console.log(heading("A note that does not exist"));
    show(await client.callTool({ name: "read_note", arguments: { path: "no/such/note.md" } }));

    // Search for a word taken from a note that actually exists, so this says
    // something real on any vault rather than looking for a term that only
    // happens to appear in mine.
    if (firstPath) {
        const term = searchTermFrom(listing, firstPath);
        if (term) {
            console.log(heading(`search_notes: ${term}`));
            show(await client.callTool({ name: "search_notes", arguments: { query: term } }), 12);
        }
    }

    console.log(heading("property_inventory"));
    show(await client.callTool({ name: "property_inventory", arguments: {} }), 20);

    console.log(heading("tag_inventory"));
    show(await client.callTool({ name: "tag_inventory", arguments: {} }), 15);

    if (firstPath) {
        console.log(heading(`note_links: ${firstPath}`));
        show(await client.callTool({ name: "note_links", arguments: { path: firstPath } }), 15);
    }

    console.log(heading("vault_health"));
    show(await client.callTool({ name: "vault_health", arguments: {} }), 20);

    // Attachments that cannot be searched. On a vault of handwritten pages this
    // is the interesting output: it is the work queue.
    console.log(heading("list_untranscribed"));
    const untranscribed = await client.callTool({ name: "list_untranscribed", arguments: {} });
    show(untranscribed, 20);

    // Deliberately stops at retrieval. Storing a transcription is a real,
    // durable write, and a script whose job is to demonstrate the tools has no
    // business putting invented text into the one store that cannot be rebuilt.
    const first = ((untranscribed as { content?: { text?: string }[] }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
        .split("\n")
        .map((line) => line.replace(/\s{2}\[transcription out of date\]$/, "").trim())
        .find((line) => /\.(pdf|png|jpe?g)$/i.test(line));

    if (first) {
        console.log(heading(`get_attachment: ${first}`));
        const attachment = (await client.callTool({
            name: "get_attachment",
            arguments: { path: first },
        })) as { content: { type: string; text?: string; resource?: { mimeType?: string } }[] };

        for (const part of attachment.content) {
            if (part.type === "text") console.log(`  ${(part.text ?? "").split("\n").join("\n  ")}`);
            else if (part.type === "resource")
                console.log(dim(`  [${part.resource?.mimeType ?? "binary"} handed over for reading]`));
            else console.log(dim(`  [${part.type}]`));
        }
        console.log(dim("  Not transcribing here: save_transcription is a durable write."));
    }

    await client.close();
    console.log("");
}

/**
 * A word worth searching for, taken from a note's own filename.
 *
 * The filename is the safest source: it is already in the listing, so this
 * needs no extra read, and a word from it is guaranteed to match at least the
 * note it came from.
 */
function searchTermFrom(_listing: string, path: string): string | undefined {
    const name = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
    return name
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4)
        .sort((a, b) => b.length - a.length)[0];
}

main().catch((error: unknown) => {
    console.error(`\n  ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
});
