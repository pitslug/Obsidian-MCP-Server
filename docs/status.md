# Where this is up to

Written 28 July 2026, to pick up on another machine. `docs/design.md` is the
plan; this is the progress against it and the things you would otherwise have
to rediscover.

## Getting a machine ready

```bash
git clone https://github.com/pitslug/Obsidian-MCP-Server.git
cd Obsidian-MCP-Server
npm install
npm test          # 342 tests, ~40s
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
| Transport | stdio and streamable HTTP, bearer token |
| Deployment | Dockerfile and Compose for the Slugworx stack, not yet deployed |
| Write executor | Not started, deliberately |
| OAuth 2.0 + PKCE | Not started, bearer token in the interim |

Thirteen tools: `vault_status`, `list_notes`, `read_note`, `search_notes`,
`property_inventory`, `find_by_property`, `tag_inventory`, `find_by_tag`,
`note_links`, `vault_health`, `get_attachment`, `list_untranscribed`,
`save_transcription`.

## The constraint that governs everything

**The vault at `couchdb.slugworx.net` is live, and this code is read-only until
the acceptance gate is met.** No code path in `src/` writes to CouchDB: the
replicator only ever calls `replicate.from`, and the direct reader is GET-only
by construction. `scripts/verify-vault.ts` is GET-only too, and a test asserts
that a full run issues no other method.

`save_transcription` is the one tool that stores anything, and it writes to a
local SQLite file with no path to CouchDB. That is why it stays available under
`READ_ONLY`. An integration test proves it by reading the attachment's document
revision back out of CouchDB after a transcription is saved.

### The acceptance gate

1. ~~Vault model implemented and differentially tested against the plugin's own
   library~~ done.
2. ~~Verified against the live vault, read-only: every file assembles, and
   re-chunking reproduces the plugin's own chunk IDs~~ done, 25/25 both.
3. **A verified write, against a throwaway database first.** Outstanding. Nothing
   should write to `obsidiandb` before this passes.

## What to do next

In rough order:

1. **The write executor.** The hardest remaining unit and the reason for all the
   care above. `composeWrite` and `composeDeletion` in `src/vault-model/` already
   produce the documents; what does not exist is the thing that puts them in the
   database safely. Design calls for a plan/commit protocol: a dry run that says
   exactly what would change, then a commit against that plan.
2. **Acceptance gate step three**, using the executor against a scratch database
   on the same CouchDB. Not `obsidiandb`.
3. **OAuth 2.0 with PKCE**, which is what Claude's custom connector flow expects.
   The bearer token works but is a shared secret.
4. **Deploy.** `deploy/` is written and follows the homelab template, but the
   container has never been built on the server.

Smaller things worth doing at some point:

- `get_attachment` refuses an attachment over `ATTACHMENT_SIZE_CAP` but will
  still serve a stored transcription for it. Untested; add one.
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

## Running it against the real vault

Read-only, safe against production:

```bash
npm run verify -- --url 'https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb'
npm run verify -- --url '...' --all          # every file, not a sample
npm run verify -- --url '...' --census       # where every document went
npm run verify -- --url '...' --attachments  # which attachments have text
```

The server, over stdio, with a client attached so it does something visible:

```bash
COUCHDB_URL='https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb' npm run try
```

`npm run try` pins `REPLICA_PATH`, `INDEX_PATH` and `TRANSCRIPT_PATH` under
`tmp/`, so a scratch run cannot open or damage a real store.
