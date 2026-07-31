# Moving many files at once

Written 31 July 2026, before the code, as `docs/move-rename-design.md` was. That
document deferred this one twice, in the same sentence both times: moving a
folder is the batch case wearing a different hat, and the single-file behaviour
had to be right before it was multiplied by forty. It is right now, and the
three days since have changed what "right" means here in a way worth stating up
front.

## What the single-file work established, which this inherits

Three things, and each of them constrains the design rather than merely
informing it.

**A relocation is a write and then a delete, in that order**, owned by
`WriteExecutor.relocate`. Interrupted, it leaves a duplicate rather than a hole.
Multiplied by forty inside one plan, that property has to survive: the worst
outcome of a commit that dies halfway must still be some files in both places,
never some files in neither.

**Resolution lives in one place**, `src/index/resolve.ts`, and a link may name a
file by its whole path or any tail of it beginning at a folder boundary, with or
without the extension. That last part is three days old and it matters here more
than it did for one file, for a reason in the next section.

**A plan is a message.** The connector pass on 31 July found `plan_move`
reporting "rewrites 7 link(s)" and nothing else, and the fix was to print what
each link becomes. A batch plan cannot print forty of those and stay readable,
so the grouping that fix introduced, distinct shapes with counts, is the thing
this scales rather than a detail of it.

## The measurement that decides the shape

`docs/move-rename-design.md` began by counting how the vault's links are
actually written, and found them all to be basenames, which is what put
`move_file` on the single-write path and `plan_move` on the plan path. The
equivalent question here is different, and it has a sharper answer.

**Asking about forty moves one at a time gives the wrong answer.**
`VaultIndex.resolutionImpact(from, to)` builds two views of the vault, one with
the file where it is and one with it where it is going, and reports the links
that differ. Both views assume everything else in the vault stays exactly where
it is. That assumption is free when one file moves and false when forty do.

The failure is concrete. Suppose `Interacts/Peter Litzow.pdf` and
`Interacts/Superseded/Peter Litzow.pdf` are both moving into `Archive/`, into
different subfolders. Asked about the first alone, the answer is that
`[[Peter Litzow]]` would come to mean the superseded copy, which is a repoint
worth warning about. Asked about the second alone, the mirror of the same
warning. Asked about both together, which is what is actually going to happen,
neither warning is true: the two files land in a new arrangement whose shortest
path may be either, or the link may break outright. Three different answers, and
the only one that matters is the one nobody asked for.

So the batch check cannot be a loop over the single-file check. It needs a
`resolutionImpact` that takes the whole set of relocations and builds the "after"
view once, with all of them applied. That is also cheaper: one pair of
`LinkResolver` builds for the batch rather than eighty, and one query whose
candidate targets are the union across every file moving.

## What a batch move is, which turns out to be two things

The word covers two operations that behave differently enough that conflating
them would produce a tool nobody can predict.

**Reparenting.** `Meetings/RLT/**` becomes `Archive/2026/RLT/**`, every file
keeping its name and its position beneath the folder. This is what "move a
folder" means, and it is the safe one: no two files can collide, because their
relative paths were already distinct, and a link written as a basename does not
change meaning at all. Only links that spelled out a folder are affected.

**Collecting.** Everything tagged `#superseded`, from wherever it is, into
`Archive/`. Files arrive from different folders and keep only their basenames,
so two files called `Notes.md` from two folders now want the same path. This is
the dangerous one, and the danger is not the collision, which is loud. It is the
near miss: two files that do not collide but now share a basename, so a link
that named either of them by basename resolves to whichever ends up shorter.

The proposal is that both go through one tool with two destination forms, rather
than two tools, because the selector is the same in each case and the checks are
the same. What differs is only how a destination path is computed per file.

## The tool surface

### `plan_relocate(selection, into, {flatten})`

Selection is the same object `plan_set_properties` and `plan_retag` already take:
`tag`, `property_key`, `property_value`, `folder`, `query`, all ANDed. Two
departures from those two tools, both forced:

- **Attachments are included.** `plan_set_properties` drops them, because an
  attachment has no frontmatter to set. Filing a PDF is the single most likely
  thing anybody wants this for, so `resolve()` needs a flag rather than a
  hardcoded `kind !== "text"` skip.
- **`folder` does double duty.** For a reparent it is both the selector and the
  prefix being replaced. Rather than infer that, `into` is a folder and
  `flatten` decides which operation this is: false, the default, keeps each
  file's path relative to the selected folder; true drops every file's folders
  and keeps its name.

`flatten: true` with no `folder` selector is the collecting case and is where
collisions live. `flatten: false` with no `folder` selector has no relative path
to preserve and is refused rather than guessed at.

### What it refuses outright, writing nothing

- **Two files wanting the same destination.** Named in pairs, both paths shown.
  Not resolvable by the tool: renaming one of them is a decision.
- **A destination that already exists**, unless it is a tombstone, matching
  `move_file`.
- **A selection that resolves to nothing**, which is a typo in a selector and
  reads identically to a successful no-op.
- **An empty selection**, as `plan_set_properties` already does.

### What it reports and proceeds with

Breaks and repoints, computed across the whole set at once, in the two blocks
`plan_move` already prints: what the link text becomes, grouped by distinct
shape with counts, and the "read this part carefully" block for links that would
come to mean a different file with nothing in any note changed.

The second block is the one that grows teeth at this scale. A single move that
silently repoints one link is a curiosity. A collect of thirty files into one
folder that silently repoints nine is a vault that no longer says what it said,
and the person who ran it will not read thirty lines to find out. Which suggests
a ceiling: past some number of repoints, refuse rather than report, on the
grounds that a warning nobody can act on is not a warning. Where that number
sits is the open question below.

## Execution

One plan, one commit, `{ kind: "move", from, to }` per file plus one write per
note whose links change. `PlanningWriteExecutor` already applies these in order
and already refuses in full if any note changed since the plan was made, so
nothing new is needed for atomicity, and nothing new is available either: a
commit that dies halfway leaves the files it had already relocated relocated.
That is the same guarantee as today, scaled, and it is the right one, but it
should be said in the plan's own footer rather than left to be discovered.

`planCeiling` already bounds how many changes a plan may contain. A reparent of a
large folder plus its link rewrites can exceed it, and the resulting refusal
should name the ceiling and suggest a narrower selector rather than reporting an
internal limit.

## Out of scope, deliberately

- **Renaming by pattern.** `2026-07-06 X.pdf` becomes `X - 2026-07-06.pdf` is a
  real want and a different feature. A regular expression over filenames, given
  to a model, composed into a plan touching forty files, is the highest-variance
  thing this server could offer. If it happens it should be its own tool with
  its own document.
- **Moving a folder by naming the folder.** There is no folder object here: a
  path is a document ID and a folder is a prefix that happens to be shared. A
  tool that took a folder would have to invent one.
- **Undo.** Restoring forty files to forty former paths is a plan, and composing
  it needs a record of what the previous plan did, which nothing keeps. Worth
  wanting; not worth pretending is close.

## Open questions, which are for Chris rather than for the code

1. **The repoint ceiling.** Report and proceed at any number, or refuse past
   some count? My inclination is to refuse past about five, because the block is
   already the part of a plan most likely to be skimmed and its whole value is
   that it is short.
2. **Whether `flatten` is the right axis at all**, or whether the two operations
   should simply be two tools with plainer names. One tool with a boolean is
   fewer things to learn; two tools mean a model cannot pick the dangerous one
   by leaving a flag at its default.
3. **Whether a reparent should be allowed to skip the plan path** when nothing
   links to anything in the folder, the way `move_file` does for one file. It
   would make filing a folder of untouched attachments a single call. It also
   makes the number of notes a single call can touch unbounded, which is the
   line the plan protocol was drawn on.
