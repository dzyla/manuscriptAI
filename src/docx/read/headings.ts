/**
 * Infer section headings that a Word document never styled.
 *
 * Grant applications are routinely written with bold body paragraphs for their section titles, so
 * an imported grant would have no H1-H3 for the page budgets, the style audit or the section-aware
 * agents to key off. This module proposes headings from formatting, length, position and a list of
 * known section names. It is a pure function: no model is consulted, the same document always
 * yields the same proposals, and every proposal carries the evidence for it so the author can
 * accept or reject it (Task 11). Nothing here changes a document; `applyHeadings` converts only
 * the proposals the author accepted.
 *
 * A document that already uses heading styles is left completely alone.
 */
import type { JSONContent } from '@tiptap/core';
import { addWarning, recordFeature, type ImportReport } from '../fidelity';
import type { ReadContext } from './context';
import { paragraphDrafts, type ParagraphDraft } from './paragraphs';

export interface HeadingCandidate {
  /** Position of the paragraph in the document's top-level content. */
  index: number;
  level: 1 | 2 | 3;
  /** The paragraph's text as written, including any enumerator. */
  text: string;
  /** Why this was proposed; never empty. */
  evidence: string[];
  /** `name`: matches a known section name. `format`: only its look and position say so. */
  confidence: 'name' | 'format';
}

export interface DetectContext {
  /** The document already styles its own headings: propose nothing. */
  hasRealHeadings: boolean;
  /** Body font size in points. A line set larger than this counts as formatting evidence, like bold. Without it, only bold counts. */
  bodyFontSizePt?: number;
  /** When given, each candidate is recorded and one warning says structure was inferred. */
  report?: ImportReport;
}

export interface KnownSection {
  /** Canonical name, shown in the evidence. */
  name: string;
  /** Accepted spellings. Compared after normalisation (case, spacing, `&`/`and`, slash spacing, quotes). */
  aliases: string[];
  /** `top`: a level-1 section. `sub`: level 2 while a Research Strategy heading is open, otherwise level 1. */
  kind: 'top' | 'sub';
  /** Opens a scope in which `sub` sections are level 2. */
  opensScope?: boolean;
}

const top = (name: string, ...aliases: string[]): KnownSection => ({ name, aliases: [name, ...aliases], kind: 'top' });
const sub = (name: string, ...aliases: string[]): KnownSection => ({ name, aliases: [name, ...aliases], kind: 'sub' });

