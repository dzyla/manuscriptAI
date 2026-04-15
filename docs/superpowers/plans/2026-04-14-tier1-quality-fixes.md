# Tier 1 Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four quality/correctness issues: accurate token estimation, off-main-thread PDF parsing, citation mutations via ProseMirror AST instead of HTML regex, and auto-derived image context.

**Architecture:** Wave 1 (Tasks 1–2) makes isolated, non-overlapping changes. Wave 2 (Tasks 3–5) makes coordinated changes that all touch `Editor.tsx` and are done in the same pass to avoid conflicts.

**Tech Stack:** TypeScript, React 19, TipTap 3 / ProseMirror, Zustand 5, Vite 6, `gpt-tokenizer`, `pdfjs-dist`

---

## File Map

| File | Change |
|---|---|
| `package.json` | Add `gpt-tokenizer` |
| `src/services/ai.ts` | Swap `estimateTokens` body |
| `src/workers/pdfWorker.ts` | Full rewrite — real implementation |
| `src/components/Sidebar.tsx` | Remove main-thread PDF extraction; wire new worker |
| `src/stores/useDocumentStore.ts` | Change `renumberCitations` + `removeCitation` signatures |
| `src/components/Editor.tsx` | Add `getCitationOrder` + `updateCitations` to `EditorRef`; fix `getImageContext` |
| `src/App.tsx` | Update `renumberCitations` + `removeCitation` callbacks |

---

## Wave 1 — Isolated Fixes

---

### Task 1: Swap token estimator to `gpt-tokenizer`

**Files:**
- Modify: `package.json`
- Modify: `src/services/ai.ts:570-572`

- [ ] **Step 1: Install `gpt-tokenizer`**

```bash
cd /home/dzyla/manuscript-ai-editor
npm install gpt-tokenizer
```

Expected output: `added 1 package` (or similar), no errors.

- [ ] **Step 2: Replace `estimateTokens` in `src/services/ai.ts`**

Find (lines 570-572):
```ts
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Replace with:
```ts
import { encode } from 'gpt-tokenizer';

export function estimateTokens(text: string): number {
  return encode(text).length;
}
```

Add the import at the top of the file alongside the other imports. The function signature is unchanged — all callers work as-is.

- [ ] **Step 3: Type-check**

```bash
cd /home/dzyla/manuscript-ai-editor
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/services/ai.ts
git commit -m "fix: replace token heuristic with gpt-tokenizer cl100k"
```

---

### Task 2: Rewrite PDF worker with real implementation

**Files:**
- Rewrite: `src/workers/pdfWorker.ts`

- [ ] **Step 1: Replace the stub with a real worker**

Overwrite `src/workers/pdfWorker.ts` entirely:

```ts
import * as pdfjsLib from 'pdfjs-dist';

// Disable pdfjsLib's own sub-worker. When pdfjs runs inside a Worker,
// its internal WorkerMessageHandler conflicts with any message-passing
// framework. Setting workerSrc to '' tells pdfjs to run synchronously
// in the current context instead of spawning another worker.
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/^[ \t]*(\d{1,4}|[Pp]age\s+\d+(\s+of\s+\d+)?)[ \t]*$/gm, '')
    .replace(/^.*[Dd]ownloaded\s+from\s+.*$/gm, '')
    .replace(/^.*©\s*\d{4}.*$/gm, '')
    .replace(/^.*[Aa]ll\s+rights\s+reserved.*$/gm, '')
    .trim();
}

type ExtractRequest = { type: 'extract'; payload: ArrayBuffer };
type ResultMessage = { type: 'result'; text: string };
type ErrorMessage = { type: 'error'; message: string };

