# Carried items (open, as of 2026-10-08)

Items found during sub-projects A2a, H and U that were deliberately **not** fixed in
the sub-project that found them. Each says where it came from, why it was left, and
which sub-project should pick it up.

This file exists because `.superpowers/sdd/` is gitignored: without it these items
live only in a scratch ledger that `git clean -fdx` destroys. Same reason as
`2026-10-08-a2b-writer-contract.md`.

## User-visible, no sub-project owns them yet

- **`control-voice-remove` deletes a measured voice profile with no confirm and no
  undo** (`VoiceProfileManager.tsx`). Every other destructive action in the app
  confirms first. Pre-existing before U; verified verbatim at `89e2866`.
- **The Cite panel digests *every* `externalApiSources` entry, including DOI
  duplicates that were never added** (`CitePanel.tsx:90`) — one AI call per
  duplicate, so the cost is the user's. Pre-existing before U; verified verbatim at
  `89e2866:Sidebar.tsx:411-413`.
- **A refused snapshot restore reports through `window.alert`**
  (`SNAPSHOT_GONE_MESSAGE`). Correct but crude; no toast path reaches
  `VersionHistoryPopup` or `write/Versions.tsx`. Acceptable because the user has just
  passed a `window.confirm`, so the idiom matches.
- **The style-row rewrite button has no busy state.** The deleted `StylePanel` block
  showed "Rewriting…"; the rows do not. `inFlight` (`styleRewrite.ts:44`) still blocks
  a double click, so the only cost is missing feedback during the call. Suggestion
  rewrites already behaved this way.
- **`VoiceProfileManager` remounts when `StylePanel` flips between its empty and
  populated trees**, discarding an in-progress paste. Narrow: `styleAudit` is only
  ever set, never cleared, so it happens when the first audit lands on a blank draft
  while samples are being pasted, or when the whole draft is deleted. The common case
  (collapsing the section) is fixed.

## For A3 (real pagination)

- **`pruneFragments` runs inside the save transaction.** Fine today; revisit when
  pagination makes saves heavier.
- **Two page estimators can be on screen at once and will visibly disagree**: the
  status bar is character-density (`estimatePages`), the grant section chips are
  `words/500` (`wordsToPages`). Both labelled, accepted by U Task 1's ruling. A3
  should decide whether the section budgets move onto the real estimator.

## Test-infrastructure debt

- **`reachability.test.tsx` is 1,248 lines and was never split.** Deferred by U Task 3
  ("data to a plain `reachability.data.ts`, split in Task 9") and again by Task 9.
  Deferred twice; record it so it is not lost a third time.
- **The reachability guards cannot see** a `<select>`, a checkbox, a `<div onClick>`, a
  button whose `title` is a bare variable, or a non-`control-` templated test id. The
  caveat is in `CLAUDE.md`; the gap is real and only closes with a different guard
  technique (an AST pass rather than source regexes).
- **`App.replaceFlows.test.ts` handler slices leak across file boundaries.** It
  concatenates seven sources and scans to the next `\n  const ` *anywhere*, so six
  handlers' slices run into the following file. Latent only — the test is still
  non-vacuous — but it should extract per file.
- **`marginWarning`'s every-offending-side list is untested.** Truncating `low` to one
  entry passes all 32 `FormatPanel` tests; the `, x and y` join is unexercised.

## Known-inert, deliberately not implemented

- **The "About Agents" control (`control-agent-info`) does nothing** — `showAgentInfo`'s
  value was never rendered. Pre-existing. Its reachability row is annotated as inert so
  the row is not read as proof the feature works.
- **The chat placeholder always says "attached source"** because its `__manuscript__`
  branch is never true. Pre-existing.

## Performance, unmeasured

- Every keystroke runs `stripHtml(content)` twice in `App.tsx` (`:322`, `:404`) plus
  `useOutline` over the full HTML. `useOutline` is identity-stable so re-renders are
  avoided, but the regex passes are not. All four panels are now permanently mounted.

## Found while measuring the review on real grants (2026-10-11)

- **Symbol-font runs import as private-use characters.** The author's R01 draft stores the micro sign as a literal
  U+F06D (a Symbol-font 'm') in `word/document.xml`, with the run's font set to Symbol, not as `<w:sym>`. The DOCX
  reader has no mapping for the private-use area, so the character survives into the document text, where it renders
  as a missing glyph and silently breaks anything that reads units: "5<U+F06D>g" is not a dose to a detector, and a
  model quoting it produces a quote that cannot be found again. Ten occurrences in that one file (also U+F067 for
  gamma). Fix belongs in `src/docx/read/`: map the Symbol and Wingdings private-use ranges to Unicode when the run's
  font says so. The review spike worked around it with its own `deSymbol` map; R2's detectors need the real fix or the
  same workaround.
- **Real grant headings need a wider keyword table than `sections.ts` has.** "2.1 Current state of research",
  "A5. Scientific Rigor and Consideration of Relevant Biological Variables", "C2.2b. Frequency of administration",
  "Reason for the choice of research institution", "Project 1." all classify as `any` today, so no check applies to
  them. Recorded in the Review v2 spec §3.1; the spike used a widened table.
