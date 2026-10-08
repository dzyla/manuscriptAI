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
import { createReport, plural, recordFeature, type ImportReport } from '../fidelity';
import { emptyPreservationStore, type PackageRel, type PreservationStore } from '../preserve/types';
import { captureFragment } from '../preserve/xml';
import { warnOnce, type AssetDraft, type ReadContext } from './context';
import { COMMENT_WARNING, TRACKED_CHANGE_WARNING } from './opaque';
import { readBody } from './body';
import type { FigureMatch } from './drawings';
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
  /**
   * Each picture in `doc.content` with the caption paragraph found for it: `image` and `caption` are positions in `doc.content`
   * (a picture lifted out of a paragraph of text is a block of its own, so it has one). They are positions as the document was
   * READ, and go stale at the first edit: re-derive with `matchCaptions(doc.content)` (drawings.ts) after that. Applying headings
   * converts paragraphs in place and moves nothing, so they still hold for the document the author accepted. Empty when the
   * document has no pictures. A picture with no caption has `caption: null`.
   */
  figures: FigureMatch[];
  fileName?: string;
  /** The input, untouched: parts the app does not model (footnotes, headers, theme, ...) are re-emitted from it on export. */
  original: ArrayBuffer;
}

/** The steps of a read, in order, for a progress display. Reported before each step starts. */
export type ImportStage = 'opening' | 'styles' | 'body' | 'headings' | 'report';

/**
 * `onStage` (optional) is told which step is starting. It is progress information only: it is never given document content, and a
 * callback that throws does not stop the read.
 */
export async function readDocx(data: ArrayBuffer, limits?: OpenOptions, fileName?: string, onStage?: (stage: ImportStage) => void): Promise<ImportResult> {
  const stage = (s: ImportStage): void => {
    try {
      onStage?.(s);
    } catch {
      // progress display must never fail a read
    }
  };
  stage('opening');
  const pkg = await openPackage(data, limits);
  const report = createReport();
  const preservation = emptyPreservationStore();
  const assets: AssetDraft[] = [];
  let counter = 0;
  stage('styles');
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

  stage('body');
  const { blocks, figures } = await readBody(body, ctx);
  // A document needs a block. An empty body reads as one empty paragraph, which claims no original XML (nothing was there).
  const content = blocks.length ? blocks : [specNormalizeNode({ type: 'paragraph', attrs: { styleId: null } })];
  const doc: JSONContent = { type: 'doc', content };
  stage('headings');
  const headingCandidates = inferHeadings(doc, ctx);

  stage('report');
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

  if (figures.length) report.figures = { images: figures.length, captioned: figures.filter(f => f.caption !== null).length };

  recordRels(ctx, mainPart, body);
  recordStyleIds(ctx);
  disclose(ctx, mainPart, body);
  report.described = describedAtoms(doc);

  return {
    doc,
    format: { ...ctx.styles.format, page },
    assets,
    preservation,
    report,
    headingCandidates,
    figures,
    ...(fileName === undefined ? {} : { fileName }),
    original: data,
  };
}

// ─── style ids ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `preservation.styles`: `readStyles` computes the Word-styleId <-> app-style-id mapping and the set of backfilled styles, and both
 * belong to the persisted result, not to this function's locals, because the writer cannot reconstruct either from `format.styles`
 * (a localised document's `heading1` is `Titre1` in Word; a backfilled `heading1` is not in the document at all). Stored on the
 * preservation store rather than on `StyleDef`: see `PreservationStore.styles`.
 */
function recordStyleIds(ctx: ReadContext): void {
  const wordIdByAppId: Record<string, string> = {};
  for (const [wordId, appId] of ctx.styles.styleIdByWordId) wordIdByAppId[appId] = wordId;
  ctx.preservation.styles = { wordIdByAppId, backfilled: [...ctx.styles.backfilled].sort() };
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
const FORMAT_CHANGES = [
  'rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'tblPrExChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'numberingChange',
  'customXmlInsRangeStart', 'customXmlDelRangeStart', 'customXmlMoveFromRangeStart', 'customXmlMoveToRangeStart',
];
const COMMENT_ANCHORS = ['commentRangeStart', 'commentRangeEnd', 'commentReference'];
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

interface Census {
  revisions: number;
  formatting: number;
  /** Distinct comment ids anchored in the part. */
  commentIds: Set<string>;
}

/**
 * Revisions, formatting changes and comment anchors under `root`, counted directly from the XML. An `mc:AlternateContent` holds
 * the same content twice (a DrawingML `mc:Choice` and its VML `mc:Fallback`, as for a text box); only the Choice is counted, so one
 * tracked insertion in a text box is one.
 */
function censusOf(root: Element): Census {
  const rev = new Set(REVISIONS);
  const fmt = new Set(FORMAT_CHANGES);
  const cmt = new Set(COMMENT_ANCHORS);
  const out: Census = { revisions: 0, formatting: 0, commentIds: new Set() };
  const walk = (el: Element): void => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      if (e.namespaceURI === MC_NS && e.localName === 'Fallback') continue;
      if (e.namespaceURI === W_NS) {
        if (rev.has(e.localName)) out.revisions++;
        else if (fmt.has(e.localName)) out.formatting++;
        else if (cmt.has(e.localName)) {
          const id = e.getAttributeNS(W_NS, 'id');
          if (id) out.commentIds.add(id); // an anchor with no id names no comment
        }
      }
      walk(e);
    }
  };
  walk(root);
  return out;
}

