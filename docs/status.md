# Where this is up to

Written 28 July 2026, and updated as each piece landed: the write executor, the
single-note tools, then the batch and daily ones, then the deployment, then
moving and renaming, then tagging, then the last few gaps before daily use.
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
npm test          # 743 tests, ~90s
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
| Tools            | Thirteen read tools, plus fourteen write tools registered only when `READ_ONLY=false`                            |
| Write executor   | Built and tested: single-file writes, deletes, relocation, and the plan/commit protocol, all with a tool surface |
| Daily notes      | Path template inferred from the vault's own dated filenames, overridable, resolved in a configured time zone     |
| Acceptance gate  | Met. Step three re-run end to end against `obsidian-writetest` on 30 July 2026, move path included, confirmed in Obsidian |
| Transport        | stdio and streamable HTTP                                                                                        |
| Vault contents   | 12 text notes, 15 attachments. Deliberately nearly empty until the OneNote migration starts                      |
| Deployment       | Live on the Slugworx stack since 29 July 2026, pinned to `:0.1`. `READ_ONLY=false` since 30 July, scope-gated     |
| OAuth 2.1        | Exercised live: Claude connects through Pocket-ID holding `vault:read`, and the audience check was confirmed     |

Thirteen read tools: `vault_status`, `list_notes`, `read_note`, `search_notes`,
`property_inventory`, `find_by_property`, `tag_inventory`, `find_by_tag`,
`note_links`, `vault_health`, `get_attachment`, `list_untranscribed`,
`save_transcription`.

Fourteen write tools, registered only when `READ_ONLY=false`. Nine act on a
single file: `create_note`, `append_note`, `append_daily`, `edit_note`,
`set_properties`, `delete_note`, `restore_note`, `move_file`, `copy_file`. Five are the plan
path: `plan_set_properties`, `plan_move` and `plan_retag` write nothing and
return a plan, `commit_plan` applies one by ID, `discard_plan` throws one away.
Absent rather than disabled, so a read-only server does not advertise something
it will refuse.

The split between the two groups is not a preference about naming. A tool that
touches one file is a write tool; anything that touches several goes through
plan and commit, because a multi-note edit reviewed by nobody is the failure the
plan protocol exists to prevent. A move that changes only the folder touches one
file. A rename touches every note that links to it. So `move_file` and
`plan_move` are the same operation on either side of that line, and `move_file`
refuses and names the other one rather than deciding for itself.

`restore_note` is the counterpart, and it exists because of what `delete_note`
had to say for itself: that putting the text back was not something this server
could do. It usually is. A soft delete keeps the document and its chunk list, so
the note is normally still assemblable out of its own deletion record, and
restoring it is writing that content back against the tombstone's revision.
Usually, not always: the plugin's orphan cleanup is entitled to collect chunks no
live note refers to, and once it has, the note is gone. So the tool assembles
first and refuses with a plain explanation rather than writing half a note, and
the acceptance gate checks the recovery against a real database, because whether
the chunks are still there is not a thing a fixture can answer.

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

## A deleted note cannot come back as an answer

The counterpart to being able to delete: search must not then hand the note back
as context for a question. Being asked about something you deliberately removed
is worse than a missing answer, and it is not a hypothetical, because search is
served by the index rather than the vault. The changes feed removes a deleted
note from the index within the second, and the feed can also fail, at which point
`builder.ts` logs it, stops following, and search goes on answering from a set of
notes that is quietly frozen. Nothing in the answer would look wrong.

So the index proposes and the vault decides. Every tool that returns paths from
the index (`search_notes`, `find_by_property`, `find_by_tag`, `note_links`,
`vault_health`) confirms them against the replica first, through
`VaultReader.live`, which reads the file documents and no chunks. A path the
vault no longer holds is dropped from the answer and removed from the index on
the way past, so reading repairs. `src/server/confirm.ts` holds the reasoning.

Three consequences worth knowing:

