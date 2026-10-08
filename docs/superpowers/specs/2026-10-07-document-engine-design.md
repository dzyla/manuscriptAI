# Document Engine (Word Fidelity, Revisions, Dynamic Citations, NIH Pages) — Design

**Date:** 2026-10-07 (rev 2, after external design review)
**Branch:** feat/document-engine
**Status:** Revised design, pending user review
**Supersedes:** `2026-07-03-nih-page-view-design.md` (never implemented; folded in here)

## Guiding principle

> **Editing a supported part of a collaborator's Word document must not damage unrelated
> content, metadata, citations, or revision history.**

Every implementation decision is checked against this. Where full Word fidelity is not
achievable, the design preserves rather than approximates, and says so in the import report.

## Program context

The app is being overhauled toward a Grantease-class grant + manuscript writing tool.
Deployment: **client-side, SaaS-ready** (no backend now; persistence and LLM access behind
interfaces so auth/sync/key-proxy can be added later).

Delivery order (user-approved, rev 2):

```
A1 → A2 → A3 → B → A4 → A5 → C → D
```

| Phase | Scope | Gate to pass before moving on |
|---|---|---|
| **A1** | Canonical document + format model, asset store, repository, preservation layer, fidelity contract | Migration of existing docs lossless; repository atomicity tests |
| **A2** | Core DOCX interop: paragraphs, runs, styles, headings, lists, tables, images, page setup | Word harness: untouched round-trip + edit-one-paragraph round-trip pass on real Word docs |
| **A3** | Revision + comment engine (inline + structural), DOCX serialization | Word harness: Accept All / Reject All in Word yield the expected structure |
| **B** | Suggestion engine on A3 (AI edits = tracked changes, AI notes = comments) | Own spec |
| **A4** | Dynamic citations (CSL) + Paperpile / EndNote / Mendeley field preservation | Manual Word + Paperpile check (see §7) |
| **A5** | Pagination, formatting UI polish, NIH compliance profile, PDF output + validation | Pagination prototype gate, then calibration gate against Word |
| C, D | Agent pipeline + reviewer; grant workspace | Own specs |

## Problem (2026-10-07 audit)

1. DOCX cannot be opened as the manuscript (`App.tsx:1014-1053` always `JSON.parse`s).
2. DOCX export ignores page setup and fonts; nested lists, table structure, alignment,
   links, super/subscript, WebP images lost; citations become literal `[N]`.
3. No page/format model: font hard-coded, page guides are a proportional guess, grant
   budgets are words ÷ 500.
4. Citations are static `[N]` text with a manual registry; no citation styles, no live
   bibliography.
5. Toolbar lacks font family/size, styles, spacing, super/sub, page break, review tools.

## Non-goals (all of A)

Header/footer editing (preserved only), multiple sections with differing page setup,
columns, line numbering, footnote/endnote editing (preserved), equation editing (preserved),
Word "move" revisions as moves (imported as delete + insert), writing Paperpile's native
field format, real-time collaboration.

---

## 1. Fidelity contract

Every OOXML feature belongs to exactly one category. The import report lists counts per
category; category 4 always produces a visible warning.

| Category | Meaning | Features |
|---|---|---|
| **1. Editable, round-trippable** | Edited in the app; exported semantically equivalent | Paragraphs, runs (font, size, bold/italic/underline, color, super/sub), paragraph + character styles, alignment, spacing, indents, headings, bullet/numbered lists incl. nesting, tables (header row, merged cells, widths), inline images + captions, **floating images with square/tight wrap** (rendered as CSS floats left/right with wrap distance; original anchor XML reused while position/size untouched), page breaks, hyperlinks, page size + margins, tracked insert/delete (inline + paragraph mark + table row), formatting-change revisions, comments with replies/resolved, native citations |
| **2. Approximated, semantically preserved** | Displayed approximately; original XML kept and re-emitted | Floating drawings with other wrap modes (behind/in front of text, top-and-bottom: shown as block images), tab stops, keep-with-next/keep-lines, widow control, table borders/shading, complex numbering formats, external citation fields (Paperpile/EndNote/Mendeley/Zotero: shown with their stored visible text) |
| **3. Opaque, preserved while untouched** | Read-only chip; emitted verbatim with its dependencies; deletable as a unit | Equations (OMML), footnote/endnote references, content controls (SDT) other than Google wrappers, bookmarks, unknown fields, embedded OLE objects, paragraph-level section breaks |
| **4. Unsupported** | Explicit import warning; best-effort text kept | Macros (`.docm` rejected outright), ActiveX, text boxes with complex layout, SmartArt (preserved as cat. 3 where its XML is self-contained, else warned) |

