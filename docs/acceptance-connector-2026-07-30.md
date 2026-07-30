# The connector acceptance pass, 30 July 2026

Run against `obsidian-writetest` through the deployed server and Claude's custom
connector, on the evening of 30 July 2026 Brisbane time. Written as its own file
because most of it belongs in `docs/status.md` and some of it does not, and
sorting that out is easier once the whole run is written down.

## What this was, and what it was not

`npm run verify:write` drives the executor. This drove the *tools*, over OAuth,
through an MCP client that had to decide which one to call from the descriptions
alone. That is a different question and it fails differently: the script proves a
document reaches CouchDB intact, and this proves the surface a model actually
meets is usable and says true things about itself.

Three of the four defects below are wording rather than behaviour, which is what
you would expect from a pass that only looks at the surface, and is not a reason
to discount them. Every one of them would change what a model does next.

Nothing was written that is still there. The vault opened and closed at 30 files
with an identical tag inventory, and `mcp-write-check/` was left alone.

## What passed

The baseline was exact. `vault_status` named ten tools that can change the vault
(`create_note`, `append_note`, `append_daily`, `edit_note`, `set_properties`,
`delete_note`, `restore_note`, `move_file`, `copy_file`, `commit_plan`), said
"Index feed: attached", and reported the conventions as `"CLAUDE.md", passed to
this client when it connected`, which is the three-state answer doing its job.
`vault_health` carried its conflicts section.

The single-note path was unremarkable in the way it should be, and the chunk
accounting was visible on every receipt: create wrote 2 and reused 0, the append
wrote 1 and reused 1, the edit the same.

The move reported what it was for:

> Moved "mcp-test/scratch.md" to "mcp-test/filed/scratch.md".
> Revision 1-dc0f0efb, 271 bytes, 0 chunk(s) written and 2 reused.
> No link in the vault would break or come to mean a different file, which was
> checked before anything was written.

Zero chunks on a move is the property that matters on a 4 MiB Interact, stated
on the one operation where it is not obvious that nothing was uploaded.

`plan_move` rewrote both links with the embed marker and the subpath intact
(`[[minutes]]` and `![[minutes#Detail]]`), kept the short form because it still
lands on the right file, and the commit counted the relocation properly: "2
note(s) written, 1 removed". `plan_retag` announced the merge before doing it,
changed the frontmatter half and the body half in one plan, and left the
frontmatter as the list it found. `restore_note` returned 288 bytes against 288
deleted, text identical, backlinks re-resolved, and said where the content came
from rather than leaving it to be assumed.

## Four things to fix

### 1. `delete_note` still says restoring is impossible

Every delete ends:

> Marked deleted rather than erased, which is how the sync plugin does it: every
> device removes its copy on the next sync and the document stays behind as the
> record of that. **Restoring the text is not something this server can do.**

`restore_note` then did it, byte for byte, thirty seconds later.

This is the third time in three days, and the wording of the entry in "Things
that cost time once already" is already written for it: a value that was written
once and describes something that changes. The read-only instructions string was
this. The startup warning that listed six of seven tools was this. What makes
this one worse than either is that the sentence is not merely stale, it is
actively steering: a model that reads it will not offer the undo, so the tool
built specifically so that a delete is not final is invisible at exactly the
moment it is needed.

The fix is the same as the other two. Compose the sentence from whether
`restore_note` is registered, and put a test on it. There is a shape here worth
naming, since three instances is a pattern rather than a coincidence: **every
sentence this server says about its own capabilities needs to be computed from
the capability, and the ones that hurt most are the ones that tell a model not to
try.**

### 2. `move_file`'s refusal undercounts the links

`hub.md` referenced the note twice, once plainly and once as an embed. The
refusal said:

> Nothing was written. Moving "mcp-test/filed/scratch.md" to
> "mcp-test/filed/minutes.md" would change what links mean.
>
> 1 link(s) would stop resolving:
>   mcp-test/hub.md: [[scratch]]
>
> Use plan_move, which rewrites the affected links and shows you the whole plan
> before anything is written.

`plan_move`, on the identical operation, reported and then rewrote **2**:

>   mcp-test/hub.md: rewrites 2 link(s) to point at mcp-test/filed/minutes.md

`note_links` had already listed both, and distinguished them, so the index knows.
Either `resolutionImpact` dedupes per (note, target) or it does not walk embeds,
and the two possibilities are worth telling apart before fixing either: if it is
the second, the same blindness is in the break and repoint check that the whole
move design rests on, and a folder move could repoint an embed silently. The
count is the symptom; what it is a symptom of is the question.

Same species as the commit that returned two receipts for one change, and it
lands on the message that decides whether anyone reaches for the plan path at
all.

### 3. `append_daily` cannot infer a template on `obsidian-writetest`

It refused, correctly and legibly:

