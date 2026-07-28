/**
 * Access to `node:sqlite`, isolated.
 *
 * Two things are worked around here, and keeping both in one file means the
 * rest of the index can just import `DatabaseSync` and forget about them.
 *
 * First, `node:sqlite` is loaded through `createRequire` rather than a static
 * import. Vite - which Vitest builds on - carries a hard-coded list of Node
 * builtins that predates this module, so a static `import ... from
 * "node:sqlite"` gets its prefix stripped and then fails to resolve as a
 * package. A runtime require is opaque to that analysis. The type-only import
 * below is erased at compile time, so it costs nothing and keeps full typing.
 *
 * Second, the module is still marked experimental in Node 22 and emits a
 * warning on load, though it no longer needs a flag. It is used here in
 * preference to a native SQLite binding because the alternative requires a C++
 * toolchain in the container whenever a prebuilt binary is unavailable, which
 * is a worse failure mode than an API that might shift. If it does shift, this
 * file is the only thing that needs to change.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
export type StatementSync = import("node:sqlite").StatementSync;
