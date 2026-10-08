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
import { plural, recordFeature, type ImportReport, type ImportWarning } from '../fidelity';
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
  /**
   * `name`: matches a known section name. `format`: only its look and position say so. `aim`: an "Aim 1" / "AIM 2." line.
   * `sibling`: completes a numbered run whose other members were found (2.1, 2.2, [2.3], 2.4).
   */
  confidence: 'name' | 'format' | 'aim' | 'sibling';
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
  /** Closes the body: what follows (trailing matter) must not inherit a sub-level from the sections above. */
  endsBody?: boolean;
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
  { ...top('References Cited', 'Bibliography and References Cited', 'Literature Cited', 'Bibliography'), endsBody: true },
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
  { ...top('References'), endsBody: true },
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
/**
 * Aim titles and numbered-sibling completions are real titles that run longer than a bare section name. 30, not the
 * ordered "about 20": one real grant's "AIM 1: <title and objective>" line is 30 words (its run-in aim paragraphs are 150+).
 */
const MAX_WORDS_LONG = 30;
/** A numbered sibling must lie within this many paragraphs of the run, or twice the widest spacing the run already shows, whichever is more. */
const SIBLING_REACH = 12;
/** An aim title must be followed by a paragraph at least this long; a contents list is a run of short lines. */
const MIN_BODY_WORDS = 8;
/**
 * A gap fill is also admitted if the gap it fills (heading to heading, so it INCLUDES all the body text in between) is at most
 * this many paragraphs per step of the numbering across it: 100 for one missing number's two steps being 200, 300 for two missing
 * numbers, and so on. Beyond that a gap fill is dropped silently: nothing but the missing proposal shows it.
 */
const SIBLING_GAP_SPAN = 100;

/**
 * "Aim 1", "AIM 2.", "Aim III:" (after any enumerator): a specific-aim title. After the number there must be a separator
 * (`:` `.` `)` a dash) or the end of the line, or a capitalised next word ("Aim 1 Characterize ..."). A lowercase next word
 * means a sentence ("Aim 2 will determine ...", "Aim 1 builds on ..."). Roman numerals must be capitals so "Aim in ..." is not one.
 */
const AIM = /^([Aa][Ii][Mm]\s+(?:\d+|[IVXL]+))(?:\s*[:.)\u2013\u2014-]|\s+(?=[A-Z])|$)/;
/** Words that, straight after the aim number, make it a sentence about an aim even when capitalised or after a separator. */
const AIM_SENTENCE_WORD = new Set([
  'of', 'is', 'are', 'was', 'were', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'has', 'have', 'had', 'and', 'or',
  'builds', 'tests', 'aims', 'addresses', 'examines', 'uses', 'seeks', 'proposes', 'focuses', 'investigates', 'determines', 'explores', 'describes',
  'evaluates', 'assesses', 'extends', 'complements', 'follows', 'relies', 'depends', 'requires', 'includes',
]);
/**
 * Words that start a sentence about an aim only when NO separator follows the number ("Aim 1 This aim tests ...", "Aim 2 In this
 * aim we test F"). After a separator they are ordinary title words: "AIM 2: In vivo validation", "Aim 1: To define", "Aim 3: This
 * approach tests ...".
 */
const AIM_PROSE_WORD = new Set(['to', 'in', 'this', 'we', 'our', 'here']);

/** Dot leaders or an ellipsis: a table-of-contents line ("Aim 1 ........ 4"), not a title. */
const LEADERS = /\.{3,}|\u2026|(?:\.\s){3,}/;

/** The "Aim 1" token of an aim title, or null (including for a sentence that merely starts with one). */
function aimToken(rest: string): string | null {
  const m = AIM.exec(rest);
  if (!m) return null;
  const next = rest.slice(m[1].length).replace(/^[\s:.)\u2013\u2014-]+/, '').split(/\s+/, 1)[0] ?? '';
  const word = next.replace(/[^A-Za-z]/g, '');
  const hasSeparator = /^\s*[:.)\u2013\u2014-]/.test(rest.slice(m[1].length));
  const lower = word.toLowerCase();
  if (AIM_SENTENCE_WORD.has(lower) || (!hasSeparator && AIM_PROSE_WORD.has(lower))) return null;
  return m[1];
}

