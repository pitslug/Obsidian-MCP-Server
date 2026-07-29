# Where this is up to

Written 28 July 2026, and updated as each piece landed: the write executor, the
single-note tools, then the batch and daily ones. `docs/design.md` is the plan; this is the
progress against it and the things you would otherwise have to rediscover.

## Getting a machine ready

```bash
git clone https://github.com/pitslug/Obsidian-MCP-Server.git
cd Obsidian-MCP-Server
npm install
npm test          # 520 tests, ~70s
```

Node 22 or later. Nothing else is needed to run the suite: it stands up its own
CouchDB (pouchdb-server in-process) and never touches a real vault.

The CouchDB credentials are **not** in this repository and must not be. The
verifier takes them on the command line; the server takes them from the
environment, or from Docker secrets in deployment. This repo is public.

## State

| Unit             | State                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Vault model      | Verified against the live vault: 25/25 files assembled, 25/25 re-chunked to byte-identical chunk IDs             |
| Replicator       | Pull-only, decoding at the `transform-pouch` boundary                                                            |
| Note parsing     | Frontmatter, tags, wikilinks, headings, Obsidian's own rules                                                     |
| Index            | SQLite FTS5: search, properties, tags, link graph                                                                |
| Attachments      | PDF text extraction, indexed and retrievable                                                                     |
| Handwriting      | Transcriptions stored durably, indexed, survive an index rebuild                                                 |
| Tools            | Thirteen read tools, plus eight write tools registered only when `READ_ONLY=false`                               |
| Write executor   | Built and tested: single-note writes, deletes, and the plan/commit protocol. Both halves now have a tool surface |
| Daily notes      | Path template inferred from the vault's own dated filenames, overridable, resolved in a configured time zone     |
| Acceptance gate  | Met. All three steps passed as of 28 July 2026                                                                   |
| Transport        | stdio and streamable HTTP, bearer token                                                                          |
| Deployment       | Dockerfile and Compose for the Slugworx stack, not yet deployed                                                  |
| OAuth 2.0 + PKCE | Not started, bearer token in the interim                                                                         |

Thirteen read tools: `vault_status`, `list_notes`, `read_note`, `search_notes`,
`property_inventory`, `find_by_property`, `tag_inventory`, `find_by_tag`,
`note_links`, `vault_health`, `get_attachment`, `list_untranscribed`,
`save_transcription`.

Eight write tools, registered only when `READ_ONLY=false`. Five write a single
note: `create_note`, `append_note`, `append_daily`, `edit_note`,
`set_properties`. Three are the batch path: `plan_set_properties` writes
nothing and returns a plan, `commit_plan` applies one by ID, `discard_plan`
throws one away. Absent rather than disabled, so a read-only server does not
advertise something it will refuse.

Every one of them reads the note fresh from CouchDB and writes against the exact
revision it read, in one observation. That is the whole reason
`WriteRequest.expectedRev` is required: a tool that let the executor look the
revision up would succeed every time and lose an edit occasionally.

The batch path has the same requirement and it is easier to miss there.
`plan_set_properties` reads each note to compose its new frontmatter, and
planning then reads every target again to record the revision commit will check.
Between those two reads is a window, and a plan that recorded the fresher
revision would commit over a change it never saw. So a `PlanOperation` may carry
its own `expectedRev`, and planning refuses outright if the vault has moved
underneath it. Same discipline as the single-note path, on the path where nobody
is watching the result.

### Reviewing a plan

`docs/design.md` called the rendering the real problem here, and it is: the plan
protocol is only worth its cost if the review in the middle actually happens,
and what defeats a review is not too little detail but too much. `renderPlan` in
`src/write/render.ts` sorts by consequence rather than printing the changes. The
totals come first, because most bad plans are visible from the totals alone. A
change the composing tool marked `notable`, meaning it replaces or removes
something that was there, is never truncated however long the plan gets.
Everything else is sampled with an exact count of what was left out. No-ops are
counted, not listed, so a plan that reports touching 400 notes when it will
change three does not teach people that the numbers are noise.

`notable` is set by the tool, not the plan machinery, because only the tool can
know: overwriting a property that already had a different value and adding one
that was absent produce identical plans otherwise, and only the first destroys
something.

### Daily notes

Obsidian keeps the daily note folder and date format in `.obsidian/`, hidden
files are not synced on this vault, and so the setting is not in CouchDB at all.
`append_daily` infers the template from the dated filenames the vault already
has, needs two of them before it will believe a pattern, and reports what it
inferred on every call. `DAILY_NOTE_PATH` overrides it.