- The answer says how many results were left out and **never which**. Naming a
  deleted note in a search result is the leak in miniature, and a path is enough
  for a model to repeat it or go looking. The paths go to the log instead.
- `note_links` refuses outright for a deleted note, because a note's links are
  its content.
- `property_inventory` and `tag_inventory` aggregate and return no paths to
  confirm, so they are the one surface still relying on the feed having been
  applied. They report counts and property values, not note paths.

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

### Moving, renaming and copying

Built 30 July 2026, to `docs/move-rename-design.md`, which measured the vault
first and found the assumption in the checklist item wrong: every link in this
vault is a basename, so a move breaks nothing and a rename breaks everything.
That is what put `move_file` on the single-write path and `plan_move` on the
plan path.

The check both of them turn on is `VaultIndex.resolutionImpact`, which
recomputes link resolution with the destination substituted for the source and
reports two things. A **break** is a link that resolved to something and would
resolve to nothing. A **repoint** is a link that would resolve to a different
file, with no text changed anywhere. The second is the one worth the machinery:
a break is loud, and a repoint leaves the vault reading correctly and meaning
something else. This vault holds both `Interacts/Peter Litzow.pdf` and
`Interacts/Superseded/Peter Litzow.pdf`, so it is one folder move away from that
at any time.

Answering a hypothetical meant writing the resolution rule a second time, in
code, since no table holds the answer for a vault that has not been written to
yet. The copies are checked against each other in `test/index/resolve.spec.ts`
rather than trusted, because a mirror nobody checks is a fork.

Three things follow from a path being a document ID here, and each one is
somewhere it can be enforced rather than remembered:

- **A relocation is a write and then a delete, in that order**, and
  `WriteExecutor.relocate` owns both. The worst outcome of an interruption is
  then a duplicate, which is visible and fixable, rather than a hole where a
  note used to be. `test/write/executor.spec.ts` constructs the interruption
  deliberately, because the ordering is the whole safety argument and asserting
  it is the only way to know it was implemented as designed.
- **The destination reuses the source's chunks**, which are guaranteed present
  precisely because the source is still live at that moment. A 4 MiB Interact
  PDF moves without a byte of it going back over the wire.
- **In a plan, a relocation is one operation**, `{ kind: "move", from, to }`.
  Expressed as the two existing kinds it would put the ordering at the mercy of
  the order of an array, and would let a plan commit a delete whose matching
  write had failed.

`plan_move` rewrites each affected link with the smallest edit that works: the
target text changes, and the alias, subpath, embed marker and whitespace do not.
The one subtlety is that the obvious new text is sometimes the old text.
Renaming nothing about `[[Peter Litzow.pdf]]` while moving that file under
`Superseded/` produces the identical link, now resolving to the other copy, so
every rewrite is checked against the vault as it will be and falls back to the
full path when the short form no longer lands on the right file.

### Tagging

Built 30 July 2026. `plan_retag` renames, merges or removes a tag across the
vault, and it is on the plan path because a tag rename is a batch by definition:
the selector is the tag itself, which is why this one does not take the usual
selection arguments and cannot be called with no selection at all.

The reason it could not be done with `plan_set_properties` is worth keeping.
That tool sets a property to a literal, so renaming a tag with it would give
every selected note the same `tags` value rather than each note its own list
with one element changed. A tag rename has to compute a value per note. And a
tag lives in two places that look nothing alike, a `tags:` list in frontmatter
and `#tag` in the body, both of which the index reads and `find_by_tag` returns,
so handling one and not the other leaves the vault half renamed with the tool
reporting success.

Three decisions in it:

- **A rename takes the nested tags with it.** Obsidian treats `#work/acme` as
  living under `#work`, so leaving it behind would strand it under a parent that
  no longer exists. `#workshop` is untouched, because a prefix match without the
  separator is how a rename quietly eats a different tag.
- **A removal does not do the same thing in reverse.** Removing `#work` when
  `#work/acme` exists might mean removing those too or might mean leaving them,
  and it is a judgement about what the tags mean rather than about syntax. It
  refuses and names them.