// ── guards that apply to a FORMAT match only (a look-alike of bold or larger text that is not a section title) ──
const MONTH = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const NUMERIC_DATE = /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/;
const PAGE_ARTIFACT = /^(?:page\s+\d|\d+\s+of\s+\d+$)/i;
const DISCOURSE = /^(?:importantly|notably|interestingly|however|moreover|furthermore|key\s+findings?|in\s+summary|of\s+note|conversely|therefore)\b/i;
const STATUS_WORD = /^(?:confidential|draft|preliminary|do\s+not\s+distribute|for\s+review\s+only)\b/i;
const STATUS_PHRASE = /do\s+not\s+distribute|for\s+review\s+only/i;
const LABEL_LIKE = /^(?:panel\s+\w|extended\s+data\b|supplementary\s+(?:fig|table|data)|notes?:?$)/i;

/**
 * Why a bold or larger short line is NOT taken as a heading, or null. These shapes (an author list, a date, a running head, a
 * bold lead-in, a status stamp, a panel label) are what a title page and a body are full of. Name, aim and sibling
 * matches never come through here: their evidence is stronger than the look.
 */
function formatRejection(text: string, rest: string): string | null {
  if (text.includes(',')) return 'contains a comma';
  const date = NUMERIC_DATE.test(text) || (MONTH.test(text) && (/\d/.test(text) || !/\s/.test(text)));
  if (date) return 'looks like a date';
  if (PAGE_ARTIFACT.test(text)) return 'looks like a page number or running head';
  if (DISCOURSE.test(rest)) return 'begins with a discourse marker, so it is a lead-in';
  if (STATUS_PHRASE.test(text)) return 'is a document-status stamp';
  const status = STATUS_WORD.exec(rest);
  if (status && /^\s*(?:$|[-\u2013\u2014:|(\[])/.test(rest.slice(status[0].length))) return 'is a document-status stamp';
  if (LABEL_LIKE.test(rest)) return 'is a figure, panel or note label';
  return null;
}

/**
 * The document already styles at least one section heading (a Heading style or a direct outline level) among its top-level
 * blocks. A heading inside a table cell or a list item is a label in a layout (a boxed form title), not evidence that the
 * author styled the document's section titles, so it does not count.
 */
export function hasHeadings(doc: JSONContent): boolean {
  return (doc.content ?? []).some(n => n.type === 'heading');
}

function isBlank(d: ParagraphDraft): boolean {
  return d.text === '' && d.atoms.length === 0 && !d.multiline;
}

/**
 * The paragraph that follows `drafts[i]` in the document, skipping blank ones, or null if the run of paragraphs ends first.
 * A bullet or numbered list standing right there (after blank paragraphs too) counts as what follows: its first item is
 * returned, flagged `isListLead`; a figure on a line of its own counts the same way (flagged `isFigureLead`), because a title
 * followed by a picture is a title. A table or heading in between still ends the search. Pictures lifted out of the next
 * paragraph (`liftedAfter`) are not in between: they belong to it.
 */
function followingParagraph(drafts: ParagraphDraft[], i: number): ParagraphDraft | null {
  let prev = drafts[i];
  for (let j = i + 1; j < drafts.length; j++) {
    const d = drafts[j];
    if (d.index !== prev.index + 1 + (prev.liftedAfter ?? 0)) return prev.leadsIntoList ?? null; // a list or figure leads on; a table or heading stands between
    if (!isBlank(d)) return d;
    prev = d;
  }
  return prev.leadsIntoList ?? null;
}

/** How the evidence describes what follows a title. */
function followerWords(next: ParagraphDraft): string {
  if (next.isFigureLead) return 'a figure';
  return next.isListLead ? 'a list whose first item is not bold or larger' : 'a body paragraph that is not bold or larger';
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

/** One short line with letters in it, nothing the app cannot show, and not already styled as a caption. */
function eligibleLine(d: ParagraphDraft, maxWords: number, allowBreakIfBold = false): boolean {
  if (d.node.type !== 'paragraph' || !d.text || d.atoms.length) return false;
  if (d.multiline && !(allowBreakIfBold && d.allBold)) return false;
  if (d.node.attrs?.styleId === 'caption') return false;
  if (!/[\p{L}]/u.test(d.text)) return false; // a page number, a rule of dashes
  if (d.words > maxWords) return false;
  return !TERMINAL_STRONG.test(d.text);
}

/** "2.3." -> { prefix: "2", depth: 2, n: 3 }; "C.1" -> { prefix: "c", depth: 2, n: 1 }. Only multi-part enumerators ending in a number. */
function numbered(text: string): { prefix: string; depth: number; n: number } | null {
  const { enumerator } = split(text);
  if (!enumerator) return null;
  const parts = enumerator.replace(/^\(|[.)]+$|\)$/g, '').split('.').filter(Boolean);
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !/^\d+$/.test(last)) return null;
  return { prefix: parts.slice(0, -1).join('.').toLowerCase(), depth: parts.length, n: Number(last) };
}

/** Bold, or set in a larger font than the body: the two looks that can make a short line read as a title. */
function emphatic(d: ParagraphDraft, ctx: DetectContext): boolean {
  return d.allBold || (ctx.bodyFontSizePt !== undefined && d.minFontSizePt !== null && d.minFontSizePt > ctx.bodyFontSizePt);
}

/**
 * Real body text for a title to be followed by: not emphatic, and long enough not to be another contents line. The first item
 * of a list is exempt from the length rule (its items are short by nature) but not from the others.
 */
function isBodyParagraph(d: ParagraphDraft | null, ctx: DetectContext): d is ParagraphDraft {
  return !!d && !emphatic(d, ctx) && (d.isListLead ? d.words > 0 : d.words >= MIN_BODY_WORDS) && aimToken(split(d.text).rest) === null;
}

function detect(drafts: ParagraphDraft[], ctx: DetectContext): HeadingCandidate[] {
  const out: HeadingCandidate[] = [];
  let lastLevel1: HeadingCandidate | null = null; // nearest name-matched level-1 heading so far
  let scopeOpen = false; // a Research Strategy heading is open

  const larger = (d: ParagraphDraft): boolean =>
    ctx.bodyFontSizePt !== undefined && d.minFontSizePt !== null && d.minFontSizePt > ctx.bodyFontSizePt;

  drafts.forEach((d, i) => {
    // Rule 2 and 6: one short line, nothing the app cannot show, not already structure.
    const { enumerator, rest } = split(d.text);
    const aim = aimToken(rest);
    const isAim = aim !== null;
    if (!eligibleLine(d, isAim ? MAX_WORDS_LONG : MAX_WORDS_NAME)) return;

    const shape = `single line of ${plural(d.words, 'word')}`;
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
      bits.push(TERMINAL_PERIOD.test(d.text) ? `${shape}, trailing period ignored for a known section name` : `${shape}, no terminal period, question or exclamation mark`);
      const c: HeadingCandidate = { index: d.index, level: base.level, text: d.text, evidence: bits, confidence: 'name' };
      out.push(c);
      if (base.level === 1) lastLevel1 = section.endsBody ? null : c;
      if (section.opensScope) scopeOpen = true;
      else if (section.kind === 'top') scopeOpen = false;
      return;
    }

    // Aim title: an "Aim 1" / "AIM 2." line. Bold is not required and a period is tolerated, because the pattern is specific.
    if (isAim) {
      if (LEADERS.test(d.text)) return;
      const next = followingParagraph(drafts, i);
      if (!isBodyParagraph(next, ctx)) return;
      const sentences = rest.slice(aim!.length).replace(/^[\s.:)]+|\.$/g, '').split(/[.!?]\s+(?=[A-Z])/).length;
      const bits = [
        `begins with "${aim}", a specific-aim title`,
        ...(sentences > 1 ? [`holds ${sentences} sentences (a title followed by an objective?): accepting makes the whole paragraph the heading`] : []),
        lastLevel1 ? `placed below the level-1 heading "${lastLevel1.text}", so level 2` : 'no section heading precedes it, so level 2',
        d.allBold ? 'entire paragraph is bold' : 'not bold (not required for an aim title)',
        TERMINAL_PERIOD.test(d.text) ? `${shape} (limit ${MAX_WORDS_LONG} words), trailing period ignored` : `${shape} (limit ${MAX_WORDS_LONG} words)`,
        next.isFigureLead
          ? 'followed by a figure, and no contents-list dot leaders'
          : next.isListLead
          ? `followed by a list whose first item (${plural(next.words, 'word')}) is not bold or larger, and no contents-list dot leaders`
          : `followed by a body paragraph of ${plural(next.words, 'word')} that is not bold or larger, and no contents-list dot leaders`,
      ];
      out.push({ index: d.index, level: 2, text: d.text, evidence: bits, confidence: 'aim' });
      return;
    }

    // Format match: stricter than a name match, because nothing but the look says it is a heading.
    if (d.words > MAX_WORDS_FORMAT) return;
    if (TERMINAL_PERIOD.test(d.text)) return;
    if (CAPTION_LIKE.test(d.text)) return;
    if (formatRejection(d.text, rest)) return;
    const bigger = larger(d);
    if (!d.allBold && !bigger) return;
    const next = followingParagraph(drafts, i);
    if (!next || next.allBold || larger(next)) return;
    const bits: string[] = [];
    if (d.allBold) bits.push('entire paragraph is bold');
    if (bigger) bits.push(`entire paragraph is in a larger font (${d.minFontSizePt} pt) than the ${ctx.bodyFontSizePt} pt body text`);
    bits.push(`${shape}, no terminal period, question or exclamation mark`);
    bits.push(`followed by ${followerWords(next)}`);
    const base = depth(lastLevel1 ? 2 : 1);
    bits.push(lastLevel1 ? `follows the level-1 heading "${lastLevel1.text}", so level 2` : 'no section heading precedes it, so level 1');
    if (base.note) bits.push(base.note);
    out.push({ index: d.index, level: base.level, text: d.text, evidence: bits, confidence: 'format' });
  });

  completeNumberedRuns(drafts, out, ctx);
  return out;
}