/** NIH application and manuscript (IMRAD) section names. */
export const KNOWN_SECTIONS: KnownSection[] = [
  // NIH, general
  top('Project Summary/Abstract', 'Project Summary', 'Project Abstract', 'Summary/Abstract'),
  top('Project Narrative'),
  top('Specific Aims', 'Specific Aim'),
  top('Background and Significance', 'Background & Significance'),
  top('Research Plan', 'Research Design and Methods', 'Research Design'),
  { ...top('Research Strategy'), opensScope: true },
  sub('Significance'),
  sub('Innovation'),
  sub('Approach'),
  sub('Preliminary Studies/Data', 'Preliminary Studies', 'Preliminary Data', 'Preliminary Results', 'Preliminary Studies and Data'),
  sub('Rigor of the Prior Research', 'Rigor', 'Scientific Rigor', 'Rigor of Prior Research', 'Rigor and Reproducibility', 'Rigor of the Proposed Research'),
  top('Timeline'),
  top('Vertebrate Animals'),
  top('Human Subjects', 'Human Subjects Research', 'Protection of Human Subjects'),
  top('Select Agent Research'),
  top('Resource Sharing Plan', 'Resource Sharing Plans'),
  top('Data Management and Sharing Plan', 'Data Management and Sharing'),
  top('Authentication of Key Biological and/or Chemical Resources', 'Authentication of Key Biological Resources'),
  top('Multiple PD/PI Leadership Plan', 'Multiple PI Leadership Plan', 'Multiple PD/PI Leadership'),
  top('Consortium/Contractual Arrangements', 'Consortium Contractual Arrangements'),
  top('Letters of Support', 'Letter of Support'),
  top('Facilities', 'Facilities and Other Resources'),
  top('Equipment'),
  top('Biosketch', 'Biographical Sketch'),
  top('Budget Justification'),
  top('Introduction to Resubmission', 'Introduction to Resubmission Application', 'Introduction to Revision', 'Introduction to Revision Application', 'Introduction to the Resubmission', 'Introduction to the Revision'),
  top('References Cited', 'Bibliography and References Cited', 'Literature Cited', 'Bibliography'),
  // NIH, career awards
  top("Candidate's Background", 'Candidate Background', "Candidate's Goals"),
  top('Career Goals and Objectives', 'Career Goals'),
  top('Career Development/Training Activities', 'Career Development Plan', 'Training Activities', 'Career Development and Training Activities'),
  top('Training in Responsible Conduct of Research'),
  top('Sponsor and Co-Sponsor', 'Sponsor and Co-Sponsor Statements', 'Sponsor and Co-Sponsors'),
  // manuscript
  top('Abstract'),
  top('Introduction'),
  top('Background'),
  top('Methods', 'Methodology'),
  top('Materials and Methods', 'Methods and Materials', 'Experimental Procedures', 'Experimental Section'),
  top('Results', 'Results and Discussion'),
  top('Discussion'),
  top('Conclusion', 'Conclusions', 'Concluding Remarks'),
  top('References'),
  top('Acknowledgements', 'Acknowledgments', 'Acknowledgement', 'Acknowledgment'),
  top('Author Contributions', 'Authors Contributions', 'Author Contribution'),
  top('Competing Interests', 'Conflict of Interest', 'Conflicts of Interest', 'Declaration of Interests', 'Competing Interest'),
  top('Figure Legends', 'Figure Captions', 'Figure Legend'),
  top('Supplementary', 'Supplementary Material', 'Supplementary Materials', 'Supplementary Information', 'Supplemental Material', 'Supplemental Information'),
];

/** Lower-case, `&` as `and`, quotes straightened, punctuation other than `/` and `'` dropped, spacing collapsed. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/'\s]/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_ALIAS = new Map<string, KnownSection>();
for (const s of KNOWN_SECTIONS) for (const a of s.aliases) if (!BY_ALIAS.has(normalize(a))) BY_ALIAS.set(normalize(a), s);

/**
 * A leading enumerator: `A.`, `a)`, `(a)`, `1.`, `1)`, `1.1`, `1.1.2.`, `I.`, `IV)`, `(ii)`. A bare letter or
 * numeral needs its punctuation, so the article in "A Study" is never taken for one.
 */
const ENUMERATOR = /^(?:\(\s*(?:[A-Za-z]|\d+|[IVXLCivxlc]+)\s*\)|[A-Za-z]\.\d+(?:\.\d+)*[.)]?|(?:[A-Za-z]|[IVXLC]+)[.)]|\d+(?:\.\d+)*[.)]?)(?=\s)\s+/;

/** A caption, not a section: "Figure 1", "Table S2", "Fig. 3". */
const CAPTION_LIKE = /^(?:supplementary\s+)?(?:figs?\.?|figures?|tables?|schemes?|boxes?|panels?)\s*S?\d/i;

/** A question or exclamation is a sentence, never a title. A period is tolerated only after a known section name ("B. INNOVATION."). */
const TERMINAL_STRONG = /[!?]$/;
const TERMINAL_PERIOD = /\.$/;

const MAX_WORDS_NAME = 10;
const MAX_WORDS_FORMAT = 8;

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The document already styles at least one heading (a Heading style or a direct outline level). */
export function hasHeadings(doc: JSONContent): boolean {
  const walk = (n: JSONContent): boolean => n.type === 'heading' || (n.content ?? []).some(walk);
  return walk(doc);
}

function isBlank(d: ParagraphDraft): boolean {
  return d.text === '' && d.atoms.length === 0 && !d.multiline;
}

/** The paragraph that follows `drafts[i]` in the document, skipping blank ones, or null if the run of paragraphs ends first. */
function followingParagraph(drafts: ParagraphDraft[], i: number): ParagraphDraft | null {
  let prev = drafts[i];
  for (let j = i + 1; j < drafts.length; j++) {
    const d = drafts[j];
    if (d.index !== prev.index + 1) return null; // a table, figure or heading stands between
    if (!isBlank(d)) return d;
    prev = d;
  }
  return null;
}

