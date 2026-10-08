/**
 * `readDocx`: the whole of reading a Word document. `.docx` bytes -> `ImportResult`, and nothing else happens: no IndexedDB write,
 * no store mutation, no network request (the repository commits an `ImportResult` only after the author has seen the report).
 *
 * The order is fixed by what each step needs from the one before it:
 *   1. `openPackage`: the security limits are enforced here, before anything is inflated; a refusal is a `DocxOpenError`.
 *   2. `readStyles`: the document's format (fonts, styles); `readBody`: the blocks, with images loaded, lists grouped and tables
 *      read (see body.ts for why that order matters);
 *   3. `inferHeadings` on the FULLY grouped document: a candidate's index is a position in exactly that document. The candidates
 *      are returned, not applied: the report promises that none is applied until the author accepts it.
 *   4. page setup, the relationships the preserved XML refers to, and the report's disclosures (see `disclose`).
 *
 * What the report promises, and where it is kept:
 *   - every element the reader understands is recorded under its fidelity category (fidelity.ts);
 *   - everything it does not understand is an opaque atom (opaque.ts) or lives in the paragraph's stored XML, and `original` keeps
 *     the package byte for byte, so nothing is ever dropped;
 *   - what is kept but NOT shown (comment text, footnote text, headers and footers, revisions the reader cannot list) is said so in
 *     a warning. A count the reader could not make exact is never presented as exact.
 *
 * `src/docx/**` stays free of React and DOM globals so this can run in a Web Worker.
 */
import type { JSONContent } from '@tiptap/core';
import type { DocFormat } from '../../types';
import { specNormalizeNode } from '../../extensions/schemaSpecs';
import { createReport, recordFeature, type ImportReport } from '../fidelity';
import { emptyPreservationStore, type PackageRel, type PreservationStore } from '../preserve/types';
import { captureFragment } from '../preserve/xml';
import { warnOnce, type AssetDraft, type ReadContext } from './context';
import { readBody } from './body';
import { inferHeadings, type HeadingCandidate } from './headings';
import { W_NS, childElements, isW } from './ooxml';
import { mainDocumentPart, relatedParts, resolveRelTarget } from './opc';
import { readPageSetup } from './pageSetup';
import { DocxOpenError, openPackage, type DocxPackage, type OpenOptions } from './package';
import { readStyles } from './styles';

export type { AssetDraft } from './context';
export type { HeadingCandidate } from './headings';

/** Everything a read produces. Plain data (structured-cloneable), except that `original` is the caller's own buffer. */
export interface ImportResult {
  /** The document, as the editor's JSON. Never empty: a document with no content reads as one empty paragraph. */
  doc: JSONContent;
  /** Fonts, styles and page setup. */
  format: DocFormat;
  /** Images found in the package, content-addressed; committed by the repository only after the author confirms. */
  assets: AssetDraft[];
  /** The original XML of every block and opaque atom, and the relationships that XML refers to (see `PreservationStore`). */
  preservation: PreservationStore;
  report: ImportReport;
  /**
   * Section headings inferred for a document that styled none (see headings.ts). They are NOT applied to `doc`: the report says
   * each can be accepted or rejected. Their `index` is a position in `doc.content`; apply the accepted ones with `applyHeadings`.
   */
  headingCandidates: HeadingCandidate[];
  fileName?: string;
  /** The input, untouched: parts the app does not model (footnotes, headers, theme, ...) are re-emitted from it on export. */
  original: ArrayBuffer;
}

export async function readDocx(data: ArrayBuffer, limits?: OpenOptions, fileName?: string): Promise<ImportResult> {
  const pkg = await openPackage(data, limits);
  const report = createReport();
  const preservation = emptyPreservationStore();
  const assets: AssetDraft[] = [];
  let counter = 0;
  const ctx: ReadContext = {
    pkg,
    styles: readStyles(pkg, report),
    report,
    preservation,
    assets,
    nextId: () => `b${++counter}`,
  };

  const mainPart = mainDocumentPart(pkg);
  const mainDoc = await pkg.xmlAsync(mainPart);
  if (!mainDoc) throw new DocxOpenError('corrupt', 'The package has no main document part.');
  const body = mainDoc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new DocxOpenError('corrupt', 'The main document part has no body.');

  const { blocks } = await readBody(body, ctx);
  // A document needs a block. An empty body reads as one empty paragraph, which claims no original XML (nothing was there).
  const content = blocks.length ? blocks : [specNormalizeNode({ type: 'paragraph', attrs: { styleId: null } })];
  const doc: JSONContent = { type: 'doc', content };
  const headingCandidates = inferHeadings(doc, ctx);

  const { page, extraSections } = readPageSetup(body, report);
  if (extraSections > 0) {
    recordFeature(report, 'sectionBreak', extraSections);
    warnOnce(
      report,
      'sectionBreak',
      `This document has ${extraSections + 1} sections. The editor has one page setup, so the last section's page size and margins are used for all of it; the section breaks themselves are kept in place for export.`,
      3,
    );
  }
  const pageCount = readPageCount(pkg);
  if (pageCount !== undefined) report.pageCount = pageCount;

  recordRels(ctx, mainPart, body);
  disclose(ctx, mainPart, body);
  report.described = describedAtoms(doc);

  return {
    doc,
    format: { ...ctx.styles.format, page },
    assets,
    preservation,
    report,
    headingCandidates,
    ...(fileName === undefined ? {} : { fileName }),
    original: data,
  };
}

