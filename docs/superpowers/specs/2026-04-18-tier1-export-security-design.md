# Tier 1 Production Hardening: Export & Security

**Date:** 2026-04-18
**Scope:** Three critical fixes — proper `.docx` export, deterministic LaTeX export, Electron secure key storage.
**Out of scope:** Journal templates (Tier 3), AbortController (already implemented).

---

## 1. Architecture: Shared AST Walker

### New files

```
src/services/astExport.ts        — shared walker + Renderer interface
src/services/docxExport.ts       — DocxRenderer (docx npm package)
src/services/latexExport.ts      — LatexRenderer (string builder)
src/services/secureStorage.ts    — storage abstraction (Electron vs browser)
```

### Renderer interface (`astExport.ts`)

```ts
interface Renderer<T> {
  doc(children: T[]): T
  heading(level: 1|2|3, children: T[]): T
  paragraph(children: T[]): T
  text(content: string, marks: Marks): T
  bulletList(items: T[][]): T
  orderedList(items: T[][]): T
  citationNode(num: number): T
  image(src: string, width?: number): T
  hardBreak(): T
}
```

`walkNode(node: ProseMirrorNode, renderer: Renderer<T>): T` recurses the JSON tree from `editor.getJSON()`. Each renderer is a plain object implementing the interface — no class inheritance.

**Node coverage:** `doc`, `paragraph`, `heading`, `text` (bold/italic/underline/code marks), `bulletList`, `orderedList`, `listItem`, `hardBreak`, `resizableImage`, `citationNode`. Unknown nodes log a warning and fall back to their text content.

**Call site (`App.tsx`):**
```ts
// .docx — pre-fetch images first, then walk
const imageBuffers = await prefetchImages(editor.getJSON());
const doc = walkNode(editor.getJSON(), new DocxRenderer({ title, imageBuffers }));
saveAs(await Packer.toBlob(doc), `${title}.docx`);

// .tex — walkNode returns a JSZip directly
const zip = walkNode(editor.getJSON(), new LatexRenderer({ title }));
saveAs(await zip.generateAsync({ type: 'blob' }), `${title}.zip`);
```

---

## 2. DocxRenderer

### Dependency
`docx` npm package — generates native Office Open XML. Replaces the existing HTML-blob-as-`.doc` hack.

### Node mapping

| ProseMirror node | `docx` construct |
|---|---|
| `heading` level 1–3 | `Paragraph` with `HeadingLevel.HEADING_1/2/3` |
| `paragraph` | `Paragraph` |
| `text` + bold | `TextRun({ bold: true })` |
| `text` + italic | `TextRun({ italics: true })` |
| `text` + underline | `TextRun({ underline: {} })` |
| `text` + code | `TextRun({ font: 'Courier New' })` |
| `bulletList` | `Paragraph` with `bullet: { level: 0 }` |
| `orderedList` | `Paragraph` with `numbering` config |
| `citationNode` | `TextRun("[N]")` — preserves inline position |
| `resizableImage` | `ImageRun` with decoded base64 |
| `hardBreak` | `TextRun({ break: 1 })` |

### Image pre-flight
Before the walk, a one-pass scan collects all `resizableImage` `src` attributes. Base64 data URIs are decoded directly. Object URLs are resolved to `ArrayBuffer` via `XMLHttpRequest`. The resolved buffers are passed into the renderer constructor so the walk itself is synchronous.

### Output
`DocxRenderer.render(title)` returns a `docx.Document`. Caller runs `Packer.toBlob(doc)` and passes to `file-saver`.

---

## 3. LatexRenderer

### Dependencies
`jszip` — already likely present; used to bundle `.tex` + extracted figures into a single download.

No LLM calls. Fully deterministic.

### Node mapping

| ProseMirror node | LaTeX output |
|---|---|
| `heading` level 1 | `\section{...}` |
| `heading` level 2 | `\subsection{...}` |
| `heading` level 3 | `\subsubsection{...}` |
| `paragraph` | `...\n\n` |
| `text` + bold | `\textbf{...}` |
| `text` + italic | `\textit{...}` |
| `text` + underline | `\underline{...}` |
| `text` + code | `\texttt{...}` |
| `bulletList` | `\begin{itemize}...\end{itemize}` |
| `orderedList` | `\begin{enumerate}...\end{enumerate}` |
| `citationNode` | `\cite{ref-N}` |
| `resizableImage` | `\includegraphics{figures/figure-N}` |
| `hardBreak` | `\\` |

### Preamble
```latex
\documentclass[12pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{amsmath}
\title{<title>}
\begin{document}
\maketitle
```
Closes with `\end{document}`.

### Special character escaping
`escapeLaTeX(str)` converts `& % $ # _ { } ~ ^ \` to safe LaTeX equivalents before any text node is emitted. Deterministic — eliminates the main failure mode of LLM-based export.

### Image handling
Images are extracted to a `figures/` directory inside the zip. A comment block at the top of the `.tex` instructs the user to keep the extracted `figures/` folder alongside the `.tex` file.

### Output
`LatexRenderer.render(title)` returns a `JSZip` object with `manuscript.tex` at root and `figures/figure-N.png` entries. Caller calls `zip.generateAsync({ type: 'blob' })` and passes to `file-saver`.

---

## 4. Secure Key Storage

### `src/services/secureStorage.ts`

```ts
async function getItem(key: string): Promise<string | null>
async function setItem(key: string, value: string): Promise<void>
async function removeItem(key: string): Promise<void>
function isEncrypted(): boolean  // true only in Electron
```

**Electron path:** `setItem` sends IPC `secure-storage-set`; main process calls `safeStorage.encryptString()` and writes ciphertext to a JSON file in `app.getPath('userData')/secure-store.json`. `getItem` sends `secure-storage-get`; main process reads and `safeStorage.decryptString()`s. Keys never touch `localStorage`.

**Browser path:** All four functions delegate to `localStorage`. Behaviour identical to today.

### Electron IPC (`electron/main.ts`)

Three new handlers alongside existing `net-post`/`net-get`:
- `ipcMain.handle('secure-storage-set', ...)`
- `ipcMain.handle('secure-storage-get', ...)`
- `ipcMain.handle('secure-storage-remove', ...)`

`preload.mjs` exposes `window.electronAPI.secureStorage.{get,set,remove}`.

### One-time migration
On first Electron launch post-update, `secureStorage.ts` checks for `manuscript-ai-settings` in `localStorage`. If present, reads → re-saves via encrypted path → deletes `localStorage` key. Silent, one-time.

`useAIStore.ts` is updated to call `secureStorage.getItem/setItem` instead of `localStorage` directly.

### Browser warning (`SettingsModal.tsx`)
When `isEncrypted()` returns `false`, an amber banner renders below the API key fields:

> "API keys are stored unencrypted in browser localStorage. Use the desktop app for secure key storage."

No change to save/load behaviour.

---

## Dependencies to add

| Package | Purpose |
|---|---|
| `docx` | Word XML generation (DocxRenderer) |
| `jszip` | Zip bundling for LaTeX + figures |

`jszip` may already be present as a transitive dependency — verify before adding.

---

## Files modified

| File | Change |
|---|---|
| `src/App.tsx` | Replace `.doc` export branch; add `.tex` zip export; import secureStorage |
| `src/stores/useAIStore.ts` | Replace `localStorage` calls with `secureStorage` |
| `src/components/SettingsModal.tsx` | Add browser amber warning banner |
| `electron/main.ts` | Add three `secure-storage-*` IPC handlers |
| `electron/preload.mjs` | Expose `secureStorage` on `contextBridge` |
