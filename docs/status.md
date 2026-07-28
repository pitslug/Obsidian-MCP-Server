# Where this is up to

Written 28 July 2026, and updated the same day when the write executor landed,
to pick up on another machine. `docs/design.md` is the plan; this is the
progress against it and the things you would otherwise have to rediscover.

## Getting a machine ready

```bash
git clone https://github.com/pitslug/Obsidian-MCP-Server.git
cd Obsidian-MCP-Server
npm install
npm test          # 391 tests, ~60s
```

Node 22 or later. Nothing else is needed to run the suite: it stands up its own
CouchDB (pouchdb-server in-process) and never touches a real vault.

The CouchDB credentials are **not** in this repository and must not be. The
verifier takes them on the command line; the server takes them from the
environment, or from Docker secrets in deployment. This repo is public.

## State

| Unit | State |
| --- | --- |
| Vault model | Verified against the live vault: 25/25 files assembled, 25/25 re-chunked to byte-identical chunk IDs |
| Replicator | Pull-only, decoding at the `transform-pouch` boundary |
| Note parsing | Frontmatter, tags, wikilinks, headings, Obsidian's own rules |
| Index | SQLite FTS5: search, properties, tags, link graph |
| Attachments | PDF text extraction, indexed and retrievable |
| Handwriting | Transcriptions stored durably, indexed, survive an index rebuild |
| Tools | Thirteen, none of which can modify the vault |
| Write executor | Built and tested: single-note writes, deletes, and the plan/commit protocol. No tool reaches it yet |
| Transport | stdio and streamable HTTP, bearer token |
| Deployment | Dockerfile and Compose for the Slugworx stack, not yet deployed |
| OAuth 2.0 + PKCE | Not started, bearer token in the interim |

Thirteen tools: `vault_status`, `list_notes`, `read_note`, `search_notes`,
`property_inventory`, `find_by_property`, `tag_inventory`, `find_by_tag`,
`note_links`, `vault_health`, `get_attachment`, `list_untranscribed`,
`save_transcription`.

## The constraint that governs everything

**The vault at `couchdb.slugworx.net` is live, and this code is read-only until
the acceptance gate is met.** That claim used to be "nothing in `src/` can
write". It is now narrower and worth restating exactly.

`src/write/couch.ts` is the only file that issues a state-changing request.
Everything else remains read-only by construction: the replicator only ever
calls `replicate.from`, the direct reader is GET-only, and
`scripts/verify-vault.ts` is GET-only too, with a test asserting that a full run
issues no other method. `test/write/surface.spec.ts` enforces the boundary
mechanically, so a POST added to some other unit for a good reason fails the
suite rather than quietly ending the property.

Two things keep that one file harmless in the meantime. `READ_ONLY` defaults to
true and is checked before a request is built, not after a response comes back,
so a read-only deployment cannot reach CouchDB with a PUT at all. And no MCP
tool calls the executor: it is reachable from tests and from code, not from a
client.

`save_transcription` is the one tool that stores anything, and it writes to a
local SQLite file with no path to CouchDB. That is why it stays available under
`READ_ONLY`. An integration test proves it by reading the attachment's document
revision back out of CouchDB after a transcription is saved.

### The acceptance gate

1. ~~Vault model implemented and differentially tested against the plugin's own
   library~~ done.
2. ~~Verified against the live vault, read-only: every file assembles, and
   re-chunking reproduces the plugin's own chunk IDs~~ done, 25/25 both.
3. **A verified write, against a throwaway database first.** Outstanding, and
   now the only thing between here and writing. The executor exists and is
   tested against an in-process CouchDB; it has never written to a database a
   real Obsidian instance syncs from. Nothing should write to `obsidiandb`
   before this passes.

## What to do next

In rough order:

1. **Acceptance gate step three**, using the executor against a scratch database
   on the same CouchDB. Not `obsidiandb`. There is no script for this yet; the
   shape to copy is `scripts/verify-vault.ts`, pointed at a throwaway database,
   writing through `PlanningWriteExecutor` and reading the result back in
   Obsidian.
