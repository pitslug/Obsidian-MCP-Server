# Where this is up to

Written 28 July 2026, and updated as each piece landed: the write executor, the
single-note tools, then the batch and daily ones, then the deployment.
`docs/design.md` is the plan; this is the progress against it and the things you
would otherwise have to rediscover.

**Why this exists.** The notes are being migrated out of OneNote, and the
OneNote MCP server already does this job there. So the question this project has
to answer is not "does it work" but "can it do what OneNote does". That is why
the vault is nearly empty: no content moves across until the tooling is proven,
and the parity gaps are listed under "What to do next" alongside the deployment
work.

## Getting a machine ready

```bash
git clone https://github.com/pitslug/Obsidian-MCP-Server.git
cd Obsidian-MCP-Server
npm install
npm test          # 599 tests, ~85s
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
| Tools            | Thirteen read tools, plus nine write tools registered only when `READ_ONLY=false`                                |
| Write executor   | Built and tested: single-note writes, deletes, and the plan/commit protocol. Both halves now have a tool surface |
| Daily notes      | Path template inferred from the vault's own dated filenames, overridable, resolved in a configured time zone     |
| Acceptance gate  | Met. Step three re-run end to end against `obsidian-writetest` on 29 July 2026, and confirmed in Obsidian         |
| Transport        | stdio and streamable HTTP                                                                                        |
| Vault contents   | 12 text notes, 15 attachments. Deliberately nearly empty until the OneNote migration starts                      |
| Deployment       | Live on the Slugworx stack since 29 July 2026, pinned to `:0.1`, `READ_ONLY=true`                                 |
| OAuth 2.1        | Exercised live: Claude connects through Pocket-ID holding `vault:read`, and the audience check was confirmed     |

Thirteen read tools: `vault_status`, `list_notes`, `read_note`, `search_notes`,
`property_inventory`, `find_by_property`, `tag_inventory`, `find_by_tag`,
`note_links`, `vault_health`, `get_attachment`, `list_untranscribed`,
`save_transcription`.

Nine write tools, registered only when `READ_ONLY=false`. Six act on a single
note: `create_note`, `append_note`, `append_daily`, `edit_note`,
`set_properties`, `delete_note`. Three are the batch path: `plan_set_properties`
writes nothing and returns a plan, `commit_plan` applies one by ID,
`discard_plan` throws one away. Absent rather than disabled, so a read-only
server does not advertise something it will refuse.

`delete_note` is soft only, with no flag to make it otherwise, and that is not
timidity. The tombstone a soft delete leaves is what tells another device to
remove its copy; erase the document instead and a device that was offline still
holds the note, learns nothing on reconnecting, and pushes it back. The
recoverable option is also the only one that actually deletes. It refuses
attachments, because a transcription is the only thing here that cannot be
recomputed.

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
so a read-only deployment cannot reach CouchDB with a PUT at all. The eight
write tools are registered only when writes are enabled, so a read-only server
has no path from a client to the executor at all. And `COUCHDB_DATABASE` still points wherever it is configured to point:
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

    Re-run in full on 29 July 2026 against the same database, on the four
    commits pushed that day, and confirmed in Obsidian again. It covers more
    than it did the first time: insertion under a heading, properties across
    several notes, a plan composed from a read that went stale while planning,
    and two captures into a fresh daily note.

## What to do next

A checklist rather than prose, because it is now being worked across two
machines. Rough priority order within each group.

### Parity with OneNote, which is what decides the migration

- [x] **A delete tool.** `delete_note`, 30 July 2026. Soft only, refuses
      attachments, and the scope check is now enforced mechanically for every
      tool in `write-tools.ts` by `test/write/surface.spec.ts` rather than by
      remembering. Adding it found a bug it did not cause: `create_note`
      asserted absence with a hardcoded `null` revision, so any path holding a
      tombstone refused new content with a conflict that re-reading the note
      could not explain. Deleting a note in Obsidian was enough to reach it.
- [ ] **Decide what a move or rename means here, then build it.** OneNote has
      `move_page` and `copy_page`; nothing here can relocate a note, and
      reorganising as you go is most of what migrating is. The design question
      first: a rename has to rewrite every `[[wikilink]]` pointing at the old
      path, which Obsidian does silently in the app, and a move made through
      this server without that rewrite breaks links quietly. `vault_health`
      already finds broken links, so the detection half exists. Batch rename and
      move are also the obvious next plan/commit selections.
- [ ] **Decide whether OneNote ink or its transcription is the source of truth.**
      OneNote treats handwriting as first class (`get_page_ink`,
      `render_page_ink`). Here a handwritten page arrives as an image or PDF
      attachment and the equivalent is `list_untranscribed` plus
      `save_transcription`. Better for search, but it is transcription rather
      than ink, and the transcriptions are the only data in this system that
      nothing can recompute.
- [ ] Run the same task through both servers side by side once, rather than
      comparing tool lists. The gaps above came from the registered tool names.

### Finishing the deployment

- [x] **Tag `v0.1.1`.** Tagged at `929a2ba`, 30 July 2026. The compose file pins
      `:0.1` and that tag moves, so `docker compose pull obsidian-mcp` on the
      server is what puts it in the running container. Nothing in the container
      reports its own version, so confirm the pull rather than assuming it.
- [ ] Homepage entry.
- [ ] Uptime Kuma monitor against `http://obsidian-mcp:8080/health` on
      `docker_net`. Not `/mcp`, which correctly answers 401 and would read as
      permanently down.