interface NameMatch {
  section: KnownSection;
  /** The enumerator as written ("A.", "C.1."), if one was stripped. */
  enumerator: string | null;
}

function split(text: string): { enumerator: string | null; rest: string } {
  const m = ENUMERATOR.exec(text);
  return m ? { enumerator: m[0].trim(), rest: text.slice(m[0].length) } : { enumerator: null, rest: text };
}

function nameMatch(text: string): NameMatch | null {
  const { enumerator, rest } = split(text);
  const key = normalize(rest);
  const section = key ? BY_ALIAS.get(key) : undefined;
  return section ? { section, enumerator } : null;
}

/** How many parts a multi-part enumerator has: "A." and "2." are 1, "C.1." and "2.1" are 2, "1.2.3" is 3. */
function enumeratorParts(enumerator: string): number {
  return enumerator.replace(/^\(|[.)]+$|\)$/g, '').split('.').filter(Boolean).length;
}

export function detectHeadings(drafts: ParagraphDraft[], ctx: DetectContext): HeadingCandidate[] {
  if (ctx.hasRealHeadings) return [];
  const out: HeadingCandidate[] = [];
  let lastLevel1: HeadingCandidate | null = null; // nearest name-matched level-1 heading so far
  let scopeOpen = false; // a Research Strategy heading is open

  const larger = (d: ParagraphDraft): boolean =>
    ctx.bodyFontSizePt !== undefined && d.minFontSizePt !== null && d.minFontSizePt > ctx.bodyFontSizePt;

  drafts.forEach((d, i) => {
    // Rule 2 and 6: one short line, nothing the app cannot show, not already structure.
    if (d.node.type !== 'paragraph' || !d.text || d.atoms.length || d.multiline) return;
    if (d.node.attrs?.styleId === 'caption') return;
    if (!/[\p{L}]/u.test(d.text)) return; // a page number, a rule of dashes
    if (d.words > MAX_WORDS_NAME) return;
    if (TERMINAL_STRONG.test(d.text)) return;

    const shape = `single line of ${plural(d.words, 'word')}`;
    const { enumerator } = split(d.text);
    const parts = enumerator ? enumeratorParts(enumerator) : 0;
    const depth = (base: 1 | 2): { level: 1 | 2 | 3; note: string | null } =>
      parts >= 2 && Math.min(parts, 3) > base
        ? { level: Math.min(parts, 3) as 2 | 3, note: `enumerator "${enumerator}" has ${parts} parts, so level ${Math.min(parts, 3)}` }
        : { level: base, note: null };

    const named = nameMatch(d.text);
    if (named) {
      const { section } = named;
      const inScope = section.kind === 'sub' && scopeOpen;
      const base = depth(inScope ? 2 : 1);
      const bits = [`matches known section "${section.name}"`];
      if (named.enumerator) bits.push(`enumerator "${named.enumerator}" stripped before matching`);
      bits.push(
        inScope
          ? 'a sub-section of Research Strategy, so level 2'
          : section.opensScope
            ? 'a top-level section that opens the research strategy, so level 1'
            : section.kind === 'sub'
              ? 'a research-strategy sub-section, but no Research Strategy heading precedes it, so level 1'
              : 'a top-level section, so level 1',
      );
      if (base.note) bits.push(base.note);
      bits.push(d.allBold ? 'entire paragraph is bold' : 'not bold');
      bits.push(TERMINAL_PERIOD.test(d.text) ? `${shape}, trailing period ignored for a known section name` : `${shape}, no terminal punctuation`);
      const c: HeadingCandidate = { index: d.index, level: base.level, text: d.text, evidence: bits, confidence: 'name' };
      out.push(c);
      if (base.level === 1) lastLevel1 = c;
      if (section.opensScope) scopeOpen = true;
      else if (section.kind === 'top') scopeOpen = false;
      return;
    }

    // Format match: stricter than a name match, because nothing but the look says it is a heading.
    if (TERMINAL_PERIOD.test(d.text)) return;
    if (d.words > MAX_WORDS_FORMAT) return;
    if (CAPTION_LIKE.test(d.text)) return;
    const bigger = larger(d);
    if (!d.allBold && !bigger) return;
    const next = followingParagraph(drafts, i);
    if (!next || next.allBold || larger(next)) return;
    const bits: string[] = [];
    if (d.allBold) bits.push('entire paragraph is bold');
    if (bigger) bits.push(`entire paragraph is in a larger font (${d.minFontSizePt} pt) than the ${ctx.bodyFontSizePt} pt body text`);
    bits.push(`${shape}, no terminal punctuation`);
    bits.push('followed by a body paragraph that is not bold or larger');
    const base = depth(lastLevel1 ? 2 : 1);
    bits.push(lastLevel1 ? `follows the level-1 heading "${lastLevel1.text}", so level 2` : 'no section heading precedes it, so level 1');
    if (base.note) bits.push(base.note);
    out.push({ index: d.index, level: base.level, text: d.text, evidence: bits, confidence: 'format' });
  });

  if (ctx.report && out.length) report(ctx.report, out.length);
  return out;
}

