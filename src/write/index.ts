/**
 * The write executor: the only unit permitted to change the vault.
 *
 * Everything exported here either issues a state-changing request or decides
 * whether one should be issued. If a new file appears in this directory, that
 * is the question to ask of it.
 */

export * from "./couch.js";
export * from "./executor.js";
export * from "./plans.js";
