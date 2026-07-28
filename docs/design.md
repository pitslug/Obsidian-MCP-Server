# obsidian-livesync-mcp — design

**Date:** 2026-07-25
**Status:** design approved, not yet implemented

## Purpose

A single Docker container that makes an Obsidian vault synced through Self-hosted
LiveSync readable and writable by Claude from any session, on any device, by
speaking directly to the CouchDB that already backs that sync.

The vault is not materialised as files anywhere. There is no second copy of the
notes on a filesystem for another program to serve. The container replicates the
LiveSync database, understands its storage format natively, and exposes that
understanding as MCP tools.

## Why this rather than existing pieces

Two off-the-shelf routes were evaluated and rejected.

Chaining `livesync-bridge` to a filesystem-based MCP server works, but needs two
containers with two runtimes, materialises a permanently decrypted copy of the
vault on disk, and inherits `obsidian-web-mcp`'s lack of any link-graph
awareness. Adopting `obsidian-sync-mcp` wholesale is closer to right — it also
talks to CouchDB directly — but its nine tools do not cover the curation and
frontmatter work this vault is being built for, and it makes every read a live
HTTP round trip per chunk.

Building it means owning the LiveSync storage contract rather than borrowing it.
That is the real cost, and it is concentrated in one testable unit.

## Constraints and decisions already settled

The runtime is Node 22 and TypeScript, not by preference but by necessity: the
primitives that make LiveSync's format legible — `transform-pouch` for the E2EE
boundary, `octagonal-wheels`, `xxhash-wasm` for chunk identity, the PouchDB core
— exist only in JavaScript. Reimplementing them in another language would mean
reimplementing the one part of this system where being wrong destroys the vault.

Deployment is Docker Compose behind Traefik, matching existing infrastructure.

The vault is currently small — under a thousand notes — and expected to grow into
the low thousands with significant attachment volume. Everything here is sized
for the target, not the present.

Primary uses are retrieval and synthesis, curation and maintenance, and capture
from anywhere. Long-form drafting inside the vault is explicitly not a goal,
which narrows the write surface to appends, property edits, and note creation
rather than reliable authoring of large documents.

### Replication topology: pull-only, direct writes

The container holds a complete local PouchDB replica of the vault on a Docker
volume, continuously replicated **downward** from CouchDB and never upward.
Writes do not travel through the replication channel. When a tool writes, the
write executor composes the documents and `PUT`s them straight to CouchDB over
HTTP, then observes them arrive back down the pull stream as confirmation.

The alternative — a genuine two-way peer, which is what every Obsidian device is
— was considered and rejected on blast radius. Replication reconciles everything
that differs between two databases; it cannot be scoped to intent. A local
replica that drifts for any reason, whether a half-completed write, a decode bug
or a restored snapshot, has its drift pushed faithfully to the vault and thence
to every device. With direct writes, the only documents that can ever reach the
vault are ones the write executor constructed deliberately, and each one returns
an immediate per-document verdict: accepted, or `409` because the note changed
elsewhere since it was read.

The accepted cost is that the local replica is momentarily behind on a note the
server itself just wrote. The write executor patches the replica with the known
new revision rather than waiting for the pull loop to come around.

### Consistency model

Reads are served from the local replica, and search additionally goes through the
index built from it, so both are eventually consistent — typically sub-second
behind CouchDB, with search trailing note reads by the time it takes to reindex a
changed note. This is acceptable for retrieval and synthesis, and every response
carries the current replication and index lag so staleness is visible rather than
assumed away.

Two exceptions make the model safe. Read tools accept a `fresh` flag that
verifies the note document's `_rev` against CouchDB before answering, for the
cases where currency matters more than latency. And the write path never trusts
the replica: it always reads the current `_rev` from CouchDB directly before
composing a write, so a lagging replica can never cause a lost update.

### Write safety

Any operation that touches more than one note is a two-phase dry run. The first
call returns a plan — every affected path, before and after values, and totals —
and writes nothing. A second call commits that plan by ID.

Plans are single-use, expire after fifteen minutes, and record the `_rev` of
every target note at planning time. Commit refuses outright if any target has
changed since. A configurable ceiling on notes per plan, defaulting to 500, sits
behind this as defence in depth, not as the primary control.