type SidecarKind = 'footnotes' | 'endnotes' | 'headers and footers' | 'comments';

/** The parts other than the body that can hold review state, with what kind each is. A footnotes/endnotes/comments part found only by its conventional name still counts. */
function sidecarParts(pkg: DocxPackage, mainPart: string): Array<{ part: string; kind: SidecarKind }> {
  const out: Array<{ part: string; kind: SidecarKind }> = [];
  const seen = new Set<string>();
  const add = (part: string, kind: SidecarKind): void => {
    if (!seen.has(part)) {
      seen.add(part);
      out.push({ part, kind });
    }
  };
  const have = new Set(pkg.names().map(n => n.toLowerCase()));
  const find = (suffix: string, conventional: string | null, kind: SidecarKind): void => {
    // A relationship that names a part the package does not hold (or one that points outside it) finds nothing, so the
    // conventional name is tried in that case too: review state must not vanish because a relationship dangles.
    const related = relatedParts(pkg, mainPart, suffix).filter(part => have.has(part.toLowerCase()));
    for (const part of related) add(part, kind);
    if (!related.length && conventional && have.has(conventional)) add(conventional, kind);
  };
  find('footnotes', 'word/footnotes.xml', 'footnotes');
  find('endnotes', 'word/endnotes.xml', 'endnotes');
  find('header', null, 'headers and footers');
  find('footer', null, 'headers and footers');
  find('comments', 'word/comments.xml', 'comments');
  return out;
}

/** Notes that are not Word's own separators: a footnote or endnote with text in it. */
function realNotes(root: Element): number {
  let n = 0;
  for (const name of ['footnote', 'endnote']) {
    const els = root.getElementsByTagNameNS(W_NS, name);
    for (let i = 0; i < els.length; i++) {
      const type = els[i].getAttributeNS(W_NS, 'type');
      if (!type || type === 'normal') n++;
    }
  }
  return n;
}

const rev = (n: number) => plural(n, 'tracked change');

/**
 * The reader counts a revision or a comment when it meets it as a piece of a paragraph. Ones that sit anywhere else (on a
 * paragraph mark or a table row, nested in another revision, inside a content control, or in a footnote, header or the comments
 * part) are kept with the piece or part that holds them, but nothing would count them. The document is counted directly,
 * independently of the reading, and what the reading missed is ADDED to the totals, so a headline number is the number in the
 * document, and a warning says how many of them are not separate pieces. (Counting only what was met would make "32 tracked
 * changes" mean "at least 32".) Calling it again changes nothing: the arithmetic finds nothing unmet and the warnings dedupe.
 */