/**
 * A hole in a numbered sequence is evidence: when two or more candidates share a multi-part enumerator prefix, a line that
 * fills a gap in the run, or extends it by one, at the same depth and in the right place in the document, joins it at the
 * run's level - even if its own length, line count or punctuation would not qualify. Every sibling must also:
 *  - start with a capital letter ("2.3 mM Tris" is a quantity);
 *  - itself be bold or larger, AND have a bold or larger nearest run member, so a plain numbered list (or a table of contents)
 *    never joins, whether the run is bold, plain or mixed;
 *  - lie within `reach` paragraphs of its nearest run member, for a gap fill as for an extension. `reach` is the larger of
 *    SIBLING_REACH and twice the widest spacing between members whose numbers are consecutive; the span across a missing
 *    number is not evidence of how far apart sections are, so it never widens the reach;
 *  - be followed by a body paragraph (or a list whose first item is not bold or larger), not another title.
 * A bold paragraph of two lines (title, then a sub-title) joins too; body text never does. Repeats until nothing more joins.
 * Depth 1 ("1.", "2.") is left out: numbered lists and reference lists share that shape, so the sequence alone is no evidence.
 */
function completeNumberedRuns(drafts: ParagraphDraft[], out: HeadingCandidate[], ctx: DetectContext): void {
  const taken = new Set(out.map(c => c.index));
  const byIndex = new Map(drafts.map(d => [d.index, d]));
  for (let added = true; added; ) {
    added = false;
    const runs = new Map<string, Map<number, HeadingCandidate>>();
    for (const c of out) {
      const k = numbered(c.text);
      if (!k) continue;
      const key = `${k.prefix}|${k.depth}`;
      if (!runs.has(key)) runs.set(key, new Map());
      runs.get(key)!.set(k.n, c);
    }
    for (const [di, d] of drafts.entries()) {
      if (taken.has(d.index) || !eligibleLine(d, MAX_WORDS_LONG, true) || TERMINAL_PERIOD.test(d.text)) continue;
      const k = numbered(d.text);
      const run = k && runs.get(`${k.prefix}|${k.depth}`);
      if (!k || !run || run.size < 2 || run.has(k.n)) continue;
      if (!/^\p{Lu}/u.test(split(d.text).rest)) continue;
      const ns = [...run.keys()].sort((a, b) => a - b);
      const min = ns[0];
      const max = ns[ns.length - 1];
      const gapFill = k.n > min && k.n < max;
      let fits: boolean;
      if (gapFill) {
        const lower = run.get(Math.max(...ns.filter(n => n < k.n)))!;
        const upper = run.get(Math.min(...ns.filter(n => n > k.n)))!;
        fits = d.index > lower.index && d.index < upper.index;
      } else if (k.n === max + 1) fits = d.index > run.get(max)!.index;
      else if (k.n === min - 1 && k.n >= 1) fits = d.index < run.get(min)!.index;
      else fits = false;
      if (!fits) continue;
      // Proximity, measured to the nearest member for gap fills and extensions alike.
      const adjacent = ns.slice(1).flatMap((n, j) => (n === ns[j] + 1 ? [run.get(n)!.index - run.get(ns[j])!.index] : []));
      const reach = Math.max(SIBLING_REACH, 2 * Math.max(0, ...adjacent));
      const nearestN = ns.reduce((a, b) => (Math.abs(run.get(a)!.index - d.index) <= Math.abs(run.get(b)!.index - d.index) ? a : b));
      const distance = Math.abs(run.get(nearestN)!.index - d.index);
      // A gap fill is admitted on the strength of the sequence it completes: either it is near a bounding member, or the gap as a
      // whole is no wider than SIBLING_GAP_SPAN per step of the numbering. The span is measured heading to heading, so it includes
      // the body text of the sections in between: lengthening them widens it, and once it exceeds the allowance the gap fill is
      // dropped silently. The second route only moves that cliff from the reach (a dozen or so paragraphs from one neighbour) out to
      // the allowance, so a few added paragraphs no longer lose the heading.
      let proximity: string | null = distance <= reach ? `${plural(distance, 'paragraph')} from that member (at most ${reach} allowed)` : null;
      if (!proximity && gapFill) {
        const lowerN = Math.max(...ns.filter(n => n < k.n));
        const upperN = Math.min(...ns.filter(n => n > k.n));
        const span = run.get(upperN)!.index - run.get(lowerN)!.index;
        const allowed = SIBLING_GAP_SPAN * (upperN - lowerN);
        if (span <= allowed) {
          proximity = `it lies in a gap of ${plural(span, 'paragraph')} between ${k.prefix}.${lowerN} and ${k.prefix}.${upperN} (at most ${allowed} allowed: ${SIBLING_GAP_SPAN} per number step, and ${k.prefix}.${lowerN} to ${k.prefix}.${upperN} is ${plural(upperN - lowerN, 'step')}), though ${plural(distance, 'paragraph')} from the nearest member`;
        }
      }
      if (!proximity) continue;
      // Emphasis: the sibling and its nearest member are both bold (or larger).
      const nearest = byIndex.get(run.get(nearestN)!.index)!;
      if (!emphatic(d, ctx) || !emphatic(nearest, ctx)) continue;
      // And, like any format match, it must be followed by body text (or a list that opens with some) rather than another title.
      const next = followingParagraph(drafts, di);
      if (!next || emphatic(next, ctx)) continue;
      const level = run.get(max)!.level;
      const members = ns.map(n => `${k.prefix}.${n}`).join(', ');
      out.push({
        index: d.index,
        level,
        text: d.text,
        confidence: 'sibling',
        evidence: [
          `its enumerator "${split(d.text).enumerator}" ${gapFill ? 'fills a gap in' : 'extends'} the numbered run ${members} (${plural(run.size, 'heading')} already found at depth ${k.depth})`,
          `joins that run at level ${level}`,
          d.multiline
            ? `two bold lines in one paragraph (a title and a sub-title, no body text), ${plural(d.words, 'word')} (limit ${MAX_WORDS_LONG}), no terminal period, question or exclamation mark`
            : `single line of ${plural(d.words, 'word')} (limit ${MAX_WORDS_LONG} words), no terminal period, question or exclamation mark`,
          'starts with a capital letter',
          `${d.allBold ? 'bold' : 'larger than the body text'}, like the nearest member of the run (${k.prefix}.${nearestN}, ${nearest.allBold ? 'bold' : 'larger than the body text'})`,
          proximity,
          `followed by ${followerWords(next)}`,
        ],
      });
      taken.add(d.index);
      added = true;
      break; // the run has grown: rebuild it
    }
  }
  out.sort((a, b) => a.index - b.index);
}