**Google Docs exports are a first-class input.** Real collaborator files arrive via Google
Docs (verified on the user's R01: 83 `w:sdt` wrappers tagged `goog_rdk_*`, embedded fonts in
`word/fonts/`, `customXML`, no field-based citations). `goog_rdk_*` SDTs are transparent
wrappers around runs and are **unwrapped** on import (category 1); embedded fonts are kept
in the package and, when no metric-compatible stand-in exists, loaded as `FontFace` from the
package for display.

**Success criteria are split:**
- *Formatting fidelity* — category 1 features look the same in Word after export.
- *Package preservation* — category 2–3 content survives **as long as its containing
  paragraph is not edited**, and survives editing of its paragraph **if the opaque atom
  itself is not deleted**. Nothing is promised beyond that.

## 2. Canonical model (A1)

### 2.1 ProseMirror JSON is the only source of truth

- `DocumentRow.docJson` holds `editor.getJSON()`. Legacy `content` (HTML) is migrated once
  (`setContent(html)` → `getJSON()`) and then **removed from the row**.
- Code that still needs HTML (LaTeX/Markdown export, existing helpers) receives HTML
  **generated** from the JSON via `generateHTML(json, extensions)`. No second mutable copy.

### 2.2 Format model

```ts
interface PageSetup {
  size: 'letter' | 'a4'; orientation: 'portrait';
  marginsIn: { top: number; right: number; bottom: number; left: number };
}
interface StyleDef {
  id: string; name: string; type: 'paragraph' | 'character' | 'table' | 'numbering';
  basedOn?: string; next?: string;
  // editable (category 1)
  fontFamily?: string; fontSizePt?: number; bold?: boolean; italic?: boolean; color?: string;
  lineSpacing?: { rule: 'auto' | 'exact' | 'atLeast'; value: number };
  spaceBeforePt?: number; spaceAfterPt?: number;
  indent?: { leftIn?: number; firstLineIn?: number; hangingIn?: number };
  align?: 'left' | 'center' | 'right' | 'justify';
  // preserved only (category 2): keepNext, keepLines, widowControl, tabs, borders, …
  preserved?: { pPrXml?: string; rPrXml?: string };
}
interface DocFormat {
  page: PageSetup;
  styles: Record<string, StyleDef>;
  defaults: { fontFamily: string; fontSizePt: number };
  preset: 'nih' | 'manuscript' | 'a4' | 'custom';
}
```

When a document came from DOCX, `styles.xml` is **patched, never regenerated**: only
modelled properties of styles the user changed are rewritten; everything else is copied.

### 2.3 Assets

Images live in a new Dexie table `assets` (`{id, documentId, mime, blob, sha256}`); image
nodes reference `assetId`. Rendering uses object URLs. De-duplicated by hash; unreferenced
assets garbage-collected on save. Replaces data URLs in the document JSON.

### 2.4 Preservation layer (`src/docx/preserve/`)

Fixes the weakness of a bare `{xml}` passthrough: raw fragments depend on relationship ids,
namespaces and other parts.

- **Block provenance.** Every block imported from DOCX carries
  `attrs.ooxml = { blockId, sourceHash }`. The package store keeps
  `blockId → { xml, relIds: string[], nsDecls: Record<string,string> }`.
  `sourceHash` is a hash of the block's ProseMirror JSON at import time, computed with
  the `ooxml` attribute itself excluded.
- **Verbatim reuse.** On export, a block whose current JSON hash equals `sourceHash` is
  written as its **original `<w:p>`/`<w:tbl>` XML**, and every relationship it references
  is carried into the new `document.xml.rels` with its original id and target. This is the
  mechanism that enforces the guiding principle: untouched paragraphs cannot degrade.
