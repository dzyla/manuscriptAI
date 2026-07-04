# NIH Page View + Font Control — Design

**Date:** 2026-07-03
**Branch:** feat/review-crew-overhaul
**Status:** Approved design, pending implementation plan

## Problem

Page limits in grant mode are useless. The `GrantPanel` budget and the
`Editor` "page guides" both derive page count from a pure word estimate
(`WORDS_PER_PAGE ≈ 500`, `wordsToPages()`) and a *proportional geometry guess*
(`Editor.tsx:141` treats the current column as if it were 7.5 in wide and the
18 px Crimson Pro font as if it were print size). Neither corresponds to a real
8.5×11 in page at NIH formatting, so the numbers drift from reality and give the
author no trustworthy sense of whether they are within a section's page limit.

There is also no font or document-size control, so the author cannot write in an
NIH-acceptable format and cannot see real pages.

## Verified NIH formatting rules (2025 SF424 / application guide)

- **Recommended fonts:** Arial, Georgia, Helvetica, Palatino Linotype.
  Times New Roman is **not** on NIH's recommended list (excluded here).
- **Font size:** ≥ 11 pt (figures/tables may be smaller but legible).
- **Type density:** ≤ 15 characters per linear inch (satisfied by Arial 11).
- **Line spacing:** ≤ 6 lines per vertical inch → line-height ≥ ~1.09 at 11 pt.
- **Margins:** ≥ 0.5 in on all four sides.
- **Paper:** 8.5 × 11 in (US Letter) → text box 7.5 × 10 in per page.

At 96 CSS px/in: page card = 816 × 1056 px, content box = 720 × 960 px,
0.5 in margin = 48 px, 11 pt = 14.67 px, compliant single line-height ≈ 1.15
(≈ 16.9 px/line → ~5.7 lines/in).

## Decisions (from brainstorming)

1. **Pagination fidelity:** discrete page cards with reflow (Google-Docs style),
   block-level breaks. Tall blocks overflow gracefully (no mid-block splitting).
2. **Scope:** a Page-view toggle usable on *any* document, not grant-only.
3. **Font control:** dropdown locked to the NIH-recommended set, 11 pt, default
   Arial.
4. **DOCX export:** included in this build — exported `.docx` matches the on-screen
   margins and NIH font.

## Architecture

### 4.1 Page format model (per-document)

Add to the document a `pageFormat` value:

```ts
interface PageFormat {
  fontFamily: 'Arial' | 'Georgia' | 'Helvetica' | 'Palatino Linotype';
  fontSizePt: number; // fixed 11 for v1; kept as a field for future flexibility
}
```

Default `{ fontFamily: 'Arial', fontSizePt: 11 }`. Stored on the document (via
`useDocumentStore`, persisted to Dexie) so it round-trips and drives export.
Page-view **on/off** is a UI/editor preference (like `editorWidth`/`zoom`),
persisted alongside the other editor prefs, default off.

### 4.2 Page view rendering (Editor.tsx + index.css)

When Page view is ON, the editor container becomes a paginated canvas:

- Gray canvas background; content column is a fixed **720 px** wide (7.5 in) box,
  centered, sitting on **816 px** (8.5 in) white page cards with 48 px padding.
- Page cards are absolutely-positioned white rectangles (shadow, rounded, "Page N"
  label) rendered *behind* the ProseMirror content, one per page, count supplied
  by the pagination plugin (§4.3).
- Zoom uses `transform: scale(zoom/100)` on the canvas wrapper with
  `transform-origin: top center`; page geometry stays in real px so counts are
  exact regardless of zoom.
- A **format strip** (only in Page view) holds the font dropdown (NIH set, Arial
  default) and shows the fixed "11 pt" size. Changing the font updates
  `pageFormat.fontFamily`.
- CSS: a `.page-view` class on the container overrides `.ProseMirror` typography
  to NIH-fixed values — `font-family` from `pageFormat`, body/list/heading all
  11 pt (headings **bold** 11 pt), line-height ~1.15, margins tightened to print
  norms. Normal (non-page-view) mode keeps the existing Crimson Pro prose styles
  untouched.

The existing proportional `pageGuideOffsets` / `showPageGuides` code
(`Editor.tsx:137–155`, `999–1014`) is replaced by the real pagination path.

### 4.3 Pagination extension (`src/extensions/Pagination.ts`)