self.onmessage = async (e: MessageEvent<ExtractRequest>) => {
  if (e.data.type !== 'extract') return;
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(e.data.payload) }).promise;
    let raw = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      raw += content.items.map((item: any) => item.str).join(' ') + '\n\n';
    }
    const msg: ResultMessage = { type: 'result', text: cleanPdfText(raw) };
    (self as any).postMessage(msg);
  } catch (err: any) {
    const msg: ErrorMessage = { type: 'error', message: err?.message ?? String(err) };
    (self as any).postMessage(msg);
  }
};
```

- [ ] **Step 2: Type-check**

```bash
cd /home/dzyla/manuscript-ai-editor
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/workers/pdfWorker.ts
git commit -m "fix: reinstate PDF worker using Vite native Worker + workerSrc=''"
```

---

### Task 3: Wire PDF worker in Sidebar.tsx

**Files:**
- Modify: `src/components/Sidebar.tsx`

The current code imports `pdfjsLib` and `pdfWorkerUrl` at the top of the file and has an inline `extractTextFromPDF` async function (lines ~242-257). We remove all of that and replace with a worker-based call.

- [ ] **Step 1: Remove pdfjs imports from the top of `Sidebar.tsx`**

Find and remove these three lines near the top of `src/components/Sidebar.tsx`:

```ts
// Use Vite's ?url import to resolve the pdfjs worker path at build time.
// This is more reliable than new URL(..., import.meta.url) under Vite's
// dev server and build pipeline.
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
```

Also remove the `getPdfjsLib` helper function (lines ~18-21):

```ts
function getPdfjsLib() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjsLib;
}
```

- [ ] **Step 2: Replace `extractTextFromPDF` with a worker-based version**

Find the existing `extractTextFromPDF` function in `Sidebar.tsx`:

```ts
const extractTextFromPDF = async (file: File): Promise<string> => {
  const lib = getPdfjsLib();
  const data = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: new Uint8Array(data) }).promise;
  let raw = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Join items with space; preserve line breaks between items that end without one
    const pageText = content.items
      .map((item: any) => item.str)
      .join(' ');
    raw += pageText + '\n\n';
  }
  return cleanPdfText(raw);
};
```

Replace it with:

```ts
type PdfWorkerResult = { type: 'result'; text: string } | { type: 'error'; message: string };

const extractTextFromPDF = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    file.arrayBuffer().then(data => {
      const worker = new Worker(
        new URL('../workers/pdfWorker.ts', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (e: MessageEvent<PdfWorkerResult>) => {
        worker.terminate();
        if (e.data.type === 'result') resolve(e.data.text);
        else reject(new Error(e.data.message));
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message));
      };
      // Transfer the ArrayBuffer to the worker (zero-copy)
      worker.postMessage({ type: 'extract', payload: data }, [data]);
    }).catch(reject);
  });
};
```

Note: `cleanPdfText` is no longer called here — it now runs inside the worker. Keep the `cleanPdfText` function in `Sidebar.tsx` only if it is used elsewhere in that file; otherwise delete it too.

- [ ] **Step 3: Check if `cleanPdfText` is used elsewhere in Sidebar.tsx**

```bash
grep -n "cleanPdfText" /home/dzyla/manuscript-ai-editor/src/components/Sidebar.tsx
```

If the only match is the old `extractTextFromPDF` call, delete the `cleanPdfText` function from `Sidebar.tsx` as well.

- [ ] **Step 4: Type-check**

```bash
cd /home/dzyla/manuscript-ai-editor
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Manual smoke test — upload a PDF**

```bash
npm run dev
```

Open the app, drag a PDF into the sidebar, confirm the source card appears with extracted text. The UI should not freeze during extraction. Check the browser console for errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "fix: move PDF extraction off main thread via Vite native Worker"
```

---

## Wave 2 — Coordinated Changes

---

### Task 4: Refactor citation store — remove HTML dependency

**Files:**
- Modify: `src/stores/useDocumentStore.ts`

The `DocumentState` interface and implementations for `renumberCitations` and `removeCitation` change signatures. No callers are updated yet (that's Task 6) — this will temporarily cause TypeScript errors in App.tsx, which is fine until Task 6.

- [ ] **Step 1: Update the `DocumentState` interface**

Find (lines ~28-34 in `useDocumentStore.ts`):

```ts
  removeCitation: (sourceId: string, currentHtml: string) => { newHtml: string; newRegistry: Record<string, number> };