- [ ] Commit `compose/obsidian-mcp.yml` to the `SlugworxServer` repo, no secrets
      in the diff.

### Turning writes on, one switch at a time

Four switches stand between the container and the vault, and `deploy/README.md`
has the detail. Switch one is done and is meant to be lived with.

- [x] `READ_ONLY=true`, client granted only `vault:read`.
- [ ] `READ_ONLY=false`, client still only `vault:read`. Every write tool should
      appear and refuse by name. **The only step that tests a control rather
      than exercising a path that was already open.** Costs one reconnect.
- [ ] Grant `vault:write` in Pocket-ID, with `COUCHDB_DATABASE` pointed at
      `obsidian-writetest`.
- [ ] Point `COUCHDB_DATABASE` at `obsidiandb`.

### Smaller things, whenever

- [ ] `get_attachment` refuses an attachment over `ATTACHMENT_SIZE_CAP` but will
      still serve a stored transcription for it. Untested; add one.
- [ ] E2EE is not enabled on the vault. The code handles it and the differential
      tests cover it, but no real encrypted vault has been read.
- [ ] Rotate the CouchDB `obsidian` password. It was passed on a command line
      and pasted into a chat on 29 July 2026.
- [ ] The executor refuses to soft-delete a pre-chunking (`type: "notes"`) note
      on an encrypted vault, because the tombstone would carry the note's
      plaintext. If the vault turns out to hold such notes, the fix is to rewrite
      them through the chunked path rather than to relax the refusal.
- [ ] The `authenticate` hook must never throw anything but a `Response`.
      Anything else is caught by the transport, which substitutes a challenge of
      its own invention: different error code, different metadata URL, and the
      exception text as the description. This happened once, from a header
      builder that refused to quote a string containing a quote.
      `test/integration/oauth.spec.ts` asserts the exact challenge for that
      reason.

## Authentication

`AUTH_MODE` picks one of three. `oauth` is the real one and what Claude's custom
connector flow expects. `bearer` is the shared token this had before, kept
because it is useful for driving the server by hand. `none` has to be asked for
by name: a server that quietly served the vault to anyone is not a failure mode
worth leaving reachable by omission.

This server is a **resource server** and nothing else. It does not log anyone in
and it issues no tokens. Pocket-ID does both, which is also what puts the vault
behind the same passkey as everything else on the network.

### The audience check is the whole thing

Everything else in `src/auth/tokens.ts` is table stakes. The audience check is
the control that matters and the one easiest to leave out, because everything
works without it.

