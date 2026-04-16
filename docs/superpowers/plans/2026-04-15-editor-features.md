# Editor Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix bubble menu overlap, add contextual synonym/find-similar actions, add Crossref/DOI citation lookup, and add figure auto-numbering.

**Architecture:** BubbleMenu gets `placement: 'top'` to prevent overlap; selection word-count gates contextual actions; a new `fetchCrossrefDoi()` helper + `@`-trigger extension + Sidebar input handle DOI lookup; a new `FigureLabel` TipTap extension + `figureRegistry` in `useDocumentStore` handle figure auto-numbering — mirroring the existing citation pattern exactly.

**Tech Stack:** TipTap v3, Zustand, Dexie, React 19, TypeScript, Crossref public REST API (no auth)

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/components/Editor.tsx` | Modify | BubbleMenu placement, word-count guards, DOI detection in `@` picker |
| `src/services/citations.ts` | Modify | Add `fetchCrossrefDoi()` |
| `src/components/Sidebar.tsx` | Modify | Add "Add by DOI" input in Sources tab |
| `src/extensions/FigureLabel.tsx` | Create | New TipTap inline atom node |
| `src/stores/useDocumentStore.ts` | Modify | Add `figureRegistry`, `figureCounter`, `insertFigure`, `renumberFigures`, `removeFigure` |
| `src/types.ts` | Modify | Extend `DocumentRow` with figure fields |
| `src/db/manuscriptDb.ts` | Modify | No schema change needed (Dexie handles sparse fields) |
| `src/App.tsx` | Modify | Wire `onInsertFigure` and `renumberFigures` |

---

## Task 1: BubbleMenu smart positioning

**Files:**
- Modify: `src/components/Editor.tsx` (line ~915 — the first `<BubbleMenu>`)

- [ ] **Step 1: Add placement and offset to the text BubbleMenu**

In `Editor.tsx`, find the first `<BubbleMenu` (the text selection menu, around line 915). It currently has no `options` prop. Add `options={{ placement: 'top', offset: 10 }}`:

```tsx
<BubbleMenu
  editor={editor}
  options={{ placement: 'top', offset: 10 }}
  shouldShow={({ editor: e, from, to }) => {
    if (e.isActive('resizableImage')) return false;
    let hasImg = false;
    if (from !== to) e.state.doc.nodesBetween(from, to, n => { if (n.type.name === 'resizableImage') { hasImg = true; return false; } return true; });
    return !hasImg && from !== to;
  }}
>
```

- [ ] **Step 2: Verify type-check passes**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "fix: position text BubbleMenu above selection to prevent overlap"
```

---

## Task 2: Contextual bubble menu actions (synonyms for 1–2 words, Find Similar for >5 words)

**Files:**
- Modify: `src/components/Editor.tsx`

- [ ] **Step 1: Add selectionWordCount state**

In the Editor component's state declarations (around line 154, alongside `showSelectionBar`), add:

```ts
const [selectionWordCount, setSelectionWordCount] = useState(0);
```

Then in `onSelectionUpdate` (around line 219), after the line `selectedTextRef.current = hasSelection ? ...`, add:

```ts
setSelectionWordCount(
  hasSelection
    ? editor.state.doc.textBetween(from, to, ' ').trim().split(/\s+/).filter(Boolean).length
    : 0
);
```

This keeps `selectionWordCount` as a reactive state variable so the BubbleMenu re-renders correctly when selection changes.

- [ ] **Step 2: Gate Find Similar behind word count > 5**

Now `selectionWordCount` is available as a state variable in the component. Find the "Find Similar" button in the BubbleMenu JSX (currently always shown):

```tsx
<button
  onMouseDown={e => { e.preventDefault(); const text = selectedTextRef.current || getSelectedText(); if (text && onSearchSimilar) onSearchSimilar(text); }}
  className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-violet-400"
  title="Find similar published manuscripts for this selection"
>
  <Search size={11} />
  Find Similar
</button>
```

Wrap it with a conditional:

```tsx
{selectionWordCount > 5 && (
  <button
    onMouseDown={e => { e.preventDefault(); const text = selectedTextRef.current || getSelectedText(); if (text && onSearchSimilar) onSearchSimilar(text); }}
    className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-violet-400"
    title="Find similar published manuscripts for this selection"
  >
    <Search size={11} />
    Find Similar
  </button>
)}
```