function report(r: ImportReport, n: number): void {
  recordFeature(r, 'inferredHeading', n);
  addWarning(
    r,
    'inferredHeading',
    `This document uses no Word heading styles. ${plural(n, 'section heading')} ${n === 1 ? 'was' : 'were'} inferred from bold or larger text, short lines and common section names. Review them: each can be accepted or rejected, and none is applied until you accept it.`,
    2,
  );
}

/**
 * The size body text is set in: the most common size among long paragraphs (weighted by length), because a document's
 * docDefaults often differ from what its author actually typed in (one real grant has an 11 pt default and 10 pt text).
 */
export function bodyFontSize(drafts: ParagraphDraft[], fallback: number): number {
  const weight = new Map<number, number>();
  for (const d of drafts) {
    if (d.words >= 20 && d.minFontSizePt !== null) weight.set(d.minFontSizePt, (weight.get(d.minFontSizePt) ?? 0) + d.text.length);
  }
  let best = fallback;
  let bestWeight = 0;
  for (const [size, w] of weight) if (w > bestWeight) [best, bestWeight] = [size, w];
  return best;
}

/**
 * Detect headings for a document just read: works out whether the author styled any headings (looking at the
 * paragraphs actually read, because a styles.xml that DEFINES Heading 1 says nothing about whether it is used) and
 * records the result in the import report.
 */
export function inferHeadings(doc: JSONContent, ctx: ReadContext): HeadingCandidate[] {
  const drafts = paragraphDrafts(doc.content ?? [], { format: ctx.styles.format, styleIdByWordId: ctx.styles.styleIdByWordId, blocks: ctx.preservation?.blocks });
  return detectHeadings(drafts, {
    hasRealHeadings: hasHeadings(doc),
    bodyFontSizePt: bodyFontSize(drafts, ctx.styles.format.defaults.fontSizePt),
    report: ctx.report,
  });
}

const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));

/**
 * Convert the accepted paragraphs to headings. The paragraph's attributes, inline content and `ooxml`
 * provenance carry over unchanged; every other block is returned as the same object.
 *
 * Provenance: `ooxml` ({ blockId, sourceHash }) is kept as is. The hash was taken of the paragraph, so the
 * converted block no longer matches it and `isBlockUntouched` is false: the exporter regenerates a converted
 * paragraph as a heading instead of re-emitting its original `<w:p>`, which would lose the accepted heading.
 * The `blockId` still points at the original XML, so its paragraph properties stay recoverable. A candidate
 * that no longer fits the block at its index (not a paragraph, or its text changed) is skipped, never
 * applied to a neighbour.
 */
export function applyHeadings(doc: JSONContent, accepted: HeadingCandidate[]): JSONContent {
  if (!accepted.length || !doc.content) return doc;
  const byIndex = new Map(accepted.map(c => [c.index, c]));
  const content = doc.content.map((node, i) => {
    const c = byIndex.get(i);
    if (!c || node.type !== 'paragraph' || textOf(node).trim() !== c.text) return node;
    return { ...node, type: 'heading', attrs: { ...(node.attrs ?? {}), level: c.level, styleId: null } };
  });
  return { ...doc, content };
}
