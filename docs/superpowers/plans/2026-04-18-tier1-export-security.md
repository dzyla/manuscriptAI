# Tier 1 Export & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HTML-blob `.doc` export and LLM-based LaTeX export with deterministic AST-driven exporters, and harden API key storage in Electron using `safeStorage`.

**Architecture:** A shared `walkNode` function in `astExport.ts` traverses ProseMirror JSON and dispatches to a pluggable `ASTRenderer` interface. `DocxRenderer` and `LatexRenderer` each implement this interface independently. A `secureStorage` service abstracts `safeStorage` IPC in Electron and falls back to `localStorage` in the browser.

**Tech Stack:** `docx` (Word XML), `jszip` (LaTeX zip bundle), Electron `safeStorage` + `ipcMain`, React + Zustand for settings wiring.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/services/astExport.ts` | `ASTRenderer` interface, `walkNode`, `prefetchImages` |
| Create | `src/services/docxExport.ts` | `DocxRenderer` — produces `docx.Document` |
| Create | `src/services/latexExport.ts` | `LatexRenderer` — produces `JSZip` |
| Create | `src/services/secureStorage.ts` | Storage abstraction (Electron vs browser) |
| Modify | `src/App.tsx` | Replace `.doc` + `.tex` export branches; use `secureStorage` |
| Modify | `src/stores/useAIStore.ts` | Replace `localStorage` calls with `secureStorage` |
| Modify | `src/components/SettingsModal.tsx` | Add amber warning banner in browser mode |
| Modify | `electron/main.ts` | Add `secure-storage-{get,set,remove}` IPC handlers |
| Modify | `electron/preload.mjs` | Expose `secureStorage` on `window.electron` |

---

## Task 1: Install dependencies

**Files:** None (package.json updated by npm)

- [ ] **Step 1: Install `docx` and `jszip`**

```bash
cd /path/to/manuscript-ai-editor
npm install docx jszip
```

Expected: both packages added to `node_modules/` and `package.json` dependencies.

- [ ] **Step 2: Verify type-check still passes**

```bash
npm run lint
```

Expected: no errors. If `docx` or `jszip` lack bundled types, run `npm install --save-dev @types/jszip` (jszip ships its own types; docx does too — this should be a no-op).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add docx and jszip for deterministic export"
```

---

## Task 2: Create `src/services/astExport.ts`

**Files:**
- Create: `src/services/astExport.ts`

- [ ] **Step 1: Write the file**

