# Moving, renaming and copying

Written 30 July 2026, before any code. `docs/design.md` is the plan for the
server as a whole and `docs/status.md` tracks progress against it; this covers
one gap in it, which `docs/status.md` listed as the second parity item after the
delete tool: OneNote has `move_page` and `copy_page`, and nothing here can
relocate a file.

Reorganising as you go is most of what migrating notes out of OneNote consists
of, so this is not a convenience. It is the difference between a vault the
material can be moved into and a vault it can only be poured into.

## What was measured first, and what it changed

The checklist item was written on the assumption that a move breaks wikilinks
and has to rewrite them. Against the real vault that is wrong, and the design
rests on what is actually there rather than on that assumption.

Every link in the vault is a **basename embed**. The Adelaide note contains

    ![[RLT Presentation - Adelaide Office.pptx]]

which resolves to
`Meetings/RLT/Strategy/Attachments/RLT Presentation - Adelaide Office.pptx`.
`VaultIndex.resolveLinks` matches in four passes, most specific first: exact
path, exact path without the extension, basename with the extension, basename
without it. Ties within a pass go to the shortest path, which is Obsidian's own
behaviour.

Four consequences, and each one shapes a decision below:

1. **A move does not break a basename link.** A link written as a basename does
   not care which folder its target sits in. In the vault as it stands, moving a
   file needs no link rewriting at all.
2. **A rename breaks every link in this vault**, because every link is the
   basename. This is the case where the work is unavoidable.
3. **A move can silently re-point a link, which is worse than breaking one.**
   The vault holds both `Interacts/Peter Litzow.pdf` and
   `Interacts/Superseded/Peter Litzow.pdf`. A `[[Peter Litzow]]` link resolves
   to the shorter path. Move the top-level file deeper and that link starts
   naming the superseded copy, with no text changed anywhere and nothing broken
   for `vault_health` to report. The vault still reads correctly and means
   something else.
4. **Moving an attachment unsticks its transcription**, which is keyed by path
   and is the only data in this system that cannot be recomputed. Filing an
   Interact PDF into `Superseded/` is both the most likely move in this vault
   and exactly the case that would orphan one.

## The tool surface, and why it splits this way

The rule this project already follows is that a tool writing one note is a write
tool, and anything touching several goes through plan and commit, because a
multi-note edit reviewed by nobody is the failure the plan protocol exists to
prevent. A move that changes only the folder touches one file. A rename touches
every note that links to it. So the split is not a naming preference; it falls
out of what each operation does.

### `move_file(path, to)`

Relocates one file and rewrites nothing. `to` is a full vault-relative
destination including the extension, so a move and a rename are the same input
and the tool works out which happened by comparing the basenames.

Named `move_file` rather than `move_note` deliberately: unlike `delete_note` it
accepts attachments, because filing an Interact PDF into `Superseded/` is the
most likely move in this vault and an attachment is what it is.

It refuses, writing nothing, when:

- **The destination already exists.** It never overwrites, for the same reason
  `create_note` does not.
- **The source does not exist**, including when the source is a tombstone: a
  deleted note is not there to move.
- **The basename changed and a link currently resolves to the file.** Links that
  resolve to it, not links whose text happens to contain the name: the index
  knows the difference and it is the resolved set that would break. The refusal
  names the notes that would have to be edited and points at `plan_move`. A
  rename of a file nothing links to needs no rewriting, so `move_file` does it
  without complaint.
- **The move would re-point a link elsewhere**, per the check below.
- **Either path is one the plugin would not sync**, or is inside the `i:`, `ix:`
  or `ps:` internal containers. `assertWritablePath` already decides this and is
  the only thing that should.

On success it reports the old and new paths, the new revision, the bytes, and
whether a transcription came across. Also the resolution checks that passed,
named rather than implied, because "no links were affected" is the claim the
caller is relying on and it should be visible that it was checked.

### `plan_move(path, to)`

The reviewed path. Resolves the destination, works out every link that would
need rewriting, writes nothing, and returns a plan for the existing
`commit_plan`. Its operations are the relocation plus one edit per linking note.
Every link rewrite is marked `notable`, because it replaces text, and
`renderPlan` lists notable changes in full however long the plan.