- **A removal takes one space with it**, so "todo #work now" does not end up
  with a gap in the middle, and takes the space after the tag instead when the
  tag starts the line or the previous removal already claimed the one before.
  Spaces only: two at the end of a line are a line break in Markdown.

The frontmatter half keeps the shape it found, so a note written `tags: work
idea` stays a string and a note with a list stays a list. A rename onto a tag
the note already carries merges the two rather than listing it twice, and only
for the collision the rename caused: a note that already listed one tag twice
keeps both, because collapsing that would be a second change nobody asked for.

### What the server says about itself

The MCP `instructions` string is the first thing a client reads about the vault,
before any tool is called. It used to be a literal ending "This server is
currently read-only", and it went on saying that after writing was turned on, so
every connecting client was told editing was impossible while twelve tools that
edit sat registered behind the sentence. Nothing failed, because nothing was
checking a paragraph.

`src/server/instructions.ts` composes it now, from the configuration that
decides the thing being described. It says whether writes are on, and when they
are it says the three things a client has to know before using one: that a
conflict means to read the note again rather than retry, that a delete cannot be
undone here, and that a plan is meant to be shown to the person who asked before
`commit_plan` is called. It does not list the write tools, because that list is
built by the registrations and read back by `vault_status`, and a copy in the
instructions would be a third place for the same fact.

It also passes on the vault's own `CLAUDE.md`, if it has one, as the vault's
conventions. That matters more for a vault being started from scratch than for
one being migrated into: `property_inventory` and `tag_inventory` exist to show
what conventions already exist before anyone proposes another, and on an empty
vault they show nothing, which inverts the job. The risk stops being "fail to
match the existing scheme" and becomes "invent a different one every session".
Instructions are sent once, when a client connects, so editing that note has no
effect on a session already running: `vault_status` says whether this client was
told the conventions and whether they have changed since, because all three
states otherwise look identical from the outside.

### The index feed, and what a dead one costs

The index follows the replica's changes feed. It used to stop following on any
error: one log line, `following = false`, and dead until the process restarted.
Nothing about the answers gave it away, because a stale index does not fail. It
returns fewer notes, and every one it returns is real, so search goes on looking
exactly like search while quietly answering from a set of notes that stopped
growing at some point yesterday. Notes written since are not findable, not in
`search_notes` and not in the tag or property inventories, and therefore not
selectable by anything that plans a batch.

It reconnects now, doubling from a second to a minute, and resumes from the last
sequence it applied rather than from "now", which would skip whatever arrived
during the outage. `vault_status` says whether the feed is attached, because the
warning goes to a log nobody is watching and the whole problem with this failure
is that it does not announce itself.

The confirmation step means a dead feed still cannot surface a deleted note, so
this remains a staleness problem rather than a correctness one. It is a
staleness problem that used to last until someone restarted the container.

### Notes two devices both changed

`vault_health` reports conflicts now, and it is the only line in that report
that comes from the replica rather than the index, and the only one that is not
a curation problem. A conflict is two devices changing a note without having
seen each other's change, which is ordinary in a synced vault and is not an
error. What makes it worth surfacing is that nothing else ever will: CouchDB
picks a winner deterministically, every read returns that winner, and the other
version sits in the document indefinitely. Nobody loses work and nobody knows a
version exists. Obsidian's own sync plugin is the only thing that can show you
both, so that is where the report sends you.

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
so a read-only deployment cannot reach CouchDB with a PUT at all. The write
tools are registered only when writes are enabled, so a read-only server
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

    Re-run again on 30 July 2026 for the move path, and confirmed in Obsidian:
    a move that sent no chunks at all, a refusal to move onto an occupied path
    with the occupant untouched, a copy, and a rename committed in one plan
    with the link rewrites it needed, aliases, subpaths and embed markers
    intact. Every check passed. That is the gate met for everything the write
    surface can now do, rather than for what it could do yesterday.

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
- [x] **A move, rename and copy.** `move_file`, `plan_move` and `copy_file`,
      30 July 2026, to `docs/move-rename-design.md`. The design question turned
      out to have a measurable answer: every link in this vault is a basename,
      so a move breaks nothing and a rename breaks everything, which is what
      splits the tools across the single-write and plan paths. See "Moving,
      renaming and copying" above. OneNote parity on this point is now met for
      one file at a time; a folder is still many files, which is the batch case
      below.