- [ ] **Step 3: Extend Synonyms to 1–2 words**

Find the existing Synonyms button render (currently uses `!sel.includes(' ')` guard):

```tsx
{(() => {
  const sel = getSelectedText().trim();
  if (!sel || sel.includes(' ') || sel.length <= 1) return null;
  return (
    <button
      onMouseDown={e => { e.preventDefault(); handleThesaurus(); }}
      className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-green-400"
      title="Find synonyms"
    >
      <BookOpen size={11} />
      Synonyms
    </button>
  );
})()}
```

Replace with (uses `selectionWordCount` state variable):

```tsx
{selectionWordCount >= 1 && selectionWordCount <= 2 && (
  <button
    onMouseDown={e => { e.preventDefault(); handleThesaurus(); }}
    className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap text-green-400"
    title="Find synonyms / alternatives"
  >
    <BookOpen size={11} />
    Synonyms
  </button>
)}
```

- [ ] **Step 4: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "feat: contextual bubble menu — synonyms for 1-2 words, find similar for >5 words"
```

---

## Task 3: fetchCrossrefDoi helper

**Files:**
- Modify: `src/services/citations.ts`

- [ ] **Step 1: Add ManuscriptSource import and fetchCrossrefDoi function**

At the top of `src/services/citations.ts`, add the import:

```ts
import type { ManuscriptSource } from '../types';
```

At the bottom of `src/services/citations.ts`, add:

```ts
// ─── Crossref DOI lookup ──────────────────────────────────────────────────────

/**
 * Fetch metadata for a DOI from the Crossref public REST API.
 * Returns a ManuscriptSource ready to add to the source store.
 * Throws a descriptive error on 404 or network failure.
 */
export async function fetchCrossrefDoi(doi: string): Promise<ManuscriptSource> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi.trim())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'ManuscriptAIEditor/1.0 (mailto:user@example.com)' } });
  } catch {
    throw new Error('Network error — could not reach Crossref. Check your connection.');
  }
  if (res.status === 404) throw new Error(`DOI not found: ${doi}`);
  if (!res.ok) throw new Error(`Crossref returned ${res.status} for DOI: ${doi}`);

  const json = await res.json();
  const work = json.message as Record<string, any>;

  const title: string = Array.isArray(work.title) && work.title.length > 0
    ? String(work.title[0])
    : doi;

  const authors: string = Array.isArray(work.author)
    ? work.author
        .map((a: any) => [a.family, a.given].filter(Boolean).join(', '))
        .join('; ')
    : '';

  const year: number | null =
    work.published?.['date-parts']?.[0]?.[0] ??
    work['published-print']?.['date-parts']?.[0]?.[0] ??
    work['published-online']?.['date-parts']?.[0]?.[0] ??
    null;

  const journal: string = Array.isArray(work['container-title']) && work['container-title'].length > 0
    ? String(work['container-title'][0])
    : '';

  // Crossref abstracts often include JATS XML tags — strip them
  const rawAbstract: string = typeof work.abstract === 'string' ? work.abstract : '';
  const abstract = rawAbstract.replace(/<[^>]*>/g, '').trim();

  const doiStr: string = typeof work.DOI === 'string' ? work.DOI : doi;

  const fullText = [title, authors, journal, abstract].filter(Boolean).join('\n');

  return {
    id: crypto.randomUUID(),
    name: title.substring(0, 80),
    type: 'api',
    text: fullText,
    abstractText: abstract || undefined,
    apiMeta: {
      title,
      authors,
      journal,
      doi: doiStr,
      abstract,
      year,
      score: 1,
      source: 'Crossref',
    },
  };
}