A rename of a file something links to lands here, as does a move whose
re-pointing check found something: the plan lists it so the decision is made by a
person rather than by a refusal. It accepts any relocation, including ones
`move_file` would have taken, which is simply a wasted round trip rather than an
error.

The rewrite is minimal and surgical: in each linking note, the link target text
is replaced, and its alias, subpath and embed marker are preserved. A link
written as a basename gets the new basename; a link written as a path gets the
new path. Nothing else in the note is touched.

### `copy_file(path, to)`

One write, no delete, no link rewriting, so it belongs on the single-write path
and never needs the plan protocol. Sequenced last of the three: it is the least
needed for migrating and the cheapest to add once the rest exists.

The non-obvious part is that **a copy can steal links**. Copying a file creates
a basename duplicate, and if the copy lands on a shorter path than the original
it takes the original's inbound basename links with it, silently. So `copy_file`
runs the same resolution check as `move_file`, through
`resolutionImpact(from, to, { keepSource: true })`, and refuses when the copy
would capture links that currently resolve elsewhere.

A copy of an attachment carries its transcription across, because the content is
byte-identical and the transcription is therefore valid. That also avoids paying
a model to read a 4 MiB scan a second time.

## Execution order, which is the whole safety argument

A path is a document ID in this storage format, so relocating a file is not a
mutation. It is a new document, and the old one has to go.

1. Read the source fresh from CouchDB, content and revision as one observation,
   the way every write tool does.
2. Write the destination.
3. Delete the source, against the revision read in step one.
4. Move the transcription, if there is one.

In that order the worst outcome of an interruption is a duplicate, which is
visible and fixable. In the other order it is a hole where a note used to be.
This is the same reasoning as writing chunks before the note document in
`WriteExecutor.write`, and it is worth stating in both places.

**Steps two and three belong to the executor, as one method.** `relocate` on
`WriteExecutor`, not a pair of calls from the tool layer. The ordering above is
the safety property of the whole feature, and `src/write/` is the unit that owns
what reaches the vault; a guarantee implemented by the sequence of two calls in a
tool is a guarantee the next tool gets wrong. The tool layer stays thin, which is
what it is for.

That has two consequences for existing interfaces, both small and both better
found now than during implementation:

- **`WriteRequest` gains an optional `ctime`.** Today `ctime` is derived: taken
  from whatever exists at the path, and set to `mtime` when nothing does. A
  relocated file has a creation time worth carrying, and its destination path has
  nothing to derive it from. Without this every moved note sorts as newly
  created, which is invisible until someone sorts by it.
- **The destination reuses the source's chunks**, which means `relocate` passes
  the source's chunk IDs where `write` passes `reusableChunkIds(existing)`. They
  are guaranteed present precisely because the source is still live at that
  point, which is the same guarantee `reusableChunkIds` relies on. Without it a
  4 MiB Interact PDF re-sends 4 MiB to a server that already holds every chunk.

**In a plan, a relocation is one operation, not a write and a delete.**
`PlanOperation` gains `{ kind: "move", from, to }`. Expressing it as the existing
two kinds would put the ordering guarantee at the mercy of the order of an array,
and would let a plan be committed that deleted a source whose destination write
had failed.

## The re-pointing check

A new method on the index, used by all three tools and by their tests:

    resolutionImpact(
        from: string,
        to: string,
        options?: { keepSource?: boolean }
    ): {
        breaks: { source: string; target: string }[];
        repoints: { source: string; target: string; was: string; becomes: string }[];
    }

It recomputes link resolution over the notes table with `from` substituted for
`to`, using the same four-pass precedence as `resolveLinks`, and compares the
result against what resolves now. `keepSource` models a copy rather than a move,
where both paths exist afterwards: without it the same method would tell
`copy_file` that the original had gone. This is the one parameter that separates
the two cases, and they are otherwise the same question. `breaks` is a link that resolved to something
and would resolve to nothing. `repoints` is a link that would resolve to a
different file than it does today.

Candidates are the links whose target could plausibly match either path, which
is far fewer than every link in the vault: those currently resolving to `from`,
plus those whose target matches the basename or path of either side. Everything
else cannot change by definition.