```
and
```ts
  renumberCitations: (currentHtml: string) => { newHtml: string; newRegistry: Record<string, number> };
```

Replace with:

```ts
  removeCitation: (sourceId: string, orderedSourceIds: string[]) => Record<string, number>;
```
and
```ts
  renumberCitations: (orderedSourceIds: string[]) => Record<string, number>;
```

- [ ] **Step 2: Replace the `removeCitation` implementation**

Find the existing `removeCitation` implementation (starts around line 68):

```ts
  removeCitation: (sourceId, currentHtml) => {
    const { citationRegistry } = get();
    const removed = citationRegistry[sourceId];
    if (!removed) return { newHtml: currentHtml, newRegistry: citationRegistry };
    // ... (the entire old body, about 25 lines)
  },
```

Replace the entire implementation with:

```ts
  removeCitation: (sourceId, orderedSourceIds) => {
    const filtered = orderedSourceIds.filter(id => id !== sourceId);
    const newRegistry: Record<string, number> = {};
    filtered.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ citationRegistry: newRegistry, citationCounter: filtered.length });
    return newRegistry;
  },
```

- [ ] **Step 3: Replace the `renumberCitations` implementation**

Find the existing `renumberCitations` implementation (starts around line 102):

```ts
  renumberCitations: (currentHtml) => {
    const { citationRegistry } = get();
    if (Object.keys(citationRegistry).length === 0) {
      return { newHtml: currentHtml, newRegistry: citationRegistry };
    }
    // ... (the entire old body, about 30 lines)
  },
```

Replace the entire implementation with:

```ts
  renumberCitations: (orderedSourceIds) => {
    if (orderedSourceIds.length === 0) {
      return {};
    }
    const newRegistry: Record<string, number> = {};
    orderedSourceIds.forEach((id, i) => { newRegistry[id] = i + 1; });
    set({ citationRegistry: newRegistry, citationCounter: orderedSourceIds.length });
    return newRegistry;
  },
```

- [ ] **Step 4: Remove now-unused imports from `useDocumentStore.ts`**

The old implementation imported `expandCitationNums`, `formatCitationGroup`, and `mergeAdjacentCitations` from `../services/citations`. Check which are still used:

```bash
grep -n "expandCitationNums\|formatCitationGroup\|mergeAdjacentCitations" /home/dzyla/manuscript-ai-editor/src/stores/useDocumentStore.ts
```

The `insertCitation` function itself doesn't use any of these. If none appear in the remaining code, remove the `import` line at the top of the file that pulls them in.

- [ ] **Step 5: Commit (even with expected App.tsx TS errors — commit the store alone)**

```bash
git add src/stores/useDocumentStore.ts
git commit -m "refactor: citation store — pure registry math, no HTML strings"
```

---

### Task 5: Add `getCitationOrder` + `updateCitations` to EditorRef; fix `getImageContext`

**Files:**
- Modify: `src/components/Editor.tsx`

All three changes land in one file in one commit.

- [ ] **Step 1: Add new methods to the `EditorRef` interface**

Find (lines ~49-60):

```ts
export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  setContent: (html: string) => void;
  getSelectedText: () => string;
  getCurrentSection: () => string | null;
  getCurrentSectionText: () => string | null;
  scrollToHeading: (headingText: string) => void;
  scrollToCitation: (num: number) => void;
}
```

Replace with:

```ts
export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  setContent: (html: string) => void;
  getSelectedText: () => string;
  getCurrentSection: () => string | null;
  getCurrentSectionText: () => string | null;
  scrollToHeading: (headingText: string) => void;
  scrollToCitation: (num: number) => void;
  getCitationOrder: () => string[];
  updateCitations: (registry: Record<string, number>) => void;
}
```

- [ ] **Step 2: Implement `getCitationOrder` and `updateCitations` in `useImperativeHandle`**

Find the `useImperativeHandle` block that contains `getHTML` and `setContent` (around line 625). It ends with the closing of the ref object. Add the two new methods just before the closing `}`:

```ts
    getCitationOrder: () => {
      if (!editor) return [];
      const seen = new Set<string>();
      const order: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name !== 'citation') return true;
        const sourceIds: string[] = node.attrs.sourceIds ?? [];
        for (const id of sourceIds) {
          if (!seen.has(id)) { seen.add(id); order.push(id); }
        }
        return true;
      });
      return order;
    },
    updateCitations: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllCitationNums(registry);
    },