/** Returns true if the string looks like a DOI (starts with 10. prefix) */
export function looksLikeDoi(text: string): boolean {
  return /^10\.\d{4,}\/\S{3,}/.test(text.trim());
}
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/citations.ts
git commit -m "feat: add fetchCrossrefDoi helper and looksLikeDoi utility"
```

---

## Task 4: DOI input in Sources tab

**Files:**
- Modify: `src/components/Sidebar.tsx`

- [ ] **Step 1: Add state and import**

In `Sidebar.tsx`, add to imports at the top:

```ts
import { fetchCrossrefDoi, looksLikeDoi } from '../services/citations';
```

After the existing state declarations (around line 186, after `visionWarning`), add:

```ts
const [doiInput, setDoiInput] = useState('');
const [doiLoading, setDoiLoading] = useState(false);
const [doiError, setDoiError] = useState<string | null>(null);
```

- [ ] **Step 2: Add handleAddDoi function**

After `runGlobalSearch` function definition (around line 188), add:

```ts
const handleAddDoi = async () => {
  const doi = doiInput.trim();
  if (!doi) return;
  // Check if DOI already in store
  const existing = sources.find(s => s.apiMeta?.doi?.toLowerCase() === doi.toLowerCase());
  if (existing) {
    setDoiError('This DOI is already in your sources.');
    return;
  }
  setDoiLoading(true);
  setDoiError(null);
  try {
    const source = await fetchCrossrefDoi(doi);
    addSources([source]);
    setDoiInput('');
  } catch (err) {
    setDoiError(err instanceof Error ? err.message : 'Failed to fetch DOI.');
  } finally {
    setDoiLoading(false);
  }
};
```

- [ ] **Step 3: Add DOI input UI in the sources tab**

In the sources tab JSX (after the file input `<input ref={fileUploadRef} ... />` closing tag, around line 1090, before the "Manual manuscript search" comment), insert:

```tsx
{/* Add by DOI */}
<div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
  <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
    <Hash size={12} style={{ color: 'var(--text-muted)' }} />
    <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Add by DOI</span>
  </div>
  <div className="p-3 space-y-1.5">
    <div className="flex gap-1.5">
      <input
        value={doiInput}
        onChange={e => { setDoiInput(e.target.value); setDoiError(null); }}
        onKeyDown={e => { if (e.key === 'Enter') handleAddDoi(); }}
        placeholder="10.1234/journal.article"
        className="flex-1 text-[11px] px-2.5 py-1.5 border rounded-lg focus:outline-none font-mono"
        style={{ borderColor: doiError ? '#f87171' : 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
      />
      <button
        disabled={doiLoading || !doiInput.trim()}
        onClick={handleAddDoi}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40"
        style={{ background: 'var(--accent-blue)', color: '#fff' }}
      >
        {doiLoading ? <Sparkles size={11} className="animate-spin" /> : <Plus size={11} />}
        {doiLoading ? '' : 'Add'}
      </button>
    </div>
    {doiError && (
      <p className="text-[10px] px-1" style={{ color: '#ef4444' }}>{doiError}</p>
    )}
  </div>
</div>
```

- [ ] **Step 4: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: add DOI lookup input in Sources tab"
```

---

## Task 5: DOI detection in @ citation picker

**Files:**
- Modify: `src/components/Editor.tsx`

- [ ] **Step 1: Import helpers and source store**

In `Editor.tsx`, add to existing imports:

```ts
import { fetchCrossrefDoi, looksLikeDoi } from '../services/citations';
import { useSourceStore } from '../stores/useSourceStore';
```

- [ ] **Step 2: Add source store and DOI state inside the Editor component**

Inside the `Editor` component function body, after the existing state declarations (around line 181), add:

```ts
const { sources: allSources, addSources } = useSourceStore();
const [doiPickerState, setDoiPickerState] = useState<'idle' | 'loading' | 'error'>('idle');
const [doiPickerError, setDoiPickerError] = useState<string | null>(null);
```

- [ ] **Step 3: Add handleInsertDoi function**

After `handleInsertCitation` function (around line 483), add:

```ts
const handleInsertDoi = useCallback(async (doi: string) => {
  setDoiPickerState('loading');
  setDoiPickerError(null);
  try {
    // Check if DOI already in store
    let source = allSources.find(s => s.apiMeta?.doi?.toLowerCase() === doi.toLowerCase());
    if (!source) {
      source = await fetchCrossrefDoi(doi);
      addSources([source]);
    }
    // Insert citation using existing handleInsertCitation logic
    handleInsertCitation(source);
  } catch (err) {
    setDoiPickerState('error');
    setDoiPickerError(err instanceof Error ? err.message : 'DOI lookup failed.');
  } finally {
    setDoiPickerState('idle');
  }
}, [allSources, addSources, handleInsertCitation]);
```

- [ ] **Step 4: Add DOI detection UI to the citation picker**

In the citation picker JSX (inside the portal, find the `filteredCitationSources.length === 0` branch around line 1342). Replace the entire picker content (the conditional block inside the portal `<div>`) with:

```tsx
<div className="px-3 py-2 border-b flex items-center gap-1.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
  <BookOpen size={10} style={{ color: 'var(--accent-blue)' }} />
  <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Insert Citation</p>
</div>

{/* DOI detection row */}
{looksLikeDoi(citationFilter) && (
  <div className="border-b" style={{ borderColor: 'var(--border)' }}>
    {doiPickerState === 'error' ? (
      <div className="px-3 py-2">
        <p className="text-[11px]" style={{ color: '#ef4444' }}>{doiPickerError}</p>
        <button
          className="text-[10px] mt-1 underline"
          style={{ color: 'var(--text-muted)' }}
          onMouseDown={e => { e.preventDefault(); setDoiPickerError(null); setDoiPickerState('idle'); }}
        >
          Dismiss
        </button>
      </div>
    ) : (
      <button
        className="w-full text-left px-3 py-2 transition-colors flex items-center gap-2"
        style={{ background: 'rgba(59,111,212,0.06)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(59,111,212,0.12)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(59,111,212,0.06)')}
        onMouseDown={e => { e.preventDefault(); handleInsertDoi(citationFilter); }}
        disabled={doiPickerState === 'loading'}
      >
        {doiPickerState === 'loading' ? (
          <Sparkles size={12} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
        ) : (
          <ArrowRight size={12} className="shrink-0" style={{ color: 'var(--accent-blue)' }} />
        )}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {doiPickerState === 'loading' ? 'Looking up DOI…' : 'Look up DOI via Crossref'}
          </p>
          <p className="text-[10px] truncate font-mono" style={{ color: 'var(--text-muted)' }}>{citationFilter}</p>
        </div>
      </button>
    )}
  </div>
)}

{filteredCitationSources.length === 0 && !looksLikeDoi(citationFilter) ? (
  <p className="px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>No sources — upload PDFs, search, or type a DOI like 10.1234/xxx.</p>
) : (
  <div className="max-h-64 overflow-y-auto">
    {filteredCitationSources.map(src => {
      const num = citationRegistry?.[src.id];
      const label = src.type === 'api'
        ? (src.apiMeta?.authors?.split(/[,;]/)[0]?.trim() ?? src.name) + (src.apiMeta?.year ? `, ${src.apiMeta.year}` : '')
        : src.name.replace(/\.pdf$/i, '');
      return (
        <button
          key={src.id}
          className="w-full text-left px-3 py-2 border-b last:border-0 transition-colors"
          style={{ borderColor: 'var(--border)', background: 'transparent' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onMouseDown={e => { e.preventDefault(); handleInsertCitation(src); }}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold tabular-nums shrink-0 w-5 h-5 flex items-center justify-center rounded-md" style={{ background: 'var(--accent-blue)', color: '#fff' }}>
              {num ?? '?'}
            </span>
            <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{label}</span>
          </div>
          {src.type === 'api' && src.apiMeta?.title && (
            <p className="text-[10px] truncate pl-7 mt-0.5" style={{ color: 'var(--text-muted)' }}>{src.apiMeta.title}</p>
          )}
        </button>
      );
    })}
  </div>
)}
<div className="px-3 py-1.5 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
  <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Press Esc to close · Type a DOI (10.xxxx/…) to look up</p>
</div>
```

Also reset `doiPickerState` when the citation picker closes. Find where `setCitationPicker(null)` is called (inside `handleInsertCitation` and the Escape key handler). After each call, add:

```ts
setDoiPickerState('idle');
setDoiPickerError(null);
```

- [ ] **Step 5: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "feat: DOI detection in @ citation picker — auto-lookup via Crossref"
```

---

## Task 6: FigureLabel TipTap extension

**Files:**
- Create: `src/extensions/FigureLabel.tsx`

- [ ] **Step 1: Create the file**

```tsx
// src/extensions/FigureLabel.tsx
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';

function FigureLabelView({ node }: { node: any }) {
  const num: number = node.attrs.num ?? 1;
  const figureId: string = node.attrs.figureId ?? '';
  return (
    <NodeViewWrapper
      as="span"
      data-figure-label=""
      data-figure-id={figureId}
      data-figure-num={String(num)}
      className="figure-label"
      contentEditable={false}
    >
      Figure {num}
    </NodeViewWrapper>
  );
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figureLabel: {
      insertFigureLabel: (figureId: string, num: number) => ReturnType;
      updateAllFigureNums: (registry: Record<string, number>) => ReturnType;
    };
  }
}

export const FigureLabel = Node.create({
  name: 'figureLabel',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      figureId: {
        default: '',
        parseHTML: (el: Element) => el.getAttribute('data-figure-id') ?? '',
        renderHTML: (attrs) => ({ 'data-figure-id': attrs.figureId as string }),
      },
      num: {
        default: 1,
        parseHTML: (el: Element) => {
          const v = el.getAttribute('data-figure-num');
          const n = parseInt(v ?? '1');
          return isNaN(n) ? 1 : n;
        },
        renderHTML: (attrs) => ({ 'data-figure-num': String(attrs.num) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-figure-label]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const num: number = node.attrs.num ?? 1;
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-figure-label': '' }),
      `Figure ${num}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureLabelView);
  },

  addCommands() {
    return {
      insertFigureLabel:
        (figureId: string, num: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { figureId, num },
          });
        },

      updateAllFigureNums:
        (registry: Record<string, number>) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.doc.descendants((node, pos) => {
              if (node.type.name !== 'figureLabel') return;
              const figureId: string = node.attrs.figureId ?? '';
              const newNum = registry[figureId];
              if (newNum !== undefined && newNum !== node.attrs.num) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, num: newNum });
              }
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/FigureLabel.tsx
git commit -m "feat: add FigureLabel TipTap extension for auto-numbered figures"
```

---

## Task 7: figureRegistry in types, store, and DB

**Files:**
- Modify: `src/types.ts`
- Modify: `src/stores/useDocumentStore.ts`

- [ ] **Step 1: Extend DocumentRow in types.ts**

In `src/types.ts`, find the `DocumentRow` interface:

```ts
export interface DocumentRow {
  id: 'current';
  title: string;
  content: string;
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;
  updatedAt: number;
}
```

Replace with:

```ts
export interface DocumentRow {
  id: 'current';
  title: string;
  content: string;
  saveState: 'Draft' | 'Saved' | 'Auto-saved';
  citationRegistry: Record<string, number>;
  citationCounter: number;
  figureRegistry: Record<string, number>;
  figureCounter: number;
  updatedAt: number;
}
```

- [ ] **Step 2: Add figure state and methods to useDocumentStore.ts**

In `src/stores/useDocumentStore.ts`, find the `interface DocumentState` block and add after `citationCounter`:

```ts
figureRegistry: Record<string, number>;
figureCounter: number;

/**
 * Register a new figure. Returns existing number if already registered,
 * or assigns the next counter value.
 */
insertFigure: (figureId: string) => number;

/**
 * Assign sequential numbers to figures in the given order (from AST traversal).
 * Returns the new registry. Caller applies changes to the editor.
 */
renumberFigures: (orderedFigureIds: string[]) => Record<string, number>;

/**
 * Remove a figure from the registry and renumber remaining.
 */
removeFigure: (figureId: string, orderedFigureIds: string[]) => Record<string, number>;
```

In the `create<DocumentState>` call, add initial state after `citationCounter: 0,`:

```ts
figureRegistry: {},
figureCounter: 0,
```

Add the method implementations after the `renumberCitations` method:

```ts
insertFigure: (figureId) => {
  const { figureRegistry, figureCounter } = get();
  if (figureRegistry[figureId]) return figureRegistry[figureId];
  const num = figureCounter + 1;
  set({ figureRegistry: { ...figureRegistry, [figureId]: num }, figureCounter: num });
  return num;
},

renumberFigures: (orderedFigureIds) => {
  if (orderedFigureIds.length === 0) {
    set({ figureRegistry: {}, figureCounter: 0 });
    return {};
  }
  const newRegistry: Record<string, number> = {};
  orderedFigureIds.forEach((id, i) => { newRegistry[id] = i + 1; });
  set({ figureRegistry: newRegistry, figureCounter: orderedFigureIds.length });
  return newRegistry;
},

removeFigure: (figureId, orderedFigureIds) => {
  const filtered = orderedFigureIds.filter(id => id !== figureId);
  const newRegistry: Record<string, number> = {};
  filtered.forEach((id, i) => { newRegistry[id] = i + 1; });
  set({ figureRegistry: newRegistry, figureCounter: filtered.length });
  return newRegistry;
},
```

Update `resetDocument` to include figure fields:

```ts
resetDocument: () => set({
  title: 'Untitled Manuscript',
  content: DEFAULT_CONTENT,
  saveState: 'Draft',
  citationRegistry: {},
  citationCounter: 0,
  figureRegistry: {},
  figureCounter: 0,
}),
```

Update `initialize` to load figure fields (add after the `citationCounter` line inside the Dexie branch):

```ts
figureRegistry: row.figureRegistry ?? {},
figureCounter: row.figureCounter ?? 0,
```

Update `persist` to include figure fields in the `DocumentRow`:

```ts
persist: async () => {
  const { title, content, saveState, citationRegistry, citationCounter, figureRegistry, figureCounter } = get();
  const row: DocumentRow = {
    id: 'current',
    title,
    content,
    saveState,
    citationRegistry,
    citationCounter,
    figureRegistry,
    figureCounter,
    updatedAt: Date.now(),
  };
  await db.documents.put(row);
},
```

- [ ] **Step 3: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/stores/useDocumentStore.ts
git commit -m "feat: add figureRegistry and figureCounter to document store"
```

---

## Task 8: Wire FigureLabel into Editor

**Files:**
- Modify: `src/components/Editor.tsx`

- [ ] **Step 1: Import FigureLabel and Hash icon**

In the imports at the top of `Editor.tsx`, add:

```ts
import { FigureLabel } from '../extensions/FigureLabel';
```

The `Hash` icon is already imported from `lucide-react` — if not, add it to the lucide imports.

- [ ] **Step 2: Register FigureLabel in useEditor extensions**

In the `useEditor({ extensions: [...] })` call, add `FigureLabel` after `CitationNode`:

```ts
CitationNode,
FigureLabel,
```

- [ ] **Step 3: Extend EditorRef interface**

In the `EditorRef` interface (around line 50), add:

```ts
getFigureOrder: () => string[];
updateFigures: (registry: Record<string, number>) => void;
insertFigureLabelNode: (figureId: string, num: number) => void;
```

- [ ] **Step 4: Implement the new EditorRef methods**

Inside `useImperativeHandle(ref, () => ({...}))`, add after `updateCitations`:

```ts
getFigureOrder: () => {
  if (!editor) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'figureLabel') return true;
    const figureId: string = node.attrs.figureId ?? '';
    if (figureId && !seen.has(figureId)) { seen.add(figureId); order.push(figureId); }
    return true;
  });
  return order;
},

updateFigures: (registry: Record<string, number>) => {
  if (!editor) return;
  editor.commands.updateAllFigureNums(registry);
},

insertFigureLabelNode: (figureId: string, num: number) => {
  if (!editor) return;
  editor.chain().focus().insertFigureLabel(figureId, num).run();
},
```

- [ ] **Step 5: Add onInsertFigure prop**

In the `EditorProps` interface (around line 28), add:

```ts
onInsertFigure?: () => void;
```

And in the component signature destructuring:

```ts
const Editor = forwardRef<EditorRef, EditorProps>(({
  ..., onInsertFigure,
}, ref) => {
```

- [ ] **Step 6: Add "Fig #" toolbar button**

In the toolbar, after the image insert button group (around line 854), add:

```tsx
<div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border)' }} />
<ToolbarButton
  onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); if (onInsertFigure) onInsertFigure(); }}
  title="Insert figure label (auto-numbered)"