// ─── relationships ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * `preservation.rels`: the entries of the main part's relationships that the stored XML refers to, by id, so a writer can see
 * what `r:embed="rId7"` or `r:id="rId12"` meant (a picture, a hyperlink, an embedded object, a header) and re-point it.
 *
 * The ids are those the stored fragments declare (`Fragment.relIds`: every block and every atom, including pictures and links),
 * plus the ones the body's own section properties use (header and footer references), which no fragment holds. Only entries the
 * source defines are stored; an id it does not define is left out, not invented, and said so once.
 *
 * External relationships are copied as DATA (`targetMode: 'External'`, target as written). They are never fetched, resolved or
 * read: this function does not look at a target at all.
 */
function recordRels(ctx: ReadContext, mainPart: string, body: Element): void {
  const used = new Set<string>();
  for (const f of Object.values(ctx.preservation.blocks)) for (const id of f.relIds) used.add(id);
  for (const f of Object.values(ctx.preservation.fragments)) for (const id of f.relIds) used.add(id);
  for (const sect of childElements(body)) if (isW(sect, 'sectPr')) for (const id of captureFragment(sect).relIds) used.add(id);
  if (!used.size) return;

  let defined: Map<string, PackageRel>;
  try {
    defined = ctx.pkg.rels(mainPart);
  } catch {
    warnOnce(ctx.report, 'part', "The document's relationships could not be read, so the links, pictures and objects in it could not be listed. They are kept exactly as written.", 3);
    return;
  }
  let missing = 0;
  for (const id of used) {
    const rel = defined.get(id);
    if (!rel) {
      missing++;
      continue;
    }
    ctx.preservation.rels[id] = {
      id: rel.id,
      type: rel.type,
      target: rel.target,
      ...(rel.targetMode ? { targetMode: rel.targetMode } : {}),
    };
  }
  if (missing) {
    warnOnce(
      ctx.report,
      'part',
      `${missing} relationship ${missing === 1 ? 'id' : 'ids'} used by the document are not defined in its relationships part (a broken link or picture in the source). ${missing === 1 ? 'It is' : 'They are'} kept exactly as written.`,
      3,
    );
  }
}

// ─── what the report must not hide ───────────────────────────────────────────────────────────────────────────────