`VAULT_TIMEZONE` is the other half and matters more in deployment than it looks.
The container runs in UTC and Brisbane is ten hours ahead, so for ten hours of
every day the container's date is yesterday's: every evening capture would be
filed under the wrong day and nothing would report an error. It defaults to the
host zone, which is right on a laptop, and `deploy/obsidian-mcp.env.example`
sets it explicitly.

## The constraint that governs everything

**The vault at `couchdb.slugworx.net` is live. The acceptance gate is now met,
and what keeps writes off it is no longer a gate but a set of switches.** Worth
restating exactly, because the claim has narrowed twice and "it is safe" is not
a thing to leave implied.

`src/write/couch.ts` is the only file that issues a state-changing request.
Everything else remains read-only by construction: the replicator only ever
calls `replicate.from`, the direct reader is GET-only, and
`scripts/verify-vault.ts` is GET-only too, with a test asserting that a full run
issues no other method. `test/write/surface.spec.ts` enforces the boundary
mechanically, so a POST added to some other unit for a good reason fails the
suite rather than quietly ending the property.

Three things stand between that one file and the vault. `READ_ONLY` defaults to
true and is checked before a request is built, not after a response comes back,
so a read-only deployment cannot reach CouchDB with a PUT at all. The four write tools are
registered only when writes are enabled, so a read-only server has no path from
a client to the executor at all. And `COUCHDB_DATABASE` still points wherever it is configured to point:
nothing in the code prefers the real vault.

The order to relax these in is the order they are listed. Build the tools
against a scratch database with `READ_ONLY=false`, live with that for a while,
and only then point a configuration at `obsidiandb`, still read-only, before
finally turning writes on there.

`save_transcription` is the one tool that stores anything, and it writes to a
local SQLite file with no path to CouchDB. That is why it stays available under
`READ_ONLY`. An integration test proves it by reading the attachment's document
revision back out of CouchDB after a transcription is saved.

### The acceptance gate

1. ~~Vault model implemented and differentially tested against the plugin's own
   library~~ done.
2. ~~Verified against the live vault, read-only: every file assembles, and
   re-chunking reproduces the plugin's own chunk IDs~~ done, 25/25 both.
3. ~~A verified write, against a throwaway database first~~ done, 28 July 2026,
   against `obsidian-writetest`, a `_replicate` copy of the real vault with one
   Obsidian instance synced to it. `npm run verify:write` passed every check:
   create, edit with chunk reuse, stale-write refusal, plan and commit, stale-plan
   refusal, soft delete, write over the tombstone, and no conflict branches in
   the replica. Confirmed by eye in Obsidian afterwards. See "Re-running the
   gate" for how to repeat it.

## What to do next

In rough order:

1. **OAuth 2.0 with PKCE**, which is what Claude's custom connector flow expects.
   The bearer token works but is a shared secret.
2. **Deploy.** `deploy/` is written and follows the homelab template, but the
   container has never been built on the server.

3. **Re-run the gate.** The write path changed, so `npm run verify:write`
   against `obsidian-writetest` is owed before anything points at `obsidiandb`.
   It does not yet exercise the batch tools or `append_daily`; adding them to it
   is part of this step rather than a separate one.

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
  every file touched from a Linux machine. Worth doing: without it, a checkout
  on Windows shows every tracked file as modified when the same working tree is
  read from a Linux mount, which makes `git status` useless for seeing real
  work.
- The batch path only sets properties. Batch renaming, moving and retagging are
  the obvious next selections, and all three need the same thing the property
  one needed: a summary line a reviewer can read.

## Exercising the write tools by hand

`npm run try` is still read-only, deliberately: it points at whatever
`COUCHDB_URL` says, and a script that writes wherever it is pointed is not one
to leave lying around. To drive the write tools by hand, run the server against
the scratch database with writes on and talk to it with any MCP client:

```powershell
$env:COUCHDB_URL = "http://192.168.50.2:9113"
$env:COUCHDB_DATABASE = "obsidian-writetest"
$env:COUCHDB_USER = "obsidian"
$env:COUCHDB_PASSWORD = "..."
$env:READ_ONLY = "false"
npm run try
```

The tools themselves are covered end to end by
`test/integration/write-tools.spec.ts`, which runs a real MCP client against a
server with `READ_ONLY=false`.

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
- **Traefik 400s a percent-encoded slash, so the public CouchDB hostname is
  unusable for anything that addresses a document by ID.** A document ID here is
  the vault path, so `daily/2026-07-28.md` is requested as
  `daily%2F2026-07-28.md`, and `https://couchdb.slugworx.net` answers 400 while
  the container answers 404 for the same request. Replication and `_all_docs`
  are unaffected, which is why the read-only verifier never found it and why it
  surfaced at the first single-document read the write path made. Point
  `COUCHDB_URL` at the internal address: `http://couchdb:5984` in deployment,
  `http://192.168.50.2:9113` from a machine on the LAN.
