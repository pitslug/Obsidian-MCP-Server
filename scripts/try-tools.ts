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
 * directly, so it exercises the transport, the schemas and the serialisation —
 * the parts that only fail once something is actually connected.
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

/** Print a tool result, trimmed — a whole note would drown the output. */
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
        console.log(heading(`read_note — ${firstPath}`));
        show(await client.callTool({ name: "read_note", arguments: { path: firstPath } }), 25);
    } else {
        console.log(heading("read_note"));
        console.log(dim("  No markdown note found in the listing to read."));
    }

    console.log(heading("A note that does not exist"));
    show(await client.callTool({ name: "read_note", arguments: { path: "no/such/note.md" } }));

    await client.close();
    console.log("");
}

main().catch((error: unknown) => {
    console.error(`\n  ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
});