- [ ] **Batch move and rename by selector.** The obvious next plan operations,
      and deliberately not built yet: the single-file behaviour has to be right
      before it is multiplied by forty. Moving a folder is this wearing a
      different hat and should use a selector rather than a tool of its own.
- [ ] **Decide whether OneNote ink or its transcription is the source of truth.**
      OneNote treats handwriting as first class (`get_page_ink`,
      `render_page_ink`). Here a handwritten page arrives as an image or PDF
      attachment and the equivalent is `list_untranscribed` plus
      `save_transcription`. Better for search, but it is transcription rather
      than ink, and the transcriptions are the only data in this system that
      nothing can recompute.
- [x] **Tag editing.** `plan_retag`, 30 July 2026. The vault is being started
      from scratch rather than migrated into in bulk, so reorganising and
      tagging through Claude is the actual use, and tag editing was the half of
      it that did not exist: reading tags worked, changing one across the vault
      was not expressible. See "Tagging" above.
- [x] **Undo for a delete.** `restore_note`, 30 July 2026. OneNote has no
      counterpart and this is not parity: it is that a server which can delete
      and cannot undelete is the wrong asymmetry to point at somebody's only
      copy of their notes.
- [ ] Run the same task through both servers side by side once, rather than
      comparing tool lists. The gaps above came from the registered tool names.
- [ ] **An extensionless link to something that is not a note does not
      resolve.** Obsidian opens the PDF for `[[Peter Litzow]]` when nothing else
      carries that name; both copies of the resolution rule here only ever
      append `.md`, so the link reads as broken. Written down rather than fixed
      on 30 July 2026, because changing what an existing link means is not a
      thing to do inside a change about moving files, and `vault_health` at
      least reports it. `test/index/resolve.spec.ts` pins the current behaviour,
      so fixing it will fail that test rather than surprise anyone.

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
- [x] `READ_ONLY=false`, client still only `vault:read`. **Passed 30 July 2026.**
      The write tools appeared after a reconnect, and a `create_note` call was
      refused for want of `vault:write` rather than succeeding. That is the scope
      gate observed rather than assumed, which was the whole point of the step.
      Nothing has been written to `obsidiandb` by this server.
- [ ] Grant `vault:write` in Pocket-ID, with `COUCHDB_DATABASE` pointed at
      `obsidian-writetest`.
- [ ] Point `COUCHDB_DATABASE` at `obsidiandb`.

### Smaller things, whenever

- [x] **The index changes feed restarts itself.** 30 July 2026. Backoff from a
      second to a minute, resuming from the last sequence applied, and
      `vault_status` says whether it is attached. See "The index feed" above.
- [ ] `get_attachment` refuses an attachment over `ATTACHMENT_SIZE_CAP` but will
      still serve a stored transcription for it. Untested; add one.
- [ ] E2EE is not enabled on the vault. The code handles it and the differential
      tests cover it, but no real encrypted vault has been read.
- [x] **Rotate the CouchDB `obsidian` password.** Done 30 July 2026. It had been
      passed on a command line and pasted into a chat the day before. Anything
      holding the old one fails closed and confusingly: repeated failed auth
      returns "Name or password is incorrect" even once the right password is
      supplied, because the 600k-iteration PBKDF2 hash backs up. So check the
      deployed container and every synced device, rather than waiting to be
      told.
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
- **The same fact written in two places will disagree, and the copy nobody
  tests is the one that lies.** The tools that can change the vault were named in
  a sentence in `vault_status` and in another in the startup warning.
  `delete_note` was added to the first and missed in the second, so for a day the
  log greeting an operator said "Six tools can modify this vault directly" and
  listed six of the seven. It was believed, reasonably, because a warning that
  specific reads as authoritative. Both now read one list that the registrations
  themselves build, and the sentence carries no count at all, since a count is
  another copy of the same fact. Tests assert both against an independently
  written list, which is what a test is for.