A repoint in a note the operation is not already editing is what `move_file`
refuses over, and what `plan_move` lists. The reason to treat it more harshly
than a break is that a break is loud: `vault_health` finds it, Obsidian shows it
unresolved. A repoint is silent and reads as correct.

## Transcriptions

`TranscriptStore.rename(from, to)`, carrying the history rows across rather than
only the current transcription, since the history exists so that a bad rewrite
cannot destroy a good reading.

It runs after the vault write. If it fails, the move has still succeeded and the
transcription is still stored under the old path, where `list_untranscribed`
already reports orphans and says how to reattach one. That is a safe failure
rather than a lost one, and it is the reason this step is last rather than first.

## Testing

Unit, on the index:

- `resolutionImpact` for an exact-path link, a basename link, a basename link
  with an alias and a subpath, and an embed.
- Shortest-path ties, and the real duplicate this vault has: moving
  `Interacts/Peter Litzow.pdf` deeper must report a repoint of any
  `[[Peter Litzow]]` link to the superseded copy.
- A move that changes nothing, which must report neither a break nor a repoint,
  since a false positive here blocks the common case.

Unit, on the transcript store: `rename` preserves the history rows, and a
missing source is not an error.

Integration, through a real MCP client with writes enabled:

- A folder-only move: the file reads back at the new path through the vault
  model, is gone from the old, and every link still resolves.
- A rename refused, naming the notes that would need editing.
- `plan_move` then `commit_plan`: links rewritten, each linking note reading back
  correctly through the vault model, aliases and embed markers intact.
- A refusal when the destination exists, with the destination unchanged.
- An attachment move carrying its transcription, still searchable afterwards.
- A failed delete leaving a duplicate rather than a hole. Worth constructing
  deliberately, because it is the state the execution order is chosen to
  guarantee and the only way to know the order was implemented as designed.
- `copy_file` refused when the copy would steal a link.

`npm run verify:write` gains the move path once it exists. It covers the write
surface against a real vault, and this is new write behaviour.

## Out of scope, deliberately

- **Moving a folder.** That is many files at once, which is the batch case
  wearing a different hat, and it should use a selector rather than a special
  tool.
- **Batch move and rename by selector.** The obvious next plan operations, and
  the single-file behaviour has to be right before it is multiplied by forty.
- **Rewriting links in a moved note's own body.** Nothing to do: its links are
  vault-absolute or basenames, and neither changes meaning because the note
  moved.

## What changed in the building

Written 30 July 2026, after the code. The design above stood, and five things
came out differently enough to be worth stating rather than leaving someone to
find by reading both.

**`move_file` refuses on one rule, not four.** The refusals are now "no link
that resolves to this file may stop resolving to it, and nothing may come to
mean a different file", which is `resolutionImpact` returning nothing. That
covers the rename-with-links case the design listed and also a folder move that
breaks a link written as a full path, which it did not.

**A rewritten link is checked before it is written.** The design called the
rewrite minimal and surgical, and minimal was not always correct: retargeting
`[[Peter Litzow.pdf]]` for a file moving under `Superseded/` produces the same
text, now resolving to the other copy. Each new target is resolved against the
vault as it will be, and falls back to the full path when the short form no
longer lands on the right file.

**The transcript store is not called directly.** `WriteExecutor` takes one
`onRelocated` callback instead, because a second thing turned out to need the
same moment: the changes feed indexes the destination before the transcription
follows it, so the destination has to be reindexed afterwards or a transcription
silently stops being searchable. One callback, told once, with both effects
wired up where the stores are.

**A planned move carries its content.** `PlanOperation` is
`{ kind: "move", from, to, content }`, the same shape as a planned write. The
alternative was for commit to re-read the file, which is a second read of
something the plan was already composed from.

**Resolution had to be written twice.** `resolutionImpact` asks what resolution
would look like in a vault that does not exist yet, which no table can answer,
so `src/index/resolve.ts` restates the four passes in code. The two copies are
checked against each other over a vault that exercises every pass. Writing the
second copy is what turned up the unescaped `_` in the first.
