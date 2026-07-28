# The Self-hosted LiveSync storage contract

What a LiveSync vault actually looks like inside CouchDB, derived from the
plugin's own source rather than from documentation. Everything here is asserted
by the test suite; the differential tests run our implementation against the
plugin's and require agreement.

Versions this was derived from:

| Package | Version |
| --- | --- |
| `obsidian-livesync` | `main`, cloned 2026-07-28 |
| `@vrtmrz/livesync-commonlib` | 0.1.0 |
| `octagonal-wheels` | 0.1.51 |
| Database schema version | 12 |

A plugin update that changes any of this should fail loudly rather than
silently misread. See "Detecting drift" at the end.

## Document types

The discriminator is `type`. Note that `datatype`, which appears throughout the
plugin source, is **never persisted** — it exists only on in-memory objects.

| `type` | Meaning |
| --- | --- |
| `plain` | Text file. Chunks hold raw UTF-8. |
| `newnote` | Binary file. Chunks hold base64. |
| `notes` | Pre-chunking legacy note; content inline in `data`. |
| *(absent)* | Also a legacy note. The oldest documents have no `type`. |
| `leaf` | Chunk payload. |
| `chunkpack` | Packed chunks. Not produced by this version. |
| `versioninfo`, `syncinfo`, `milestoneinfo`, `nodeinfo`, `sync-parameters` | Bookkeeping. |

A file document holds exactly: `_id`, `_rev`, `path`, `ctime`, `mtime`, `size`,
`type`, `children`, `eden`, and `deleted` once soft-deleted. A chunk holds
`_id`, `_rev`, `type: "leaf"`, `data`, plus `e_: true` when encrypted.

### Deletion has two representations

The plugin's default is a **soft delete**: the document survives with
`deleted: true` in the body, keeps its `children`, and gets a bumped `mtime`.
Only with `deleteMetadataOfDeletedFiles` does it also set CouchDB's `_deleted`.
A reader must honour both.

### `eden`

An obsolete inline-chunk optimisation. Current clients always write `{}`, but on
a vault with `useEden` on, a chunk referenced by `children` may exist *only*
inside `eden`. This implementation does not read it and rejects such documents
explicitly rather than reporting their chunks as missing.

## Paths and document IDs

Without obfuscation, the ID is the path verbatim — lowercased unless
`handleFilenameCaseSensitive`, with a `/` inserted in front if it starts with
`_`, because CouchDB reserves leading-underscore IDs.

With obfuscation:

```
hp  = hex(SHA256(utf8(passphrase)))
_id = <path prefix> + "f:" + hex(SHA256(utf8(hp + ":" + path)))
```

Three consequences worth stating plainly:

- **The ID is one-way.** An obfuscated ID cannot be turned back into a path.
  The plaintext path lives inside the document, in the encrypted `path` field.
- **The ID loses case.** With the default `handleFilenameCaseSensitive: false`
  the ID is lowercased while `path` keeps the real casing. Reads must take the
  path from the `path` field.
- **Writing to an existing path means recomputing the same hash from the same
  input string.** Any difference — case folding, unicode normalisation, a
  prefix — creates a duplicate document rather than updating the original.

Obsidian normalises a path before this mapping: separators collapsed, leading
and trailing slashes stripped, `U+00A0` and `U+202F` folded to a space, and NFC
composition applied. Skipping the NFC step alone would give a decomposed
filename a different document from the one every other client uses.

Path prefixes namespace non-note documents: `i:` (hidden file sync), `ix:`
(customisation sync), `ps:` (obsolete plugin store). A path containing any other
colon is refused as a sync target by the plugin, so writing one produces a
document nothing will ever read.

## Chunking

Four splitters exist; the default since the current release is
`v3-rabin-karp`. Chunk boundaries are **not** part of the correctness contract —
a file is reassembled by concatenating `children` in order, whatever produced
them — but they are part of the *deduplication* contract. Chunks are shared only
if they are identical.

The V3 splitter is a content-defined chunker with several properties that look
like bugs and must be reproduced anyway:

- The rolling hash is never reset at a boundary; it runs continuously.
- The window does not slide until `pos >= start + windowSize`, so for the first
  48 bytes after each boundary the hash covers a growing prefix. Chunking is
  position-dependent in a way textbook Rabin-Karp is not.
- The boundary test is `hash % avg === 1`, not `=== 0`.
- Arithmetic is signed 32-bit, compared unsigned.
- A boundary landing mid-UTF-8-sequence is skipped, so a chunk can exceed the
  maximum by up to three bytes.

Sizes are derived from the input length: text under 4 MiB uses a chunk unit that
grows in steps of 32 bytes until the estimated chunk count falls to 500 or
fewer. Text at or above 4 MiB switches to binary sizing but is still emitted as
text — a corner easy to get wrong in either direction.

Text chunks are UTF-8 decoded strings, stored directly in JSON. A leading byte
order mark is content and must survive; the decoder is constructed with
`ignoreBOM: true` for that reason. Binary chunks are standard padded base64.

## Chunk identity

A chunk's ID is a **pure content hash**. There is no per-document,
per-revision, per-path or per-position salt — only, when E2EE is on, a single
vault-wide value derived from the passphrase.

```
h:<hash>       hash = XXH64(utf8(piece + "-" + piece.length), seed 0).toString(36)
h:+<hash>      hash = XXH64(utf8(piece + "-" + hashedPassphrase + "-" + piece.length), …)
```

