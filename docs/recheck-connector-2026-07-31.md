# The connector re-check, 31 July 2026

Run against `obsidian-writetest` through the deployed server and Claude's custom
connector, on the morning of 31 July 2026 Brisbane time. It checks the three
wording fixes that `docs/status.md` records as done against
`docs/acceptance-connector-2026-07-30.md`, using the same surface that found
them: the tools as a model meets them, over OAuth.

Two of the three hold. The third fixed the number and left the thing the number
was about.

Nothing was written that is still there, with one deliberate exception recorded
at the end. The vault opened and closed at 31 files.

## The baseline

`vault_status` still says all three things it needs to:

    Writes: enabled (create_note, append_note, append_daily, edit_note,
    set_properties, delete_note, restore_note, move_file, copy_file, commit_plan)
    Index feed: attached
    Conventions: "CLAUDE.md", passed to this client when it connected

Ten tools, the feed attached, and the conventions answer in its third state.

## 1. `append_note` no longer splits a list. Fixed

`mcp-test/list.md` was created with a heading and one item, then given a second
item under that heading, then a sentence that is not a list item. Read back
fresh:

    ## Log

    - Created.
    - Appended under a heading.

    This sentence is not a list item.

One list rather than two, and the blank line still arrives for the prose. The
separator is deciding per call rather than by default, which is the fix as
described.

The tool description carries it as well: "Defaults to a blank line, or to a
single newline when a list item is being added to a list, so the list is not
split in two." That matters as much as the behaviour, because the previous state
was a tool that advertised the list case and needed an argument to deliver it. A
caller reading the description now gets the right expectation without having to
test for it.

## 2. `delete_note` names the undo. Fixed

Every delete now ends:

    Marked deleted rather than erased, which is how the sync plugin does it:
    every device removes its copy on the next sync and the document stays behind
    as the record of that. That record is also what makes this reversible:
    restore_note reads the text back out of it. Not forever, though. The sync
    plugin eventually collects the pieces no live note refers to, and after that
    the note is gone for good.

The sentence that told a model not to try is gone, the tool is named, and the
real limit is stated instead of a false one. It also explains why restoring
works, which is the same record the deletion just described, so the two halves
of the message now agree with each other.

`restore_note` on that note returned:

    Restored "mcp-test/list.md".
    Revision 5-a5f2b83..., 81 bytes, 0 chunk(s) written and 0 reused.
    The content came from the deletion record itself, which is why this was
    possible; it is byte-for-byte what was there when the note was deleted, and
    not a version from any backup.

81 bytes against 81 removed, nothing uploaded, and the text identical on a fresh
read.

## 3. `move_file`'s refusal counts right and prints wrong. Half fixed

`mcp-test/hub.md` referenced `mcp-test/target.md` twice, once as `[[target]]`
and once as `![[target#Detail]]`. `note_links` saw both and told them apart:

    Links to mcp-test/target.md (2):
      mcp-test/hub.md
      mcp-test/hub.md  [embed]

The refusal on a rename:

    Nothing was written. Moving "mcp-test/target.md" to "mcp-test/renamed.md"
    would change what links mean.

    2 link(s) would stop resolving:
      mcp-test/hub.md: [[target]]
      mcp-test/hub.md: [[target]]

    Use plan_move, which rewrites the affected links and shows you the whole plan
    before anything is written. It may report more than the count above: a note
    that uses the same link text twice is one entry here and two rewrites there.

`plan_move` on the identical operation reported `rewrites 2 link(s)`, so the
counts agree and the `DISTINCT source_path, target` collapse is gone. The plan
was discarded; nothing was written by either call. The added caveat about a
repeated link text is a good sentence and is the kind of thing that stops the
next disagreement between these two numbers from reading as a bug.

What is not fixed is that both rows print as `[[target]]`. The report is
rendering a link reconstructed from the target rather than the link as it is
written in the note, so the embed arrives stripped of its `!` and its subpath.
Three things follow from that, in increasing order of how much they matter:

- Two identical lines read as a double-counting bug. The message spends its new
  caveat explaining that a repeat is real, which would not be necessary if the
  two entries did not look the same.
