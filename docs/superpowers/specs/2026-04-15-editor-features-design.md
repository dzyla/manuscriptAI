# Editor Features Design — 2026-04-15

## Scope

Five improvements to the manuscript editor:

1. BubbleMenu smart positioning (no overlap with selected text)
2. Contextual bubble menu actions gated by selection word count
3. Synonyms for 1–2 word selections
4. Crossref/DOI citation lookup (Sources tab + `@` trigger in editor)
5. Figure auto-numbering (`FigureLabel` node + `figureRegistry` in store)

Out of scope (deferred): Yjs collaboration, track changes, plagiarism checker.

---

## 1. BubbleMenu Positioning

**Problem:** The text BubbleMenu renders at the default Floating UI position (bottom), which overlaps the selected text when a suggestion from the review panel scrolls and selects text.

**Fix:** Add `options={{ placement: 'top', offset: 10 }}` to the text `BubbleMenu` in `Editor.tsx`. The image BubbleMenu already uses this pattern — the text BubbleMenu is missing it.

**File:** `src/components/Editor.tsx` — the first `<BubbleMenu>` element (line ~915).

---

## 2. Contextual Bubble Menu Actions

Selection word count gates which optional actions appear:

| Word count | Extra actions shown |
|---|---|
| 1–2 words | **Synonyms** button |
| 3–5 words | (none extra) |
| > 5 words | **Find Similar** button |

- The Synonyms button guard changes from `!sel.includes(' ')` to `wordCount <= 2 && wordCount >= 1`.
- The Find Similar button gains a guard: only render when `wordCount > 5`.
- All existing formatting and AI actions (Polish, Shorten, etc.) remain visible for all selection sizes.

Word count is computed from `selectedText.trim().split(/\s+/).filter(Boolean).length`.

---

## 3. Synonyms for 1–2 Words

**Current behavior:** `getThesaurus()` is called only when the selected text has no spaces (single word).

**New behavior:** Call `getThesaurus()` when `wordCount <= 2`. The AI prompt already handles multi-word phrases gracefully (it returns synonyms/alternatives for the phrase).

The display label changes from `Synonyms for "word"` to `Synonyms for "word or phrase"` (uses the actual selected text as the label, which already works).

**File:** `src/components/Editor.tsx` — `handleThesaurus` guard and the bubble menu render condition.

---

## 4. Crossref/DOI Lookup

### 4a. Helper function

Add `fetchCrossrefDoi(doi: string): Promise<ManuscriptSource>` to `src/services/citations.ts`.

- Fetches `https://api.crossref.org/works/{encodeURIComponent(doi)}`
- Extracts: `title` (first element of title array), authors (formatted as "Last, First; Last, First"), year (`published['date-parts'][0][0]`), journal (`container-title[0]`), DOI, abstract (when present)
- Returns a `ManuscriptSource` with `type: 'api'`, `apiMeta` populated as `SemanticSearchResult`, `id` = `crypto.randomUUID()`
- Throws a descriptive error if the DOI is not found (HTTP 404) or the network fails

### 4b. Sources tab input

Add a "Add by DOI" section to the Sources tab in `Sidebar.tsx`, positioned below the existing upload buttons.

- A text input with placeholder `10.1234/journal.xxx`
- An "Add" button (or Enter key) triggers `fetchCrossrefDoi`
- Loading state: spinner on the button
- On success: source added to the store via `useSourceStore`, toast "Citation added"
- On error: inline error message below the input

### 4c. `@` trigger DOI detection

Extend the existing `@` citation picker logic in `Editor.tsx`.

- While the citation picker is open and the user has typed after `@`, check if the typed text matches `/^10\.\d{4,}\//` (DOI prefix pattern)
- When matched: show a "DOI detected" state in the picker dropdown — a single row with a Crossref icon, the DOI text, and a "Look up" label
- On click (or auto-trigger after a short debounce once the DOI looks complete — ends with a non-space character after the slash): call `fetchCrossrefDoi`
- Loading: replace the row with a spinner
- On success: add source to store, insert `CitationNode` at the `@` position (same as `handleInsertCitation`), close the picker
- On error: show inline error in the picker
- If the DOI already exists in the source store (match by `apiMeta.doi` case-insensitive): skip the fetch and insert the existing citation directly