```ts
// src/services/astExport.ts

export interface Marks {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  strike?: boolean;
}

export interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string }>;
  content?: PmNode[];
}

export interface ImageMeta {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  mimeType: string;
}

// ASTRenderer: implement one method per ProseMirror node type.
// Return type is unknown at the interface level — each renderer uses its own
// concrete types internally (e.g. docx.Paragraph, string).
export interface ASTRenderer {
  // block-level (children of doc)
  doc(children: unknown[]): unknown;
  heading(level: 1 | 2 | 3, inlines: unknown[]): unknown;
  paragraph(inlines: unknown[]): unknown;
  bulletList(items: unknown[][]): unknown;
  orderedList(items: unknown[][]): unknown;
  resizableImage(src: string, alt: string, width: string, meta?: ImageMeta): unknown;
  table(rows: unknown[][][]): unknown;
  // inline-level (children of block nodes)
  text(content: string, marks: Marks): unknown;
  citationNode(nums: number[]): unknown;
  hardBreak(): unknown;
}

// Resolves all resizableImage srcs to ArrayBuffers + dimensions before the walk.
export async function prefetchImages(root: PmNode): Promise<Map<string, ImageMeta>> {
  const srcs = new Set<string>();
  function collect(node: PmNode) {
    if (node.type === 'resizableImage' && typeof node.attrs?.src === 'string') {
      srcs.add(node.attrs.src as string);
    }
    node.content?.forEach(collect);
  }
  collect(root);

  const map = new Map<string, ImageMeta>();
  await Promise.all([...srcs].map(async (src) => {
    try {
      let buffer: ArrayBuffer;
      let mimeType = 'image/png';
      if (src.startsWith('data:')) {
        const [header, base64] = src.split(',');
        mimeType = header.match(/:(.*?);/)?.[1] ?? 'image/png';
        const binary = atob(base64);
        buffer = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      } else {
        const res = await fetch(src);
        buffer = await res.arrayBuffer();
        mimeType = res.headers.get('content-type') ?? 'image/png';
      }
      const { width, height } = await getImageDimensions(src);
      map.set(src, { buffer, width, height, mimeType });
    } catch {
      // skip unresolvable images
    }
  }));
  return map;
}

function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 300 });
    img.onerror = () => resolve({ width: 400, height: 300 });
    img.src = src;
  });
}

function parseMarks(marks?: Array<{ type: string }>): Marks {
  const m: Marks = {};
  for (const mark of marks ?? []) {
    if (mark.type === 'bold')      m.bold      = true;
    if (mark.type === 'italic')    m.italic    = true;
    if (mark.type === 'underline') m.underline = true;
    if (mark.type === 'code')      m.code      = true;
    if (mark.type === 'strike')    m.strike    = true;
  }
  return m;
}

export function walkNode(node: PmNode, r: ASTRenderer, images?: Map<string, ImageMeta>): unknown {
  switch (node.type) {
    case 'doc':
      return r.doc((node.content ?? []).map(c => walkNode(c, r, images)));

    case 'heading':
      return r.heading(
        (node.attrs?.level as 1 | 2 | 3) ?? 1,
        (node.content ?? []).map(c => walkNode(c, r, images))
      );

    case 'paragraph':
      return r.paragraph((node.content ?? []).map(c => walkNode(c, r, images)));

    case 'bulletList':
      return r.bulletList(
        (node.content ?? []).map(li => {
          const firstPara = li.content?.find(c => c.type === 'paragraph');
          return (firstPara?.content ?? []).map(c => walkNode(c, r, images));
        })
      );

    case 'orderedList':
      return r.orderedList(
        (node.content ?? []).map(li => {
          const firstPara = li.content?.find(c => c.type === 'paragraph');
          return (firstPara?.content ?? []).map(c => walkNode(c, r, images));
        })
      );

    case 'resizableImage': {
      const src = (node.attrs?.src as string) ?? '';
      return r.resizableImage(
        src,
        (node.attrs?.alt as string) ?? '',
        (node.attrs?.width as string) ?? '100%',
        images?.get(src)
      );
    }

    case 'table':
      return r.table(
        (node.content ?? []).map(row =>       // tableRow
          (row.content ?? []).map(cell =>     // tableCell / tableHeader
            (cell.content ?? []).flatMap(block =>  // paragraph blocks within cell
              (block.content ?? []).map(inline => walkNode(inline, r, images))
            )
          )
        )
      );

    case 'text':
      return r.text(node.text ?? '', parseMarks(node.marks));

    case 'citation':
      return r.citationNode((node.attrs?.nums as number[]) ?? []);

    case 'hardBreak':
      return r.hardBreak();

    default:
      console.warn(`astExport: unknown node type "${node.type}", falling back to text`);
      return r.text(
        (node.content ?? []).map(c => c.text ?? '').join(''),
        {}
      );
  }
}
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors from `src/services/astExport.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/services/astExport.ts
git commit -m "feat: add shared ProseMirror AST walker and ASTRenderer interface"
```

---

## Task 3: Create `src/services/docxExport.ts`

**Files:**
- Create: `src/services/docxExport.ts`

This renderer maps every `ASTRenderer` method to `docx` constructs. `doc()` assembles the final `Document`; `bulletList`/`orderedList` return `Paragraph[]` (arrays), which `doc()` flattens.

- [ ] **Step 1: Write the file**

```ts
// src/services/docxExport.ts
import {
  Document, Paragraph, TextRun, HeadingLevel, ImageRun,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  LevelFormat, Packer,
} from 'docx';
import type { ASTRenderer, Marks, ImageMeta } from './astExport';

