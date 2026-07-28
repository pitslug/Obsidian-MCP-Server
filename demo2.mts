import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeWrite } from "./src/vault-model/compose.js";
import { resolveSettings } from "./src/vault-model/settings.js";
import { DOCID_MILESTONE, DOCID_VERSIONING, SUPPORTED_DB_VERSION } from "./src/vault-model/constants.js";
import { startFakeCouch } from "./test/helpers/couch-server.js";
const S = resolveSettings({ customChunkSize: 60 });
const couch = await startFakeCouch();
await couch.createDatabase("v");
await couch.seed("v", [
 { _id: DOCID_MILESTONE, type:"milestoneinfo", created:1, accepted_nodes:[], node_info:{}, locked:false, node_chunk_info:{}, tweak_values:{a:{encrypt:false,hashAlg:"xxhash64",chunkSplitterVersion:"v3-rabin-karp",customChunkSize:60}} },
 { _id: DOCID_VERSIONING, type:"versioninfo", version: SUPPORTED_DB_VERSION },
]);
for (const [p,t] of [
  ["projects/mortgage refinance.md","---\nstatus: active\npriority: 2\ntags: [home, finance]\n---\n\nThe refinance plan. See [[daily note]] and [[missing]].\n"],
  ["daily note.md","---\nstatus: done\npriority: high\n---\n\nBought milk. #errands\n"],
] as [string,string][]) {
  const c = await composeWrite(p, {kind:"text",text:t}, {settings:S, now:1700000000000});
  await couch.seed("v", [...(c.chunks as any), c.entry as any]);
}
console.log("COUCH=" + couch.url);
