#!/usr/bin/env node
/**
 * Entry point.
 *
 * Configuration failures exit non-zero with the reason on stderr rather than a
 * stack trace — in a container, that message is all the operator gets.
 */

import { start } from "./server/index.js";
import { ConfigError, loadConfig } from "./config.js";

async function main(): Promise<void> {
    let running: Awaited<ReturnType<typeof start>> | undefined;

    const shutdown = async (signal: string) => {
        process.stderr.write(`\nReceived ${signal}, shutting down.\n`);
        try {
            await running?.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));

    running = await start(loadConfig());
}

main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
        process.stderr.write(`\nConfiguration error: ${error.message}\n\n`);
        process.exit(78); // EX_CONFIG
    }
    process.stderr.write(`\n${(error as Error).stack ?? String(error)}\n\n`);
    process.exit(1);
});