- **A structural test can stop testing anything without failing.** The scope
  check test in `test/write/surface.spec.ts` finds tool registrations by
  splitting the source on `server.addTool({`. Wrapping that call to collect the
  tool names, an hour later, would have left it splitting on a string that no
  longer occurred: zero blocks, nothing to check, green. Any test that discovers
  its own subjects needs a floor on how many it found.
- **The index is a cache, and its failure mode is not lag but persistence.** It
  can hold a note the vault does not, which no amount of correctness in the
  delete path prevents: the feed that would tell it can die, and does so with a
  log line and no other symptom. So an index result is a candidate rather than an
  answer. Two things follow that were not obvious before writing it. Confirming
  costs one shallow lookup per result set, not per result, so the honest version
  is affordable. And the check is the only moment when something has both noticed
  the staleness and knows which path it is, which is why it repairs the index
  rather than logging and moving on.
- **A guard that names what it withheld has not withheld it.** The first version
  of the staleness line listed the paths it had dropped, which put a deleted
  note's path back into the answer that exists to keep it out. Caught by a test
  asserting the path was absent from the output, not by reading the code.
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
- **A cache that stops updating does not look broken, it looks smaller.** The
  index feed died on any error and stayed dead until the process restarted.
  Every answer it gave afterwards was correct, which is exactly the problem:
  search returns real notes, just not all of them, and there is no shape of
  answer that says "and eleven others you wrote since Tuesday". It reconnects
  with backoff now and `vault_status` says whether it is attached. The general
  version: a failure that degrades an answer rather than preventing one needs
  something that reports its own health, because nobody will infer it from the
  output.
- **A soft delete is recoverable right up until the plugin tidies up.** A
  tombstone keeps its chunk list, which is what `restore_note` rests on, and the
  plugin's orphan cleanup is entitled to collect chunks no live note references.
  Both facts are true and the second one is invisible, so the tool assembles the
  note before claiming it can restore anything, and says plainly that the pieces
  are gone when they are. The gate checks this against a real database, since
  whether the chunks are still there is precisely what a fixture cannot tell you.
- **A paragraph can be wrong for a day and nothing will notice.** The server's
  MCP instructions said it was read-only, in a hardcoded string, and kept saying
  it after `READ_ONLY=false` went live. Every client was told writing was
  impossible while twelve write tools sat registered behind the sentence, and
  the failure mode is a model that reasonably declines to try. Prose about a
  system is a claim about it, and the same rule applies as to the tool list in
  `vault_status`: compute it from the thing it describes, and put a test on it.
  `test/server/instructions.spec.ts` reads like a test of writing and is a test
  of a fact.
- **A structural test only covers the file it names.** The scope check in
  `test/write/surface.spec.ts` read `write-tools.ts` and nothing else, so the
  plan tools were outside it until `plan_retag` was added, which is the wrong
  moment to notice: composing a plan reads every selected note and returns their
  content, so an unscoped planning tool would hand a vault to a connection
  holding only `vault:read` before anything was committed. It covers both files
  now, with `discard_plan` exempted by name rather than by accident.
- **A link target goes into a LIKE pattern, so `_` in a filename was a
  wildcard.** Link resolution matched a basename with `n.path LIKE '%/' ||
  links.target`, and SQLite reads `_` as "any character", so `[[report_2026]]`
  resolved against `report-2026.md` and, ties going to the shortest path, could
  win. `notesUnder` had already learned this about folder names and escapes for
  it; this was the same bug where it decides what a link means rather than what
  a batch includes. Found while writing the second copy of the resolution rule,
  which is an argument for having written it.