> Cannot work out where this vault's daily notes live. No folder in the vault
> holds two or more notes with date-shaped filenames. Obsidian keeps that setting
> in a hidden file this vault does not sync, so it is inferred from the dated
> filenames already in the vault. Set DAILY_NOTE_PATH to a template such as
> "daily/YYYY-MM-DD.md", or use append_note with an explicit path.

The scratch database holds exactly one dated filename, `2026/07/30.md`, and the
rule needs two. Adding a second unblocked it and the inference was right, and
said what it was right about:

> Inferred the template "YYYY/MM/DD.md" from 2 existing note(s), for example
> 2026/07/30.md and 2026/07/29.md.

The refusal is good behaviour and the situation is still a gap: the capture path
is the one thing on the write surface that cannot be exercised on the scratch
database as it stands, so it is the one thing that will first be exercised
against `obsidiandb`. Set `DAILY_NOTE_PATH` in the writetest environment, or
accept that this tool is only ever tested by its unit tests and by the real
vault.

Worth noticing that the two-filename rule was tuned for a vault being migrated
into, and `obsidian-writetest` is a copy of a vault that has barely been written
to. The rule is not wrong. It just does not clear the floor on the database it
will be developed against, which is a thing to know rather than a thing to
change.

### 4. A stray quoted path in the vault

`list_notes` returns

    "mcp-write-check/from-a-client.md"

with literal quote characters in the path, sorting above every other entry.
Almost certainly `verify:write` passing an over-quoted argument through to a
document ID on some earlier run, and harmless where it sits. It is worth
following up only because a document ID here is a vault path, and a path that
contains characters nobody intended is the kind of thing that is fine until
something tries to address it.

Left in place, since that folder belongs to the gate.

## One smaller thing

Appending a list item under a heading inserts a blank line before it, because the
separator defaults to a blank line and does so regardless of what it is
separating:

    ## Log

    - Created.

    - Appended under a heading.

Two Markdown lists rather than one, which renders with a gap. The default is
documented and is right for prose. It is wrong for the case the tool description
itself names first, "a line to a running list", and a caller has to know to pass
`separator: "\n"` to get what it advertised. Either the default should look at
whether the line it is following is a list item, or the description should stop
promising the case that needs an argument.

## The timezone, working as designed

The capture filed under `2026/07/31.md` while the container's clock read
15:59 UTC on the 30th, because `VAULT_TIMEZONE` is Brisbane and it was 01:59 on
the 31st there.

That is correct, and it is `docs/status.md`'s own reasoning running in the
direction the note does not describe. The doc warns that the container's date is
yesterday's for ten hours of every day. The other half is that from the vault's
side it is tomorrow's for those same ten hours, so anything run after 14:00 UTC
files under a date that has not arrived yet on the machine watching it. Nothing
is wrong, and it will look wrong the first time, which is the argument for
writing it down rather than for changing anything.

## Ready to paste into `docs/status.md`

### Under the acceptance gate, as a note on item 3

> Exercised separately through the connector on the evening of 30 July 2026,
> against the same database. Not the gate, which is `verify:write` and stays the
> thing that proves documents reach CouchDB intact, but the other half of the
> question: the tools as a model meets them, over OAuth, chosen from their own
> descriptions. It covered what the script deliberately does not, which is the
> wording. Every operation behaved, and three messages turned out to describe the
> server as it was rather than as it is. See
> `docs/acceptance-connector-2026-07-30.md`.

### Under "What to do next", parity group

- [ ] **`delete_note` says restoring is impossible, and it is not.** The sentence
      predates `restore_note` and steers a model away from the undo. Compose it
      from the registration and test it, like the instructions string and the
      startup warning before it.
- [ ] **`move_file`'s refusal counts fewer links than `plan_move` rewrites.** One
      versus two, on a note linked plainly and as an embed. Find out whether
      `resolutionImpact` dedupes or skips embeds before fixing the count, because
      the second answer reaches the break and repoint check itself.

### Under "Smaller things, whenever"

- [ ] Set `DAILY_NOTE_PATH` on the writetest environment. The database holds one
      dated filename and inference needs two, so `append_daily` is the only tool
      on the write surface that cannot be exercised there.
- [ ] `append_note` separates with a blank line even into a list, splitting it in
      two. Either look at the preceding line or stop advertising the list case.
- [ ] A path with literal quote characters, `"mcp-write-check/from-a-client.md"`,
      is sitting in the vault. Probably `verify:write` over-quoting an argument.

### Under "Things that cost time once already"

- **The vault's day is not the container's day, in both directions.** The note on
  `VAULT_TIMEZONE` covers the container being ten hours behind. The consequence
  going the other way is that after 14:00 UTC a capture files under tomorrow's
  daily note, correctly, while every clock the operator is looking at still says
  today. Confirmed on 30 July 2026: `append_daily` at 15:59 UTC created
  `2026/07/31.md`.