`piece.length` is the JavaScript UTF-16 length, not the byte length. For binary
files the piece is the base64 string, so the hash covers base64 text.

`hashedPassphrase` uses only the first three quarters of the passphrase's
characters, prefixed by a salt constant that contains a literal `U+0003`.

**This confirms the first assumption in the design document.** The write path
can reuse chunks across notes and treat a 409 on a chunk PUT as success, because
the document already there has by construction the same content.

The caveat: nothing upstream verifies this. A 409 is unconditionally read as
"already exists", and a genuine collision would silently alias two pieces. The
write executor should log any case where a colliding ID has different local
content.

Four other hash algorithms are selectable. Under `sha1` the hash is base64, so
roughly one unencrypted chunk in sixty-four begins with `+` — which means the
`h:+` prefix is **not** a reliable marker of encryption on its own. The plugin
avoids this only because it does not install the encryption transform at all
when encryption is off.

## Encryption and compression

Both are `transform-pouch` transforms on the remote handle. Compression is
installed first and therefore ends up outermost:

```
write:  plaintext → encrypt → compress → wire
read:   wire → decompress → decrypt → plaintext
```

Two document classes bypass both transforms entirely: anything under `_local/`,
and bare tombstones. That exemption is what makes the PBKDF2 salt readable
before anything else can be decrypted.

### What is encrypted, decided by `_id`

| ID | Effect |
| --- | --- |
| `h:+…` | `data` encrypted, `e_: true` |
| `syncinfo` | `data` encrypted like a chunk |
| `f:…` | metadata protected (see below) |
| everything else | untouched |

Note the consequence for prefixed documents: hidden-file and plugin-sync
documents get IDs like `i:f:…`, and the obfuscation test is `startsWith("f:")`,
so **their `path` field is left in the clear**.

### Wire formats

| Prefix | Format |
| --- | --- |
| `%=` | AES-256-GCM. `base64(IV[12] ‖ hkdfSalt[32] ‖ ct ‖ tag)`. Master key is PBKDF2-SHA256(passphrase, vault salt, 310 000); per-message key is HKDF-SHA256. **Current.** |
| `%` | Legacy AES-256-GCM. `"%" ‖ hex(IV[16]) ‖ hex(salt[16]) ‖ base64(ct‖tag)`. Note the 16-byte GCM IV. |
| `%~` | Deprecated V3. Decrypt only. |
| `[…]` | Oldest format, a JSON array of three strings, plaintext JSON-wrapped. Decrypt only. |
| `LZ…` | Deflate. `~` after the marker means the pre-deflate payload was base64 and was decoded first. |

`%=` must be tested before `%`, since one is a prefix of the other.

The vault-wide PBKDF2 salt is base64 in
`_local/obsidian_livesync_sync_parameters`, field `pbkdf2salt`.

### Metadata protection

Under E2EE v2, an obfuscated document's entire metadata object — path, times,
size **and the chunk list** — is JSON-encrypted into `path` behind the prefix
`/\:`, and `mtime`, `ctime`, `size` are zeroed and `children` emptied on the
wire.

This has a sharp edge. An encrypted document and a genuinely empty note are
indistinguishable by shape: both have `children: []` and `size: 0`. Assembling
one without decoding it first yields an empty note and no error. Worse,
encrypting an already-encrypted document seals the zeroed fields and the
emptied chunk list, destroying the only record of the note's content while
leaving a document that still reads cleanly. The plugin guards this in two
places; so must anything else that writes.

Under legacy E2EE only `path` is protected, deterministically — the salt and IV
are derived from `SHA-256(path ‖ passphrase)`, so the same path always yields
the same ciphertext.

## Settings that change the format

These cannot be assumed. Every device publishes its own copy into
`_local/obsydian_livesync_milestone` under `tweak_values`; read them from there.

`encrypt`, `passphrase`, `usePathObfuscation`, `useDynamicIterationCount`,
`E2EEAlgorithm`, `enableCompression`, `hashAlg`, `chunkSplitterVersion`,
`handleFilenameCaseSensitive`, `minimumChunkSize`, `customChunkSize`,
`useSegmenter`, `useEden`.

If two devices disagree on one of these, that is a real problem in the vault —
the plugin itself blocks sync on it — and it should be reported rather than
resolved by picking a winner.

Values must also be type-checked. A string `"false"` where a boolean belongs is
truthy, and for `handleFilenameCaseSensitive` that means every document ID gets
the wrong casing and every write creates a duplicate, silently.

## Two upstream misspellings

`_local/obsydian_livesync_milestone` and `_local/obsydian_livesync_nodeinfo` are
spelled with a `y`. `_local/obsidian_livesync_sync_parameters` is not. Both are
load-bearing.

## Detecting drift

The riskiest future change is a plugin update that alters chunking or the
encryption format. Three cheap checks:

1. The database schema version in `obsydian_livesync_version` against
   `SUPPORTED_DB_VERSION` (currently 12).
2. `tweak_values` for a `chunkSplitterVersion`, `hashAlg` or `E2EEAlgorithm`
   this implementation does not recognise — `readTweakValues` reports these as
   `invalid` rather than adopting them.
3. Re-running the differential test suite after bumping the pinned
   `@vrtmrz/livesync-commonlib` version. That is what it is for.
