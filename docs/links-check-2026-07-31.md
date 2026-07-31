# Link resolution, checked through the connector

31 July 2026, against `obsidian-writetest`, on the build that rewrote link
resolution. Run the way a client meets the server: tool descriptions and
responses only, no source read. The vault was left as it was found, at 31 files
with no unresolved links.

The release does what it claims. Seventeen link forms were written into one note
and every one of them resolved the way Obsidian would resolve it, including the
three that should resolve to nothing. The failure recorded on 30 July is gone:
`move_file` on `Interacts/Peter Litzow.pdf` now reports that `[[Peter Litzow]]`
would stop resolving, where before it reported nothing and then broke the link.

What follows is the other half. Every finding below is about what the tools
**say**, not what they do, because nothing they did was wrong.

## What resolves, checked one line at a time

One note, seventeen links, read back through `note_links`.

| Written as                                                         | Resolved to                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `[[Peter Litzow]]`                                                 | `Interacts/Peter Litzow.pdf`                                                |
| `[[Peter Litzow.pdf]]`                                             | `Interacts/Peter Litzow.pdf`                                                |
| `[[Interacts/Peter Litzow.pdf]]`                                   | `Interacts/Peter Litzow.pdf`                                                |
| `[[Peter Litzow - 2026-07-06]]`                                    | `Interacts/Superseded/Peter Litzow - 2026-07-06.pdf`                        |
| `[[anthony chaytors]]`                                             | `Interacts/Anthony Chaytors.pdf`                                            |
| `[[ANTHONY CHAYTORS.PDF]]`                                         | `Interacts/Anthony Chaytors.pdf`                                            |
| `[[Attachments/RLT Presentation - Adelaide Office.pptx]]`          | `Meetings/RLT/Strategy/Attachments/RLT Presentation - Adelaide Office.pptx` |
| `[[Strategy/Attachments/Adelaide Office Strategy Discussion.pdf]]` | `Meetings/RLT/Strategy/Attachments/Adelaide Office Strategy Discussion.pdf` |
| `[[Attachments/Adelaide Office Strategy Discussion]]`              | `Meetings/RLT/Strategy/Attachments/Adelaide Office Strategy Discussion.pdf` |
| `[[ttachments/Adelaide Office Strategy Discussion.pdf]]`           | nothing                                                                     |
| `[[Network Planning]]`                                             | `Personal/Home/Network Planning.md`                                         |
| `[[Network Planning.txt]]`                                         | `Network Planning.txt`                                                      |
| `[[Pasted image 20260730185843.png]]`                              | `2026/07/Attachments/Pasted image 20260730185843.png`                       |
| `![[2026-07-02 Harmony Meeting#Actions]]`                          | `Meetings/Clients/Harmony/Attachments/2026-07-02 Harmony Meeting.pdf`       |
| `[[Grahame Binks\|Grahame]]`                                       | `Interacts/Grahame Binks.pdf`                                               |
| `[[Peter_Litzow]]`                                                 | nothing                                                                     |
| `[[Nothing At All Whatsoever]]`                                    | nothing                                                                     |

Four of those are the point of the release and would have failed a week ago: the
bare surname, the uppercase extension, the partial path with the extension left
off, and the extensionless embed with a subpath into a PDF. Three of the rest
are the ones that matter more, because they are the ones that must **not**
resolve: a tail starting mid-folder-name, an underscore treated as a character
rather than a wildcard, and a name nothing carries.

`vault_health` agreed exactly, reporting those three and nothing else. Before
the release it would have called eight of these seventeen broken.

## Findings

### 1. A move plan does not show what the links will say

`plan_move` on a rename that touches seven links reports this and nothing more:

```
link-check/Rename Targets.md: rewrites 7 link(s) to point at Interacts/Patricia Leenen - 2026-07-06.pdf
```

The plan protocol exists so a person can read what is about to happen before it
happens, and this is the one thing a reader of a rename plan needs and cannot
get: what each link will actually become. It matters because the answer is not
predictable. The rewrite is documented as the smallest edit that works, and it
falls back to a full path when the short form would land on the wrong file, so
the shape of a link in somebody's note can change and the plan will not say so.

The awkward part is that `move_file`'s refusal, which is the message that sends
people to `plan_move`, lists every affected link individually with its embed
marker and subpath intact. The tool being recommended shows less than the
recommendation. This is the same shape as the 31 July finding, where the link
count was corrected and the list printed under it was not: a plan is a message,
and this one is only measured, not shown.

Suggested: list each rewrite as `old -> new`, the way the copy refusal already
lists `would mean X instead of Y`.

### 2. A rewrite adds an extension that the writer left off

Committing that rename produced, among the seven:

```
- Basename, no extension: [[Patricia Leenen]]
+ Basename, no extension: [[Patricia Leenen - 2026-07-06.pdf]]
```