>
  <Hash size={14} />
</ToolbarButton>
```

- [ ] **Step 7: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "feat: register FigureLabel extension in editor, add toolbar button and EditorRef methods"
```

---

## Task 9: Wire figure insertion in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Pull figure methods from the store**

In `App.tsx`, find the `useDocumentStore` destructure (around line 33). Add:

```ts
insertFigure: storeInsertFigure,
renumberFigures: storeRenumberFigures,
```

- [ ] **Step 2: Add handleInsertFigure callback**

After the `handleInsertCitation` callback in `App.tsx` (search for `const handleInsertCitation`), add:

```ts
const handleInsertFigure = useCallback(() => {
  const figureId = crypto.randomUUID();
  const num = storeInsertFigure(figureId);
  editorRef.current?.insertFigureLabelNode(figureId, num);
  // Renumber all figures to ensure sequential order after insertion
  setTimeout(() => {
    const orderedIds = editorRef.current?.getFigureOrder() ?? [];
    const newRegistry = storeRenumberFigures(orderedIds);
    editorRef.current?.updateFigures(newRegistry);
    const newHtml = editorRef.current?.getHTML() ?? '';
    setContent(newHtml);
    lastExternalContent.current = newHtml;
  }, 50);
}, [storeInsertFigure, storeRenumberFigures, setContent]);
```