Single-note writes execute directly. Requiring a round trip to append a line to a
daily note would make capture-from-anywhere annoying enough to go unused, and the
blast radius of one note is one note.

### Attachments

Attachment metadata — path, size, MIME type, and which notes reference it — is
indexed. Attachment bytes are never indexed and never enter the search path.

A specific attachment can be retrieved on request, subject to a configured size
cap defaulting to 25 MB: images are returned for Claude to look at, PDFs are
extracted to text, anything above the cap is refused with its size reported
rather than reassembled in memory.

### Authentication

OAuth 2.0 with PKCE, implemented in the server against a single configured
client, which is what Claude's custom connector flow expects. A Traefik IP
allowlist or Cloudflare Access sits in front during initial rollout.

## Architecture

Six units inside one container. Each has a single responsibility and a boundary
that can be tested across.

### Replicator

Owns the local PouchDB instance (LevelDB adapter, Docker volume) and an open pull
replication from CouchDB, with `transform-pouch` applying decryption at the
boundary. Reports replication lag and health. Does not know what a note is.

### Vault model

The LiveSync semantics layer, and the unit where correctness matters most: chunk
assembly and splitting, chunk identity, path deobfuscation, note document shape.

Built as pure functions with no network access and no database handle. Documents
in, note out. Note in, documents out. This constraint is deliberate and load
bearing — it is what allows the riskiest code in the system to be tested
exhaustively against captured fixtures with no CouchDB present.

### Index

SQLite on a Docker volume, fed from the local replica's changes feed via the
vault model. Holds an FTS5 table over note bodies plus separate tables for
frontmatter properties, tags, links, and attachment metadata. Knows nothing about
CouchDB or chunks; it consumes assembled notes.

Because the index parses notes rather than reading files, the wikilink graph and
backlinks are available — the capability that ruled out the off-the-shelf
filesystem server.

### Write executor

The only unit in the process permitted to make a state-changing outbound request.
Everything else is read-only by construction, which reduces "can this corrupt my
vault?" to a question about one file.

Composes documents through the vault model, reads current revisions from CouchDB,
`PUT`s, handles `409` by refusing rather than retrying blind, and owns staged plan
state for the dry-run protocol.

### Tool layer

Exposes the MCP surface over `fastmcp`. Contains no logic of its own beyond
validating arguments and translating a tool call into calls on the units above.

### Transport and auth layer

Terminates streamable HTTP, implements OAuth 2.0 with PKCE, sits behind Traefik.

## Data flow

**Read.** Tool call → index lookup for search and filtering → note documents from
local replica → vault model assembles chunks into a note → response, annotated
with replica lag. With `fresh: true`, a `_rev` check against CouchDB precedes
assembly.

**Write.** Tool call → current `_rev` read from CouchDB → vault model splits new
content into chunks → write executor `PUT`s new chunk documents, then the note
document → local replica patched with the known result → change appears on all
devices through their own replication.

**Index maintenance.** Replica changes feed → vault model assembles each changed
note → index rows replaced within a transaction. The index is a derived artifact
and can be rebuilt from the replica at any time without touching CouchDB.

## Tool surface

Read and search: full-text search with path, tag, property and date filters
returning snippets; frontmatter property search; single and batch note reads;
folder and glob listing; outgoing links and backlinks for a note; tag inventory
with counts; **property inventory with counts and observed value types**;
attachment listing and metadata; attachment retrieval under cap; and a status
tool reporting replica lag, document counts and index health.

The property inventory tool deserves specific mention because it directly serves
the stated goal of building a more robust frontmatter system: it lets Claude see
what property keys and value shapes already exist across the vault before
proposing a schema, rather than guessing.

Write: append to a note, creating it if absent; create a note with frontmatter
and body; targeted in-note edit by string match; set properties on one note;
batch set properties across a query result; append to today's daily note. Batch
operations are plan-gated; the rest execute directly.

A global read-only toggle disables every write tool. Initial rollout runs with it
on.

## Configuration and deployment