- The distinction the report exists to convey is the one it drops. Whether a
  rename is about to change an embed, and one carrying a subpath at that, is the
  difference between a link a person will fix by hand and one they will not
  notice at all.
- It is the same class of defect as the count was, one layer further in. The
  original finding asked whether `resolutionImpact` dedupes or does not walk
  embeds. The answer was the first, and the fix addressed the first, but the
  report path still discards the as-written form even though the index has it:
  `plan_move` rewrites `![[...#...]]` intact and `note_links` marks the embed.
  So this is not a second blindness in the check, which is the good news. It is
  the report throwing away something it was handed.

Worth saying plainly, since it is the whole reason the last pass cared: the
break and repoint check itself looks sound. Resolution reads the target and
nothing else, both tools agree on what would break, and the plan rewrote both
forms correctly on 30 July. The remaining defect is confined to what the refusal
prints.

## 4. `append_daily` files from the environment. Done

    Appended to "Daily/2026-07-31.md".
    Revision 2-dffb032..., 38 bytes, 1 chunk(s) written and 0 reused.
    DAILY_NOTE_PATH is set to "Daily/YYYY-MM-DD.md".

The template is attributed to the variable rather than to inference, which is
the distinction that matters when the inference is the thing that failed here
last time. The capture path is now exercisable on the scratch database, so it is
no longer the one tool on the write surface whose first real outing would be
against `obsidiandb`.

The date is correct and will look wrong to anyone reading it from a container
clock: 22:55 UTC on the 30th is 08:55 on the 31st in Brisbane. This is the
second confirmation of the entry already in "Things that cost time once
already", now from the other side of the day: the previous one filed a day
ahead at 15:59 UTC, this one is a normal Brisbane morning that the container
still calls yesterday.

## Cleanup, and the one thing left behind

`mcp-test/list.md`, `mcp-test/hub.md` and `mcp-test/target.md` were deleted, each
with the corrected message. `list_notes` on the folder returns "No notes found
under "mcp-test"", and `vault_status` reports 31 files, the count it opened with.

One line was left in place: `Daily/2026-07-31.md` carries "Connector re-check of
the three fixes." That note already existed, so nothing new was created and the
file count did not move, but the line is a test artefact sitting in a daily note
and should come out when convenient.

## Ready to paste into `docs/status.md`

### Correcting the note on acceptance gate item 3

The line currently reads "See `docs/acceptance-connector-2026-07-30.md`; all
three are fixed." Two are. Suggested replacement:

> See `docs/acceptance-connector-2026-07-30.md`. Re-checked through the
> connector on 31 July 2026: the `delete_note` wording and the `append_note`
> separator are fixed, and `move_file`'s refusal counts correctly but still
> prints every link in its reconstructed form, so an embed loses its marker and
> its subpath. See `docs/recheck-connector-2026-07-31.md`.

### Under "What to do next", parity group

- [ ] **`move_file`'s refusal prints links reconstructed rather than as
      written.** The count is fixed; an embed still appears as `[[target]]`, so
      two real links render as two identical rows and the subpath and `!` are
      lost. The index holds the raw form, since `plan_move` rewrites it intact
      and `note_links` marks the embed, so this is `resolutionImpact`'s report
      dropping what it was given rather than the check missing anything.

### Amending the entry under "Things that cost time once already"

The entry on the disagreeing count is right about what it describes and stops
one step early. Suggested addition to its end:

> Fixing the count did not fix the report. The rows are still rendered from the
> target, so the two links that disagreed now agree on the number and print
> identically, and the embed marker and subpath that made them different are
> gone. The general form is worth having: a count and the list under it are two
> claims, and correcting the one that was measured leaves the one that was only
> ever displayed.

### Under "Smaller things, whenever"

Two items can be closed:

- `DAILY_NOTE_PATH` on the writetest environment is set, to
  `Daily/YYYY-MM-DD.md`, and `append_daily` says so on every call.
- The `append_note` separator item, covered above.

Still open, unchanged and unexamined this run: the path with literal quote
characters, `"mcp-write-check/from-a-client.md"`.