export { Packer };

const ORDERED_LIST_REF = 'ordered-list-1';

export class DocxRenderer implements ASTRenderer {
  private title: string;
  private images: Map<string, ImageMeta>;

  constructor(opts: { title: string; images: Map<string, ImageMeta> }) {
    this.title = opts.title;
    this.images = opts.images;
  }

  doc(children: unknown[]): Document {
    // Flatten arrays produced by bulletList/orderedList
    const blocks: (Paragraph | Table)[] = [];
    for (const child of children) {
      if (Array.isArray(child)) {
        blocks.push(...(child as (Paragraph | Table)[]));
      } else if (child != null) {
        blocks.push(child as Paragraph | Table);
      }
    }
    return new Document({
      title: this.title,
      numbering: {
        config: [{
          reference: ORDERED_LIST_REF,
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }],
        }],
      },
      sections: [{ children: blocks }],
    });
  }

  heading(level: 1 | 2 | 3, inlines: unknown[]): Paragraph {
    const map = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
    } as const;
    return new Paragraph({
      heading: map[level],
      children: inlines as TextRun[],
    });
  }

  paragraph(inlines: unknown[]): Paragraph {
    return new Paragraph({ children: inlines as TextRun[] });
  }

  text(content: string, marks: Marks): TextRun {
    return new TextRun({
      text: content,
      bold: marks.bold,
      italics: marks.italic,
      underline: marks.underline ? {} : undefined,
      font: marks.code ? 'Courier New' : undefined,
      strike: marks.strike,
    });
  }

  citationNode(nums: number[]): TextRun {
    const label = nums.length === 0 ? '[?]'
      : nums.length === 1 ? `[${nums[0]}]`
      : `[${nums[0]}–${nums[nums.length - 1]}]`;
    return new TextRun({ text: label });
  }

  hardBreak(): TextRun {
    return new TextRun({ break: 1 });
  }

  bulletList(items: unknown[][]): Paragraph[] {
    return items.map(inlines =>
      new Paragraph({
        bullet: { level: 0 },
        children: inlines as TextRun[],
      })
    );
  }

  orderedList(items: unknown[][]): Paragraph[] {
    return items.map(inlines =>
      new Paragraph({
        numbering: { reference: ORDERED_LIST_REF, level: 0 },
        children: inlines as TextRun[],
      })
    );
  }

  resizableImage(src: string, _alt: string, widthAttr: string, meta?: ImageMeta): Paragraph {
    if (!meta?.buffer || meta.buffer.byteLength === 0) {
      return new Paragraph({ children: [new TextRun({ text: '[image]', italics: true })] });
    }
    // Parse width attr (e.g. "400px", "100%") → pixel width capped at 600
    const parsedPx = parseInt(widthAttr);
    const displayWidth = (!isNaN(parsedPx) && parsedPx > 0 && !widthAttr.includes('%'))
      ? Math.min(parsedPx, 600)
      : 500;
    const aspectRatio = meta.height > 0 ? meta.height / meta.width : 0.75;
    const displayHeight = Math.round(displayWidth * aspectRatio);
    const ext = meta.mimeType.includes('jpeg') ? 'jpg' : 'png';

    return new Paragraph({
      children: [
        new ImageRun({
          type: ext,
          data: new Uint8Array(meta.buffer),
          transformation: { width: displayWidth, height: displayHeight },
        }),
      ],
    });
  }

  table(rows: unknown[][][]): Table {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(cells =>
        new TableRow({
          children: cells.map(inlines =>
            new TableCell({
              children: [new Paragraph({ children: inlines as TextRun[] })],
            })
          ),
        })
      ),
    });
  }
}
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors. If `docx` types differ (e.g. `ImageRun` signature), adjust the constructor arguments to match the installed version — run `node -e "const {ImageRun} = require('docx'); console.log(Object.keys(ImageRun.prototype))"` to inspect if needed.

- [ ] **Step 3: Commit**

```bash
git add src/services/docxExport.ts
git commit -m "feat: add DocxRenderer — ProseMirror AST to native Word XML"
```