A TipTap/ProseMirror plugin that produces the discrete-card effect via decorations:

- **Measure** on layout-affecting changes (doc updates + `ResizeObserver` on the
  ProseMirror root), debounced with `requestAnimationFrame`.
- Walk **top-level blocks**, accumulating rendered height within the 960 px content
  box. When the next block would cross the current page's bottom margin, record a
  break **before** that block and insert a **widget-decoration spacer** sized to
  push the block down to the next page's top-margin line.
- **Block-level only:** a paragraph/table/image is never split mid-line — the whole
  block moves to the next page. This is what makes the plugin robust (like Word's
  "keep lines together"). Uneven bottom whitespace where a block jumps is correct
  pagination, not a defect.
- **Tall-block rule:** a single block taller than 960 px overflows past the card
  edge onto the next card rather than splitting. Documented limitation; acceptable
  for grants (figures rarely exceed a page).
- **Output:** the plugin exposes the current page count (plugin state / callback)
  so the Editor can render the matching number of card backgrounds and so the
  page-position lookup (§4.4) can map a document position → page number.

The plugin lives in its own file with a narrow interface: input = editor view +
page geometry constants; output = decoration set + page count + a
`pageForPos(pos)` helper. It can be understood and reasoned about without touching
the rest of the editor.

### 4.4 Real page budgets (GrantPanel.tsx)

When Page view is ON, `GrantToolbar` switches each budgeted section from the word
estimate to the **actual page the section ends on**, using the plugin's
`pageForPos()` against the section's heading/end positions — e.g. "Approach ends
on p. 4 / 9". When Page view is OFF, it falls back to the existing
`wordsToPages()` estimate. This is the payoff that makes page limits trustworthy.

### 4.5 DOCX export (docxExport.ts)

`DocxRenderer` constructor gains `pageFormat`. On export:

- Section `properties.page.margin` set to **720 twips** (0.5 in) on all sides.
- Document default run style set to the chosen font at **11 pt** (22 half-points)
  via `styles.default.document.run = { font, size: 22 }`, plus compliant line
  spacing on the default paragraph style.
- Heading styles set to the same font, bold, 11 pt, so the exported document
  matches the on-screen NIH layout.

The caller that constructs `DocxRenderer` (in `App.tsx` export flow) threads the
document's `pageFormat` through.

## Data flow

```
useDocumentStore.pageFormat ──▶ Editor (.page-view CSS + font strip)
        │                              │
        │                              ▼
        │                    Pagination plugin ──▶ page count ──▶ card backgrounds
        │                              │
        │                              └──▶ pageForPos() ──▶ GrantToolbar budgets
        │
        └──▶ DocxRenderer(pageFormat) ──▶ .docx margins + font
```

## Testing

- Type-check gate: `npm run lint` (tsc). No runtime test harness exists.
- Manual/Playwright smoke: toggle Page view on a multi-page document, confirm
  (a) page cards render with gutters, (b) content flows card-to-card without being
  clipped, (c) a block that would cross a boundary jumps whole to the next page,
  (d) switching NIH fonts changes the on-screen font and page count updates,
  (e) GrantPanel shows real "ends on p. N / limit", (f) exported `.docx` opens with
  0.5 in margins and the selected font at 11 pt.
- Unit-testable pure piece: the block-walking break computation (given block
  heights + page geometry → break indices + page count) can be extracted as a pure
  function and covered by vitest.

## Out of scope (v1)

- Splitting a single block across pages (tall tables/images) — overflow instead.
- Headers/footers, page numbers baked into export, per-section page sizes.
- Line-spacing / font-size controls beyond the fixed NIH defaults (fields exist
  for later).

## Files touched

- `src/types.ts` — `PageFormat` type; document gains `pageFormat`.
- `src/stores/useDocumentStore.ts` — persist `pageFormat`, setter.
- `src/extensions/Pagination.ts` — **new** pagination plugin + pure break helper.
- `src/components/Editor.tsx` — page-view canvas, card backgrounds, font strip;
  remove proportional page-guide code.
- `src/index.css` — `.page-view` NIH typography + canvas/card styles.
- `src/components/GrantPanel.tsx` — real page-position budgets when page view on.
- `src/services/docxExport.ts` — margins + NIH font from `pageFormat`.
- `src/App.tsx` — page-view toggle state/persistence, thread `pageFormat` to export.
