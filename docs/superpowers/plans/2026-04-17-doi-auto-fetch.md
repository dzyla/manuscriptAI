# DOI Auto-Fetch on Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-fetch one or more Crossref DOIs when the user presses Space after `@<doi>` or `@<doi1>,<doi2>` in the editor, inserting a merged citation node without requiring a button click.

**Architecture:** A `citationFilterRef` keeps the Space keydown handler in sync with the current filter without stale closures. The Space handler splits on commas, validates each part as a DOI, then calls `handleInsertMultipleDoi` (parallel `Promise.allSettled` fetches). A new `insertCitationBatch` TipTap command inserts a single CitationNode with all source IDs and citation numbers.

**Tech Stack:** React 19, TipTap, Zustand (`useSourceStore`), `fetchCrossrefDoi` / `normalizeDoi` / `looksLikeDoi` from `src/services/citations.ts`.

---

## File Map

| File | Change |
|------|--------|
| `src/services/citations.ts` | Extend `normalizeDoi` to strip `doi:` prefix |
| `src/extensions/CitationNode.tsx` | Add `insertCitationBatch` command to type declaration and `addCommands()` |
| `src/components/Editor.tsx` | Add `citationFilterRef`; extend Space handler; add `handleInsertMultipleDoi`; update `insertMergedCitation` helper |

---

### Task 1: Extend `normalizeDoi` to strip `doi:` prefix

**Files:**
- Modify: `src/services/citations.ts:314-316`

- [ ] **Step 1: Update `normalizeDoi`**

Find this block (around line 314):
```ts
/** Strips any doi.org URL prefix, returning the bare DOI (e.g. "10.1038/...") */
export function normalizeDoi(text: string): string {
  return text.trim().replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi\.org\//i, '');
}
```

Replace with:
```ts
/** Strips doi.org URL and bare doi: prefixes, returning the bare DOI (e.g. "10.1038/...") */
export function normalizeDoi(text: string): string {
  return text.trim()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi\.org\//i, '')
    .replace(/^doi:/i, '');
}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/citations.ts
git commit -m "fix: normalizeDoi strips doi: prefix notation"
```

---

### Task 2: Add `insertCitationBatch` command to CitationNode

**Files:**
- Modify: `src/extensions/CitationNode.tsx`

- [ ] **Step 1: Extend the command type declaration**

Find (lines 33-39):
```ts
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (sourceId: string, num: number) => ReturnType;
      updateAllCitationNums: (registry: Record<string, number>) => ReturnType;
    };
  }
}
```

Replace with:
```ts
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      insertCitation: (sourceId: string, num: number) => ReturnType;
      insertCitationBatch: (sourceIds: string[], nums: number[]) => ReturnType;
      updateAllCitationNums: (registry: Record<string, number>) => ReturnType;
    };
  }
}
```

- [ ] **Step 2: Add the command implementation**

Find (lines 85-93):
```ts
  addCommands() {
    return {
      insertCitation: (sourceId: string, num: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceIds: [sourceId], nums: [num] },
          });
        },
```

Replace with:
```ts
  addCommands() {
    return {
      insertCitation: (sourceId: string, num: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceIds: [sourceId], nums: [num] },
          });
        },

      insertCitationBatch: (sourceIds: string[], nums: number[]) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceIds, nums },
          });
        },
```

- [ ] **Step 3: Type-check**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/CitationNode.tsx
git commit -m "feat: add insertCitationBatch command to CitationNode"
```

---

### Task 3: Add `citationFilterRef` and Space handler to Editor

**Files:**
- Modify: `src/components/Editor.tsx`

`citationFilterRef` keeps the keydown handler in sync with the latest `citationFilter` state value without needing to re-register the listener on every keystroke.

- [ ] **Step 1: Add `citationFilterRef` alongside existing state**

Find (line 173):
```ts
  const [citationFilter, setCitationFilter] = useState('');
```

Replace with:
```ts
  const [citationFilter, setCitationFilter] = useState('');
  const citationFilterRef = useRef('');