---

## Task 4: Create `src/services/latexExport.ts`

**Files:**
- Create: `src/services/latexExport.ts`

- [ ] **Step 1: Write the file**

```ts
// src/services/latexExport.ts
import JSZip from 'jszip';
import type { ASTRenderer, Marks, ImageMeta } from './astExport';

const LATEX_ESCAPE: Array<[RegExp, string]> = [
  [/\\/g,  '\\textbackslash{}'],
  [/&/g,   '\\&'],
  [/%/g,   '\\%'],
  [/\$/g,  '\\$'],
  [/#/g,   '\\#'],
  [/_/g,   '\\_'],
  [/\{/g,  '\\{'],
  [/\}/g,  '\\}'],
  [/~/g,   '\\textasciitilde{}'],
  [/\^/g,  '\\textasciicircum{}'],
];

function esc(s: string): string {
  let out = s;
  for (const [re, replacement] of LATEX_ESCAPE) out = out.replace(re, replacement);
  return out;
}

export class LatexRenderer implements ASTRenderer {
  private title: string;
  private zip: JSZip;
  private figureIndex = 0;
  private images: Map<string, ImageMeta>;

  constructor(opts: { title: string; images: Map<string, ImageMeta> }) {
    this.title = opts.title;
    this.zip = new JSZip();
    this.images = opts.images;
  }

  doc(children: unknown[]): JSZip {
    const body = children.join('\n\n');
    const hasFigures = this.figureIndex > 0;
    const preamble = [
      `\\documentclass[12pt]{article}`,
      `\\usepackage[margin=1in]{geometry}`,
      `\\usepackage{graphicx}`,
      `\\usepackage{hyperref}`,
      `\\usepackage{amsmath}`,
      hasFigures ? `% Place the extracted figures/ folder next to this .tex file before compiling.` : '',
      `\\title{${esc(this.title)}}`,
      `\\author{}`,
      `\\date{}`,
      `\\begin{document}`,
      `\\maketitle`,
    ].filter(Boolean).join('\n');

    this.zip.file('manuscript.tex', `${preamble}\n\n${body}\n\n\\end{document}\n`);
    return this.zip;
  }

  heading(level: 1 | 2 | 3, inlines: unknown[]): string {
    const cmd = ['\\section', '\\subsection', '\\subsubsection'][level - 1];
    return `${cmd}{${inlines.join('')}}`;
  }

  paragraph(inlines: unknown[]): string {
    return inlines.join('');
  }

  text(content: string, marks: Marks): string {
    let s = esc(content);
    if (marks.code)      s = `\\texttt{${s}}`;
    if (marks.bold)      s = `\\textbf{${s}}`;
    if (marks.italic)    s = `\\textit{${s}}`;
    if (marks.underline) s = `\\underline{${s}}`;
    if (marks.strike)    s = `\\sout{${s}}`;
    return s;
  }

  citationNode(nums: number[]): string {
    if (nums.length === 0) return '\\cite{?}';
    return `\\cite{${nums.map(n => `ref-${n}`).join(',')}}`;
  }

  hardBreak(): string {
    return '\\\\\n';
  }

  bulletList(items: unknown[][]): string {
    const entries = items.map(inlines => `  \\item ${inlines.join('')}`).join('\n');
    return `\\begin{itemize}\n${entries}\n\\end{itemize}`;
  }

  orderedList(items: unknown[][]): string {
    const entries = items.map(inlines => `  \\item ${inlines.join('')}`).join('\n');
    return `\\begin{enumerate}\n${entries}\n\\end{enumerate}`;
  }

  resizableImage(src: string, alt: string, widthAttr: string, meta?: ImageMeta): string {
    this.figureIndex++;
    const figName = `figure-${this.figureIndex}.png`;

    if (meta?.buffer && meta.buffer.byteLength > 0) {
      this.zip.folder('figures')!.file(figName, meta.buffer);
    }

    // Parse width: "400px" → 0.55\textwidth, "100%" → \textwidth, unknown → 0.8\textwidth
    let widthSpec = '0.8\\textwidth';
    if (widthAttr.endsWith('%')) {
      const pct = parseFloat(widthAttr) / 100;
      widthSpec = `${pct.toFixed(2)}\\textwidth`;
    } else if (widthAttr.endsWith('px')) {
      const px = parseInt(widthAttr);
      // Approximate: 600px ≈ \textwidth on a standard 6-inch text block
      const frac = Math.min(px / 600, 1.0);
      widthSpec = `${frac.toFixed(2)}\\textwidth`;
    }

    return [
      `\\begin{figure}[htbp]`,
      `  \\centering`,
      `  \\includegraphics[width=${widthSpec}]{figures/${figName}}`,
      alt ? `  \\caption{${esc(alt)}}` : '',
      `\\end{figure}`,
    ].filter(Boolean).join('\n');
  }

  table(rows: unknown[][][]): string {
    if (rows.length === 0) return '';
    const colCount = rows[0].length;
    const colSpec = Array(colCount).fill('l').join(' | ');
    const rowStrings = rows.map(cells =>
      cells.map(inlines => inlines.join('')).join(' & ')
    );
    return [
      `\\begin{table}[htbp]`,
      `  \\centering`,
      `  \\begin{tabular}{${colSpec}}`,
      `    \\hline`,
      rowStrings.map(r => `    ${r} \\\\`).join('\n    \\hline\n'),
      `    \\hline`,
      `  \\end{tabular}`,
      `\\end{table}`,
    ].join('\n');
  }
}
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/latexExport.ts
git commit -m "feat: add LatexRenderer — deterministic ProseMirror AST to LaTeX"
```