Pocket-ID signs tokens for every service on the network with the same key and
the same issuer. A server checking only the signature and the issuer would
accept the token Immich holds, or Mealie, or Papra. One leaked token from the
least careful service on the network would be a key to the most sensitive thing
on it. So a token is accepted only when its `aud` names
`https://obsidian-mcp.slugworx.net/mcp` exactly, and `test/auth/tokens.spec.ts`
has a test for precisely that case: right key, right issuer, right person, wrong
service, refused.

Pocket-ID fills `aud` from the RFC 8707 `resource` parameter, which the MCP
specification requires clients to send and Claude always sends. That is what
makes the check possible at all, and it is why the setup below is not optional.

### Setting it up in Pocket-ID

**Pocket-ID v2.10.0 or later.** That release added OAuth APIs with scoped
permissions, which is the feature all of this rests on. Check the running
version before anything else; Pocket-ID is one of the pinned images.

1. **Register the API.** In Pocket-ID, add an API whose identifier is
   `https://obsidian-mcp.slugworx.net/mcp`, exactly matching `MCP_PUBLIC_URL`
   and the URL typed into Claude. Give it two permissions: `vault:read` and
   `vault:write`.

    Not optional, and the failure if it is skipped is not obvious. Claude always
    sends `resource`, and Pocket-ID answers a `resource` naming an API it does
    not know with `invalid_target`, which fails the authorization request before
    any token exists. The symptom is a connector that will not connect, with
    nothing wrong at this end.

2. **Register the client.** An OIDC client called something like `Claude`, with
   both callback URLs, since Claude uses either host:

       https://claude.ai/api/mcp/auth_callback
       https://claude.com/api/mcp/auth_callback

    PKCE on. Confidential, so it has a secret. Grant it `vault:read` on the API
    above, and `vault:write` only when writes are meant to be on.

3. **Add the connector in Claude.** A custom connector pointed at
   `https://obsidian-mcp.slugworx.net/mcp`, with the client ID and secret from
   step 2 pasted in. Pocket-ID does not support dynamic client registration and
   does not publish a Client ID Metadata Document, so a pre-registered client is
   the path, and it is the better one here anyway: one stable client rather than
   a new registration per connection.

### Rolling it out

The scope and the read-only switch are different controls and worth moving
separately. Grant `vault:read` only, with `READ_ONLY=true`, and live with it.
Then `READ_ONLY=false` while the token still carries only `vault:read`, which
proves the scope gate rather than assuming it: every write tool should refuse.
Then grant `vault:write`.

### Things that will bite

- **Anthropic reaches both hosts, from `160.79.104.0/21`.** Discovery requests
  go to `auth.slugworx.net` from the same range as the MCP requests. A rule that
  lets one through and not the other fails in a way that looks like the MCP
  server being unreachable.
- **The router stays on `chain-no-auth@file`.** The service authenticates its
  own callers now, properly. Putting traefik-forward-auth in front would break
  it: an MCP client cannot complete an interactive browser login for a
  forward-auth cookie.
- **Claude waits 10 seconds** for discovery and token endpoints, and 30 for
  refresh. Well within what Pocket-ID does, but worth knowing when the flow
  fails intermittently.
- **`MCP_PUBLIC_URL` has to be exact.** Trailing slash, missing `/mcp`, http
  instead of https: any of them rejects every token, and the log says the token
  was not issued for this server rather than that the setting is wrong.

### Scopes at the tool boundary

The transport requires `vault:read` to connect at all, answering a token without
it with a 403 and an `insufficient_scope` challenge naming what is needed. Write
tools check `vault:write` per call, in the tool.