- **`_local` documents do not replicate.** The milestone document, which is
  where every vault setting is published, is one. So is the sync-parameters
  document holding the E2EE salt. A database duplicated with `_replicate` has
  neither until a device syncs to it and republishes them. This is not a CouchDB
  quirk to work around; it is what `_local` means.
- **A chunk being in `children` is not proof it exists as a document.** On a
  `useEden` vault it may live only inside `eden`, and a tombstone's chunks are
  exactly what the plugin's orphan cleanup collects. Reusing either writes a note
  referencing chunks that exist nowhere. `reusableChunkIds` returns nothing in
  both cases; the cost is re-sending chunks on a write that was happening anyway.

## Re-running the gate

It has passed once. Repeat it after any change to the write path, and before
pointing anything new at a database that matters.

`obsidian-writetest` already exists and is worth keeping: a copy of the real
vault with one device synced to it is the right place to develop the write tools
against. Refresh it with another `_replicate` when it drifts too far.

To build one from scratch again:

1. Create a database on the same CouchDB, called something like
   `obsidian-writetest`. Not `obsidiandb`, and the script refuses that name plus
   `obsidian`, `vault`, `livesync` and `notes` in case of a typo.
2. Point **one** Obsidian instance at it, through LiveSync's setup URI, and let
   it sync. One device, because the script refuses a database more than one has
   synced to: that is what a vault in real use looks like whatever it is called.
   Override with `--expect-devices N` only after looking at why.

    This step is not optional, and the reason is not obvious. A database made by
    replicating another one arrives with no milestone document, because that is a
    `_local` document and `_local` documents do not replicate. Without it every
    setting falls back to a default, and `customChunkSize` defaulting to 0 caps
    `absoluteMaxPieceSize` at 100 KiB, below the 256 KiB unit the binary path
    uses. Every attachment then gets sliced at exactly 100 KiB while text is
    unaffected, because its own maximum is 1 KiB either way. The write succeeds,
    reads back correctly, and is chunked unlike everything else in the vault.
    `verify:write` refuses to run at all until a device has published settings;
    this is why.

Then the machine half:

```bash
npm run verify:write -- --url 'https://USER:PASS@couchdb.slugworx.net' --db obsidian-writetest --keep
```

It creates a note, edits it reusing chunks, refuses a stale write, plans and
commits a batch, refuses a stale plan, soft-deletes, writes over the tombstone,
and reads every result back out of CouchDB through the vault model rather than
through its own client or the replica. It checks the local replica for conflict
branches. Everything it makes lives under `mcp-write-check/`, and without
`--keep` it removes it again on the way out.

`--keep` is what you want the first time, because the human half is looking at
those notes. The script finishes by printing exactly what should appear in
Obsidian and where. Open the vault and compare. Delete `mcp-write-check/` from
Obsidian when you are satisfied.

Only when both halves have passed does anything point at `obsidiandb`, and it
does so with `READ_ONLY` on for a first period.

Duplicating the vault is a `_replicate` call against CouchDB itself, run from the
server. Do not copy the data files: CouchDB 3.x keeps a database as shards
registered in the internal `_dbs` database, so a copied and renamed `.couch` file
is not a database.

```bash
curl -sS -X POST "http://127.0.0.1:9113/_replicate" -u 'obsidian' \
  -H "Content-Type: application/json" \
  -d '{"source":"obsidiandb","target":"obsidian-writetest","create_target":true}'
```

## Running it against the real vault

Read-only, safe against production:

```bash
npm run verify -- --url 'https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb'
npm run verify -- --url '...' --all          # every file, not a sample
npm run verify -- --url '...' --census       # where every document went
npm run verify -- --url '...' --attachments  # which attachments have text
```

Nothing above writes.

The one command that does is `npm run verify:write`, and it refuses to run
against `obsidiandb`. See below.

The server, over stdio, with a client attached so it does something visible:

```bash
COUCHDB_URL='https://USER:PASS@couchdb.slugworx.net/?db=obsidiandb' npm run try
```

`npm run try` pins `REPLICA_PATH`, `INDEX_PATH` and `TRANSCRIPT_PATH` under
`tmp/`, so a scratch run cannot open or damage a real store.
