# DOI Auto-Fetch on Space — Design Spec

**Date:** 2026-04-17  
**Status:** Approved

---

## Problem

The `@` citation picker currently requires the user to click a "Look up DOI via Crossref" button after typing a DOI. This is an unnecessary confirmation step. Users also cannot paste or type multiple DOIs at once.

---

## Goal

- Single DOI: `@10.1038/nature12345 ` (Space) → auto-fetch and insert `[N]` with no button click.
- Multi-DOI: `@10.1038/aaa,10.1234/bbb ` (Space) → fetch all in parallel, insert one merged `[1,2]` CitationNode.
- Support `doi:` prefix notation (`doi:10.1038/xxx`) in addition to bare DOIs and `doi.org` URLs.

---

## Architecture

### 1. `src/services/citations.ts` — `normalizeDoi`

Extend the single-line regex to also strip the `doi:` prefix:

```
doi:10.1038/xxx  →  10.1038/xxx
```

No other changes to this file.

### 2. `src/components/Editor.tsx` — Space trigger

**Where:** inside the existing `handleAtKey` keydown listener, when `showCitationPickerRef.current` is true.

**Logic:**
```
if (e.key === ' ') {
  const filter = citationFilter (read from ref to avoid stale closure)
  const parts = filter.split(',').map(normalizeDoi).filter(looksLikeDoi)
  if (parts.length > 0) {
    e.preventDefault()          // don't type a space
    if (parts.length === 1) handleInsertDoi(parts[0])
    else                    handleInsertMultipleDoi(parts)
  }
}
```

`citationFilter` is read through a ref (`citationFilterRef`) so the keydown handler always sees the latest value without needing to be recreated on every filter change.

### 3. `src/components/Editor.tsx` — `handleInsertMultipleDoi`

```
async function handleInsertMultipleDoi(dois: string[]) {
  setDoiPickerState('loading')
  setDoiPickerError(null)

  const results = await Promise.allSettled(
    dois.map(async doi => {
      let source = allSources.find(doi match)
      if (!source) {
        source = await fetchCrossrefDoi(doi)
        addSources([source])   // add immediately so renumber sees it
      }
      return source
    })
  )

  const succeeded = results.filter(fulfilled).map(r => r.value)
  const failed    = results.filter(rejected).map((r, i) => dois[i])

  if (succeeded.length === 0) {
    setDoiPickerState('error')
    setDoiPickerError(`Failed: ${failed.join(', ')}`)
    return
  }

  // Insert a single merged CitationNode containing all succeeded nums
  insertMergedCitation(succeeded)   // calls onInsertCitation for each, collects nums, inserts one node

  if (failed.length > 0) {
    // partial success — show warning but picker already closed by insertMergedCitation
    // toast or console.warn the failed DOIs (no blocking UI)
  }
}
```

### 4. `src/components/Editor.tsx` — `insertMergedCitation`

Refactors the common end of `handleInsertCitation` into a helper that accepts an array of sources, collects their citation numbers, and inserts a single CitationNode with `nums: [n1, n2, ...]`.

```
function insertMergedCitation(sources: ManuscriptSource[]) {
  const nums = sources.map(s => onInsertCitation(s.id))
  deleteRange({ from: atPos, to: curPos })
  editor.chain().focus().insertCitationNums(nums).run()
  // reset picker state
}
```

The existing `insertCitation` command only takes a single `(sourceId, num)` pair. A new `insertCitationBatch` command will be added to `CitationNode.tsx`:

```ts
insertCitationBatch: (sourceIds: string[], nums: number[]) =>
  ({ commands }) =>
    commands.insertContent({
      type: 'citation',
      attrs: { sourceIds, nums },
    })
```

### 5. Picker UI — loading state for batch

When `doiPickerState === 'loading'` the existing spinner covers both single and batch. No new UI component needed.

For partial-failure: if some DOIs failed and some succeeded, the picker will already be closed (citations inserted). A brief inline console warning is acceptable; a full blocking error is not shown for partial success.

---

## Data Flow

```
User types: @10.1038/aaa,10.1234/bbb[Space]
         │
         ▼
keydown Space → citationFilterRef = "10.1038/aaa,10.1234/bbb"
         │       split(',') → ["10.1038/aaa", "10.1234/bbb"]
         │       both looksLikeDoi → true
         │       preventDefault()
         ▼
handleInsertMultipleDoi(["10.1038/aaa", "10.1234/bbb"])
         │
         ▼
Promise.allSettled([fetchCrossrefDoi, fetchCrossrefDoi])
         │
         ▼
addSources([source1, source2])
         │
         ▼
insertMergedCitation([source1, source2])
  → nums = [onInsertCitation(id1), onInsertCitation(id2)]
  → deleteRange(@..cursor)
  → insertCitationNums([1, 2])
         │
         ▼
Document: ... [1,2] ...
```

---

## Scope

| File | Change |
|------|--------|
| `src/services/citations.ts` | `normalizeDoi`: add `doi:` prefix strip |
| `src/extensions/CitationNode.tsx` | Add `insertCitationBatch(sourceIds, nums)` command |
| `src/components/Editor.tsx` | `citationFilterRef`, Space handler, `handleInsertMultipleDoi`, `insertMergedCitation` |

No changes to stores or Sidebar.

---

## Out of Scope

- Tab or Enter as alternative auto-fetch triggers (Space only)
- Showing a preview of fetched titles before inserting
- Deduplication across already-inserted citations (existing logic handles this)
