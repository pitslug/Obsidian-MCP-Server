import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.spec.ts"],
        environment: "node",
        testTimeout: 60_000,
        hookTimeout: 60_000,
        server: {
            deps: {
                // Vite's list of Node builtins predates `node:sqlite`, so
                // without this it strips the prefix and fails to resolve
                // "sqlite" from node_modules.
                external: ["node:sqlite"],
            },
        },
    },
    ssr: {
        external: ["node:sqlite"],
    },
});