`[[Patricia Leenen - 2026-07-06]]` resolves perfectly well, and nothing else in
the vault carries that stem, so the extension was not needed. Same for case:
`[[patricia leenen]]` came back capitalised. Neither is wrong, and both are
larger than the smallest edit that works, which is what the tool says it makes.

This one is created by the release rather than revealed by it. Extensionless
links to attachments were invisible before, so the rewriter never had to carry
their style across; now that they resolve, they get rewritten, and the style is
dropped. Anybody who writes `[[Peter Litzow]]` by habit will find their notes
gradually acquiring `.pdf` every time a file is renamed.

Suggested: keep the extension off when the extensionless form still resolves to
the destination, and keep the writer's case when it still resolves.

### 3. `note_links` never prints the link text

Outgoing links from a note with seventeen of them come back as seventeen
resolved paths, sorted by the link text, which is not shown. So
`Interacts/Peter Litzow.pdf` appears three times in a row, in an order the
reader has no way to account for, and there is nothing to say which line of
their note each one came from. Only the unresolved ones show their text, because
for those the text is all there is.

Backlinks are the sharper case:

```
Links to Interacts/Peter Litzow.pdf (3):
  link-check/Resolution.md
  link-check/Resolution.md
  link-check/Resolution.md
```

The reason to ask for backlinks before renaming something is to find out what
text would have to change. That is exactly what the answer leaves out, and the
release makes it more common, because more ways of writing a link now land on
the same file.

Suggested: print the link text alongside the resolved path in both directions,
with the embed marker and subpath the refusals already show.

### 4. "rewriting the 0 note(s) that link to it"

`plan_move` opens with that sentence whenever nothing links to the file. It
should say that nothing links to it, or say nothing at all.

### 5. `vault_status` does not mention the plan tools

```
Writes: enabled (create_note, append_note, append_daily, edit_note,
set_properties, delete_note, restore_note, move_file, copy_file, commit_plan)
```

`plan_move`, `plan_retag`, `plan_set_properties` and `discard_plan` are missing.
Literally that is right, since those four write nothing, and the line is
described as naming the tools that can change the vault. But `commit_plan`
appears with no tool listed that could produce a plan for it to commit, and
`move_file`'s own refusal sends people to a tool this line implies is not there.
A reader working out what this server can do gets a wrong answer from the tool
whose job is to tell them.

Suggested: name them in a second clause, as the tools that prepare a change
rather than make one.

### 6. A stray blank line

`note_links` output begins with an empty line when asked for backlinks only.

## Re-checks, all passing

- **`delete_note` says restoring is usually possible.** It now explains the
  tombstone, says `restore_note` reads the text back out of it, and says plainly
  that the sync plugin's cleanup eventually makes that impossible. A delete and
  a restore were run end to end and the note came back byte for byte.
- **`append_note` does not split a list.** `- Eggs` joined a two-item list with a
  single newline; a paragraph appended under a different heading still got a
  blank line.
- **A `move_file` refusal prints links as they were written.** A note holding the
  same target as a plain link, an embed, a subpath link, an aliased link and an
  exact duplicate reported three entries, correctly collapsing the duplicate and
  the alias while keeping `![[...]]` and `[[...#Summary]]` distinct. The caveat
  sentence about the count is accurate: `plan_move` then rewrote five.
- **`append_daily` files under configuration.** Wrote to `Daily/2026-07-31.md`
  and said `DAILY_NOTE_PATH is set to "Daily/YYYY-MM-DD.md"`.

Two more worth recording as working, since both are new and both are the quiet
kind of failure:

- **`copy_file` refuses a copy that would steal inbound links.** Copying
  `Personal/Home/Network Planning.md` to a shallower path was refused, naming
  both links and both files, including one in an existing note that was not part
  of the test.
- **`plan_move` warns about a repoint it will not fix.** Moving a file onto a
  shorter path that another file's links resolve through produced a "read this
  part carefully" block, and said why rewriting them is not that tool's business.

## Left behind

Nothing live. Five test notes were created under `link-check/` and all five were
deleted, along with a copy under `link-check/archive/copies/`; their tombstones
remain, as they must. `Daily/2026-07-31.md` gained a `## Log` heading and one
line from the `append_daily` check. `Interacts/Patricia Leenen.pdf` was renamed
and renamed back, so it is at its original path with a new revision.

## What was built instead, on one of these

Findings 1, 2, 3, 4 and 5 were fixed the same day. Finding 2 suggested keeping
the writer's capitalisation when it still resolves, and what went in is broader
and simpler: a rewrite now tries the text the link already has before anything
else, so a move that changes only the folder rewrites nothing at all, and the
capitalisation survives because the link does. Only a rename, which no spelling
of the old name survives, replaces somebody's text with the vault's.
