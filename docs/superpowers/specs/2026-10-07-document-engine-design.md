# Document Engine (Word Fidelity, Page Setup, NIH Formatting) — Design

**Date:** 2026-10-07
**Branch:** feat/document-engine
**Status:** Approved design, pending user review of this spec
**Supersedes:** `2026-07-03-nih-page-view-design.md` (never implemented; its goals are folded in here)

## Program context

The app is being overhauled toward a Grantease-class grant + manuscript writing tool.
Deployment stays **client-side, SaaS-ready** (no backend now; persistence and LLM access
sit behind interfaces so auth/sync/key-proxy can be added later). The overhaul is split
into four sub-projects, built in order, each with its own spec → plan → build:

| | Sub-project | Depends on |
|---|---|---|
| **A** | **Document engine** (this spec): DOCX fidelity, page setup/styles, paged view, NIH compliance, track-changes + comments model | — |
| B | Suggestion engine: decoration highlights, PM-mapped anchors, AI edits as tracked changes, AI notes as comments, streaming | A |
| C | Agent pipeline + reviewer: fewer calls, section-aware context, NIH 2025 Simplified Review Framework study section | B |
| D | Grant workspace: full NIH mechanism/attachment catalog, drafting wizard, FOA→template agent, writing-skill library, citation engine (OpenAlex/PubMed) | A–C |

A deliberately builds the **tracked-change and comment primitives** that B uses: AI edit
suggestions become tracked insertions/deletions; AI reviewer notes become comments.

## Problem (from the 2026-10-07 audit)

1. **DOCX cannot be opened as the manuscript.** `App.tsx:1014-1053` accepts `.docx` but
   always `readAsText` + `JSON.parse` → "Failed to load workspace file". The only DOCX
   path (`docxWorker.ts`, `mammoth.extractRawText`) makes a plain-text *source*.