- **The changes feed did not re-resolve links after a removal, so a moved file
  arrived unreachable.** A move produces two changes: the destination, which was
  indexed and re-resolved, and then the source's tombstone, which called
  `index.remove` and stopped. `remove` clears the resolution of every link
  pointing at the removed path, so links to the moved file sat unresolved until
  the next restart. Resolution changes when a path disappears, and not only by
  breaking: in a vault with two files of the same name the other one takes over,
  which is Obsidian's behaviour and is exactly what a move depends on.
- **The feed indexed the moved attachment before its transcription followed
  it.** `relocate` writes the destination, deletes the source, and only then
  tells the stores outside the vault. The replica patch means the feed sees the
  destination immediately, so it indexed the new path while the transcription
  was still filed under the old one, found nothing to index for it, and never
  looked again: a scan a model had been paid to read would silently stop being
  findable. The listener now reindexes the destination after the transcription
  moves. The general shape is worth keeping: a cache fed by an event is stale
  with respect to anything that happens after the event.
- **The obvious rewrite of a link is sometimes the text it already had.**
  Renaming nothing about `[[Peter Litzow.pdf]]` while filing that file under
  `Superseded/` produces the same link, which now resolves to the other copy of
  that name. The rewrite would have reported success and changed nothing while
  the note came to mean something else. Every rewritten target is now checked
  against the vault as it will be, and falls back to the whole path when the
  short form no longer lands on the right file.
- **A commit that relocates something returns two receipts for one change.**
  `commit_plan` counted receipts, so a rename that moved one file and edited one
  note reported "3 note(s) written" and listed the old path among the notes
  written. Small, and the same species as the startup warning that undercounted:
  a number nobody can reconcile with the plan they just read teaches them that
  the numbers are noise. Deletions are now counted and marked separately.
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

Then the machine half. Note the address: this script reads every result back
by document ID, and a document ID here is the vault path, so the public
hostname 400s on the first note in a folder. See the Traefik entry below.

```powershell
$env:COUCHDB_URL = "http://192.168.50.2:9113"
$env:COUCHDB_USER = "obsidian"
$env:COUCHDB_PASSWORD = "..."
npm run verify:write -- --db obsidian-writetest --reset --keep
```

`--reset` on any run after one that used `--keep`: deleting the folder in
Obsidian is a soft delete, so every path still holds a document and the first
create would be refused.

It creates a note, edits it reusing chunks, refuses a stale write, plans and
commits a batch, refuses a stale plan, soft-deletes, writes over the tombstone,
moves a file, refuses a move onto an occupied path, copies one, and renames one
in a plan committed together with the link rewrites that rename needs. It reads
every result back out of CouchDB through the vault model rather than through its
own client or the replica, and checks the local replica for conflict branches.

The move checks are worth watching rather than only passing. The one that says
"sent no chunks" is the difference between moving a 4 MiB scan and uploading
one, and the tombstone check is what makes a rename reach the other devices as a
removal rather than as a file they still hold.

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

`plan_retag` deliberately added nothing to this script. It composes ordinary
writes and commits them through the plan protocol, both of which the run already
covers; what is new in it is which text it composes, and that is a question for
the unit tests rather than for a script that exists to prove documents reach
CouchDB intact. A change that writes a new *shape* of document belongs here. A
change that writes different words does not.

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

The public hostname is safe for this one, and only this one: it reads through
replication and `_all_docs`, never a document by ID. That is exactly why it
never found the Traefik problem.
```

Nothing above writes.

The one command that does is `npm run verify:write`, and it refuses to run
against `obsidiandb`. See below.

The server, over stdio, with a client attached so it does something visible:

```powershell
$env:COUCHDB_URL = "http://USER:PASS@192.168.50.2:9113/?db=obsidiandb"
npm run try
```

The internal address again, and for the same reason: `read_note` with
`fresh=true` fetches by document ID.

`npm run try` pins `REPLICA_PATH`, `INDEX_PATH` and `TRANSCRIPT_PATH` under
`tmp/`, so a scratch run cannot open or damage a real store.