2. **The write tools.** The executor has no MCP surface. The design's write
   surface is append, create, targeted edit by string match, set properties on
   one note, batch set properties across a query result, and append to today's
   daily note. Batch operations are plan-gated; the rest execute directly. Note
   that `write()` requires the revision the content was derived from, so an
   append tool must read, compose, and pass that revision through rather than
   letting the executor look it up.
3. **OAuth 2.0 with PKCE**, which is what Claude's custom connector flow expects.
   The bearer token works but is a shared secret.
4. **Deploy.** `deploy/` is written and follows the homelab template, but the
   container has never been built on the server.

Smaller things worth doing at some point:

- `get_attachment` refuses an attachment over `ATTACHMENT_SIZE_CAP` but will
  still serve a stored transcription for it. Untested; add one.
- The executor refuses to soft-delete a pre-chunking (`type: "notes"`) note on an
  encrypted vault, because the tombstone would carry the note's plaintext. If the
  vault turns out to hold such notes, the fix is to rewrite them through the
  chunked path rather than to relax the refusal.
- E2EE is not enabled on the vault yet. The code handles it and the differential
  tests cover it, but no real encrypted vault has been read.
- A `.gitattributes` (`* text=auto eol=crlf`) would stop the LF/CRLF warning on
  every file touched from a Linux machine.

## Things that cost time once already

- **Do not run the test suite with a stale `node_modules`.** `unpdf` arrived with
  the attachment work; a checkout that predates it fails five suites with
  "Failed to load url unpdf", including one that presents as an unrelated MCP
  "Connection closed". `npm install` after any pull that touches `package.json`.
- **Never spawn `npx` from a test.** On Windows `npx` is `npx.cmd` and
  `execFile` does not use a shell, so it fails with ENOENT before anything runs;
  on Linux it leaves a grandchild alive that hangs teardown. Use
  `process.execPath` with `--import tsx`. Both spawning specs do this now.
- **Avoid `process.exit` in the scripts.** It terminates while work is in flight:
  on Windows the verifier aborted with 0xC0000409 instead of exiting 1, and it
  can truncate a piped stdout. Set `process.exitCode` and let Node finish.
- **The transcript store is not a cache.** `transcripts.sqlite` holds the only
  data in the system that cannot be recomputed from CouchDB. It has its own file
  so an index rebuild cannot take it, `journal_mode = DELETE` so a file-level
  backup cannot copy it mid-write, a history table so a bad rewrite does not
  destroy a good transcription, and it refuses to open a schema version it does
  not recognise. Do not "tidy" any of that away.
- **No em dashes anywhere**, per the vault's own `CLAUDE.md`. `test/style.spec.ts`
  enforces it. There were 164 in here before it existed.
- **Patching the local replica needs `_revisions`, not just `_rev`.** A document
  inserted with `new_edits: false` and no ancestry has nothing to graft onto, so
  PouchDB starts a new branch: one permanent conflict leaf per write, each a full
  copy of the note, and pull replication never repairs it because `_revs_diff`
  reports nothing missing. Reads keep returning the right winner, which is what
  makes it easy to miss. `withAncestry` in `src/write/executor.ts` supplies it.
- **A chunk being in `children` is not proof it exists as a document.** On a
  `useEden` vault it may live only inside `eden`, and a tombstone's chunks are
  exactly what the plugin's orphan cleanup collects. Reusing either writes a note
  referencing chunks that exist nowhere. `reusableChunkIds` returns nothing in
  both cases; the cost is re-sending chunks on a write that was happening anyway.

## Running it against the real vault

Read-only, safe against production:

```bash
npm run verify -- --url 'https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb'
npm run verify -- --url '...' --all          # every file, not a sample
npm run verify -- --url '...' --census       # where every document went
npm run verify -- --url '...' --attachments  # which attachments have text
```

Nothing above writes. There is deliberately no `npm run` that does, until gate
step three exists.

The server, over stdio, with a client attached so it does something visible:

```bash
COUCHDB_URL='https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb' npm run try
```

`npm run try` pins `REPLICA_PATH`, `INDEX_PATH` and `TRANSCRIPT_PATH` under
`tmp/`, so a scratch run cannot open or damage a real store.