```

- [ ] **Step 3: Replace `getImageContext` with AST-aware version**

Find the existing `getImageContext` function (lines ~379-391):

```ts
  const getImageContext = (): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    // Only provide context for a real multi-node selection (not a plain NodeSelection)
    if (from === to) return '';
    const parts: string[] = [];
    editor.state.doc.nodesBetween(from, to, node => {
      if (node.type.name === 'resizableImage') return false;
      if (node.isText && node.text) parts.push(node.text);
      return true;
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
```

Replace with:

```ts
  const getImageContext = (): string => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;

    // If the user has explicitly selected text spanning the image, use that.
    if (from !== to) {
      const parts: string[] = [];
      editor.state.doc.nodesBetween(from, to, node => {
        if (node.type.name === 'resizableImage') return false;
        if (node.isText && node.text) parts.push(node.text);
        return true;
      });
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    // Image is clicked but nothing selected — derive context from AST.
    const doc = editor.state.doc;

    // Find the image node position.
    let imagePos: number | null = null;
    doc.descendants((node, pos) => {
      if (imagePos !== null) return false;
      if (node.type.name === 'resizableImage') { imagePos = pos; return false; }
      return true;
    });
    if (imagePos === null) return '';

    // Pass 1 (caption-aware): find nearest paragraph whose text starts with "figure".
    let bestCaption = '';
    let bestDist = Infinity;
    doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true;
      const text = node.textContent.trim();
      if (/^figure/i.test(text)) {
        const dist = Math.abs(pos - imagePos!);
        if (dist < bestDist) { bestDist = dist; bestCaption = text; }
      }
      return true;
    });
    if (bestCaption) return bestCaption;

    // Pass 2 (surrounding paragraphs): nearest preceding + following paragraph.
    let preceding = '';
    let following = '';
    doc.descendants((node, pos) => {
      if (node.type.name !== 'paragraph') return true;
      const text = node.textContent.trim();
      if (!text) return true;
      const nodeEnd = pos + node.nodeSize;
      if (nodeEnd <= imagePos!) {
        preceding = text; // keep overwriting — last one before image wins
      } else if (pos >= imagePos! && !following) {
        following = text; // first one after image
      }
      return true;
    });
    return [preceding, following].filter(Boolean).join('\n').trim();
  };
```

- [ ] **Step 4: Type-check**

```bash
cd /home/dzyla/manuscript-ai-editor
npx tsc --noEmit
```

Expected: errors only in `App.tsx` (old call sites for `renumberCitations`/`removeCitation` — fixed in Task 6). No new errors in `Editor.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/Editor.tsx
git commit -m "feat: add getCitationOrder/updateCitations to EditorRef; fix getImageContext AST traversal"
```

---

### Task 6: Update App.tsx citation call sites

**Files:**
- Modify: `src/App.tsx`

This resolves the TypeScript errors introduced in Task 4 and completes the citation refactor.

- [ ] **Step 1: Update `renumberCitations` callback**

Find (lines ~447-455):

```ts
  const renumberCitations = useCallback(() => {
    const html = editorRef.current?.getHTML();
    if (!html) return;
    const { newHtml } = storeRenumberCitations(html);
    if (newHtml !== html) {
      editorRef.current?.setContent(newHtml);
      setContent(newHtml);
    }
  }, [storeRenumberCitations, setContent]);