---

## Task 5: Wire docx + LaTeX export in `App.tsx`

**Files:**
- Modify: `src/App.tsx` (lines ~786–812)

The current `doDownload` function has a `docx` branch that saves an HTML blob as `.doc`, and a `tex` branch that calls the LLM. Both are replaced.

- [ ] **Step 1: Add `getJSON` to `EditorRef` in `src/components/Editor.tsx`**

The `EditorRef` interface (line 53) exposes `getHTML` but not `getJSON`. Add the method.

In `src/components/Editor.tsx`, find the `EditorRef` interface:
```ts
export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
```
Add `getJSON` after `getHTML`:
```ts
  getHTML: () => string;
  getJSON: () => Record<string, unknown>;
```

Then find the `useImperativeHandle` implementation (around line 786) where `getHTML` is exposed:
```ts
    getHTML: () => editor?.getHTML() || '',
```
Add `getJSON` immediately after:
```ts
    getHTML: () => editor?.getHTML() || '',
    getJSON: () => editor?.getJSON() ?? { type: 'doc', content: [] },
```

- [ ] **Step 2: Add imports at the top of `src/App.tsx`**

Find the existing imports block and add after the last import:

```ts
import { prefetchImages, walkNode } from './services/astExport';
import { DocxRenderer, Packer } from './services/docxExport';
import { LatexRenderer } from './services/latexExport';
```

- [ ] **Step 2: Replace the `docx` and `tex` branches in `doDownload`**

Find this block in `src/App.tsx` (around line 792):