Note: `lastExternalContent` is a ref inside Editor, not App. Remove the `lastExternalContent.current` line from App. The `setContent` call will propagate via props and `Editor` will see it as an external update (handled by the existing `useEffect` content sync).

Corrected version:

```ts
const handleInsertFigure = useCallback(() => {
  const figureId = crypto.randomUUID();
  const num = storeInsertFigure(figureId);
  editorRef.current?.insertFigureLabelNode(figureId, num);
  setTimeout(() => {
    const orderedIds = editorRef.current?.getFigureOrder() ?? [];
    const newRegistry = storeRenumberFigures(orderedIds);
    editorRef.current?.updateFigures(newRegistry);
    const newHtml = editorRef.current?.getHTML() ?? '';
    setContent(newHtml);
  }, 50);
}, [storeInsertFigure, storeRenumberFigures, setContent]);
```

- [ ] **Step 3: Pass onInsertFigure to Editor**

In the `<Editor ... />` JSX in `App.tsx`, add:

```tsx
onInsertFigure={handleInsertFigure}
```

- [ ] **Step 4: Add figure renumber on document load**

In the `useEffect` that calls `initDocument()` (around line 137), after the citation migration block, add figure renumbering:

```ts
// Renumber figures on load to recover from any out-of-order state
setTimeout(() => {
  const orderedFigureIds = editorRef.current?.getFigureOrder() ?? [];
  if (orderedFigureIds.length > 0) {
    const newRegistry = useDocumentStore.getState().renumberFigures(orderedFigureIds);
    editorRef.current?.updateFigures(newRegistry);
  }
}, 200);
```

