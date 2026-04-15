# Tier 1 Quality Fixes — Design Spec
_Date: 2026-04-14_

## Scope

Four targeted fixes to the most fragile parts of the editor:

1. Token estimation — replace heuristic with real tokenizer
2. PDF parsing — move off main thread via native Vite Web Worker
3. Citation system — eliminate HTML regex round-trips, use ProseMirror AST exclusively
4. Image context — auto-derive context from AST when no text is selected

---

## Wave 1 — Isolated, non-overlapping changes

### 1. Token Estimation (`src/services/ai.ts`)

**Problem:** `Math.ceil(text.length / 4)` is inaccurate for academic text with math,
numbers, or non-ASCII characters. Can silently exceed context windows.

**Fix:**
- Install `gpt-tokenizer` (pure JS, cl100k, ~50 KB).
- Replace the single `estimateTokens` function body with `encode(text).length`
  from `gpt-tokenizer/model/gpt-4o`.
- No other changes to `ai.ts`.

**Files changed:** `src/services/ai.ts`, `package.json`

---

### 2. PDF Web Worker (`src/workers/pdfWorker.ts`, `src/components/Sidebar.tsx`)

**Problem:** `pdfWorker.ts` is a stub. All PDF parsing runs on the main thread in
`Sidebar.tsx`, freezing the UI on large PDFs. The original worker was abandoned
because pdfjsLib's `WorkerMessageHandler` conflicts with Comlink when imported
inside a worker.

**Fix — Worker file:**
- Replace stub with a real `pdfWorker.ts` that imports `pdfjs-dist` directly.
- Set `GlobalWorkerOptions.workerSrc = ''` inside the worker to disable pdfjsLib's
  own sub-worker (this resolves the `WorkerMessageHandler` conflict without Comlink).
- Implement `extractText(arrayBuffer: ArrayBuffer): Promise<string>` that iterates
  pages and concatenates text content.
- Listen for `message` events with a simple `{ type: 'extract', payload: ArrayBuffer }`
  envelope; respond with `{ type: 'result', text }` or `{ type: 'error', message }`.

**Fix — Sidebar.tsx:**
- Remove the inline `pdfjsLib.getDocument()` main-thread extraction code.
- On PDF upload, create the worker via Vite native syntax:
  ```ts
  new Worker(new URL('../workers/pdfWorker.ts', import.meta.url), { type: 'module' })
  ```
- Send the file's `ArrayBuffer` via `postMessage`, listen for the response,
  terminate the worker on completion or error.
- No Comlink dependency.

**Files changed:** `src/workers/pdfWorker.ts`, `src/components/Sidebar.tsx`

---

## Wave 2 — Coordinated changes (both touch `Editor.tsx`)

### 3. Citation System Refactor

**Problem:** `renumberCitations` and `removeCitation` in `useDocumentStore.ts`
accept raw HTML, run a global regex (`/\[([\d,\-]+)\]/g`), and return new HTML
for the caller to inject via `setContent`. This:
- Destroys undo/redo history on every citation change
- Mangles legitimate `[1]` bracket text in the document
- Bypasses the already-correct `updateAllCitationNums` ProseMirror command in
  `CitationNode.tsx`

**Fix — `useDocumentStore.ts`:**
- `renumberCitations(orderedSourceIds: string[]): Record<string, number>`
  Accepts citation order from the editor AST. Assigns sequential numbers.
  Updates store. Returns `newRegistry`. No HTML, no regex.
- `removeCitation(sourceId: string, orderedSourceIds: string[]): Record<string, number>`
  Removes the source, renumbers remaining in passed order. Returns `newRegistry`.
  No HTML.
- `insertCitation` unchanged.

**Fix — `Editor.tsx` (EditorRef additions):**
- `getCitationOrder(): string[]`
  Traverses `editor.state.doc` via `descendants`, collects `sourceIds` arrays
  from every `citation` node in document order. Flattens and deduplicates,
  preserving first-seen order.
- `updateCitations(registry: Record<string, number>): void`
  Calls `editor.commands.updateAllCitationNums(registry)` — the existing
  ProseMirror command that dispatches a single transaction, preserving undo history.

**Fix — `App.tsx` + `Sidebar.tsx`:**
Replace every citation mutation call site with the new three-step pattern:
```ts
const orderedIds = editorRef.current.getCitationOrder();
const newRegistry = store.renumberCitations(orderedIds);  // or removeCitation
editorRef.current.updateCitations(newRegistry);
```
No more `editor.getHTML()` → regex → `editor.setContent()` in any citation path.

**Files changed:** `src/stores/useDocumentStore.ts`, `src/components/Editor.tsx`,
`src/App.tsx`, `src/components/Sidebar.tsx`

---

### 4. Image Context — AST Traversal (`src/components/Editor.tsx`)

**Problem:** `getImageContext()` returns `''` when `from === to` (image clicked,
no text selected), giving the VLM zero context.

**Fix:**
When `from === to`, run the following AST traversal instead of returning early:

1. **Caption-aware pass (try first):** Walk `editor.state.doc.descendants` from
   the image node's position outward. Find the nearest paragraph whose text content
   starts with "figure" (case-insensitive). Return that paragraph's full text.

2. **Surrounding-paragraph fallback:** If no caption found, locate the image node's
   position in the document. Collect the nearest preceding paragraph node and nearest
   following paragraph node. Return their text content joined with `\n`.

3. **Empty fallback:** If neither yields text, return `''`.

The existing selection-based path (`from !== to`) is unchanged.

**Files changed:** `src/components/Editor.tsx`

---

## Non-Goals

- No changes to citation BibTeX export, Zotero integration, or reference panel UI.
- No changes to AI model routing, prompt logic, or other AI features.
- No component splitting (deferred to a later tier).
- No API key security hardening (deferred to later tier).
- No new features (Crossref, figure numbering, collab, track changes).