export function detectHeadings(drafts: ParagraphDraft[], ctx: DetectContext): HeadingCandidate[] {
  if (ctx.hasRealHeadings) {
    // The author styled their own headings: propose nothing. If that suppressed titles that would otherwise have been
    // proposed (a styled title page over unstyled sections, say), the report says so rather than staying silent.
    const suppressed = ctx.report ? detect(drafts, ctx).length : 0;
    if (ctx.report) publish(ctx.report, 0, suppressed);
    return [];
  }
  const out = detect(drafts, ctx);
  if (ctx.report) publish(ctx.report, out.length, 0);
  return out;
}

/** What `publish` added to a report, so a repeat run on the same report replaces it instead of adding to it. */
const published = new WeakMap<ImportReport, { n: number; warnings: ImportWarning[] }>();

function publish(r: ImportReport, n: number, suppressed: number): void {
  const before = published.get(r);
  if (before) {
    if (before.n) {
      r.counts.inferredHeading = (r.counts.inferredHeading ?? 0) - before.n;
      if (!r.counts.inferredHeading) delete r.counts.inferredHeading;
      r.byCategory[2] -= before.n;
    }
    r.warnings = r.warnings.filter(w => !before.warnings.includes(w));
  }
  const added: ImportWarning[] = [];
  const warn = (message: string) => {
    const w: ImportWarning = { feature: 'inferredHeading', message, category: 2 };
    r.warnings.push(w);
    added.push(w);
  };
  if (n > 0) {
    recordFeature(r, 'inferredHeading', n);
    warn(
      `This document uses no Word heading styles. ${plural(n, 'section heading')} ${n === 1 ? 'was' : 'were'} inferred from bold or larger text, short lines, aim titles, numbering and common section names. Review them: each can be accepted or rejected, and none is applied until you accept it.`,
    );
  }
  if (suppressed > 0) {
    warn(
      `Section headings were not inferred, because the document already uses at least one Word heading style (it is left exactly as its author structured it). ${plural(suppressed, 'unstyled line')} look${suppressed === 1 ? 's' : ''} like section titles and stay${suppressed === 1 ? 's' : ''} body text.`,
    );
  }
  published.set(r, { n, warnings: added });
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