```ts
    } else if (format === 'docx') {
      saveAs(new Blob([currentContent], { type: 'application/msword' }), `${title.replace(/\s+/g, '_')}.doc`);
    } else if (format === 'tex') {
      setIsAnalyzing(true);
      showToast('Converting to LaTeX...', 'info');
      try {
        const turndownService = new TurndownService();
        const markdown = turndownService.turndown(currentContent);
        // Fallback to simple LLM conversion to avoid heavy pandoc-wasm dependency
        const { chatWithAgent } = await import('./services/ai');
        const prompt = "Convert the following academic manuscript (Markdown) into a clean, well-structured LaTeX document suitable for a generic academic journal. Include a preamble with standard packages (article class, geometry, graphicx, hyperref). Put the title as '"+title+"'. Ensure all sections, bolding, italics, and lists are properly converted. Return ONLY the raw LaTeX code, starting with \\documentclass and ending with \\end{document}.";
        const result = await chatWithAgent(prompt, markdown, 'editor', aiSettings);
        let tex = result.text.replace(/```(latex|tex)?\n/g, '').replace(/\n```/g, '');
        saveAs(new Blob([tex], { type: 'application/x-tex' }), `${title.replace(/\s+/g, '_')}.tex`);
        showToast('LaTeX conversion complete', 'success');
      } catch (err) {
        showToast('LaTeX conversion failed', 'error');
        console.error(err);
      } finally {
        setIsAnalyzing(false);
      }
```

Replace it with:

```ts
    } else if (format === 'docx') {
      try {
        const json = editorRef.current?.getJSON() ?? { type: 'doc', content: [] };
        const images = await prefetchImages(json as any);
        const renderer = new DocxRenderer({ title, images });
        const doc = walkNode(json as any, renderer, images) as ReturnType<DocxRenderer['doc']>;
        const blob = await Packer.toBlob(doc);
        saveAs(blob, `${title.replace(/\s+/g, '_')}.docx`);
        showToast('Word document exported', 'success');
      } catch (err) {
        showToast('Word export failed', 'error');
        console.error(err);
      }
    } else if (format === 'tex') {
      try {
        const json = editorRef.current?.getJSON() ?? { type: 'doc', content: [] };
        const images = await prefetchImages(json as any);
        const renderer = new LatexRenderer({ title, images });
        const zip = walkNode(json as any, renderer, images) as ReturnType<LatexRenderer['doc']>;
        const blob = await zip.generateAsync({ type: 'blob' });
        saveAs(blob, `${title.replace(/\s+/g, '_')}.zip`);
        showToast('LaTeX package exported', 'success');
      } catch (err) {
        showToast('LaTeX export failed', 'error');
        console.error(err);
      }
```

- [ ] **Step 3: Update the download button label for `.tex` in the menu**

Find (around line 925 in `src/App.tsx`):
```tsx
<button onClick={() => handleDownload('tex')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>AI Convert to LaTeX</button>
```

Replace with:
```tsx
<button onClick={() => handleDownload('tex')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>Export to LaTeX (.zip)</button>
```

- [ ] **Step 4: Verify type-check**

```bash
npm run lint
```

Expected: no errors. If `editorRef.current?.getJSON` raises a type error, cast it: `(editorRef.current as any)?.getJSON?.()`.

- [ ] **Step 5: Start dev server and test both exports**

```bash
npm run dev
```

Open http://localhost:3000. Type a short document with a heading, bold text, and a bullet list. Click File → Export → `.docx` — verify a real `.docx` file downloads and opens correctly in Word/LibreOffice. Click Export → LaTeX `.zip` — verify a `.zip` downloads containing `manuscript.tex` with correct `\section`, `\textbf`, `\begin{itemize}` etc.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: replace HTML-blob doc export and LLM LaTeX with AST-driven exporters"
```

---

## Task 6: Create `src/services/secureStorage.ts` (browser path only)

**Files:**
- Create: `src/services/secureStorage.ts`

We build the browser path first so the app still works before the Electron IPC is wired.

- [ ] **Step 1: Write the file**

```ts
// src/services/secureStorage.ts

type ElectronSecureStorage = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function getElectronSecureStorage(): ElectronSecureStorage | null {
  return (window as any).electron?.secureStorage ?? null;
}

export function isEncrypted(): boolean {
  return getElectronSecureStorage() !== null;
}

export async function getItem(key: string): Promise<string | null> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.get(key);
  return localStorage.getItem(key);
}

export async function setItem(key: string, value: string): Promise<void> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.set(key, value);
  localStorage.setItem(key, value);
}

export async function removeItem(key: string): Promise<void> {
  const electron = getElectronSecureStorage();
  if (electron) return electron.remove(key);
  localStorage.removeItem(key);
}
```

- [ ] **Step 2: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/secureStorage.ts
git commit -m "feat: add secureStorage abstraction (browser path, Electron stub)"
```