- **Opaque atoms.** Category 3 content becomes an inline or block atom
  `{ kind, label, fragmentId }`. The fragment stores XML **with all in-scope namespace
  declarations captured at parse time** and its relationship dependencies. When the
  containing paragraph is regenerated, the atom's fragment is emitted verbatim and its
  dependencies re-registered (ids kept if free, else remapped and rewritten in the fragment).
- **Defined behaviors.**
  - Atom deleted by the user → fragment dropped; its relationships dropped if no other
    block references them.
  - Atom copied → second copy gets a new fragment id; relationships shared (read-only parts).
  - Paired markers (bookmark start/end, comment range markers from foreign tools) are kept
    as two atoms linked by id; if one half is deleted, the other is dropped on export.
  - Paragraph-level `sectPr` → preserved block attribute; only the body-level `sectPr` is
    editable via `PageSetup`.
- **Package parts** kept verbatim from the original: headers, footers, theme, fontTable,
  footnotes, endnotes, settings (with `trackRevisions` toggled from app state), custom XML,
  `people.xml`. Regenerated: `document.xml`, `numbering.xml` (merged: original definitions
  kept, new ones appended), comment parts, `[Content_Types].xml`, rels.

### 2.5 Repository, atomicity, recovery

`DocumentRepository` (Dexie implementation; interface is the SaaS seam):

```ts
interface DocumentRepository {
  load(id): Promise<LoadedDocument>;                 // doc + format + comments + citations meta
  save(doc: LoadedDocument): Promise<void>;          // single Dexie rw transaction across tables
  importDocx(result: ImportResult, decisions: ReconcileDecisions): Promise<string>;
  getAsset(id) / putAsset(blob)
  getPackage(docId)                                   // original .docx + preservation store
  listVersions(docId) / restoreVersion(versionId)
}
```

- `save` writes the document row, comment threads, and asset references in **one IndexedDB
  transaction** (atomic by IndexedDB semantics). Comment threads are stored in the document
  row itself (they are small), so a document and its anchors can never diverge.
- Before each save, the previous row is kept as the newest entry in the existing
  `versionSnapshots` table (bounded ring), giving recovery from a bad save.
- Dexie v3 migration: adds `assets`, `docxPackages`; documents gain `docJson`, `format`,
  `comments`, `citationStyle`; migrates HTML → JSON and data-URL images → assets.
  Migration is idempotent and tested on a snapshot of a real v2 database.

### 2.6 Import transaction boundary

The importer is **pure**: `.docx bytes → ImportResult` with no side effects.
`ImportResult` includes `reconciliationCandidates` (external citation items ↔ existing
Sources by DOI/PMID/normalized title). The UI shows the import report + candidates; only on
confirm does `repository.importDocx` commit everything in one transaction. Sources are never
created or modified by the parser.

### 2.7 Import security

- Reject `.docm`/`.dotm` and any package containing `vbaProject.bin`.
- Limits: compressed size ≤ 50 MB, total uncompressed ≤ 300 MB, ≤ 2000 entries, max
  compression ratio 100:1 per entry (zip-bomb guard), checked from the central directory
  **before** inflating.
- Entry names normalized; reject absolute paths and `..` segments.
- Relationships with `TargetMode="External"` are recorded but **never fetched**;
  linked images render as a placeholder.
- Hyperlinks: only `http`, `https`, `mailto` schemes become clickable; others shown as text.
- ActiveX/OLE binaries are kept as opaque bytes, never executed or rendered.
- XML parsed with `DOMParser` (no DTD/entity expansion in browsers); parse errors →
  category 4 warning for that part.

## 3. Core DOCX interop (A2)