**DOI completeness heuristic:** auto-trigger fetch when the typed text after `@` matches `/^10\.\d{4,}\/\S{3,}$/` (has the registry prefix, slash, and at least 3 suffix chars). This avoids fetching mid-type.

---

## 5. Figure Auto-Numbering

### 5a. `FigureLabel` TipTap extension

New file: `src/extensions/FigureLabel.tsx`

An inline atom node (same pattern as `CitationNode`):

```
attrs: { figureId: string, num: number }
renders as: <span class="figure-label" data-figure-id="...">Figure N</span>
```

- `figureId`: stable UUID assigned at insertion time
- `num`: the display number, updated by `renumberFigures()`
- Commands: `insertFigureLabel()` (inserts at cursor with next available num), `updateAllFigureNums(registry)` (walks doc and patches all nums)

### 5b. `figureRegistry` in `useDocumentStore`

Add to `DocumentRow` and `useDocumentStore`:

```ts
figureRegistry: Record<string, number>  // figureId → number
figureCounter: number                    // monotonically increasing, never reused
```

Methods:
- `insertFigure(figureId: string): number` — assigns next counter value, adds to registry, returns the number
- `renumberFigures(): { newRegistry: Record<string, number>; newHtml: string }` — walks document HTML in order (same approach as `renumberCitations`), assigns 1, 2, 3… in appearance order, returns updated registry + updated HTML
- `removeFigure(figureId: string)` — removes from registry

### 5c. EditorRef extension

Add to `EditorRef` interface:
- `getFigureOrder(): string[]` — returns figureIds in document order
- `updateFigures(registry: Record<string, number>): void` — calls `updateAllFigureNums`

### 5d. Toolbar button

Add a "Fig #" toolbar button to the editor toolbar (after the image insert button). Clicking it:
1. Calls `storeInsertFigure()` to get a new figureId + num
2. Inserts a `FigureLabel` node at the cursor
3. Calls `renumberFigures()` and applies the returned HTML (same pattern as citation insertion)

### 5e. Auto-renumber trigger

Call `renumberFigures()` in `App.tsx` on the same occasions as `renumberCitations()`:
- After any figure insertion
- On document load (to recover from any out-of-order state)

---

## Data Flow Summary

```
User types @10.1234/xxx
  → citation picker detects DOI pattern
  → fetchCrossrefDoi() → Crossref API
  → ManuscriptSource added to useSourceStore
  → CitationNode inserted at cursor
  → renumberCitations() called

User clicks "Fig #" toolbar button
  → storeInsertFigure() → figureId + num
  → FigureLabel node inserted at cursor
  → renumberFigures() called → HTML updated

User reorders paragraphs containing FigureLabel nodes
  → on next save / manual renumber → renumberFigures() → numbers update
```

---

## Files Changed

| File | Change |
|---|---|
| `src/components/Editor.tsx` | BubbleMenu placement, word-count guards, synonym guard, DOI detection in `@` picker |
| `src/services/citations.ts` | `fetchCrossrefDoi()` helper |
| `src/extensions/FigureLabel.tsx` | New TipTap node extension |
| `src/stores/useDocumentStore.ts` | `figureRegistry`, `figureCounter`, `insertFigure`, `renumberFigures`, `removeFigure` |
| `src/components/Sidebar.tsx` | "Add by DOI" input in Sources tab |
| `src/App.tsx` | Wire `renumberFigures` on figure events, pass `onInsertFigure` to Editor |
| `src/types.ts` | `DocumentRow` extended with `figureRegistry`, `figureCounter` |
| `src/db/manuscriptDb.ts` | Schema migration for new `figureRegistry`/`figureCounter` fields |