2. **DOCX export ignores formatting.** `docxExport.ts` uses `docx` library defaults
   (Calibri, 1" margins); nested lists flattened, table structure lost, alignment/links/
   super/subscript dropped, WebP images dropped, citations become literal `[N]`.
3. **No page or format model.** Font hard-coded (Crimson Pro, `index.css:6`); page guides
   (`Editor.tsx:132-155`) assume a 7.5"-wide column, so page counts are fiction; grant
   budgets are words ÷ 500.
4. **Toolbar** lacks font family, size, styles, line spacing, super/sub, page break,
   review tools.

## Goals / success criteria

- Open a collaborator's `.docx` and see it with its fonts, sizes, margins, headings,
  nested lists, tables (merged cells), images, captions, tracked changes, comments and
  Zotero/EndNote citations intact.
- Export back to `.docx` such that Word shows the same formatting, real tracked changes,
  real comments, and live Zotero fields (Zotero "Refresh" works). Parts the app does not
  model (headers/footers, theme, footnotes, equations) are preserved unchanged.
- One-click NIH preset (Arial 11 pt, 0.5" margins, US Letter, compliant spacing) with a
  live compliance checker.
- Page view whose page count matches Word/LibreOffice within ±¼ page on a 12-page doc.
- Word-class formatting UI: styles + per-selection overrides.

## Non-goals (A)

Header/footer editing (preserved only), multiple sections with differing page setup,
columns, line numbering, footnote editing (preserved as read-only chips), equation editing
(passthrough), real-time collaboration, the AI suggestion rework (B).

## 1. Data model and architecture

### 1.1 Storage: ProseMirror JSON

Documents are stored as ProseMirror JSON (`editor.getJSON()`), not HTML. HTML cannot
losslessly carry tracked-change metadata, comment ids, style references or CSL payloads.
`DocumentRow` gains `docJson`; legacy `content` (HTML) is migrated once on load
(`setContent(html)` → `getJSON()`) and retained for HTML-based exporters until they move.

### 1.2 Format model (per document, on `useDocumentStore`)

```ts
interface PageSetup {
  size: 'letter' | 'a4';
  orientation: 'portrait';
  marginsIn: { top: number; right: number; bottom: number; left: number };
}
interface StyleDef {
  id: string;            // 'normal' | 'heading1'..'heading3' | 'caption' | 'bibliography' | imported ids
  name: string;
  basedOn?: string;
  fontFamily?: string; fontSizePt?: number; bold?: boolean; italic?: boolean; color?: string;
  lineSpacing?: number;  // multiple of "single"
  spaceBeforePt?: number; spaceAfterPt?: number; indentFirstIn?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
}
interface DocFormat {
  page: PageSetup;
  styles: Record<string, StyleDef>;
  preset: 'nih' | 'manuscript' | 'a4' | 'custom';
}
interface Comment {
  id: string; author: string; date: string; text: string;
  replies: Comment[]; resolved: boolean; source: 'user' | 'docx' | 'ai';
}
```

- `DocFormat` persisted on the document row. Default for new documents: NIH preset.
- Comments: new Dexie table `comments` (indexed by `documentId`); the anchor is a
  `CommentRange` mark in the doc, the thread lives in the table.
- Original package: new Dexie table `docxPackages` holding the imported `.docx` blob per
  document, used on export to preserve unmodelled parts.
- Dexie schema → v3 (adds `comments`, `docxPackages`; documents gain `docJson`, `format`).

### 1.3 Editor extensions (`src/extensions/format/`, one small file each)

- **Run overrides:** `TextStyle`-based marks `fontFamily`, `fontSize`, `color`,
  superscript/subscript (use official TipTap extensions where they exist).
- **Paragraph attributes:** `styleId`, `lineSpacing`, `spaceBefore/After`, `indentFirst`
  on paragraph + heading; rendered CSS = resolved style ⊕ overrides.
- **Track changes:** `Insertion` / `Deletion` marks `{id, author, date}`; a `trackChanges`
  editor mode where typing creates insertions and deletes wrap text in `Deletion` instead
  of removing it. Commands: `acceptChange(id)`, `rejectChange(id)`, `acceptAll`,
  `rejectAll`, `goToNextChange`, `goToPrevChange`.
- **Comments:** `CommentRange` mark `{commentId}`; commands `addComment`, `resolveComment`.
- **`PageBreak`** block node.
- **Citations:** existing `CitationNode` gains optional `{cslJson, fieldCode}` so Zotero /
  EndNote payloads survive editing.
- **`Passthrough`** inline + block atom nodes `{kind, label, xml}` for OOXML the app does
  not model (equations, footnote refs, content controls, unknown fields). Rendered as a
  small read-only chip ("equation", "footnote 3").

### 1.4 Converters (`src/docx/`, pure TypeScript, no React)

- `read/` — `.docx` bytes → `{ doc: PMJson, format: DocFormat, comments: Comment[],
  citations: CitationImport[], report: ImportReport }`. Runs in a new Comlink worker
  `src/workers/docxImportWorker.ts`.
- `write/` — `{ doc, format, comments, sources, package?: Blob }` → `.docx` bytes.
- `ooxml/` — shared namespaces, unit conversion (twips, half-points, EMU), XML helpers
  (DOMParser / XMLSerializer; JSZip already a dependency).
- `docxExport.ts` and the `docx` npm dependency are removed. LaTeX/Markdown export keep
  `astExport`, switched to read PM JSON.
- `mammoth` + `docxWorker.ts` remain only for the Sources uploader (plain-text extraction
  of reference docs).

### 1.5 SaaS-ready seam

All document persistence goes through a `DocumentRepository` interface
(`load`, `save`, `loadPackage`, `savePackage`, `listComments`, `saveComments`) with a
Dexie implementation. Stores depend on the interface, not Dexie directly.

## 2. Import / export pipeline

### 2.1 Import (`src/docx/read`)

1. Unzip. Parse `styles.xml`: `docDefaults` + `basedOn` chain resolved into `StyleDef`s.
   Headings identified by `outlineLvl` or "Heading N" style name.
2. `sectPr` of the body (`pgSz`, `pgMar`) → `PageSetup`. Multi-section docs: last section
   wins; others listed in the import report.
3. Body:
   - `w:p` → paragraph/heading with `styleId` + direct paragraph overrides (`spacing`,
     `ind`, `jc`).
   - `w:r` → text with marks from `rPr` (`rFonts@ascii`, `sz`, `b`, `i`, `u`, `color`,
     `vertAlign`).
   - `numbering.xml` (`abstractNum` levels, `numFmt`) → nested bullet/ordered lists.
   - `w:tbl` → table; `gridSpan` → colspan, `vMerge` → rowspan, `tblHeader` → header row,
     `tblGrid` widths kept.
   - `w:drawing` → image (resolve `r:embed` via rels → media → data URL; extent EMU → size).
     Paragraphs in the Caption style → figure caption.
   - `w:br w:type="page"` → `PageBreak`.
   - `w:hyperlink` → link mark.
4. Revisions: `w:ins` / `w:del` (author, date) → `Insertion` / `Deletion` marks
   (`w:delText` read as text).
5. Comments: `commentRangeStart/End` → `CommentRange`; `comments.xml` +
   `commentsExtended.xml` (`paraIdParent`, `done`) → threads with replies + resolved.
6. Citations:
   - Complex/simple fields with `ADDIN ZOTERO_ITEM CSL_CITATION {json}` → citation nodes
     carrying `cslJson` + raw `fieldCode`. Each CSL item matched to an existing Source by
     DOI (then normalized title), else a new Source is created; registry renumbered via
     `renumberCitations()`.
   - `ADDIN EN.CITE` → parse the embedded EndNote record XML (title, authors, year, DOI)
     the same way.
   - `ZOTERO_BIBL` / `ADDIN EN.REFLIST` field result → bibliography block (marked so the
     writer can regenerate or preserve it).
7. Anything unrecognized → `Passthrough` node holding the raw XML; never silently dropped.
8. `ImportReport` → toast: pages, tracked changes, comments, linked citations,
   passthrough items, warnings.

The workspace loader in `App.tsx` dispatches by extension: `.json` → existing workspace
path, `.docx` → this importer (fixing the audit P0), `.md/.txt` → text import.

### 2.2 Export (`src/docx/write`)

- **Doc originated from DOCX:** start from the stored original package. Keep headers,
  footers, theme, `fontTable`, `footnotes.xml`, `endnotes.xml`, settings and their rels.
  Regenerate `document.xml`, `numbering.xml`, `comments.xml` (+ extended), media and
  rels. **Patch** `styles.xml` only for styles whose modelled properties changed, so
  unmodelled properties (tabs, borders) survive.
- **New doc:** build from a minimal built-in base package; `styles.xml` generated from
  `DocFormat`.
- `sectPr` written from `PageSetup` (`pgSz` in twips, `pgMar`).
- Citations with `fieldCode` → written back as Zotero/EndNote complex fields (begin /
  instrText / separate / result / end) so the reference manager's Refresh keeps working.
  App-native citations → `[N]` text + a generated bibliography section from Sources.
- Tracked changes → `w:ins` / `w:del` with author/date. AI-authored changes (sub-project
  B) use author names like "AI · Language Surgeon".
- Comments → `commentRangeStart/End`, `commentReference`, `comments.xml`,
  `commentsExtended.xml`.
- `Passthrough` → raw XML emitted verbatim.

## 3. Editor UI, page view, compliance

### 3.1 Metric-compatible bundled fonts

Accurate pagination requires on-screen glyph widths identical to Word's. Bundle via
`@fontsource` (offline-capable for Electron; works on Linux):

| Document font | Bundled metric-compatible stand-in |
|---|---|
| Arial, Helvetica | Arimo |
| Georgia | Gelasio |
| Palatino Linotype | TeX Gyre Pagella |
| Times New Roman | Tinos |
| Calibri | Carlito |

CSS font stacks list the real font first (used if installed), the stand-in second.
Export always writes the real font name.

### 3.2 Page view (`src/extensions/pagination/`)

- Page cards sized from `PageSetup` (Letter = 816×1056 CSS px at 96 dpi), content box
  inset by margins. Zoom via `transform: scale()` on the canvas; geometry stays in real px.
- **Line-level breaks:** measure line boxes of top-level blocks (`getClientRects`); when a
  line crosses the content-box bottom, insert a block-level widget spacer *at that line's
  start position* (`posAtCoords`), pushing the remainder to the next page's top margin.
  Tables and images break at block level; a block taller than a page overflows its card.
- **Word line-height calibration:** "single" spacing = per-font factor (Arial ≈ 1.149,
  others measured from font metrics `ascent+descent+lineGap`) so lines-per-page match Word.
- Re-measure on doc change + `ResizeObserver`, debounced via `requestAnimationFrame`.
- Pure core: `computeBreaks(lines: {top, height, pos}[], geometry) → {breaks, pageCount}`,
  unit-tested. Plugin exposes `pageCount` and `pageForPos(pos)`.
- "Draft" toggle = continuous view (no cards). Page view is the default.
- `pageForPos` feeds grant budgets ("Research Strategy ends p. 12.4 / 12"), replacing
  `wordsToPages` and the proportional `pageGuideOffsets` code (removed).

### 3.3 Toolbar (Word-style compact ribbon)

Groups: **Styles** dropdown with live previews · **Font** family (an "NIH-compliant" group
with ✓ badge, then others), size, B/I/U, super/sub, color · **Paragraph** align, line
spacing, lists, indent/outdent · **Insert** table, figure, page break, citation ·
**Review** track changes toggle, accept / reject, prev / next change, new comment.
Overflow "⋯" menu at narrow widths. Existing BubbleMenu keeps working.

### 3.4 Page setup dialog + ruler

- Presets: **NIH** (Arial 11, 0.5" margins, Letter, single), **Journal manuscript**
  (Times 12, double-spaced, 1" margins), **A4**, **Custom**.
- Edit paper size, margins, Normal / Heading 1–3 / Caption styles.
- Horizontal ruler above the page with draggable left/right margin handles.

### 3.5 Comments rail

Threads rendered in the right margin aligned to their anchors (Google-Docs style):
reply, resolve, delete, jump. Clicking a `CommentRange` focuses its thread.

### 3.6 Status bar + compliance checker

Status bar: "Page X of Y", word count, compliance badge ("NIH ✓" or "2 issues" →
popover list; click jumps to the offending range).

`checkCompliance(doc, format, preset) → Issue[]` — pure function:
- **Error:** any margin < 0.5"; body text < 11 pt; > 6 lines per vertical inch;
  > 15 characters per linear inch (computed from font metrics via canvas `measureText`).
- **Warning:** font outside {Arial, Georgia, Helvetica, Palatino Linotype}; figure/table
  text < 9 pt.
Only runs the NIH rules when `preset === 'nih'` or a grant template is active.

## Error handling

- Malformed `.docx` (bad zip, missing `document.xml`) → clear toast, existing document
  untouched.
- Per-element parse failure → element becomes `Passthrough` + report warning; import
  continues.
- Export failure → toast with the reason; never write a partial file.
- Missing fonts → stand-in used; a one-time notice names the substitution.

## Testing

- **Vitest (converters):** one small fixture `.docx` per feature (styles, nested lists,
  merged cells, images + captions, track changes, comments with replies, Zotero
  citations, EndNote citations, passthrough equation, page setup). Assert import result
  shape and **import → export → import stability**. Fixtures are generated by a script
  (raw OOXML templates) so they are reviewable in git.
- **Vitest (pure units):** `computeBreaks`, `checkCompliance`, style resolution, unit
  conversion, HTML→JSON migration.
- **Playwright smoke** (scratchpad pattern from prior work): import a fixture, toggle page
  view, change font/preset, add a comment, accept a tracked change, export.
- **Acceptance fixture:** one real NIH-format document supplied by the user.
- **Optional pagination calibration:** export → LibreOffice headless PDF → page count vs
  editor `pageCount`, target ±¼ page on a 12-page doc. Requires
  `sudo apt install libreoffice-writer` (not currently installed); skipped if absent.
- Gate: `npx tsc --noEmit` + `npm test`.

## Files

New:
- `src/docx/read/*`, `src/docx/write/*`, `src/docx/ooxml/*`, `src/docx/*.test.ts`,
  `scripts/fixtures/make-docx-fixtures.ts`
- `src/extensions/format/*` (TextStyle marks, paragraph attrs, Insertion/Deletion,
  CommentRange, PageBreak, Passthrough)
- `src/extensions/pagination/*`
- `src/workers/docxImportWorker.ts`
- `src/services/compliance.ts`, `src/services/formatPresets.ts`
- `src/db/documentRepository.ts`
- `src/components/editor/Toolbar.tsx`, `PageSetupDialog.tsx`, `Ruler.tsx`,
  `CommentsRail.tsx`, `StatusBar.tsx`

Changed:
- `src/types.ts`, `src/db/manuscriptDb.ts` (v3), `src/stores/useDocumentStore.ts`
- `src/components/Editor.tsx` (extensions, page canvas; toolbar extracted)
- `src/extensions/CitationNode.tsx` (cslJson/fieldCode)
- `src/App.tsx` (DOCX open, export wiring; workspace loader dispatch)
- `src/components/GrantPanel.tsx` (real page budgets)
- `src/services/astExport.ts` (read PM JSON)
- `src/index.css` (page canvas, font stacks)
- `package.json` (+ `@fontsource/*`, TipTap text-style/super/subscript; − `docx`)

Removed: `src/services/docxExport.ts`, proportional page-guide code in `Editor.tsx`, unused `mammoth` import in `App.tsx`.
