# Obsidian-MCP-Server

An MCP server that makes an Obsidian vault synced through
[Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) readable and
writable by Claude, by speaking directly to the CouchDB that already backs that
sync.

The vault is never materialised as files. There is no second copy of the notes
on disk for another program to serve — this understands LiveSync's storage
format natively and exposes that understanding as MCP tools.

See [`docs/design.md`](docs/design.md) for the full design.

## Status

**In progress.** A read-only vertical slice runs end to end: it replicates a
real vault and serves it over MCP. Search, attachments and every write path are
still to come.

| Unit | State |
| --- | --- |
| Vault model | Implemented, verified against a live vault |
| Replicator | Implemented — pull-only, decoding at the boundary |
| Tool layer | Three read tools: status, read, list |
| Transport | stdio and streamable HTTP, bearer token |
| Deployment | Dockerfile and Compose for the target stack |
| Index | Not started — `list_notes` walks the replica |
| Write executor | Not started, deliberately |
| OAuth 2.0 + PKCE | Not started — bearer token in the interim |

194 tests. `scripts/verify-vault.ts` can be pointed at a live vault read-only;
see below.

## Running it

```bash
npm install && npm run build

COUCHDB_URL='https://user:password@couchdb.example.net/?db=obsidiandb' \
MCP_TRANSPORT=stdio \
REPLICA_PATH=./tmp/replica \
node dist/index.js
```

It reads the vault's storage settings from the vault itself, replicates the
whole database locally, waits for that first pass, then serves. `deploy/`
holds a Dockerfile and a Compose file for a Traefik-fronted stack.

Configuration is environment variables throughout. Every sensitive value also
accepts a `NAME_FILE` form naming a file to read it from, which is how Docker
secrets are consumed. `deploy/obsidian-mcp.env.example` lists all of them.

### Why writes are absent rather than disabled

`READ_ONLY` defaults to true, but more to the point the write tools are not
registered at all. A tool that exists and reports "not implemented" is worse
than no tool: a model will call it, and the user will conclude that writing is
one setting away.

## Why the vault model came first

It is the unit whose failure is unrecoverable. Everything else can be wrong in
ways you notice: a replication bug stalls, an index bug returns nothing, a tool
bug throws. A vault model bug writes a note that comes back subtly altered, and
you find out weeks later.

So it is built as pure functions — no network, no database handle, documents in
and a note out — which is what allows it to be tested three ways:

- **Round-trip property tests.** Splitting a note into chunks and reassembling
  it is the identity function, across empty files, very large files, unicode,
  astral-plane characters, mixed line endings, byte order marks, and content
  sized at every boundary the chunker derives.
- **Differential tests against the plugin itself.** `@vrtmrz/livesync-commonlib`
  is a dev dependency, so the suite runs our chunker, our path mapping, our
  compression and our document transform against the code every other device is
  actually running, and requires agreement. This is the strongest evidence
  available short of a real vault.
- **Failure-mode tests.** Most of the assembly suite asserts that the *error*
  happens — a missing chunk, an undecoded document, a payload that is not valid
  base64 — rather than that the success does.

## What the model owns

```
src/vault-model/
  constants.ts    Storage-format literals, each with its upstream source
  types.ts        Document shapes as they exist in CouchDB
  settings.ts     Format settings, and reading them from the vault's own milestone
  ids.ts          Path ↔ document ID, normalisation, obfuscation
  hash.ts         Chunk identity, all five hash algorithms
  chunking/       The V3 Rabin-Karp content-defined chunker
  crypto.ts       The E2EE boundary (delegates to octagonal-wheels)
  compression.ts  The deflate layer
  transform.ts    Wire form ⇄ plain form
  assemble.ts     Documents in, file out
  compose.ts      File in, documents out
```

[`docs/livesync-storage-contract.md`](docs/livesync-storage-contract.md) records
the storage format this was derived from, including the parts that look like
bugs and have to be reproduced anyway.

## Findings so far

Three things the design flagged as assumptions, now settled:

- **Chunk IDs are pure content hashes.** No per-document, per-revision or
  per-position salt. The write path can reuse chunks across notes and treat a
  409 on a chunk PUT as success, exactly as the design hoped.
- **Path obfuscation is one-way, but the plaintext path is in the document.**
  Recovering a path from an ID is impossible; recovering it from the decrypted
  `path` field is routine. Writing to an existing obfuscated path means
  recomputing the identical hash, so path normalisation has to match Obsidian's
  exactly — including NFC composition and non-breaking-space folding.
- **The E2EE v2 metadata seal is not idempotent.** Encrypting an
  already-encrypted document destroys its chunk list irrecoverably while leaving
  a document that still reads cleanly as an empty note. Guarded, and tested
  against the plugin's own transform.

Two things deliberately not implemented, and why:

- **The V1 and V2 chunk splitters.** Chunk boundaries do not affect
  correctness — the plugin reassembles whatever it is given — only
  deduplication. Implementing two more splitters to save bandwidth on a vault
  that almost certainly uses the current default is not worth the surface area.
  Writing to such a vault throws unless `allowSplitterFallback` is set.
- **`eden` inline chunks.** An obsolete optimisation. Documents carrying them
  are rejected with a message saying so, rather than reporting their chunks as
  missing and leaving the caller unable to satisfy a request that never can be.

## Verifying against a real vault

`scripts/verify-vault.ts` points at a live LiveSync database and checks that
this code understands it. It is **read-only by construction** — the only
request method in the file is `GET`, and a test asserts that a full run issues
nothing else — so it is safe against a production vault.

```bash
npm run verify -- --url 'https://user:password@couchdb.example.net/?db=obsidiandb'
```

It reports the vault's own format settings (read from the milestone document,
not assumed), flags any setting two devices disagree on, assembles a sample of
notes, and then does the check that matters: re-chunks each note and compares
the chunk IDs it *would* write against the ones the plugin actually wrote. If
those match, the write path deduplicates exactly as another device does.

`--census` walks the entire ID space instead and reports where every document
went: counts by type, live versus deleted files, notes versus hidden-file sync,
and how much of the chunk store is orphaned. Most documents in a LiveSync
database are chunks, not notes, so `doc_count` is a poor proxy for vault size —
the census is what tells you the difference.

Useful flags: `--all` to verify every file in the vault rather than a sample,
`--sample N`, `--passphrase` for an encrypted vault, `--verbose` for per-file
output, and `--capture out.json` to save real documents as fixtures — that file
contains note content, so do not commit it.

The sample is spread evenly across the whole ID range rather than taking the
first N, because IDs sort by path and attachments cluster at one end. It also
reports the text/binary split and warns when a run contained no binary files at
all, so a green result cannot quietly mean "attachments untested".

## Development

Requires Node 22 or later.

```bash
npm install
npm test           # everything
npm run test:diff  # just the differential tests against the plugin
npm run typecheck
```

The differential tests import `@vrtmrz/livesync-commonlib` by explicit file
path, because its package exports map does not expose the modules involved. That
import lives in `test/helpers/upstream.ts` and must never appear in `src/` — the
point of the vault model is that it owns this logic rather than borrowing it.

## Licence

MIT.