- [ ] **Step 5: Add CSS for figure-label styling**

In `src/main.tsx` or the global CSS file, add a style for `.figure-label` so it renders visually distinct (like `.citation-badge`). Find where citation-badge is styled (search in the CSS/index.css):

```bash
grep -rn "citation-badge" /home/dzyla/manuscript-ai-editor/src/ /home/dzyla/manuscript-ai-editor/index.html 2>/dev/null | head -5
```

Then add analogous styling for `.figure-label`. If `citation-badge` is styled inline or via Tailwind, add to the same location:

```css
.figure-label {
  display: inline-block;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.85em;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.12);
  color: #065f46;
  border: 1px solid rgba(16, 185, 129, 0.25);
  cursor: default;
  user-select: none;
  white-space: nowrap;
}
```

- [ ] **Step 6: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire figure insertion, renumbering, and load-time recovery in App"
```

---

## Final Verification

- [ ] **Run dev server and manually test all 5 features**

```bash
npm run dev
```

Test checklist:
1. Select text from review panel click → BubbleMenu appears **above** selected text, not overlapping
2. Select 1 word → Synonyms button appears; click it → synonyms load
3. Select 2 words (e.g. "cell death") → Synonyms button appears
4. Select 3–4 words → neither Synonyms nor Find Similar appears
5. Select 6+ words → Find Similar button appears; click → search opens
6. Sources tab → Add by DOI section visible → paste `10.1038/nature12373` → click Add → source appears
7. Editor → type `@10.1038/nature12373` → citation picker shows "Look up DOI via Crossref" row → click → citation inserted
8. Editor → click "Fig #" toolbar button → `Figure 1` inline node inserted → insert another → `Figure 2` appears → move first one after second → renumber → labels update

- [ ] **Final type-check**

```bash
npm run lint
```

Expected: no errors.
