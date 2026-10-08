# A2b writer contract: what the DOCX reader (A2a) hands the writer, and what the writer must do with it

Status: binding input for A2b. Written at the end of A2a (branch `feat/a2-docx-interop`) by an agent that had not taken part in
building it, from the code, the spec and the plan alone, as a test of whether the contract is derivable. Where this document and a
code comment disagree, that is a bug in one of them: fix it, do not pick one silently.

Read first: `2026-10-07-document-engine-design.md` (fidelity contract section 1, canonical model section 2, preservation layer
section 2.4, import transaction 2.6, security 2.7) and the A2a plan (`docs/superpowers/plans/2026-10-07-a2a-docx-reader.md`,
closing note: "A2a's output must already contain everything the writer needs: original bytes, block fragments with rel ids, opaque
fragments, style ids and the unmodelled-property remainders").

A2a is the reader only. There is no writer, no `styles.xml` patching, no verbatim block reuse on export, no Word interoperability
harness (`npm run verify:word`) and no acceptance matrix in it; those are A2b.

## 0. How to use this document

Sections 2 to 12 are rules, grouped by what the writer is emitting. Each states the rule, why, and where the code that holds it
lives (`Code:`). Section 13 lists the imperfections A2a accepted on purpose and the writer inherits. Section 14 lists what must be
MEASURED in Word, not reasoned about. Section 15 gives the real-document numbers to use as acceptance baselines.

A rule written "must" is a contract. A rule written "suggested" is a design hint the writer may replace. Anything a section does not
say is undefined, not permitted.

The four promises the whole preservation layer exists to keep (A2a keeps them on the way in; the writer keeps them on the way out):

1. Anything the app does not model is preserved, never dropped.
2. Per-paragraph provenance survives everything, so an untouched paragraph is re-emitted verbatim.
3. Nothing inferred is applied without the author accepting it (inferred headings).
4. External (`r:link`) relationships are recorded but never fetched. Nothing in `src/docx/**` makes a request, and the writer must
   not either: an external relationship is copied as data (`targetMode: 'External'`).

## 1. What A2a hands the writer, and where it is

`readDocx(bytes)` (`src/docx/read/index.ts`) returns an `ImportResult`. After the author confirms, `repository.importDocx`
(`src/db/documentRepository.ts`) writes it in ONE transaction:

| `ImportResult` field | Persisted as | What it is for the writer |
|---|---|---|
| `doc` | `documents` row, `docJson` (the model, ProseMirror JSON) | The source of truth for everything the app models. |
| `format` | `documents` row, `format` (`DocFormat`) | Page setup (size, margins), `styles` (`StyleDef`, ids are the APP's), defaults. |
| `original` | `docxPackages` row, `original` (ArrayBuffer) | The package, byte for byte. Never rewritten by a save. Every part the app does not model is re-emitted from it. |
| `preservation` | `preservationStores` row, `store` (`PreservationStore`) | `blocks` (blockId to original `<w:p>`/`<w:tbl>` XML), `fragments` (fragmentId to opaque atom / image run XML), `rels`, `styles`. Mutable: pruned and extended by saves. |
| `assets` | `assets` table, by `assetId` (`a_` + first 32 hex of the SHA-256) | The bytes of every image the model references. |
| `report`, `headingCandidates`, accepted indexes | `importReports` row | What the author was told, and which inferred headings were accepted. |
| `figures` | NOT persisted | Caption pairings as positions in `doc.content` at read time. They go stale at the first edit; recompute with `matchCaptions(doc.content)` (`src/docx/read/drawings.ts`). |

Identity: the `documents` row, the `docxPackages` row, the `preservationStores` row and the `importReports` row all carry the same
`importId`. A package and preservation store may be used ONLY for a document whose `importId` equals theirs. Block ids (`b1`,
`b2`, ...) and fragment ids are import-local counters, NOT globally unique: two different imports share ids, so provenance cannot
be used to tell whether a package belongs to a document. New Manuscript, workspace load, template apply, text import and Version
History restore detach the package (`replaceWithHtml`, `resetDocument` in `src/stores/useDocumentStore.ts`); a document with no
matching package is a document made in the app and is exported from the minimal base package (spec section 3).
Code: `src/types.ts` (`DocumentRow.importId`, `DocxPackageRow`, `PreservationRow`), `src/db/documentRepository.ts`.

Backups: replacing a document by an import keeps the replaced one, with its package and preservation store, in
`importBackupParts`; `revertImport()` swaps it back. A writer reads only the CURRENT rows (`repo.getPackage()`,
`repo.getPreservation()`).

## 2. FROZEN FORMATS (read this before changing the schema)

### 2.1 `blockHash` covers every attribute, so any schema change can switch the whole preservation layer off, silently

`blockHash(node)` (`src/docx/preserve/hash.ts`) is `cyrb53(stableStringify(node))` with only the `ooxml` attribute removed
(and, for a `resizableImage`, `src`, a session `blob:` URL filled in when a document is opened). EVERYTHING else is in the hash: every
attribute of the node and of every descendant, and every mark with its attributes. `ooxml.sourceHash` was computed this way over the
node as it was read, and is stored in the user's IndexedDB.

Consequence, stated so it cannot be misread: **adding ANY attribute to ANY node or mark type, with ANY default (including `null`),
changes the JSON of every stored node of that type, so `isBlockUntouched` answers false for every imported block that contains one.
Every untouched paragraph silently becomes "edited". Nothing throws, nothing is logged, nothing is shown. The writer then regenerates
the whole document from the model, and the unmodelled paragraph properties, bookmarks, comment anchors and section breaks that only
the verbatim XML held are lost.** The same holds for changing a default, an attribute's name, `stableStringify`, `cyrb53`,
`stripProvenance`, or the order in which `normalizeDoc` fills attributes.

Upcoming work that will do this unless it is careful: revisions (A3: author/date attributes on nodes or marks), dynamic citations
(A4), pagination and formatting UI (A5), the style audit (H, highlights as marks). Each must either not add stored attributes to
block nodes, or version the hash first.

The format is **frozen once A2a ships**. Before changing anything above: store a hash version beside `sourceHash` (and
`structureHash`, and `lifted[].sourceHash`), or hash against an explicit allow-list of attributes, and re-stamp stored documents
on migration. The golden test `FROZEN FORMATS` in `src/docx/preserve/hash.test.ts` pins the hash of one paragraph, heading, image and
table (and the table's `structureHash`) against literals; if it fails, you are in this situation. Do not just update the literal.

### 2.2 The other frozen values

- `structureHash` (tables): compared byte for byte against `ooxml.structureHash`. Its format changed during A2a development; any
  further change makes every stored table read as "structure changed" (section 5.3) and be rebuilt without its original shell. Frozen.
- `lifted[].sourceHash` (`preservation.blocks[hostBlockId].lifted`): the `blockHash` of the lifted image node as read. Frozen for the
  same reason: a change makes every stored record read as `edited` or differ.
- `PreservationStore.version` is 1. `styles` was added to it without a version bump because it is optional (absent means "not made
  by `readDocx`"); a store without it must be handled.

Code: `src/docx/preserve/hash.ts`, `src/docx/preserve/lifted.ts`, `src/docx/preserve/types.ts`.

## 3. Paragraphs, headings and provenance

### 3.1 Verbatim reuse

Every paragraph and heading the reader produced carries `attrs.ooxml = { blockId, sourceHash }` and a stored original:
`preservation.blocks[blockId]` is a `Fragment { xml, relIds, nsDecls }` holding the original `<w:p>` with only the namespaces it uses
declared (each fragment re-parses on its own). `isBlockUntouched(node)` (`hash.ts`) compares `blockHash(node)` with `sourceHash`.

- **Untouched: re-emit `blocks[blockId].xml` verbatim**, carrying every relationship id in `relIds` into the new
  `document.xml.rels` with its original id and target (`preservation.rels`), remapping with `allocateRelIds` / `remapRelIds`
  (`src/docx/preserve/xml.ts`) only if an id is taken.
- Emit each `blockId` **at most once**. The editor's guard (`OpaqueFragmentGuard`, `src/extensions/preserve/OpaqueNodes.ts`) clears
  duplicated provenance on paste and split, keeping it on the node that still hashes to its `sourceHash` (else the first), but a JSON
  load or any other path may not have passed through it. Two copies of one `<w:p>` duplicate every bookmark and comment id in it.
- Provenance is stamped on `paragraph`, `heading`, `table` and a `resizableImage` that stands for a whole paragraph. A block-level
  `opaqueBlock` carries a `fragmentId` and no `ooxml` (it is emitted from its fragment, section 4). A list node (`bulletList`,
  `orderedList`) has NO `ooxml` of its own: its items' paragraphs do (section 9).
- A paragraph that failed schema normalization at read time keeps its text but has NO `ooxml` and no stored block (its atoms were
  withdrawn with it). It is always generated. A paragraph with no `ooxml` (typed, pasted, split) is always generated.

Code: `src/docx/read/paragraphs.ts`, `src/docx/preserve/hash.ts`, `src/extensions/preserve/OoxmlProvenance.ts`.

### 3.2 Edited paragraph: rebuild from the model, but start from the original `<w:pPr>`

An edited paragraph keeps its `blockId`, so `blocks[blockId].xml` is still there. The model owns only some paragraph properties:
`styleId`, `textAlign`, `lineSpacing`, `spaceBefore`, `spaceAfter`, `indentLeft`, `indentFirstLine` and, on a heading, `level`. The
writer **must** build the new `<w:pPr>` from the original one, not write a fresh `<w:pPr>` from the node. What lives only in the
original `<w:pPr>` and is lost otherwise: `w:numPr` (list membership and level, subject to 3.5), `w:keepNext`, `w:keepLines`,
`w:pageBreakBefore`, `w:widowControl`, `w:tabs`, `w:shd`, `w:pBdr`, `w:framePr`, `w:ind` right/start/end, the paragraph-mark `w:rPr`,
**`w:sectPr` (a paragraph-level section break, section 11)**, and any `w:pPrChange`.

**The rule for the owned properties is a diff, and it is binding.** Read the original `<w:pPr>` back with the reader's own property reader
(`readProps` in `src/docx/read/paragraphs.ts`; it is not exported yet, export it or run `readParagraph` on the stored XML), which yields
the model values the paragraph had at import. For each owned property:
- node value equals the re-read value: leave the original XML for that property EXACTLY as it is (this keeps spellings and extra
  attributes the model cannot express);
- node value differs: the node wins, and **a node `null` means "inherit from the style": REMOVE the explicit property**. If the author
  cleared `indentLeft` and the original has `<w:ind w:left="720"/>`, remove `w:left` (keep the other `w:ind` attributes whose model value
  is unchanged; drop the element if none remain). Leaving it would silently discard the author's edit.
When `styleId` changes (including by the heading rule in 3.4), write the new `w:pStyle` by REPLACING the original one, never adding
a second, and **drop any direct `w:outlineLvl`** (a stale one survives next to the new style otherwise and makes Word outline the
paragraph at the old level).

Run properties are different: there is no per-run provenance. Marks are written from the model. What a rebuilt paragraph loses
(accepted, section 13): unmodelled `w:rPr` children (`caps`, `lang`, `kern`, ...), `w:b w:val="0"` overrides, hyperlink targets that
are not `http`/`https`/`mailto`, `smartTag` / `customXml` wrappers, Google `sdtPr`, `w:noBreakHyphen` (read as `-`), and the layout
cache `lastRenderedPageBreak`.

Heading precedence, recorded because 3.2 and 3.4 depend on it: the reader decides a paragraph's heading level from its style first
and a direct `w:outlineLvl` second, the INVERSE of Word (where the direct value wins). For an untouched paragraph that is irrelevant
(it is verbatim). For a rebuilt heading the node's `level` is authoritative (3.4).

Rebuilt paragraphs reference styles by Word id, never by the app's id: section 10.

### 3.3 Page breaks, splitting, Google wrappers

- `pageBreak` is an INLINE atom so that a paragraph with a break stays one node and one owner of the original XML. Splitting such a
  paragraph duplicates its `blockId` (the guard clears one). The writer writes a `<w:br w:type="page"/>` run for it.
- Google Docs `goog_rdk_*` content controls are unwrapped on read and their own `sdtPr` is stored nowhere. An untouched
  paragraph still carries its wrapper inside the verbatim XML; a block-level wrapper (around several paragraphs) is gone.
- Hyperlinks: only `http`, `https`, `mailto` become link marks. Others are text.

### 3.4 Headings

A document that styles no headings (neither real grant does) gets `headingCandidates` (`src/docx/read/headings.ts`), which are NOT
applied until accepted. An accepted candidate is converted in place by `applyHeadings`: the node becomes `heading` with `level` and
`styleId: null`, `ooxml` unchanged. Its hash no longer equals `sourceHash` (the type and level are hashed), so it reads as **edited**:
rebuild it, starting from the original `<w:pPr>` (3.2). An unaccepted candidate leaves the paragraph a paragraph, untouched and verbatim.

**For a `heading` node, `level` is authoritative and `styleId` is not.** The author makes headings with the toolbar too
(`Editor.tsx` calls `toggleHeading`), and that keeps whatever `styleId` the node had: `toggleHeading({level: 2})` on an imported Word
Heading 1 gives `heading{level: 2, styleId: 'heading1'}`, and `toggleHeading({level: 1})` on an imported body paragraph gives
`heading{level: 1, styleId: 'bodyText'}`. So, for every `heading` node written by the generator (rebuilt, converted, or new):
1. If `styleId` is `heading1`, `heading2` or `heading3` AND equals `heading<level>`, use it.
2. Otherwise ignore `styleId` and use the style for `heading<level>`.
3. Resolve that app style id to a Word id through section 10: `wordIdByAppId['heading<level>']` if the document defines it; if it is
   `backfilled`, ADD a definition to `styles.xml` first. REPLACE any `w:pStyle` already in the original `<w:pPr>` (never add a second)
   and drop its `w:outlineLvl` (3.2).
The result must never be a heading with the body style, or with no heading style at all.

The direct formatting an inferred heading was detected by (bold, a larger `fontSize` mark) stays in the model as marks and **is
written as it is**: it is the author's own formatting, it reproduces exactly what they saw in Word, and a direct run property wins over
the style, so it does not stack. Do not strip it. The heading style adds the outline level and navigation, not a new look.

A numbered Word heading loses its visible number in the editor (recorded as `complexNumbering`): never regenerate a heading that
carries `w:numPr` from the node alone; start from its `<w:pPr>`.

### 3.5 What `isBlockUntouched` cannot see

A paragraph's hash covers the paragraph node and everything inside it. It does not cover its CONTAINER, so a paragraph can be moved
and still read untouched. A writer must reconcile, for every paragraph it re-emits verbatim:

- **List membership and level.** `w:numPr` is inside the paragraph's XML, but the list is a container in the model. A paragraph lifted
  out of a list, put into one, moved to another list, nested deeper, or left in a list whose kind was toggled between bullets and
  numbers is still hash-untouched, and its verbatim `<w:numPr>` is now stale. Compare the verbatim `numPr` with the container (section
  9.1) and patch the numId and `ilvl` in the verbatim XML, or, for a paragraph that left every list, remove the direct `numPr` (if a
  style carries the numbering, write `<w:numPr><w:numId w:val="0"/></w:numPr>` to suppress it).
- **Cell position** (section 5.2) and **lifted pictures** (section 6.2): handled by the rules there.
- **Ids that must be unique in the whole document.** Verbatim XML keeps its original ids (`w:id` of bookmarks, comment ranges and
  revisions; `wp:docPr@id`). Anything the writer generates (a new bookmark, a new drawing) must take an id unused anywhere in the
  output, and a fragment emitted a second time (a pasted atom) is a duplicate of ids already in the document: give the copy fresh
  ids (section 14 item 4 asks Word what it does with duplicates).

## 4. Opaque atoms and fragments

Category 3 content (equations, footnote and endnote references, content controls, bookmarks, fields, tracked changes, comment
anchors, OLE objects) is an `opaqueInline` or `opaqueBlock` node `{ kind, label, fragmentId }`. `preservation.fragments[fragmentId]`
is its XML, with only the namespaces it uses, and its `relIds`. A run-level atom keeps its run's `w:rPr` (a footnote reference stays
superscript).

- **Emit the fragment verbatim** where the atom stands in a generated paragraph, and register its `relIds` as in 3.1.
- Atom deleted: drop the fragment; drop its relationships if no other emitted block or fragment references them.
- Atom copied: the editor's guard gives the copy a fresh `f_<uuid>` and clones the XML into the store in the same transaction as
  the document save (`onDuplicateFragment`), so a copy has its own fragment. Relationships are shared.
- Paired markers are linked by id: bookmark start/end, comment range start / end / reference, and the pieces of a complex field
  (`field start`, `field code` or `citation field code`, `field separator`, `field result`, `field end`). If one half of a pair is gone,
  drop the other. A field's displayed result between the chips is ORDINARY EDITABLE TEXT: editing a paragraph that holds a split
  citation field can break the field (section 13).
- **The writer must tolerate a missing fragment.** A node can reference a `fragmentId` that is in no `preservation.fragments`:
  undo past the 10-entry backup ring can restore an atom whose fragment was already pruned. Do not throw: skip the atom with an export
  warning (a picture falls back to being emitted from the model, 6.5). Code: `src/docx/preserve/refs.ts` (`pruneFragments`). A missing
  fragment leaves the NODE in the document, which interacts with three other rules, so after every fragment-miss skip:
  - **re-run the pairing and field checks.** Skipping one `commentRangeStart` and still emitting its `commentRangeEnd`, or dropping a
    field start and emitting its code and end, produces a broken pair; the checks above must run on the set of atoms actually emitted,
    not on the nodes in the model;
  - **a skipped `opaqueBlock` that was a table cell's only block** leaves a `<w:tc>` with no `<w:p>`, which Word rejects: apply 5.5 to
    the emitted cell, not to the model's;
  - **a `strip` (6.2) never needs the fragment**: it works from the host's `blocks` entry and the `lifted` record, so a pruned image
    fragment does not prevent stripping the deleted picture from its host.
- `preservation.rels` holds ONLY the relationship ids the stored XML uses, plus the ids the body's `sectPr` uses for headers and
  footers. It is not the package's relationship list. Everything else (styles, numbering, footnotes, theme, settings, comments,
  fonts) must be read from the original `word/_rels/document.xml.rels` in `original`.

## 5. Tables

A `table` node has `ooxml = { blockId, sourceHash, structureHash }`; `blocks[blockId].xml` is the whole original `<w:tbl>`
(borders, shading, margins, row heights, the table style, revision marks, the cells folded into merges). A nested table has its own
entry and is also inside its parent's. A model row is a `<w:tr>`, a model cell a `<w:tc>`; cells hold paragraphs (each with its own
`ooxml`), lists (grouped per cell), nested tables and opaque blocks. Cell and row nodes carry NO provenance.
Code: `src/docx/read/tables.ts` (header), `src/docx/preserve/hash.ts` (`structureHash`, `isTableShellUnchanged`).

Decide per table, in this order:

### 5.1 Untouched: `isBlockUntouched(table)`

Re-emit `blocks[blockId].xml` verbatim. Nothing else to do (a lifted-picture strip cannot apply inside it: removing or moving such a
picture changes the table's JSON and so its hash).

### 5.2 Shell unchanged: `isTableShellUnchanged(table)` (true) and not untouched

`structureHash` licenses **only** reusing the shell: `tblPr`, `tblGrid`, each row's `trPr` and each cell's `tcPr`. It does not say
where content is. **Rebuild each cell's block sequence from the model by `blockId`**, re-emitting an untouched block's original XML,
generating the rest. Never patch "only the edited paragraphs" into the old cells.

Five rearrangements leave `structureHash` equal, and a writer that patches in place silently loses them: (1) an untouched paragraph
moved between cells; (2) the blocks of a cell reversed; (3) a nested table swapped with a paragraph; (4) two rows of identical shape
swapped; (5) a cell's content replaced by a list and a heading. In (1) to (4) every paragraph is still untouched, which is what makes
them invisible; in (5) the new blocks are new or converted (not untouched), but the table's shell is equally unchanged, and the cell
still has to be rebuilt from the model.

`structureHash` is blind to `tblPr` / `trPr` / `tcPr`: it hashes only the model-visible skeleton (rows, cells, `colspan`, `rowspan`,
`colwidth`, header or not, and nested tables' skeletons). Equality is meaningful ONLY because the app has no way to edit those
properties. If a feature ever lets the author edit borders, shading, row height or cell margins, the hash must be extended (and
versioned, section 2) in the same change.

Visible consequence, accepted: `tcPr` and `trPr` stay by POSITION, so swapping two identical-shaped rows moves the content and not
the formatting. A shaded totals row swapped with a plain row leaves the shading on the wrong row. (The content-identity inheritance of
5.3 would fix this and may be used here too; A2a does not require it.)

### 5.3 Structure changed: `isTableShellUnchanged(table)` is false

Reachable from the editor's table menu (`src/components/Editor.tsx`, "Add row above / below", "Add column before / after", "Delete
row", "Delete column") and from merging and splitting cells. The original `<w:tbl>`'s row and cell sequence, `tblGrid` and
positional `trPr` / `tcPr` describe a table that no longer exists; "row i is the i-th `<w:tr>`" is false; the folded vMerge cells
(5.4) are in the wrong rows. A table with no stored `structureHash` is treated the same. A change inside a NESTED table also changes
every ancestor's `structureHash` (it includes nested skeletons), so ancestors take this path too. The rule:

1. Build the `<w:tbl>` from the MODEL: rows from `tableRow`; cells from `tableCell` / `tableHeader`; `colspan` to `gridSpan`; `rowspan` to
   a `vMerge` restart cell plus continuation cells; `colwidth` (CSS px) x 15 to `tcW` / `tblGrid` in twips (a column whose width is
   null is the writer's choice); a header row to `tblHeader`. Each cell's blocks by `blockId` exactly as in 5.2. The original XML is
   not walked row by row.
2. Keep from the original what does not depend on rows or columns and the app cannot edit. `tblPr` whole (style, borders, width,
   layout, look, cell margins, and a `tblPrChange` revision). For a surviving cell keep its `tcPr` EXCEPT the structure properties the
   model regenerates (`gridSpan`, `vMerge`, `hMerge`, `tcW`); for a surviving row keep its `trPr` except `tblHeader`. So shading,
   borders, margins, vertical alignment, no-wrap, row height, cantSplit AND the revision marks inside them (`cellIns`, `cellDel`,
   `cellMerge`, `tcPrChange`, `trPrChange`, a tracked row insertion or deletion in `trPr`) travel with the cell or row. "Surviving" is
   decided by CONTENT identity: a model cell holding a block whose `blockId` is inside an original `<w:tc>` inherits that cell's
   properties, never by position. If a model cell's blocks come from several original cells, the one holding its FIRST matched block
   claims it; if two model cells claim one original cell, the first in document order keeps it and the other is treated as new (a
   paragraph moved between cells takes its old cell's formatting with it only if it is that cell's first matched block; this
   misattributes shading when a paragraph moved AND a row was added, and is accepted).
3. A cell or row with no such match (every one the author added, and every regenerated continuation cell) copies ONLY the formatting
   properties of a neighbour (`shd`, `tcBorders`, `tcMar`, `vAlign`, `noWrap`; `trHeight`, `cantSplit`), NEVER revision marks: an
   author-added cell must not carry another author's tracked insertion. Choice of neighbour: for an added ROW, the nearest preceding
   row in the same grid column that has a match, else the nearest following (Word's own "insert row below"). For an added COLUMN
   (no row in that grid column has a match in either direction), the matched cell next to it in the same row, left first, else right.
   For both at once, the column neighbour wins. With no neighbour at all the cell gets nothing but what the table style provides. This
   is an approximation, not exact for shading banded by position; the export should say the table's cell formatting was approximated.
4. The folded vMerge continuation cells are REGENERATED from the model's `rowspan`s (a blank `<w:tc>` with `tcW`, `vMerge` and the
   restart cell's formatting properties, per step 3), NOT re-inserted from the original. After a row is added inside a merged region
   the model's `rowspan` is larger than the original's and a continuation exists with no original to copy. A row that had no model
   cells (5.4) survives only if its neighbours do.
5. Every `<w:tc>` ends in a `<w:p/>` (5.5).
6. `tblGrid` is rebuilt from the model, so it can disagree with the kept `tblPr`: if `tblPr` has a `tblW` of type `dxa`, or
   `tblLayout` is `fixed`, set `tblW` to the sum of the rebuilt grid; leave a `pct` or `auto` `tblW` alone. A `tblGridChange` inside the
   old `tblGrid` describes a grid that no longer exists and is dropped.
7. **Nothing the report counted may be dropped without saying so.** The import headline counts table-level revision marks
   (`cellIns`, `cellDel`, `cellMerge` as tracked changes; `trPrChange`, `tcPrChange`, `tblPrChange`, `tblGridChange` as formatting
   changes). Steps 2 and 6 carry all but `tblGridChange`. A mark is also lost when its row or cell was removed (deleting a row
   deletes its marks) or sits on a regenerated cell. The export must warn with the number of table revision marks it could not carry.

What may not happen under any rule: a model block (paragraph, list, image, nested table) disappears; a cell's content lands in
another cell; the `<w:tbl>` is invalid (each row's `gridSpan` sum equals the grid width; a `vMerge` continuation sits under a restart
cell). Adding one row to the snsf budget table (17 rows, 21 model cells, 11 folded) takes this path: its cells keep their shading and
borders by content identity, the new row takes the formatting of the row above, and the 11 continuation cells are regenerated.

### 5.4 Folded vMerge cells and cell-less rows (shell reused, 5.2)

The model does not contain every `<w:tc>`. A `<w:tc>` folded into a `rowspan` is blank and is not a model cell (the snsf table has
11); it exists only in the original `<w:tbl>`, with its `tcPr` (`vMerge`, shading, borders). A `<w:tr>` whose cells were all folded, or
that carried only `trPr`, is a model row with no cells. When the shell is reused, **re-insert each folded cell at its grid column
and re-emit each cell-less row, from the original `<w:tbl>`**; walk the original row with `colspan` plus the `rowspan`s of the cells
above to find the grid column. A writer that builds rows from model cells alone drops the continuation cells and breaks the row and
grid alignment (no text is lost; the structure is). A vMerge continuation that could not be folded (nothing above it, a different
span, or content in it) was read as an ordinary cell; nothing is dropped to make a merge work.

If the report carries `tableBorders` or `tableLayout`, the original XML is the authority for those properties.

### 5.5 A cell that ends in a nested table

Word requires every `<w:tc>` to end in a `<w:p>`. A cell whose last block is a nested table has no trailing paragraph in the model
(a cell with no paragraph at all was given an empty paragraph with no provenance). When emitting such a cell from the model,
**append an empty `<w:p/>`** after the table; more generally, after everything else (including skipped atoms, section 4) a `<w:tc>` that
ends without a `<w:p>` gets one. Code: the comment in `readCell`, `src/docx/read/tables.ts`.

## 6. Images and drawings

Three kinds of `resizableImage` node, told apart by their attributes:

| Kind | `fragmentId` | `ooxml` | `anchorBlockId` | Where its XML is |
|---|---|---|---|---|
| Stand-in: a figure that is a whole paragraph | set | set (the paragraph's) | null | `blocks[blockId]` (the `<w:p>`), run in `fragments[fragmentId]` |
| Lifted: a picture anchored in a paragraph of text | set | none | the host paragraph's `blockId` | inside the HOST's original XML; run also in `fragments[fragmentId]` |
| Inserted by the author | empty | none | null | nowhere |

Node attributes: `assetId` (the bytes, in the asset store), `width` (share of the text area, e.g. `'50%'`), `widthIn` / `heightIn`
(inches AS READ), `wrap` (`inline` / `left` / `right` / `block` / null), `align`, `alt`, `title`, `crop` (percent per edge). An
external (`r:link`) picture is a placeholder node with `assetId` and `src` null; nothing was fetched; the link is in its fragment.
Drawings that cannot become an image (dangling relationship, EMF/WMF/TIFF, chart, SmartArt, shape) stay opaque atoms with a
"drawing" label. Code: `src/docx/read/drawings.ts` (header), `src/docx/preserve/lifted.ts`, `src/extensions/specs/resizableImage.ts`.

### 6.1 Size: trust `width`

A resize in the editor changes `width` only. `widthIn` and `heightIn` are the size as read and go **stale**; never use them for size.
Compute the new size from `width` times the CURRENT text-area width (`DocFormat.page` width less margins), keeping the picture's
aspect ratio; patch it into `wp:extent` and the picture's `a:ext` (never rebuild the drawing).

### 6.2 Lifted pictures: use `planLiftedDrawings`

The host paragraph's original XML still contains the `w:drawing` while the paragraph is untouched, so deleting, moving or copying
the image node does not change the host. Do not decide from the nodes alone: call `planLiftedDrawings(doc, store)` (`lifted.ts`).
It reads the record `preservation.blocks[hostBlockId].lifted = [{ fragmentId, drawingIndex, sourceHash }]` (`drawingIndex` = ordinal
among ALL `w:drawing` elements of that `<w:p>`, in document order; `docPr@id` is not unique and is not used; block entries are never
pruned) and returns two lists. The cases below need different actions; do not fold them together:

- `strip` entries: remove the `drawingIndex`-th `w:drawing` from the host's original XML before re-emitting it verbatim (the picture
  was deleted, or moved away). **Apply strips in DESCENDING `drawingIndex` order** within a host (the plan is already so ordered), or
  snapshot the host's drawing list before removing anything: splicing one at a time shifts every later ordinal, and an ascending
  sweep strips the wrong pictures. A host that is rebuilt needs no strip: nothing is carried over.
- `emit` entries that are NEW placements of the picture, written from `fragments[fragmentId]` (the `<w:r>` with the whole drawing)
  inside a `<w:p>` of their own (an image is a block in the model): `why: 'copy'` (pasted; its `fragmentId` is in no record) and
  `why: 'moved'` (dragged away from its host, **or its host paragraph was deleted**; the matching `strip`, if the host still exists,
  removes the original).
- `emit` with `why: 'host-edited'`: the picture is still in place but its host is edited and rebuilt. Put the run back INTO that
  rebuilt host (6.7 for where).
- `emit` with `why: 'edited'`: **NOT a new placement.** The host is untouched and still contains the drawing. Writing the picture
  from its fragment would emit it twice. Re-emit the host verbatim with THIS drawing patched in place (6.3).
- An image node whose host is untouched and in place, with an unchanged `sourceHash`, produces nothing: it is already in the host.

Strips apply to a host wherever it is emitted, including inside a table cell or list item that is being rebuilt.

### 6.3 A picture edited in place (`why: 'edited'`)

Re-emit the host verbatim with THIS drawing patched from the node (if the host is also rebuilt it is `host-edited` and is written from
the node anyway). Patch from: size from `width` (6.1) into `wp:extent` / `a:ext`; `alt` and `title` into `wp:docPr@descr` / `@title`;
`crop` into `a:srcRect` (percent x 1000); `wrap` and `align` into the `wp:wrap*` and `wp:positionH` of the anchor (a change of side is
`wp:positionH`; a change to `inline` or `block` cannot be expressed in the anchor, so rebuild the drawing as inline or topAndBottom);
**and `assetId`**. A record with no `sourceHash` (an older import) cannot detect any of this.

### 6.4 `assetId` changed: the picture was replaced, and the bytes change

`assetId` is the hash of the bytes, and `blockHash` counts it, so a replaced picture is correctly `edited`; but unlike every other
attribute it means a different image. Patching a size into the old drawing would keep showing the old picture. The writer must:
take the new bytes and mime from the asset store by `assetId`; add them as a NEW media part (never overwrite the old one, which may
still be used by a copy; an orphaned part is harmless) with its content type; add a NEW relationship to `word/_rels/document.xml.rels`
whose id collides with neither the original rels nor `preservation.rels`; point `a:blip@r:embed` at it (and remove `r:link` if the old
blip had one). Then size, crop and alt as in 6.3, with the aspect ratio of the NEW bytes, not of `widthIn`:`heightIn`. The same
applies to a stand-in whose `assetId` changed (patch inside its original `<w:p>`, 6.6).

### 6.5 Inserted images are in no plan

An image the author inserted has no `fragmentId` and no record. `planLiftedDrawings` skips it (and returns an empty plan when
nothing was ever lifted), and nothing else in the preservation layer mentions it, so **a writer that emits only what the plan lists
drops it silently**. Find them by walking the model: a `resizableImage` with an empty `fragmentId` and no `ooxml`. For each, create
from nothing: a new media part from the asset (with content type), a new relationship, and a new `w:drawing` (`wp:inline` for `wrap`
null or `inline`; a `wp:anchor` with `wrapSquare` for `left` / `right`; a line of its own for `block`; extent from `width` x text
width, aspect ratio from the bytes; `alt` / `title` into `wp:docPr@descr` / `@title` with a `docPr@id` unused anywhere in the
document), in a `w:r` in its own `w:p`. The same fallback serves a picture whose fragment is missing (section 4). Code:
`lifted.ts` (`planLiftedDrawings` skips at `if (!fragmentId || blockIdOf(img.node)) continue`).

### 6.6 Never rebuild an edited figure paragraph from its paragraph properties

A stand-in (a figure that is a paragraph of its own) owns its paragraph's original XML. While untouched, re-emit it verbatim. Once
edited, **patch that `<w:p>`** (replace the run holding the drawing with the fragment's run, change `wp:extent`, ...); never rebuild it
from `<w:pPr>` plus the run. The bookmarks around a figure (cross-reference targets) and anything else in that paragraph exist only
in the original XML: the bookmark atoms of a figure paragraph are deliberately not in the model. A stand-in is NOT in
`planLiftedDrawings` (it has no host); its own `isBlockUntouched` says whether it was edited, and the edit is patched into the `<w:p>`
from the same attributes as 6.3, including `assetId` (6.4).

### 6.7 Where a surviving run goes in a REBUILT host (known wrong for some inline pictures)

When a host is rebuilt, the picture's run is put at the START of the host's content, in image order, because its position among the
host's runs is not stored. That is faithful for a floating picture (positioned relative to the paragraph) and wrong for an inline
picture lifted from the middle of a sentence: it moves to the front. Accepted (section 13).

## 7. Captions and figures

`ImportResult.figures` (not persisted) pairs each picture in `doc.content` with its caption paragraph; the report row is
`report.figures = { images, captioned }`. A writer does not need captions to export (the caption is an ordinary paragraph with its
own provenance); they are for figure renumbering and checks. Recompute with `matchCaptions(doc.content)` after any edit. A
Caption-styled paragraph pairs by style; otherwise by its label ("Fig. 3.", "Figure 3:", "Supplementary Fig. S2 |"). A pairing needs
the next number in its series or a restart at 1; a gap is allowed only if something explains it (an unpaired opaque drawing between
the figures). `figures.images` counts TOP-LEVEL pictures only; a picture inside a table cell is not paired at import, so the dialog's
"Images" row can be larger than the "(of N)" in the caption row. The dialog row key is `figureCaption` (not `caption`, which is Word's
Caption style). Accepted: section 13.

## 8. Report and review state (what must survive)

A collaborator-reviewed file holds review state the editor does not show. It lives in the package parts (keep verbatim until the revision engine, A3, owns comment editing: `comments.xml`,
`commentsExtended.xml`, `commentsIds.xml`, `people.xml`, footnotes, endnotes, headers, footers) and in atoms: tracked changes (`w:ins`,
`w:del`, `w:moveFrom`, `w:moveTo` as one atom each, their text only in the fragment), comment anchors (start / end / reference), and
the formatting-change records (`rPrChange` and the like, inside paragraph XML while untouched). The report counts them as exactly as an independent census of the XML allows
(`counts.trackedChange`, `counts.formatChange`, `counts.comment`, `commentsNotInText`; known gaps are in section 13); the writer must not lose any while a block is
untouched or its atom is not deleted. Deleting a tracked-change chip also deletes comment anchors nested in it (5 in r01); the comment
record stays in `comments.xml` with no anchor. `settings.xml` is kept with `trackRevisions` toggled from app state.

## 9. Lists and numbering

A list is a `bulletList` / `orderedList` of `listItem`s, nested. Each item holds the very paragraph the reader produced, with its own
`ooxml` and stored original, so `isBlockUntouched` holds inside a list item and an untouched item is re-emitted verbatim. The list
node has no provenance and no single `<w:p>`. Definitions live ONLY in the package's untouched `word/numbering.xml`: keep that part
verbatim; append new definitions for new lists (spec section 2.4: "original definitions kept, new ones appended"). Each item's own
`w:numPr` (numId and ilvl) is in its `<w:pPr>` in `blocks[blockId].xml` (a continuation paragraph of an item has none). A newly typed
item has no blockId; give it the list's `wordNumId` and its nesting depth as `ilvl`. Numbering carried by a style is in `styles.xml`.
Code: `src/docx/read/numbering.ts` (header).

### 9.1 Before trusting `attrs.wordNumId`, check the definition's `w:numFmt` against the node type

`wordNumId` is the numId the list was READ with and can be wrong for the node. Two routes: an edit that keeps the list node but changes
its type (the node type changes, `wordNumId` does not) leaves an id naming a definition of the other kind, and emitting it makes Word
show numbers for a bullet list or the reverse; and the toolbar's `toggleOrderedList` builds a fresh list node, so `wordNumId` is `null`.
The null case is handled by the same rule below (no id to trust, so choose or create one). Look up `w:num` to `w:abstractNum` to the `w:lvl` for the item's level; `bullet` is valid only for a `bulletList`,
anything else only for an `orderedList`. On a mismatch, or a null id, choose or create a definition of the right kind. The same check
applies to each item's own `w:numPr` in verbatim XML (3.5): toggling a list changes no paragraph, so every item still reads untouched
while its stored `numPr` names the old kind. (The comment
in `src/extensions/preserve/WordNumbering.ts` used to imply the exporter could simply "find the definition by this id"; it now says
the opposite.)

### 9.2 Labels

Numbering labels the editor shows can differ from Word's (counter keying, `lvlRestart`, shared abstractNums): see section 14. The
text and the original `numbering.xml` are preserved either way. A numbered heading keeps heading status but loses its visible number
in the editor: reuse its `<w:pPr>` (3.4).

## 10. Styles

`DocFormat.styles` keys are APP style ids. They are not Word's. A French document's "Heading 1" is `w:styleId="Titre1"` in Word and
`heading1` in the app (matched by `w:name`, which Word keeps in English). Emitting `w:pStyle w:val="heading1"` for that document
refers to a style that does not exist and the edited heading loses its formatting in Word.

The mapping and the backfilled set are persisted on the preservation store:
`preservation.styles = { wordIdByAppId: Record<string, string>, backfilled: string[] }` (`PreservationStore.styles`, set by
`recordStyleIds` in `src/docx/read/index.ts`). They are kept there rather than on `StyleDef` because they are meaningful only against
the original `styles.xml` and so have exactly the lifetime of the store and the package (both detached together, section 1); on
`StyleDef` they would survive into style presets, workspace JSON export and documents with no package, where they are false. Every app
style is in exactly one of the two: the document's own (it has a Word id) or backfilled.

1. Emitting `w:pStyle` / `w:rStyle`: use `wordIdByAppId[appId]`. Never the app id, never `styleIdByWordId` (read-time only).
2. A `backfilled` id is NOT in the document's `styles.xml` (the preset's built-ins the document lacked, and a synthesised `normal`).
   Do not emit it as the document's own style and do not assume a Word id for it. If a node uses one (an accepted inferred heading uses
   `heading1`..`3`; a caption uses `caption`), ADD a style definition to `styles.xml` with a Word id unused by every `w:styleId` AND
   every `w:name` in that file; this is what the reader avoided with the duplicate-"heading 1" fix. Do not add a second "heading 1".
3. `styles.xml` is PATCHED, never regenerated (spec 2.2): copy everything, rewrite only the modelled properties of styles the user
   changed. `w:docDefaults` beyond font family and size, and every unmodelled property, exist only in the original part.
4. `StyleDef.wordDefault` and `StyleDef.customStyle` are the source of truth for `w:default` / `w:customStyle`. `preserved.extraXml` is a
   clone of the whole original `<w:style>` reduced to its other children, so its ROOT also carries those attributes: ignore the root's
   attributes and copy only its CHILDREN.
5. `StyleDef.derivedFromDefaults` lists fields that were copied in from `w:docDefaults/w:pPrDefault` (so the app's resolver agrees with
   Word), not authored by the style. Omit listed fields when re-emitting the style. Edit contract: any code that sets one of those
   fields on a style must remove it from the list, or a writer that omits listed fields silently drops the edit.
6. `StyleDef.preserved.pPrXml` / `rPrXml` hold the unmodelled children (and any modelled child whose attributes were only partly
   understood, kept whole); merge them back when emitting a style. Style merging in the app is field-level, not attribute-level: a style
   that declares only `indent.left` loses a docDefault `firstLine` in the resolver.
7. If `wordIdByAppId` is empty and `backfilled` covers every style in a package that has a `word/styles.xml`, the original part could not
   be read (a corrupt `styles.xml` falls back to the NIH preset with a warning). Keep the original part verbatim and do not rewrite it.
8. A PARAGRAPH node (not a heading; headings follow 3.4) whose Word `w:pStyle` named a style the document does not define reads with
   `styleId: null`; keep its original `w:pStyle` when starting from the original `<w:pPr>` (3.2: node and re-read value are both null, so
   the original is left alone).

Code: `src/docx/read/styles.ts` (`StylesResult`, the writer-rules comment), `src/types.ts` (`StyleDef`).

## 11. Page setup and the body `sectPr`

`readPageSetup` (`src/docx/read/pageSetup.ts`) captures ONLY page size (letter or A4; landscape and other sizes only warn) and the
four margins into `DocFormat.page`. The body's `w:sectPr` also holds the gutter, columns, `titlePg` (different first page), header and
footer references, `pgNumType` (format and start), `w:type`, line numbering and page borders. None of these is modelled and none is
stored elsewhere. They survive an export ONLY if the writer **keeps the ORIGINAL body `sectPr` from the package** and changes at most
its `pgSz` / `pgMar` when `DocFormat.page` was edited, instead of writing a fresh one from `DocFormat.page`. The header and footer
relationship ids it references are the ones `preservation.rels` stores for it.

A paragraph-level `sectPr` (a section break) lives only inside that paragraph's `<w:pPr>`; the report counts it as `sectionBreak` and
the app has one page setup. An untouched paragraph keeps it; a rebuilt one must carry it from the original `<w:pPr>` (3.2). Deleting the
paragraph deletes the section break. Headers, footers, theme, fontTable, footnotes, endnotes, settings, custom XML and `people.xml`
are kept verbatim from the package.

## 12. Lifecycle facts the writer relies on

- The reader is pure; nothing is written until the author confirms. Cancelled imports leave no trace.
- Autosaves rewrite the preservation store whole and prune unreferenced fragments; they never rewrite the package bytes.
- Fragment ids cloned by the paste guard exist in the store from the same transaction as the document save that references them.
- Import excludes itself from undo and resets editor history, so a pre-import entry cannot splice into the imported document.
- Everything the reader derived is deterministic: reading the same bytes twice gives deep-equal results (`private-fixtures.test.ts`).

## 13. Accepted, deliberate imperfections the writer inherits

None is a bug to fix in A2b unless it says so. Each was weighed and accepted.

- **Caption gaps.** An UNEXPLAINED gap in a caption series loses the captions after it (the explaining window is between consecutive
  images, not consecutive paired figures: "Fig. 1, chart, uncaptioned image, Fig. 3" loses Fig. 3). A first figure that does not start
  at 1 is not trusted unless drawings before it explain it. A decorative `shape` counts as an explainer, so it can explain a gap it
  did not cause. Cost of the alternative: a wrong pairing. A missing pairing never drops a paragraph.
- **`widthIn` / `heightIn` staleness** (6.1). Trust `width`.
- **Rebuilt-host run position** (6.7): an inline picture lifted from mid-sentence moves to the start of a rebuilt host.
- **`preservation.rels` is a subset** (section 4).
- **Shading follows position, not content, when identical rows are swapped** (5.2).
- **Table formatting inherited by content identity is approximate** for added rows and cells (5.3).
- **Split citation fields.** A reference-manager field (Zotero, Mendeley, EndNote, Paperpile, ...) is kept as chips with its result as
  editable text between them; editing it can break the field. The report warns once.
- **Tracked-change text** is preserved and counted but neither shown nor editable in the editor (it is visible only inside its chip).
- **Google `sdtPr`** is stored nowhere (3.3).
- **Unmodelled run properties** are lost when a paragraph is edited (3.2); `noBreakHyphen` becomes `-`.
- **Inferred headings are heuristic.** Recall gaps are known (a "Project N." title is not detected; a plain one-word "Results" line is
  promoted). Every proposal is rejectable at import. An accepted heading is rebuilt (3.4).
- **Editor view** does not float `wrap` or apply `crop`: figures render as blocks, uncropped. Attributes are stored and exported
  (6.3); this is a view-layer gap for A4 or the UI work, not a writer problem.
- **Numbering labels** in the editor may differ from Word's for shapes neither real document has (section 14).
- **Review state the report cannot count exactly.** A footnotes, endnotes or comments part too large to inflate is warned about
  ("could not be read") but its tracked changes and comments are not counted. An `mc:AlternateContent` with a `Fallback` and no `Choice`
  is never counted. `disclose`'s `unmet()` (`src/docx/read/index.ts`) is clamped at 0 on purpose and can under-count in one shape: a
  footnote comment is absorbed when a body anchor carries no `w:id` (malformed XML, since `w:id` is required). The clamps were kept, not
  turned into negative figures, because `unmet` is ADDED to a headline and a negative addition would be wrong; the surplus case is
  rare enough to record. (The read-only-pieces figure is different: it is a bare subtraction and a negative shows in the dialog and the
  summary: `preservedReadOnly`, `src/docx/fidelity.ts`.)
- **Table revision marks** lost by an export of a structure-changed table: `tblGridChange`, and any mark on a row or cell that was
  removed (5.3 step 7). The export warns with a count.
- **Heading precedence** is style-over-`outlineLvl`, the inverse of Word (3.2). For a rebuilt heading the node's `level` decides.

## 14. Measurements the writer phase must TAKE (do not guess)

`npm run verify:word` (spec 8.2: a Word 16 COM harness on the Windows host) must measure, on constructed documents, and the reader's
counter keying (`listCounterKey`, `src/docx/read/numbering.ts`) must then be changed to match what Word does:

1. **`startOverride` versus `lvlOverride` counting.** Today any `w:lvlOverride`, even a format-only one with no `w:startOverride`, makes
   the whole `w:num` count independently of the other nums that share its abstractNum. Measure whether Word keys the independent count
   on a `startOverride` instead, and whether a `lvlOverride` on one level affects the others.
2. **`numStyleLink` counter sharing.** Today the counter key uses the `w:num`'s own `abstractNumId`, not the abstractNum reached
   through `w:numStyleLink`, so two numIds that share a definition through a style link get separate counters. Measure whether Word
   shares one count.
3. Also unmeasured: `w:lvlRestart` (read, flagged, not applied) and the label of a list that resumes after a heading.
4. **Duplicate ids.** What Word does with two bookmarks, comment ranges or `wp:docPr` elements sharing an id (a pasted atom emitted twice,
   3.5) and with a comment record that has no anchor (8): repair prompt, silent fix or nothing.

Until measured, these are unknown, not "probably fine". They affect only the label the editor shows, never the preserved text.

## 15. Real-document baselines (counts only; the files are private and gitignored in `fixtures/private/`)

An export of an unedited import must reproduce these. Do not put text from either file in any test output.

| | r01 (NIH R01) | snsf |
|---|---|---|
| Paragraphs / provenance | `counts.paragraph` 135, plus the 10 lifted pictures as blocks; all 135 untouched | `counts.paragraph` 177 (includes paragraphs in table cells); all untouched |
| Headings styled | 0 (no Word heading styles; 9 inferred candidates) | 0 (9 inferred candidates) |
| Images | 10, all anchored `wrapSquare` (9 left, 1 right), 3 cropped, all lifted from untouched hosts | 3, inline stand-ins |
| Caption pairings (`ImportResult.figures`, `report.figures`) | 10 of 10 | 2 of 3 |
| Tables | 0 | 1: 17 rows, 32 source cells = 21 model cells + 11 folded `vMerge`; rowspans 5, 5, 3, 2 |
| Lists | 0 (numbering.xml has no `w:num`) | 5 single-item bullet lists |
| Review state | 45 tracked changes (32 ins/del + 13 formatting), 52 comments (152 anchors), 8 warnings | 22 citations + 1 bibliography (94 field pieces), 4 warnings |
| Word highlight marks | 34 marks in 22 paragraphs | 30 hex run shadings |
| Preservation | 11 rels used | 6 rels used (3 for header and footer) |

`highlight` is a mark in the model (Word's `w:highlight` and a run-level `w:shd` fill both read into it); the AI suggestion highlights are editor
decorations and never in the model, so there is nothing to filter at export.

The acceptance matrix is spec 8.3. "Untouched Word DOCX to export: byte-identical blocks for all paragraphs, no Word repair, counts
equal" is the first row, and is only achievable if section 2 holds.

## Index: where each rule lives

| Rule | Section | Code |
|---|---|---|
| Frozen hashes; any schema attribute downgrades everything | 2 | `src/docx/preserve/hash.ts` (`blockHash`), golden test in `hash.test.ts` |
| Verbatim reuse; edited paragraphs start from original `pPr` | 3 | `src/docx/read/paragraphs.ts`, `preserve/hash.ts` |
| Inferred headings | 3.4 | `src/docx/read/headings.ts` |
| Atoms, fragments, missing fragment | 4 | `src/extensions/preserve/OpaqueNodes.ts`, `src/docx/preserve/refs.ts`, `src/docx/read/opaque.ts` |
| Shell reuse, five rearrangements | 5.2 | `src/docx/preserve/hash.ts` (`structureHash`, `isTableShellUnchanged`) |
| Structure changed | 5.3 | `src/docx/preserve/hash.ts` |
| Folded cells, cell-less rows | 5.4 | `src/docx/read/tables.ts` (header) |
| Trailing `<w:p/>` | 5.5 | `src/docx/read/tables.ts` (`readCell`) |
| Images: `planLiftedDrawings`, strips, `assetId`, inserted | 6 | `src/docx/preserve/lifted.ts`, `src/docx/read/drawings.ts` |
| Captions | 7 | `src/docx/read/drawings.ts` (`matchCaptions`), `src/docx/read/index.ts` |
| Numbering and stale `wordNumId` | 9 | `src/extensions/preserve/WordNumbering.ts`, `src/docx/read/numbering.ts` |
| Style ids, backfilled | 10 | `src/docx/preserve/types.ts`, `src/docx/read/index.ts` (`recordStyleIds`), `src/docx/read/styles.ts` |
| Body `sectPr` | 11 | `src/docx/read/pageSetup.ts` |
| Measurements | 14 | `src/docx/read/numbering.ts` (`listCounterKey`) |