Converters live in `src/docx/` as pure TypeScript; import runs in a new Comlink worker
`src/workers/docxImportWorker.ts`. (`docxWorker.ts` + `mammoth` remain only for the Sources
uploader's plain-text extraction.)

**Import** — `styles.xml` (docDefaults, `basedOn` chains, paragraph + character styles,
headings by `outlineLvl`/"Heading N"); body `sectPr` → `PageSetup`; `w:p` → paragraph/
heading with `styleId` + direct overrides; `w:r` → text with marks from `rPr` and `rStyle`;
`numbering.xml` → nested lists (original numbering ids kept on list nodes for export);
`w:tbl` → table (`gridSpan`, `vMerge`, `tblHeader`, `tblGrid`); `w:drawing` inline →
image asset (anchored drawings → category 2); Caption-style paragraphs → caption;
`w:br type=page` → `PageBreak`; `w:hyperlink` → link.

**Export** — package assembled per §2.4. New documents start from a minimal built-in base
package with `styles.xml` generated from `DocFormat`. Fonts are written by their real
names.

The workspace loader in `App.tsx` dispatches by extension: `.json` → workspace,
`.docx` → importer (fixes audit P0), `.md/.txt` → text import.
`docxExport.ts` and the `docx` npm dependency are removed.

## 4. Revision engine (A3)

Marks alone cannot represent structural revisions. The model combines marks and node
attributes (the approach used by Fidus Writer's ProseMirror track-changes), with one
transaction policy.

### 4.1 Representation

| Revision | Representation | OOXML |
|---|---|---|
| Inserted text | `insertion` mark `{id, author, date}` | `w:ins` around runs |
| Deleted text | `deletion` mark `{id, author, date}` (text stays in doc, rendered struck) | `w:del` + `w:delText` |
| Formatting change | `formatChange` mark `{id, author, date, before: MarkSpec[]}` | `w:rPrChange` |
| Inserted paragraph mark (split) | paragraph attr `markRevision: {type:'ins', id, author, date}` | `w:pPr/w:rPr/w:ins` |
| Deleted paragraph mark (merge) | paragraph attr `markRevision: {type:'del', …}` | `w:pPr/w:rPr/w:del` |
| Paragraph property change | paragraph attr `pPrChange: {id, author, date, before}` | `w:pPrChange` |
| Inserted / deleted table row | row attr `rowRevision: {type, id, author, date}` | `w:trPr/w:ins` / `w:del` |
| Inserted / deleted image or atom | `insertion`/`deletion` mark on the inline atom | `w:ins`/`w:del` around the run |

Revision ids are stable strings generated once per revision and kept through import and
export (Word's numeric `w:id` is mapped on write).

### 4.2 Transaction policy (`src/extensions/revisions/trackPlugin.ts`)

When track changes is on, a plugin rewrites each user transaction before it applies:

- **Typing / paste** → inserted content gets an `insertion` mark (current author). Pasted
  block content also gets `markRevision: ins` on new paragraph marks.
- **Delete over normal text** → content is not removed; it gets a `deletion` mark.
- **Delete over own `insertion`** → content is actually removed (cancels the insertion).
- **Delete over another author's `insertion`** → marked `deletion` (Word behavior).
- **Delete over existing `deletion`** → no-op; cursor moves past it.
- **Typing inside a `deletion`** → insertion placed after the deleted span.
- **Deleting a paragraph boundary** → both paragraphs stay; the first gets
  `markRevision: del`. **Splitting** a paragraph → new paragraph gets `markRevision: ins`.
- **Formatting a range** → `formatChange` mark recording the prior marks (first change
  wins; later changes keep the original `before`).
- **Table row insert / delete** → `rowRevision`.
- **Undo / redo** operate on the rewritten transactions, so undoing a tracked delete
  removes the `deletion` mark (history plugin sees one coherent step).

### 4.3 Accept / reject semantics

Commands `acceptRevision(id)`, `rejectRevision(id)`, `acceptAll`, `rejectAll`,
`acceptInRange`, `nextRevision`, `prevRevision`:

- Accept insertion → remove mark. Reject insertion → delete content.
- Accept deletion → delete content. Reject deletion → remove mark.
- Accept paragraph-mark deletion → join with next paragraph. Reject → clear attr.
- Accept paragraph-mark insertion → clear attr. Reject → join.
- Accept format change → drop `before`. Reject → restore `before` marks.
- Row revisions analogous on table rows.

Pure function core `applyRevisionDecision(doc, id, decision) → Transaction`, unit-tested
on structural cases (multi-paragraph replace, merged paragraphs, deleted row, deleted image).

### 4.4 Comments

Word stores comment anchors **in-band** (`commentRangeStart/End` markers inside the
content stream). The app mirrors that rather than keeping out-of-band anchors, so anchors
survive undo, copy/paste and save atomically with the document.

- `comment` mark `{commentId}` with `excludes: ''` → **overlapping** comments allowed; a
  range spanning paragraphs or table cells is the same mark on each text node.
- `commentPoint` zero-width inline atom `{commentId}` for insertion-point comments.
- Threads (`{id, author, initials, date, text, replies, resolved, wordIds}`) stored in the
  document row (§2.5). `wordIds` keep original `w:id`, `w14:paraId`, `w16cid:durableId`.
- Anchor deleted entirely → thread marked `orphaned`, shown in the rail's "Detached"
  section, never silently deleted; exported as a point comment at the deletion site.
- DOCX parts read + written: `comments.xml`, `commentsExtended.xml` (`paraIdParent`,
  `done`), `commentsIds.xml` (durable ids), `commentsExtensible.xml` (UTC dates),
  `people.xml` (authors).

### 4.5 Gate

The Word harness (§8.2) must show: Word opens exports without repair; Word's
`Revisions.AcceptAll` and `RejectAll` on our exported file produce text and paragraph
structure equal to the app's own accept-all / reject-all; Word-authored revisions and
comments import and re-export unchanged.

## 5. Dynamic citations (A4)

### 5.1 Native citations (CSL, live)

- `citation` inline atom `{clusterId, items: [{sourceId, locator?, prefix?, suffix?,
  suppressAuthor?}]}` — one node per citation cluster (`[3–5]`, `(Smith 2020; Lee 2021)`).
- Sources hold CSL-JSON (`useSourceStore`; BibTeX / DOI / PubMed / PDF imports convert to
  CSL-JSON).
- Document has `citationStyle` (CSL style id). Rendering via **citation-js** (already a
  dependency) with bundled styles: NLM/Vancouver, NIH-common numeric, APA, Nature, Cell,
  PNAS, Science, Chicago author-date; any `.csl` file can be added.
- Cluster text and the `bibliography` block are **computed**, never stored as text: they
  re-render on any citation insert/remove/reorder or style change. Numbering in numeric
  styles follows first appearance automatically. This replaces `citationRegistry` +
  `renumberCitations()`; A4 migrates the remaining call sites (B leaves citation code
  untouched so it does not depend on A4).
- The existing `@` picker inserts clusters; a cluster popover edits items, locators,
  prefix/suffix.

### 5.2 External citations (Paperpile / EndNote / Mendeley / Zotero)

Verified from the installed Paperpile Word add-in: it stores clusters as
`ADDIN paperpile_citation <clusterId>…</clusterId><metadata>…</metadata><data>BASE64-JSON</data>`
with an `ADDIN paperpile_bibliography` field, and it ships converters from Mendeley
(`ADDIN CSL_CITATION {CSL-JSON}`), Zotero and EndNote fields into its own.

- External fields import as an `externalCitation` atom `{manager, fieldCode,
  resultXml, items: CSL-JSON[] | null, clusterKey}` — **category 2**: the stored visible
  result is displayed exactly as the manager rendered it; the field code is kept verbatim.
  - Paperpile: `<data>` base64 JSON decoded (best effort) to list items in the popover.
  - Mendeley / Zotero: CSL-JSON in the field parsed directly.
  - EndNote: `EN.CITE` record XML parsed for title/authors/year/DOI.
- External bibliography fields → `externalBibliography` block, preserved verbatim.
- External citations are **not renumbered and not restyled** by the app.
- **Reconciliation is separate and non-destructive**: a "Link to library" action matches
  items to Sources (DOI → PMID → normalized title + year) and stores the link on the node;
  the field and its visible text are untouched.
- User edits to an external cluster (add/remove item) convert that cluster to a native
  citation and record it in the report; the original field is not partially rewritten.

### 5.3 Export rules

| Citation | Exported as |
|---|---|
| External, untouched | Original field verbatim (begin / instrText / separate / result / end) |
| Native (or converted) | Live **`ADDIN CSL_CITATION {CSL-JSON}`** field (Mendeley schema) with the rendered text as field result; native bibliography → `ADDIN CSL_BIBLIOGRAPHY` field |

CSL_CITATION is an open, documented format. Mendeley Cite reads it natively and Paperpile's
add-in converts it into live Paperpile citations ("Convert Mendeley citations"), so citations
written in the app remain refreshable in Word.

### 5.4 Gate (manual, documented checklist)

On the Windows host with Word + Paperpile: (1) open an exported doc with untouched
Paperpile citations → Paperpile Refresh succeeds; (2) native citations → Paperpile
"Convert Mendeley citations" yields live Paperpile citations that refresh; (3) EndNote and
Mendeley fixtures preserved byte-identical. Automatable parts (field codes present and
well-formed, Word opens without repair, `Fields.Count` unchanged) run in the Word harness.

## 6. Pagination, formatting UI, NIH (A5)

### 6.1 Metric-compatible fonts

Bundled via `@fontsource` (offline-capable): Arial/Helvetica → Arimo, Georgia → Gelasio,
Palatino Linotype → TeX Gyre Pagella, Times New Roman → Tinos, Calibri → Carlito. CSS
stacks list the real font first, stand-in second; export writes real names. Fonts reduce
but do not eliminate layout divergence from Word (shaping, line-breaking), which is why
calibration (§6.3) is a gate, not an assumption.

### 6.2 Pagination — prototype first

**Prototype (gate P):** a non-destructive paginator, document stays continuous:

- Measure line boxes with `Range.getClientRects()` over each text block's DOM and map
  each line start to a document position with `view.posAtDOM()` (not `posAtCoords`).
- Measurement is done on **natural geometry**: known spacer heights above a line are
  subtracted, so inserted spacers do not feed back into the layout plan. Re-pagination is
  incremental from the first changed block; a pass must converge in ≤ 2 iterations
  (asserted; oscillation falls back to block-level breaks for that block).
- Breaks rendered as ProseMirror **widget decorations** (`side: -1`, `ignoreSelection`,
  `<span contenteditable=false style="display:block">` sized to the remaining page + top
  margin of the next card). Card backgrounds are absolutely positioned behind the editor.
- Tables, images and opaque blocks break at block level. Keep-with-next on headings
  honored (heading never last line of a page). No widow/orphan control in v1.
- Pure core `planPages(lines, geometry, keepRules) → {breaks, pageCount, posToPage}`.

Prototype acceptance: selection drag, shift-click, copy/paste, IME typing, comments,
tracked revisions and find/scroll all behave identically across page breaks; typing at
the bottom of a page stays smooth (≤ 16 ms re-plan for a 15-page doc on the dev machine).

**Fallback if P fails:** block-level cards for display + `planPages` run on measured line
boxes for **page counts and section end positions only** (accurate numbers, less pretty
cards). Decided at the gate, recorded in the plan.

"Draft" toggle = continuous view. Page view is the default.

### 6.3 Calibration — mandatory gate

Baseline is **Microsoft Word**, driven via PowerShell COM from WSL (verified available:
Word 16.0). For each calibration document: export → Word opens → `ComputeStatistics(pages)`
and per-section end positions via `Range.Information(wdActiveEndPageNumber)` +
line number → compare with `planPages`.

- **Page count: exact match** on every calibration document.
- **Section end position: within ±3 lines** of Word.
- Calibration set (local only, `fixtures/private/`, gitignored, never committed):
  1. User's real R01 (Google Docs export; Word baseline: **17 pages, 12,434 words,
     32 revisions, 52 comments, 10 floating figures**).
  2. Word-derived variants of (1) produced by the harness via COM: re-saved as native Word
     OOXML; revisions accepted; body font switched to Georgia and to Palatino Linotype.
  3. 2–3 NIAID sample applications (public PDFs, educational use) converted to `.docx` by
     Word's PDF reflow, kept unmodified apart from format conversion.
  4. Word-generated stress documents (dense text, many headings, tables, figures), built
     by the harness through COM so their OOXML is genuinely Word-authored.
  5. One copy of (1) with Paperpile citations inserted by the user (for §5.4).
- Per-font "single" line-height factors are fitted from Word measurements, not guessed.

### 6.4 Formatting UI

- **Toolbar** (compact Word-style ribbon): Styles dropdown with live previews · Font family
  ("NIH recommended" group with ✓, then others) · size · B/I/U · super/sub · color ·
  alignment · line spacing · lists · indent · Insert (table, figure, page break, citation)
  · Review (track changes, accept/reject, prev/next, new comment). Overflow "⋯" at narrow
  widths.
- **Page setup dialog:** presets NIH (Arial 11, 0.5" margins, Letter, single), Journal
  manuscript (Times 12, double, 1"), A4, Custom; paper size, margins, Normal/Heading/
  Caption styles.
- **Ruler** with draggable left/right margin handles.
- **Comments rail** in the right margin aligned to anchors; reply, resolve, detached section.
- **Status bar:** "Page X of Y", words, compliance badge.
- **Citation style picker** + bibliography placement.
- A dedicated visual-design pass (frontend-design skill) during implementation.

### 6.5 NIH compliance — three levels

`ComplianceProfile = { ruleset: 'nih-2025', attachment: AttachmentType, opportunity?:
{ pageLimit?, hyperlinksAllowed?: boolean, extraRules? } }`. The profile is chosen
explicitly (grant template or user), **independent of the formatting preset**.

Rules verified against NIH "Format Attachments" (grants.nih.gov, fetched 2026-10-07):

| Level | Checks | Severity |
|---|---|---|
| **1. Document formatting** | Body text ≥ 11 pt; ≤ 15 chars per linear inch (font metrics); ≤ 6 lines per vertical inch; margins ≥ 0.5"; paper ≤ 8.5×11 | Error |
| | Font outside Arial/Georgia/Helvetica/Palatino Linotype | Info ("acceptable if it meets the density/size rules", which are checked separately) |
| | Figure/table text < 11 pt | Info ("must be legible at 100%"; no fixed cutoff) |
| **2. Attachment requirements** | Page limit for the attachment type (from the grant template / opportunity); headers or footers present ("Do not include headers or footers"); content in margins; hyperlinks present when `hyperlinksAllowed` is false; when allowed, link text must show the actual URL | Error / warning |
| **3. Submission validation** | Run on the **exported PDF**: page size, page count vs limit, minimum rendered body font size, fonts embedded, not encrypted | Error |

### 6.6 PDF output + validation

NIH accepts PDF only. The app produces the submission PDF **from its own page view**:
Electron `webContents.printToPDF` (exact page size, zero margins since the cards include
them); browser build uses print CSS (`@page` size + margins) via `window.print()`.
Level-3 validation parses the produced PDF with `pdfjs-dist` (already a dependency): page
dimensions, page count, text item font sizes (scaled by transform), font embedding flags.
The DOCX path remains for collaborators; "NIH-compliant" is only claimed for a PDF that
passed level 3.

## 7. Error handling

- Malformed / oversized / macro-enabled `.docx` → clear toast; current document untouched
  (nothing committed until the import transaction).
- Per-element parse failure → element becomes an opaque atom (category 3) or category 4
  warning; import continues.
- Export failure → toast with reason; never writes a partial file.
- Save failure → previous version kept in `versionSnapshots`; toast offers restore.
- Missing fonts → stand-in used; one-time notice names the substitution.

## 8. Testing

### 8.1 Unit (vitest, CI)

Converters per feature, `planPages`, `applyRevisionDecision`, track-plugin policy cases,
comment anchor mapping, compliance rules, style resolution, unit conversion, preservation
(verbatim reuse + rel remapping), migrations, zip-bomb/path-traversal guards, CSL rendering.
Synthetic fixtures generated by `scripts/fixtures/make-docx-fixtures.ts` (reviewable).

CI: `.github/workflows/webpack.yml` currently only builds; add `npx tsc --noEmit` and
`npm test`.

### 8.2 Word interoperability harness (local, `npm run verify:word`)

Node script → copies files to a Windows temp dir → PowerShell COM (`Word.Application`,
invisible) → per file: open (detect repair prompts via `Documents.Open` errors /
`OpenAndRepair:false`), counts (paragraphs, tables, comments, revisions, fields, inline
shapes), page count, `ExportAsFixedFormat` PDF, `Revisions.AcceptAll`/`RejectAll` on
copies → saves → re-imported by the app's reader for structural comparison. Results
written as JSON + a markdown summary. Skips with a clear message when Word is unavailable.

### 8.3 Acceptance matrix

| Test | Required result | How |
|---|---|---|
| Untouched Word DOCX → export | Byte-identical blocks for all paragraphs; no Word repair; counts equal | Harness, real docs |
| Edit one paragraph → export | All other blocks verbatim; counts equal except the edited block | Harness |
| Word tracked changes round-trip | Accept/Reject All in Word == app accept/reject all | Harness |
| Multi-paragraph / merged-paragraph / table-row revisions | Structure correct after accept and after reject, in app and in Word | Unit + harness |
| Comments with replies + overlaps + point comments | Threads, authors, resolved state, anchors intact in Word | Harness |
| Paperpile / EndNote / Mendeley citations | Fields verbatim; Paperpile Refresh works; native CSL fields convert in Paperpile | Harness + manual §5.4 |
| Nested lists, merged tables | Numbering and spans correct in Word | Harness |
| Pagination | Gate P + calibration §6.3 | Harness + Playwright |
| Repeated edit/export ×10 | No cumulative change in untouched content (hash-stable) | Unit + harness |
| Malformed, huge, zip-bomb, macro docs | Safe rejection, existing data intact | Unit |
| NIH PDF | Level-3 validation passes on a compliant doc, fails on seeded violations | Unit + Playwright |

Real documents are required alongside synthetic fixtures; the set is defined in §6.3.

### 8.4 UI

Playwright smoke (scratchpad pattern from prior work): import, page view, font/preset
change, comment, tracked edit + accept, citation insert + style switch, export DOCX + PDF.

Gate for every phase: `npx tsc --noEmit` + `npm test` + that phase's harness checks.

## 9. Files

New:
- `src/docx/read/*`, `src/docx/write/*`, `src/docx/preserve/*`, `src/docx/ooxml/*`,
  `src/docx/security.ts`, tests alongside
- `src/workers/docxImportWorker.ts`
- `src/extensions/format/*` (text-style marks, paragraph attrs, PageBreak, opaque atoms)
- `src/extensions/revisions/*` (marks, attrs, `trackPlugin`, `applyRevisionDecision`)
- `src/extensions/comments/*` (comment mark, point atom)
- `src/extensions/citations/*` (cluster atom, external citation atom, bibliography blocks)
- `src/extensions/pagination/*` (`planPages`, plugin)
- `src/services/csl.ts` (citation-js rendering, bundled styles)
- `src/services/compliance/*` (profiles, rules, PDF validator)
- `src/services/formatPresets.ts`, `src/services/pdfExport.ts`
- `src/db/documentRepository.ts`
- `src/components/editor/Toolbar.tsx`, `PageSetupDialog.tsx`, `Ruler.tsx`,
  `CommentsRail.tsx`, `StatusBar.tsx`, `ImportReportDialog.tsx`, `CitationPopover.tsx`
- `scripts/fixtures/make-docx-fixtures.ts`, `scripts/verify-word/*` (Node + PowerShell)

Changed:
- `src/types.ts`, `src/db/manuscriptDb.ts` (v3), `src/stores/useDocumentStore.ts`,
  `src/stores/useSourceStore.ts` (CSL-JSON)
- `src/components/Editor.tsx` (extensions, page canvas; toolbar extracted)
- `src/extensions/CitationNode.tsx` → replaced by `src/extensions/citations/`
- `src/App.tsx` (DOCX open, export wiring, loader dispatch)
- `src/components/GrantPanel.tsx` (real page budgets, compliance profile)
- `src/services/astExport.ts` (HTML generated from JSON)
- `src/index.css`, `package.json` (+ `@fontsource/*`, TipTap text-style/sub/superscript;
  − `docx`), `.github/workflows/webpack.yml`

Removed: `src/services/docxExport.ts`, proportional page-guide code in `Editor.tsx`, unused
`mammoth` import in `App.tsx`, `citationRegistry`/`renumberCitations` (in A4).