function disclose(ctx: ReadContext, mainPart: string, body: Element): void {
  const { report } = ctx;
  // This clamp is deliberate and can under-count in one shape: when the reader counted MORE than the census finds (for example a
  // footnote comment absorbed because a body anchor carries no `w:id`), the surplus is not subtracted again and nothing is added.
  // Recorded in the writer contract section 13; the headline is then the reader's own count, never lower than what it met.
  const unmet = (total: number, counted: number | undefined): number => Math.max(0, total - (counted ?? 0));

  const main = censusOf(body);
  const sidecars: Array<{ kind: SidecarKind; census: Census; notes: number; records: Set<string> }> = [];
  const unreadable: string[] = [];
  for (const { part, kind } of sidecarParts(ctx.pkg, mainPart)) {
    let doc: Document | undefined;
    try {
      doc = ctx.pkg.xml(part);
    } catch {
      unreadable.push(part);
      continue;
    }
    if (!doc) continue;
    const records = new Set<string>();
    if (kind === 'comments') {
      const els = doc.getElementsByTagNameNS(W_NS, 'comment');
      for (let i = 0; i < els.length; i++) {
        const id = els[i].getAttributeNS(W_NS, 'id');
        if (id) records.add(id);
      }
    }
    sidecars.push({ kind, census: censusOf(doc.documentElement), notes: kind === 'footnotes' || kind === 'endnotes' ? realNotes(doc.documentElement) : 0, records });
  }
  if (unreadable.length) {
    warnOnce(
      report,
      'part',
      `${plural(unreadable.length, 'part')} of the document (${unreadable.join(', ')}) could not be read, so any tracked changes or comments in ${unreadable.length === 1 ? 'it' : 'them'} could not be counted. ${unreadable.length === 1 ? 'It is' : 'They are'} kept in the file.`,
      3,
    );
  }
  const where = (pick: (c: Census) => number): string =>
    (['footnotes', 'endnotes', 'headers and footers', 'comments'] as SidecarKind[])
      .map(kind => [kind, sidecars.filter(x => x.kind === kind).reduce((n, x) => n + pick(x.census), 0)] as const)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${n} in ${kind}`)
      .join(', ');

  // tracked changes
  const outsideRevisions = sidecars.reduce((n, x) => n + x.census.revisions, 0);
  const revisions = unmet(main.revisions + outsideRevisions, report.counts.trackedChange);
  const inBody = unmet(main.revisions, report.counts.trackedChange);
  if (revisions) recordFeature(report, 'trackedChange', revisions);
  if (inBody) {
    warnOnce(
      report,
      'trackedChange',
      `${rev(inBody)} ${inBody === 1 ? 'sits' : 'sit'} on a paragraph mark or table row, or inside other preserved content. ${inBody === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${inBody === 1 ? 'is' : 'are'} not shown as separate pieces.`,
      3,
    );
  }
  if (outsideRevisions) {
    warnOnce(
      report,
      'trackedChange',
      `${rev(outsideRevisions)} (${where(c => c.revisions)}) sit outside the main text. ${outsideRevisions === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${outsideRevisions === 1 ? 'is' : 'are'} not shown here.`,
      3,
    );
  }
  if (report.counts.trackedChange) warnOnce(report, 'trackedChange', TRACKED_CHANGE_WARNING, 3);

  // formatting changes
  const outsideFormatting = sidecars.reduce((n, x) => n + x.census.formatting, 0);
  const formatting = unmet(main.formatting + outsideFormatting, report.counts.formatChange);
  const formattingInBody = unmet(main.formatting, report.counts.formatChange);
  if (formatting) recordFeature(report, 'formatChange', formatting);
  if (formattingInBody) {
    warnOnce(
      report,
      'formatChange',
      `${plural(formattingInBody, 'formatting change')} ${formattingInBody === 1 ? 'sits' : 'sit'} on a paragraph mark, in a table, or inside other preserved content (such as a tracked insertion). ${formattingInBody === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${formattingInBody === 1 ? 'is' : 'are'} not shown as separate pieces.`,
      3,
    );
  }
  if (outsideFormatting) {
    warnOnce(
      report,
      'formatChange',
      `${plural(outsideFormatting, 'formatting change')} (${where(c => c.formatting)}) sit outside the main text. ${outsideFormatting === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${outsideFormatting === 1 ? 'is' : 'are'} not shown here.`,
      3,
    );
  }

  // comments: anchored in the body, anchored elsewhere (a footnote, a header), or recorded in the comments part with no anchor at all
  const anchored = new Set(main.commentIds);
  for (const x of sidecars) if (x.kind !== 'comments') x.census.commentIds.forEach(id => anchored.add(id));
  const anchoredElsewhere = [...anchored].filter(id => !main.commentIds.has(id)).length;
  const records = new Set<string>();
  for (const x of sidecars) x.records.forEach(id => records.add(id));
  const unanchored = [...records].filter(id => !anchored.has(id)).length;
  const comments = unmet(anchored.size + unanchored, report.counts.comment);
  const commentsInBody = unmet(main.commentIds.size, report.counts.comment);
  if (comments) recordFeature(report, 'comment', comments);
  // Comments that are in the file but not in the main text (kept in a footnote or header, or with no anchor at all): the summary says so
  // when that is ALL of them, so "4 comments" is not taken to mean four places in the text.
  if (anchoredElsewhere + unanchored > 0) report.commentsNotInText = anchoredElsewhere + unanchored;
  if (commentsInBody) {
    warnOnce(
      report,
      'comment',
      `${plural(commentsInBody, 'comment')} ${commentsInBody === 1 ? 'is' : 'are'} anchored inside other preserved content (a content control or a tracked change). ${commentsInBody === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${commentsInBody === 1 ? 'is' : 'are'} not shown as separate anchors.`,
      3,
    );
  }
  if (anchoredElsewhere) {
    warnOnce(
      report,
      'comment',
      `${plural(anchoredElsewhere, 'comment')} ${anchoredElsewhere === 1 ? 'is' : 'are'} anchored only in a footnote, endnote, header or footer. ${anchoredElsewhere === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${anchoredElsewhere === 1 ? 'is' : 'are'} not shown here.`,
      3,
    );
  }
  if (unanchored) {
    warnOnce(
      report,
      'comment',
      `${plural(unanchored, 'comment')} in the comments part ${unanchored === 1 ? 'has' : 'have'} no anchor in the text. ${unanchored === 1 ? 'It is' : 'They are'} counted above and kept in the file, but ${unanchored === 1 ? 'is' : 'are'} not shown here.`,
      3,
    );
  }
  if (report.counts.comment) warnOnce(report, 'comment', COMMENT_WARNING, 3);

  // footnotes and endnotes: a note with text in it is not shown, whether or not its marker survived as an atom of its own (a marker
  // added with Track Changes on sits inside the tracked insertion)
  const notes = sidecars.reduce((n, x) => n + x.notes, 0);
  if (notes || report.counts.footnoteRef || report.counts.endnoteRef) {
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
    // A citation nested in a citation was counted when it closed; only a field of another kind is part of its parent's pieces.
    if (open.length && !field.citation) open[open.length - 1].pieces += field.pieces;
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