One service in a Compose stack, joined to the existing Traefik network and to
whatever network CouchDB is reachable on, with two named volumes: one for the
PouchDB replica, one for the SQLite index. Both are derived data and safe to
destroy.

Configuration is environment variables throughout, with no config file, so
nothing holding a secret ever needs to sit on disk as a mounted file. The
sensitive values are the CouchDB URL, database name, username and password, and
the LiveSync E2EE passphrase — with the path obfuscation passphrase alongside it
if that is enabled. The rest is operational: public hostname, OAuth client ID and
secret, read-only toggle, attachment size cap, and plan ceiling.

That the E2EE passphrase must live on this host is inherent to the goal rather
than a flaw in the design. Something has to decrypt the notes for Claude to read
them. It does mean this host holds the keys to the entire vault, and its security
posture should reflect that.

First start replicates the whole database, which for a vault of this size is
minutes rather than hours, and the status tool reports progress. The index builds
from the replica as it lands.

## Error handling

Failures must be loud and must never produce plausible-looking wrong content.

A note whose chunks are not all present in the replica is fetched directly from
CouchDB; if a chunk is still missing, the read fails. A partially assembled note
is never returned, because a truncated note that looks complete is worse than an
error. Decryption failure is likewise an error, never a silent return of
ciphertext or garbage.

If CouchDB is unreachable, reads continue from the replica with staleness clearly
flagged, and writes fail cleanly rather than queueing. If replication has stalled,
the status tool says so and every read response carries the growing lag. A `409`
on write returns the current server-side content alongside the refusal, so the
next step is an informed re-read rather than a blind retry. An attachment over the
size cap is refused with its actual size reported.

## Testing

The vault model is tested first and hardest, because it is the unit whose
failure is unrecoverable. Round-trip property tests assert that splitting a note
into chunks and reassembling it is the identity function, across empty files,
very large files, unicode, mixed line endings, and content at and around chunk
boundaries. Golden fixtures — real document sets captured from a throwaway vault
synced by the actual plugin — assert that the model reads what LiveSync writes.

Integration tests run against an ephemeral CouchDB in Compose, seeded from those
fixtures, covering the changes feed, index maintenance, and the plan-and-commit
protocol including expiry and stale-`_rev` refusal.

The acceptance gate before this touches the real vault has three steps, in order.
Round-trip and fixture tests pass. The container runs read-only against a
throwaway CouchDB database that a real Obsidian instance is syncing to, and a
sample of notes reconstructs correctly. A write made through the tools appears
correctly in that Obsidian instance. Only then does it point at the real database,
and it does so with the read-only toggle on for a first period.

## Assumptions to verify during implementation

These are believed true and cheap to confirm, but the design leans on them.

Chunk identifiers are pure content hashes with no per-document or per-revision
salt. Assembly does not depend on this, since a complete replica holds every
chunk document regardless — but the write path does, because composing a write
means computing identifiers for new chunks and reusing existing ones. If
identifiers turn out to be salted, the write path needs the salt derivation and
loses chunk reuse across notes; reads are unaffected.

A correctly shaped document written directly to CouchDB is indistinguishable to
the plugin from one that arrived via replication. CouchDB does not record
authorship, so this should hold, but replication checkpoints or filtered
replication would be where it breaks.

The E2EE transform and path obfuscation schemes match what the installed plugin
version produces, and the document schema version is one this understands. A
plugin update that changes chunking is the most likely future breakage and should
fail loudly rather than silently misread.

## Out of scope

OneNote migration — content has already been moved. Long-form drafting tools.
Canvas support. Multi-vault support. Rename and move with automatic link
rewriting, which is genuinely useful but is a large feature with vault-wide blast
radius and should be its own design once the foundation is trusted.
Write-protected path globs, deferred for the same reason: the dry-run gate is the
chosen control, and adding a second overlapping one before the first has been
lived with is speculative.

## Rollback

Stopping the container removes the only extra writer; devices continue syncing
through CouchDB exactly as before. Deleting its volumes discards the replica and
index, both of which are derived and rebuild from CouchDB on next start. Nothing
in this design modifies Obsidian plugin configuration, so there is no client-side
change to undo.