```

- [ ] **Step 2: Keep the ref in sync whenever state updates**

Find the effect that reads `editor?.state.selection.from` and updates `citationFilter` (around line 311):
```ts
  // While citation picker is open, track filter text from what was typed after '@'
  useEffect(() => {
    if (!citationPicker || !editor) return;
    const curPos = editor.state.selection.from;
    const from = atInsertPos.current; // position before '@'
    if (curPos > from) {
      const typed = editor.state.doc.textBetween(from, Math.min(curPos, from + 40), '');
      // typed starts with '@', strip it
      setCitationFilter(typed.replace(/^@/, '').toLowerCase());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.state.selection.from, citationPicker]);
```

Replace with:
```ts
  // While citation picker is open, track filter text from what was typed after '@'
  useEffect(() => {
    if (!citationPicker || !editor) return;
    const curPos = editor.state.selection.from;
    const from = atInsertPos.current; // position before '@'
    if (curPos > from) {
      const typed = editor.state.doc.textBetween(from, Math.min(curPos, from + 40), '');
      const filter = typed.replace(/^@/, '').toLowerCase();
      setCitationFilter(filter);
      citationFilterRef.current = filter;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.state.selection.from, citationPicker]);
```

- [ ] **Step 3: Add Space auto-trigger inside `handleAtKey`**

Find (lines 288-305):
```ts
    const handleAtKey = (e: KeyboardEvent) => {
      if (showCitationPickerRef.current) {
        if (e.key === 'Escape') { setCitationPicker(null); setCitationFilter(''); setDoiPickerState('idle'); setDoiPickerError(null); }
        return;
      }
      if (e.key === '@') {
```

Replace with:
```ts
    const handleAtKey = (e: KeyboardEvent) => {
      if (showCitationPickerRef.current) {
        if (e.key === 'Escape') {
          setCitationPicker(null);
          setCitationFilter('');
          citationFilterRef.current = '';
          setDoiPickerState('idle');
          setDoiPickerError(null);
        }
        if (e.key === ' ') {
          const filter = citationFilterRef.current;
          const parts = filter
            .split(',')
            .map(p => normalizeDoi(p.trim()))
            .filter(p => looksLikeDoi(p));
          if (parts.length > 0) {
            e.preventDefault();
            if (parts.length === 1) {
              handleInsertDoiRef.current(parts[0]);
            } else {
              handleInsertMultipleDoiRef.current(parts);
            }
          }
        }
        return;
      }
      if (e.key === '@') {
```

Note: `handleInsertDoiRef` and `handleInsertMultipleDoiRef` are refs to the handler functions — added in Task 4 — so the keydown closure always calls the latest version.

- [ ] **Step 4: Type-check**

```bash
npm run lint
```
Expected: errors about `handleInsertDoiRef` and `handleInsertMultipleDoiRef` not existing yet — that's fine, Task 4 adds them.

- [ ] **Step 5: Commit after Task 4 fixes the errors** *(defer to end of Task 4)*

---

### Task 4: Add `handleInsertMultipleDoi` and wire handler refs

**Files:**
- Modify: `src/components/Editor.tsx`

- [ ] **Step 1: Add handler refs after the existing `doiPickerState` state declarations**

Find (line 190):
```ts
  const [doiPickerState, setDoiPickerState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [doiPickerError, setDoiPickerError] = useState<string | null>(null);
```

Add after those two lines:
```ts
  const handleInsertDoiRef = useRef<(doi: string) => void>(() => {});
  const handleInsertMultipleDoiRef = useRef<(dois: string[]) => void>(() => {});
```

- [ ] **Step 2: Add `handleInsertMultipleDoi` function**

Find the existing `handleInsertDoi` function (around line 538):
```ts
  const handleInsertDoi = async (doi: string) => {
    const bareDoi = normalizeDoi(doi);
    setDoiPickerState('loading');
    setDoiPickerError(null);
    try {
      let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === bareDoi.toLowerCase());
      if (!source) {
        source = await fetchCrossrefDoi(bareDoi);
        addSources([source]);
      }
      handleInsertCitation(source); // closes picker and resets doi state internally
    } catch (err) {
      setDoiPickerState('error');
      setDoiPickerError(err instanceof Error ? err.message : 'DOI lookup failed.');
    }
  };
```

Replace with:
```ts
  const handleInsertDoi = async (doi: string) => {
    const bareDoi = normalizeDoi(doi);
    setDoiPickerState('loading');
    setDoiPickerError(null);
    try {
      let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === bareDoi.toLowerCase());
      if (!source) {
        source = await fetchCrossrefDoi(bareDoi);
        addSources([source]);
      }
      handleInsertCitation(source);
    } catch (err) {
      setDoiPickerState('error');
      setDoiPickerError(err instanceof Error ? err.message : 'DOI lookup failed.');
    }
  };

  const handleInsertMultipleDoi = async (dois: string[]) => {
    if (!editor || !onInsertCitation) return;
    setDoiPickerState('loading');
    setDoiPickerError(null);

    const results = await Promise.allSettled(
      dois.map(async (doi) => {
        let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === doi.toLowerCase());
        if (!source) {
          source = await fetchCrossrefDoi(doi);
          addSources([source]);
        }
        return source;
      })
    );

    const succeeded = results
      .filter((r): r is PromiseFulfilledResult<ManuscriptSource> => r.status === 'fulfilled')
      .map(r => r.value);
    const failedDois = dois.filter((_, i) => results[i].status === 'rejected');

    if (succeeded.length === 0) {
      setDoiPickerState('error');
      setDoiPickerError(`Could not fetch: ${failedDois.join(', ')}`);
      return;
    }

    // Collect citation numbers for all succeeded sources
    const nums = succeeded.map(s => onInsertCitation(s.id));
    const sourceIds = succeeded.map(s => s.id);

    const atPos = atInsertPos.current;
    const curPos = editor.state.selection.from;
    editor.chain().focus().deleteRange({ from: atPos, to: curPos }).run();
    (editor.chain().focus() as any).insertCitationBatch(sourceIds, nums).run();

    setCitationPicker(null);
    setCitationFilter('');
    citationFilterRef.current = '';
    setDoiPickerState('idle');
    setDoiPickerError(null);

    if (failedDois.length > 0) {
      console.warn('DOI batch: failed to fetch', failedDois.join(', '));
    }
  };
```

Note: `ManuscriptSource`, `normalizeDoi`, `looksLikeDoi`, and `fetchCrossrefDoi` are all already imported in `Editor.tsx` (lines 12 and 27).

- [ ] **Step 3: Keep handler refs up to date**

Add a `useEffect` immediately after both handler definitions to keep the refs current:

```ts
  useEffect(() => {
    handleInsertDoiRef.current = handleInsertDoi;
    handleInsertMultipleDoiRef.current = handleInsertMultipleDoi;
  });
```

This runs after every render, so the keydown handler always calls the latest closure.

- [ ] **Step 4: Type-check**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 5: Commit Tasks 3 + 4 together**

```bash
git add src/components/Editor.tsx
git commit -m "feat: auto-fetch DOI(s) on Space in @ citation picker"
```

---

### Task 5: Update picker UI for batch loading state

**Files:**
- Modify: `src/components/Editor.tsx` (citation picker JSX, around line 1407)

The picker currently shows a single "Look up DOI via Crossref" button. Update the label to reflect multi-DOI mode and show how many DOIs were detected.

- [ ] **Step 1: Update the DOI detection row label**

Find (around line 1439-1443):
```tsx
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {doiPickerState === 'loading' ? 'Looking up DOI…' : 'Look up DOI via Crossref'}
                    </p>
                    <p className="text-[10px] truncate font-mono" style={{ color: 'var(--text-muted)' }}>{citationFilter}</p>
                  </div>
```

Replace with:
```tsx
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {doiPickerState === 'loading'
                        ? 'Fetching from Crossref…'
                        : (() => {
                            const count = citationFilter.split(',').filter(p => looksLikeDoi(normalizeDoi(p.trim()))).length;
                            return count > 1 ? `Look up ${count} DOIs via Crossref` : 'Look up DOI via Crossref';
                          })()}
                    </p>
                    <p className="text-[10px] truncate font-mono" style={{ color: 'var(--text-muted)' }}>{citationFilter}</p>
                  </div>
```

Also update the `onMouseDown` handler for the button to support batch:

Find (around line 1427-1431):
```tsx
                  onMouseDown={e => {
                    e.preventDefault();
                    if (doiPickerState !== 'idle') return;
                    handleInsertDoi(citationFilter);
                  }}
```

Replace with:
```tsx
                  onMouseDown={e => {
                    e.preventDefault();
                    if (doiPickerState !== 'idle') return;
                    const parts = citationFilter
                      .split(',')
                      .map(p => normalizeDoi(p.trim()))
                      .filter(p => looksLikeDoi(p));
                    if (parts.length > 1) {
                      handleInsertMultipleDoi(parts);
                    } else {
                      handleInsertDoi(parts[0] ?? citationFilter);
                    }
                  }}
```

- [ ] **Step 2: Type-check**

```bash
npm run lint
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "feat: show DOI count and support batch click in citation picker"
```

---

## Verification Checklist

After all tasks are complete, manually verify:

- [ ] `@10.1038/s41586-020-2649-2 ` (space) → auto-fetches, inserts `[N]`, no button click needed
- [ ] `@doi:10.1038/s41586-020-2649-2 ` → same (doi: prefix stripped)
- [ ] `@https://doi.org/10.1038/s41586-020-2649-2 ` → same (doi.org URL stripped)
- [ ] `@10.1038/aaa,10.1234/bbb ` (two DOIs, space) → fetches both in parallel, inserts `[1,2]` merged node
- [ ] `@10.1038/aaa,notadoi ` → only the valid DOI is fetched; invalid part ignored (filtered by `looksLikeDoi`)
- [ ] `@10.9999/doesnotexist ` → shows error in picker (404 from Crossref)
- [ ] Clicking the "Look up DOI" button still works (single and multi)
- [ ] Escape closes the picker without inserting anything
- [ ] `npm run lint` passes clean