---

## Task 7: Wire `secureStorage` into `useAIStore` and `App.tsx`

**Files:**
- Modify: `src/stores/useAIStore.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Update `src/stores/useAIStore.ts`**

Add import at the top of `src/stores/useAIStore.ts`:
```ts
import * as secureStorage from '../services/secureStorage';
```

Find the `initialize` method in `useAIStore.ts` (around line 103):
```ts
      // Load AI settings from localStorage
      const settingsJson = localStorage.getItem('manuscript-ai-settings');
```
Replace with:
```ts
      // Load AI settings from secure storage (encrypted in Electron, localStorage in browser)
      const settingsJson = await secureStorage.getItem('manuscript-ai-settings');
```

Find (around line 152 in `useAIStore.ts`):
```ts
            localStorage.setItem('manuscript-ai-settings', JSON.stringify(merged))
```
Replace with:
```ts
            await secureStorage.setItem('manuscript-ai-settings', JSON.stringify(merged))
```

- [ ] **Step 2: Update `App.tsx` settings save call**

In `src/App.tsx`, find (around line 1208):
```ts
onUpdateSettings={(s) => { setAiSettings(s); localStorage.setItem('manuscript-ai-settings', JSON.stringify(s)); }}
```
Replace with:
```ts
onUpdateSettings={(s) => { setAiSettings(s); secureStorage.setItem('manuscript-ai-settings', JSON.stringify(s)); }}
```

Add the import for `secureStorage` near the top of `App.tsx` (alongside the existing service imports):
```ts
import * as secureStorage from './services/secureStorage';
```

- [ ] **Step 3: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/stores/useAIStore.ts src/App.tsx
git commit -m "feat: route AI settings through secureStorage abstraction"
```

---

## Task 8: Add browser warning to `SettingsModal`

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: Add import**

At the top of `src/components/SettingsModal.tsx`, add:
```ts
import { isEncrypted } from '../services/secureStorage';
```

- [ ] **Step 2: Add the amber warning banner**

In `SettingsModal.tsx`, find the provider section start (around line 119):
```tsx
                {activeSection === 'provider' ? (
                  <>
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Provider</label>
```

Add the warning immediately after the opening `<>`, before the provider label div:
```tsx
                {activeSection === 'provider' ? (
                  <>
                    {!isEncrypted() && (
                      <div className="flex items-start gap-2 p-3 rounded-xl text-xs" style={{ background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.25)', color: 'rgb(180,100,0)' }}>
                        <span className="mt-0.5 shrink-0">⚠</span>
                        <span>API keys are stored unencrypted in browser localStorage. Use the desktop app for secure key storage.</span>
                      </div>
                    )}
                    <div className="space-y-3">
                      <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Provider</label>
```

- [ ] **Step 3: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Verify visually**

```bash
npm run dev
```

Open http://localhost:3000. Click the Settings gear. Open the Provider tab — the amber banner should appear. It should not appear in the Agents or Zotero tabs (it's only in the provider section).

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat: show unencrypted storage warning in browser Settings"
```

---

## Task 9: Add Electron IPC handlers for secure storage

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.mjs`

- [ ] **Step 1: Update `electron/main.ts`**

Add `safeStorage` to the existing import at line 1:
```ts
import { app, BrowserWindow, ipcMain, net, safeStorage } from 'electron';
```

Add `path` and `fs` imports below the existing imports:
```ts
import fs from 'node:fs';
```

Add the three IPC handlers at the bottom of `electron/main.ts`, before `app.whenReady().then(createWindow)`:

