# U — Layout Restructure: Design

**Date:** 2026-10-08
**Sub-project:** U (own branch/worktree, `feat/u-layout`)
**Status:** Section 1 approved in conversation; sections 2–6 decided by the controller with reasoning recorded, for the user to correct.

## Problem

The app has accumulated features faster than it has arranged them. Measured on `main` at `89e2866`:

- **Six sidebar tabs** (chat, suggestions, history, sources, outline, style) in one 2,358-line `Sidebar.tsx`. The sources tab alone is 937 lines.
- **53 controls** in `Editor.tsx`'s toolbar, all present at all times, including four that are only meaningful when a figure is selected.
- `App.tsx` is 1,817 lines and owns both the application state and the entire shell.
- Two version-history components exist (`VersionHistoryPanel.tsx`, `VersionHistoryPopup.tsx`); only one is imported.
- A2a added an import report dialog and a File-menu restore path; H added a Style tab. Both landed in the surface that was already full.

The user reports the clutter bites during all four of: writing prose, hunting for a feature, checking the document looks right for NIH, and reconciling AI output against the text.

## Goal

The page is the thing you look at. Controls group by the task you are doing, not by the component that owns them. AI output arrives in one place, anchored to the text. NIH page geometry — margins, fonts, text width — is visible and correct.

Success criteria:

- At rest the top bar shows roughly 8 controls, not 53.
- Four task panels replace six tabs; one panel open at a time; the rail collapses to nothing.
- The writing surface renders the document's real `PageSetup` (size, margins) and `DocFormat.defaults` (font family, size).
- Every feature reachable before the restructure is still reachable after it, proven by a test, not by inspection.
- No file left over ~400 lines among the ones this sub-project touches.

## Non-goals

- **Real pagination.** The page figure stays an estimate, labelled as one. Sub-project A3 replaces the estimator behind a single seam (§2).
- A typography or colour redesign beyond what the page surface requires. Existing CSS tokens (`--font-editor`, `--font-ui`, `--border`, the severity and accent scales) are reused.
- Any change to `src/docx/**`, to the editor schema, or to the DOCX reader's behaviour. The golden hash test (`src/docx/preserve/hash.test.ts`) must keep passing: one new node or mark attribute silently invalidates every stored `sourceHash` and switches the preservation layer off.
- Mobile layouts. Desktop-first; the design degrades to a single column under ~900px by collapsing the rail and overlaying the panel, which is enough for a laptop in a split screen.

## Decisions carried from the user

1. Scope is a restructure, not a tidy-up — all four pains are in play.
2. **U now with approximate pages**; A3 later fills real page breaks into the shape U establishes.
3. **Consolidate freely, keep everything reachable.** Features may move, merge or be demoted; nothing may become unreachable. The sole proposed removal is the unused version-history component.
4. Direction: **page-first with a task rail**.

---

## 1. Shell and placement map (approved)

Four regions:

- **Top bar** — document name, `File` / `Insert` / `AI` menus, a body-style selector, and selection-aware controls that appear only when they apply.
- **Left rail** — four icons (Write, Cite, Review, Format). Clicking opens one panel; clicking the active icon closes it. Collapsed is a legitimate resting state.
- **Page canvas** — the document, centred, at its real width.
- **Status bar** — page estimate, word count, voice distance, save state.

Placement of every current surface:

| Today | Lands in |
|---|---|
| Chat tab | **Review** panel, one section, collapsed by default |
| Suggestions tab | **Review** panel, primary section |
| Style tab | **Review** panel, merged into the same list (§4) |
| Sources tab (937 lines) | **Cite** panel, split into *Library*, *Search*, *Reference manager* |
| Outline tab | **Write** panel |
| History tab | **Write** panel, collapsed |
| Grant toolbar, template picker, instructions | **Format** panel |
| Version history | **Write** panel; one component survives, the unused one is deleted |
| Settings modal | stays a modal, reached from the top bar |
| Import report dialog | stays a modal, plus A2a's File-menu "Import report" entry |
| Text format, insert | top bar, selection-aware (§3) |
| Undo / redo | `File` menu; keyboard bindings unchanged (§3) |
| AI-on-selection (5 controls) | top-bar `AI` menu, disabled without a selection |
| AI-on-figure (4 controls) | floating on the selected figure, never otherwise (§3) |

## 2. The page surface

The canvas binds to data that already exists from A1 rather than to new UI state.