```

Replace with:

```ts
  const renumberCitations = useCallback(() => {
    if (!editorRef.current) return;
    const orderedIds = editorRef.current.getCitationOrder();
    const newRegistry = storeRenumberCitations(orderedIds);
    editorRef.current.updateCitations(newRegistry);
  }, [storeRenumberCitations]);
```

- [ ] **Step 2: Update `removeCitation` callback**

Find (lines ~457-464):

```ts
  const removeCitation = useCallback((sourceId: string) => {
    const html = editorRef.current?.getHTML() || '';
    const { newHtml } = storeRemoveCitation(sourceId, html);
    if (newHtml !== html) {
      editorRef.current?.setContent(newHtml);
      setContent(newHtml);
    }
  }, [storeRemoveCitation, setContent]);
```

Replace with:

```ts
  const removeCitation = useCallback((sourceId: string) => {
    if (!editorRef.current) return;
    const orderedIds = editorRef.current.getCitationOrder();
    const newRegistry = storeRemoveCitation(sourceId, orderedIds);
    editorRef.current.updateCitations(newRegistry);
  }, [storeRemoveCitation]);
```

- [ ] **Step 3: Remove `setContent` from the dependency array comment if present**

The `setContent` import from the store is no longer used in these two callbacks. Check if `setContent` is used anywhere else in App.tsx:

```bash
grep -n "setContent" /home/dzyla/manuscript-ai-editor/src/App.tsx
```

If it's still used elsewhere (e.g. in workspace load), leave the import. If these were the only uses, remove `setContent` from the `useDocumentStore` destructure at the top of the component.

- [ ] **Step 4: Full type-check — must be clean**

```bash
cd /home/dzyla/manuscript-ai-editor
npx tsc --noEmit
```

Expected: **zero errors**.

- [ ] **Step 5: Manual end-to-end smoke test**

```bash
npm run dev
```

Test the following in the browser:

1. Insert a citation for a source — confirm it appears in the editor as a badge with number `[1]`.
2. Insert a second citation for a different source — confirm `[2]`.
3. Click "Renumber Citations" — confirm badges update correctly without cursor jumping.
4. Remove a source from the sidebar — confirm all its citation badges disappear and remaining citations renumber without UI freeze or undo-history loss (Ctrl+Z should undo the typing step before, not the citation numbering).
5. Upload a PDF — confirm the sidebar card appears and the UI stays responsive during extraction.
6. Click an image (no text selected) — open the image chat panel and confirm context text is shown.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "refactor: citation call sites use getCitationOrder + updateCitations — no more HTML regex"
```

---

## Self-Review

**Spec coverage:**
- Token estimation (gpt-tokenizer) → Task 1 ✓
- PDF off main thread (Vite native Worker, no Comlink) → Tasks 2–3 ✓
- Citation: store takes `orderedSourceIds[]`, returns `Record<string,number>` → Task 4 ✓
- Citation: `getCitationOrder` + `updateCitations` on EditorRef → Task 5 ✓
- Citation: App.tsx call sites updated → Task 6 ✓
- Image context: caption-aware pass → surrounding-paragraph fallback → empty fallback → Task 5 ✓

**No placeholders** — every step has exact code or exact commands.

**Type consistency:**
- `getCitationOrder(): string[]` — defined in Task 5 (interface + impl), consumed in Task 6. ✓
- `updateCitations(registry: Record<string, number>): void` — same. ✓
- `renumberCitations(orderedSourceIds: string[]): Record<string, number>` — defined in Task 4, consumed in Task 6. ✓
- `removeCitation(sourceId: string, orderedSourceIds: string[]): Record<string, number>` — same. ✓
- Worker message envelope `{ type: 'extract', payload: ArrayBuffer }` / `{ type: 'result', text }` / `{ type: 'error', message }` — consistent between Task 2 (worker) and Task 3 (caller). ✓