```ts
// Secure storage: encrypt/decrypt API keys using OS keychain via safeStorage
function getSecureStorePath(): string {
  return path.join(app.getPath('userData'), 'secure-store.json');
}

function readSecureStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(getSecureStorePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSecureStore(store: Record<string, string>): void {
  fs.writeFileSync(getSecureStorePath(), JSON.stringify(store), 'utf-8');
}

ipcMain.handle('secure-storage-set', (_event, { key, value }: { key: string; value: string }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store as-is if OS encryption is unavailable (e.g. headless CI)
    const store = readSecureStore();
    store[key] = value;
    writeSecureStore(store);
    return;
  }
  const store = readSecureStore();
  store[key] = safeStorage.encryptString(value).toString('base64');
  writeSecureStore(store);
});

ipcMain.handle('secure-storage-get', (_event, { key }: { key: string }): string | null => {
  const store = readSecureStore();
  const raw = store[key];
  if (raw == null) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
});

ipcMain.handle('secure-storage-remove', (_event, { key }: { key: string }) => {
  const store = readSecureStore();
  delete store[key];
  writeSecureStore(store);
});
```

- [ ] **Step 2: Update `electron/preload.mjs`**

Replace the entire contents of `electron/preload.mjs` with:

```js
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  // CORS-free POST via Electron main process (used for APIs without CORS headers)
  netPost: (url, headers, body) => ipcRenderer.invoke('net-post', { url, headers, body }),
  // CORS-free GET via Electron main process
  netGet: (url, headers) => ipcRenderer.invoke('net-get', { url, headers }),
  // Encrypted key storage via OS keychain (safeStorage)
  secureStorage: {
    get: (key) => ipcRenderer.invoke('secure-storage-get', { key }),
    set: (key, value) => ipcRenderer.invoke('secure-storage-set', { key, value }),
    remove: (key) => ipcRenderer.invoke('secure-storage-remove', { key }),
  },
});
```

- [ ] **Step 3: Verify type-check**

```bash
npm run lint
```

Expected: no errors. `safeStorage` is part of `electron` — no additional types needed.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts electron/preload.mjs
git commit -m "feat: add safeStorage IPC handlers and expose secureStorage on window.electron"
```

---

## Task 10: Add one-time migration in `secureStorage.ts`

When the Electron app first launches after this update, any existing `manuscript-ai-settings` in `localStorage` should be migrated to the encrypted store and deleted from `localStorage`. This is a one-time, silent operation.

**Files:**
- Modify: `src/services/secureStorage.ts`

- [ ] **Step 1: Add `migrateFromLocalStorage` function**

Add to the bottom of `src/services/secureStorage.ts`:

```ts
// Call once at app startup (Electron only). Reads legacy localStorage key,
// re-saves via encrypted IPC, then deletes from localStorage.
export async function migrateFromLocalStorage(key: string): Promise<void> {
  if (!isEncrypted()) return;
  const legacy = localStorage.getItem(key);
  if (legacy == null) return;
  await setItem(key, legacy);
  localStorage.removeItem(key);
}
```

- [ ] **Step 2: Call migration in `useAIStore.initialize`**

In `src/stores/useAIStore.ts`, add the import extension (already imports `secureStorage`). In the `initialize` method, add migration call before the `getItem` read:

```ts
  initialize: async () => {
    try {
      // One-time migration from localStorage → encrypted Electron store
      await secureStorage.migrateFromLocalStorage('manuscript-ai-settings');

      // Load AI settings from secure storage (encrypted in Electron, localStorage in browser)
      const settingsJson = await secureStorage.getItem('manuscript-ai-settings');
```

- [ ] **Step 3: Verify type-check**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/secureStorage.ts src/stores/useAIStore.ts
git commit -m "feat: migrate API keys from localStorage to encrypted store on first Electron launch"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] `npm run lint` passes with zero errors
- [ ] `.docx` export: download a document, open in Word/LibreOffice — headings, bold/italic, lists, citations render correctly
- [ ] `.tex.zip` export: unzip, check `manuscript.tex` — `\section`, `\textbf`, `\begin{itemize}`, `\cite{ref-N}` are all present and the file compiles with `pdflatex`
- [ ] Browser Settings: amber banner visible under Provider tab when running in browser
- [ ] No `localStorage.getItem/setItem` calls remain in `useAIStore.ts` or `App.tsx` for the AI settings key (run `grep -n "localStorage.*manuscript-ai-settings" src/`)
- [ ] Electron build: `npm run build:electron` completes without errors