- Width and padding come from `PAGE_SIZES_IN[format.page.size]` and `format.page.marginsIn`. Body text uses `format.defaults.fontFamily` and `fontSizePt`. A document imported from `.docx` therefore renders at its own geometry with no extra wiring.
- **`editorWidth` ('normal' | 'wide' | 'full') is removed.** The page's width *is* the document's width; a second, conflicting width control is exactly the kind of clutter this sub-project exists to remove. `editorZoom` stays — it scales the page, which is a different thing.
- Page guides exist already (`Editor.tsx`'s `pageGuideOffsets`) but are gated on `mode === 'grant'`. **Ungate them:** a manuscript has pages too. They render as a dotted rule with a label.
- **The A3 seam.** One exported function owns the estimate:

  ```ts
  // src/services/pagination.ts
  export interface PageEstimate { pages: number; approximate: boolean; breaks: number[] }
  export function estimatePages(doc: JSONContent, format: DocFormat): PageEstimate
  ```

  Both the guides and the status bar read it, and nothing else computes a page number. A3 replaces the implementation and flips `approximate` to `false`; no UI changes. Until then the status bar reads `~11 of 12 pp` with the tilde, and a tooltip says the estimate ignores figure and table flow.

**Reasoning:** binding to `DocFormat` means the NIH compliance the user asked for is a property of the document, not a view setting, so it survives save, reload and export. Putting the estimate behind one function is what keeps A3 from becoming a second UI change.

## 3. Selection-aware top bar

At rest: document name · `File` · `Insert` · `AI` · body-style selector · overflow (`⋯`).

The selection-aware group appears between the menus and the overflow:

- **Text selected** — bold, italic, underline; block type (Normal, H1–H3, quote, bullet list, numbered list); alignment. Reuses `BUILTIN_STYLE_IDS` for the block list so the selector and the Format panel cannot disagree.
- **Figure selected** — the four figure-AI controls (visual description, relevance review, custom question, delete) render **on the figure**, as a small floating group. They are meaningless without a figure and must not occupy the bar.
- **Table selected** — row and column controls, which today sit in a context menu.

`AI` menu holds the five selection actions (rewrite, custom instruction, synonyms, verify claim, find similar manuscripts), each disabled with no selection and each labelled with what it does to the selection rather than with a verb alone.

**Undo and redo move to the `File` menu.** They are keyboard-first operations; two always-visible buttons for `Ctrl+Z` is not a good trade for the space. The keyboard bindings are unchanged.

**Reasoning:** the 53 controls are really five groups, and two of those groups (figure, table) are contextual by nature. Showing a control that cannot act is the main source of the "hunting for a feature" complaint, because it teaches that position does not predict availability.

## 4. The Review panel: one list, ordered by position

Today suggestions, style flags and grammar flags are three surfaces with three shapes. They become **one list ordered by position in the document**, each row carrying:

- where it is (section and an anchor that scrolls and flashes the span, reusing H's `StyleHighlights` mechanism);
- what it is (a coloured kind marker: suggestion, style, grammar);
- its evidence verbatim — H's evidence strings are written to be truthful about which checks fired and must not be paraphrased into something shorter;
- its action (accept / reject for a suggestion; rewrite for a style flag; both where both apply).

Chat sits below as a collapsed section. It is a conversational surface, not a positional one, and merging it into the list would misrepresent it.

The rail's Review icon carries a count badge. The count is of pending suggestions only, capped at 99+. Style flags are not counted, although they are actionable rows: they exist only while the style audit runs, so counting them would make the badge change with whether the panel had ever been opened, and a badge that moves because of what the user looked at is worse than one that undercounts. (Task 4's ruling: a recorded deviation from the earlier "actionable rows" wording; up to 12 style rows are not announced by the badge.)

**Reasoning:** the user's fourth pain is reconciling AI output against the text. Position is the one axis all three kinds share, so ordering by it is what makes them comparable. The existing per-kind grouping optimises for the producer, not the reader.

## 5. Code decomposition

The restructure is the occasion to split three files that are too large to reason about. No behaviour changes in this section; it is structural.

**New:**

- `src/components/shell/AppShell.tsx` — the four regions, rail state, panel mounting.
- `src/components/shell/Rail.tsx`, `src/components/shell/TopBar.tsx`, `src/components/shell/StatusBar.tsx`.
- `src/components/panels/{WritePanel,CitePanel,ReviewPanel,FormatPanel}.tsx`.
- `src/components/panels/cite/{Library,Search,ReferenceManager}.tsx` — the 937-line sources tab, split.
- `src/components/editor/{SelectionBar,FigureControls}.tsx`.
- `src/services/pagination.ts` — the A3 seam from §2.

**Changed:**

- `App.tsx` keeps ownership of application state and the handlers, and renders `AppShell`. It loses the shell markup and the menus. Target: under 700 lines.
- `Editor.tsx` keeps the TipTap instance, the extension list and the imperative ref. It loses the toolbar markup. Target: under 700 lines.
- `Sidebar.tsx` is **deleted** once all four panels are live.

**Deleted:** the unused version-history component.

**`CLAUDE.md` must be updated in the same sub-project.** It is already stale and will be actively wrong once this lands: it claims "There are no automated tests" (there are 1,316) and describes the sidebar as "Four tabs: Chat, Suggestions, Sources, History" (there are six, and the file is being deleted). An implementer reading it would look for a component that no longer exists. Update the Architecture Overview's editor and sidebar sections, and the test claim, as the last task.

**Constraint:** no file this sub-project creates exceeds ~400 lines. `src/docx/**` is untouched, and no node or mark attribute is added to the schema.

**Reasoning:** `Sidebar.tsx` at 2,358 lines is the direct cause of the tab coupling — six unrelated surfaces share one component's state. Splitting by panel makes each testable alone, which is what §6 depends on.

## 6. Testing and migration

**Reachability is the acceptance test.** Every entry point that worked before must work after, asserted as data rather than by inspection:

```ts
// src/components/shell/reachability.test.tsx
const ENTRY_POINTS = [
  { feature: 'upload a PDF source',       path: ['rail:cite', 'section:library', 'control:upload'] },
  { feature: 'search the literature',     path: ['rail:cite', 'section:search'] },
  { feature: 'accept a suggestion',       path: ['rail:review', 'row:suggestion', 'control:accept'] },
  { feature: 'rewrite a flagged sentence',path: ['rail:review', 'row:style', 'control:rewrite'] },
  { feature: 'open chat',                 path: ['rail:review', 'section:chat'] },
  { feature: 'restore a version',         path: ['rail:write', 'section:history'] },
  { feature: 'pick a grant template',     path: ['rail:format', 'section:template'] },
  { feature: 'set margins',               path: ['rail:format', 'section:page'] },
  { feature: 'import a Word document',    path: ['topbar:file', 'item:import'] },
  { feature: 'see the import report',     path: ['topbar:file', 'item:import-report'] },
  { feature: 'restore previous document', path: ['topbar:file', 'item:revert-import'] },
  { feature: 'verify a claim',            path: ['topbar:ai', 'item:verify'] },      // selection required
  { feature: 'describe a figure',         path: ['figure:selected', 'control:describe'] },
  // … one row per feature in the §1 placement map
];
```

Each row resolves against the rendered shell. A feature that moves updates its row; a feature that becomes unreachable fails the suite. This file is the migration's contract.

**Per-panel component tests** with `@testing-library/react` (available since H). Each panel renders alone, with its own store slice.

**Migration order**, each step keeping the suite green and the app usable:

1. `pagination.ts` plus the ungated guides and the page-geometry canvas. No layout change yet.
2. The shell (rail, regions, status bar) with the old `Sidebar` still mounted inside the panel area behind a flag.
3. Panels moved one at a time: Review, Cite, Write, Format — Review first, because it is the pain with the most leverage and the one that proves the list design.
4. The selection-aware top bar and the figure controls.
5. Delete `Sidebar.tsx`, the flag, `editorWidth`, and the unused version-history component.

**One browser run** at the end, as A2a's final task did: start the dev server once, drive the four panels and an import, confirm no console errors, then stop it. The standing rule in this project is no dev server during development, because the machine ran out of RAM when test workers multiplied; this is the single sanctioned exception.

**Gates:** `npx tsc --noEmit`, `npx vitest run` (baseline 1316), `npm run build`. `vitest.config.ts` stays capped at 2 forks.

## Risks

- **The reachability list is only as good as its rows.** If a feature is omitted from `ENTRY_POINTS`, the test cannot catch its loss. Mitigation: build the list from the §1 placement map, and have the task review check it against a `grep` of the current sidebar and toolbar rather than against the spec.
- **Review-list ordering depends on offsets that move.** Suggestions carry `startIndex`/`endIndex` into plain text, and style flags carry flat-text spans; both go stale as the document changes. The existing stale checks (H's `resolveFlatSentence`, A1's anchoring in `textMatch.ts`) must gate every row's action, and a row whose anchor no longer resolves must disable its action rather than act on the wrong span.
- **Removing `editorWidth` is user-visible.** It is deliberate (§2) and reversible, but it is the one change that takes something away rather than moving it.