const REVISIONS = ['ins', 'del', 'moveFrom', 'moveTo', 'cellIns', 'cellDel', 'cellMerge'];
const FORMAT_CHANGES = ['rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'numberingChange'];
const COMMENT_ANCHORS = ['commentRangeStart', 'commentRangeEnd', 'commentReference'];

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function countElements(body: Element, names: string[]): number {
  let n = 0;
  for (const name of names) n += body.getElementsByTagNameNS(W_NS, name).length;
  return n;
}

function distinctCommentIds(body: Element): number {
  const ids = new Set<string>();
  for (const name of COMMENT_ANCHORS) {
    const els = body.getElementsByTagNameNS(W_NS, name);
    for (let i = 0; i < els.length; i++) ids.add(els[i].getAttributeNS(W_NS, 'id') ?? '');
  }
  ids.delete('');
  return ids.size;
}

/**
 * The reader counts a revision or a comment when it meets it as a piece of a paragraph. Ones that sit anywhere else (on a
 * paragraph mark or a table row, nested in another revision, inside a content control) are kept with the piece that holds them,
 * but nothing would count them. The body is counted directly, independently of the reading, and what the reading missed is ADDED
 * to the totals, so a headline number is the number in the document, and a warning says how many of them are not separate pieces.
 * (Counting only what was met would make "32 tracked changes" mean "at least 32".)
 */
function disclose(ctx: ReadContext, mainPart: string, body: Element): void {
  const { report } = ctx;
  const unmet = (total: number, counted: number | undefined): number => Math.max(0, total - (counted ?? 0));

  const revisions = unmet(countElements(body, REVISIONS), report.counts.trackedChange);
  if (revisions) {
    recordFeature(report, 'trackedChange', revisions);
    warnOnce(
      report,
      'trackedChange',
      `${plural(revisions, 'tracked change')} ${revisions === 1 ? 'sits' : 'sit'} on a paragraph mark or table row, or inside other preserved content. ${revisions === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${revisions === 1 ? 'is' : 'are'} not shown as separate pieces.`,
      3,
    );
  }
  const formatting = unmet(countElements(body, FORMAT_CHANGES), report.counts.formatChange);
  if (formatting) {
    recordFeature(report, 'formatChange', formatting);
    warnOnce(
      report,
      'formatChange',
      `${plural(formatting, 'formatting change')} ${formatting === 1 ? 'sits' : 'sit'} on a paragraph mark, in a table, or inside other preserved content (such as a tracked insertion). ${formatting === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${formatting === 1 ? 'is' : 'are'} not shown as separate pieces.`,
      3,
    );
  }
  const comments = unmet(distinctCommentIds(body), report.counts.comment);
  if (comments) {
    recordFeature(report, 'comment', comments);
    warnOnce(
      report,
      'comment',
      `${plural(comments, 'comment')} ${comments === 1 ? 'is' : 'are'} anchored inside other preserved content (a content control or a tracked change). ${comments === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${comments === 1 ? 'is' : 'are'} not shown as separate anchors.`,
      3,
    );
  }

  if (report.counts.footnoteRef || report.counts.endnoteRef) {
    warnOnce(
      report,
      'footnoteRef',
      'Footnote and endnote text is kept in the file but is not shown or editable here; each marker in the text is a read-only piece.',
      3,
    );
  }
  const furniture = headersAndFootersWithContent(ctx.pkg, mainPart);
  if (furniture) {
    warnOnce(
      report,
      'part',
      `${plural(furniture, 'header or footer part')} ${furniture === 1 ? 'has' : 'have'} content (text, a page number or a picture). ${furniture === 1 ? 'It is' : 'They are'} kept in the file but not shown or editable here.`,
      3,
    );
  }
}

/**
 * How many of the document's atoms are already described by a count of their own: tracked changes, comment anchors, and the
 * pieces of a reference-manager field (a citation or bibliography). Counted in the finished document (not tallied while reading),
 * so a paragraph that was withdrawn and re-read as plain text cannot leave a stale number behind.
 *
 * A field is a run of atoms from a `field start` to its `field end`, with the `field code` in between; it is a citation when its
 * code was labelled so (see `recordField`). Fields nest, so each level is closed on its own, and a field may run across
 * paragraphs (a bibliography does), so the open fields are carried along in document order.
 */
function describedAtoms(doc: JSONContent): NonNullable<ImportReport['described']> {
  const out = { trackedChange: 0, commentAnchor: 0, citationField: 0 };
  const fieldLabels = new Set(['field start', 'field separator', 'field end', 'field code', 'citation field code', 'bibliography field code']);
  const open: Array<{ pieces: number; citation: boolean }> = [];
  const close = (): void => {
    const field = open.pop()!;
    if (field.citation) out.citationField += field.pieces;
    if (open.length) open[open.length - 1].pieces += field.pieces;
  };
  const walk = (n: JSONContent): void => {
    if (n.type === 'opaqueInline' || n.type === 'opaqueBlock') {
      const label = String(n.attrs?.label);
      if (label === 'tracked change') out.trackedChange++;
      else if (label === 'comment anchor') out.commentAnchor++;
      else if (n.type === 'opaqueInline' && fieldLabels.has(label)) {
        if (label === 'field start') open.push({ pieces: 0, citation: false });
        if (open.length) {
          const top = open[open.length - 1];
          top.pieces++;
          if (label === 'citation field code' || label === 'bibliography field code') top.citation = true;
          if (label === 'field end') close();
        } // else a stray piece outside any field: not part of one
      }
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  while (open.length) close(); // a field that never reached its end
  return out;
}

/** Header and footer parts of the main document that hold something (an empty one is Word's default and is nothing to report). */
function headersAndFootersWithContent(pkg: DocxPackage, mainPart: string): number {
  const parts = new Set([...relatedParts(pkg, mainPart, 'header'), ...relatedParts(pkg, mainPart, 'footer')]);
  let n = 0;
  for (const part of parts) {
    let doc: Document | undefined;
    try {
      doc = pkg.xml(part);
    } catch {
      n++; // unreadable: assume there is something in it rather than silently saying there is not
      continue;
    }
    if (!doc) continue;
    const texts = doc.getElementsByTagNameNS(W_NS, 't');
    let hasText = false;
    for (let i = 0; i < texts.length && !hasText; i++) hasText = (texts[i].textContent ?? '').trim() !== '';
    const other = ['instrText', 'fldSimple', 'fldChar', 'drawing', 'pict', 'object'].some(name => doc!.getElementsByTagNameNS(W_NS, name).length > 0);
    if (hasText || other) n++;
  }
  return n;
}

// ─── page count ──────────────────────────────────────────────────────────────────────────────────────────────

/** The page count Word stored when it last saved (docProps/app.xml). It is the author's number, not one computed here. */
function readPageCount(pkg: DocxPackage): number | undefined {
  try {
    for (const rel of pkg.rels('').values()) {
      if (rel.targetMode === 'External' || !rel.type.endsWith('/extended-properties')) continue;
      const part = resolveRelTarget('', rel.target);
      const doc = part === undefined ? undefined : pkg.xml(part);
      const text = doc?.getElementsByTagName('Pages')[0]?.textContent?.trim();
      if (text && /^\d+$/.test(text) && Number(text) > 0) return Number(text);
    }
  } catch {
    // an unreadable properties part is not a reason to refuse the document
  }
  return undefined;
}