That means a read-only connection still sees the write tools listed and is
refused when it uses one, which is the opposite of the choice made for
`READ_ONLY`, where the tools are absent. The difference is deliberate:
`READ_ONLY` is permanent for the deployment, so advertising a tool that can
never work would be a lie, while an insufficient scope is a property of one
connection that the client can fix by asking for more.

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
- **A tombstone is not an absence, and the tool layer treated it as one.**
  Adding `delete_note` on 30 July 2026 exposed `create_note` asserting
  `expectedRev: null` instead of the revision it had just read. A path whose
  note was deleted still holds a document, so CouchDB refused the create as a
  conflict, and the advice in the error was useless: reading the note again
  reports nothing there, so the obvious next attempt is the same failing one.
  Deleting a note in Obsidian was enough to reach it, so this was live before
  anything here could delete. Fixed in both halves: the not-found path in
  `write-tools.ts` now asks the executor for the tombstone's revision, and
  `create_note` passes the revision it read like every other tool. The lesson
  generalises past this bug. `NoteNotFoundError` means "nothing to read here",
  which is not the same claim as "nothing is here", and any code that treats the
  first as the second is one deleted note away from being wrong.
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
- **A wire marker is only a marker in the position it is defined for.**
  `assertDecoded` refused any chunk whose payload began `%=`, the E2EE v2
  ciphertext prefix. But `%=` is also how a note about printf, a spreadsheet
  formula or shell parameter expansion starts, so on an unencrypted vault a real
  note was reported as ciphertext, on a read that could never succeed. The check
  is now gated on the chunk ID: encryption appends `+` to the hash, so ciphertext
  is always `h:+...`, and anything else is content whatever it begins with.
  Found by `test/vault-model/round-trip.spec.ts`, whose random seed produced the
  counterexample `["%="]` on about one run in ten while CI stayed green on the
  same commit. That is the argument for running the suite rather than reading the
  badge.
- **`git pull` can fetch without merging, and then say nothing.** Moving between
  the work machine and this one on 29 July 2026, the pull fetched `d3a95e0` and
  left `main` at `ca94d0e`, four commits back, because four locally modified
  files blocked the merge. Three had been rewritten upstream in the meantime, so
  that work was stranded rather than merely behind, and nothing said so again
  after the first attempt. `git log --oneline HEAD..FETCH_HEAD` answers it in one
  line. The `.gitattributes` added at the same time is the other half of it:
  without one the working tree was CRLF against an LF index, `git status`
  reported every tracked file as modified, and the four that really were modified
  were invisible in the noise.
- **A container that cannot write its data directory waits rather than fails.**
  First deploy, 29 July 2026: `$DATADIR/obsidian-mcp` did not exist, so Docker
  created it as `root`, and this container runs as `$PUID:$PGID` because the
  image has no PUID entrypoint to correct that itself. Opening the LevelDB
  replica failed inside a promise, so there was no startup error and no log line,
  just "Waiting for the first pass to complete" forever. The empty data directory
  is the diagnostic. `deploy/README.md` step two now creates and chowns it before
  anything starts.

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
branches.

It then covers the rest of the write surface. **Inserting under a heading** is
the one worth understanding: every other edit in the run appends at the end,
where chunk reuse has nothing to get wrong. An insertion in the middle shifts
every chunk after it, and a splitter reusing the wrong ones produces a note that
assembles into plausible nonsense rather than failing. **Setting a property
across three notes** proves the frontmatter edit leaves bodies and neighbouring
properties alone, which a round trip through a plain object would not. And it
refuses a **plan composed from a read that went stale while planning**, which is
a different window from the stale plan above and the one nobody is watching.

Two things it prints rather than asserts, because both are judgements:

- **The rendered plan**, exactly as `plan_set_properties` would return it.
  Whether a plan is reviewable is something you find out by looking at a real
  one, and this is the only place in the process where a real one exists.
- **What daily note template it would infer**, read-only, from the filenames
  actually in the database. Worth running against a copy of the real vault for
  this alone: a wrong inference files captures in a folder nobody opens, which
  looks exactly like captures that were never made. Everything it makes lives under `mcp-write-check/`, and without
  `--keep` it removes it again on the way out.

`--keep` is what you want the first time, because the human half is looking at
those notes. The script finishes by printing exactly what should appear in
Obsidian and where. Open the vault and compare. Delete `mcp-write-check/` from
Obsidian when you are satisfied.

Then pass `--reset` on the next run. Deleting the folder in Obsidian does not
make the database ready for another go: LiveSync deletes by writing
`deleted: true` and keeping the document, so every path still has one, a plain
GET still returns it, and the first create asserts absence. Without `--reset`
the script now says so before it replicates, rather than at the first write a
minute later.

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
