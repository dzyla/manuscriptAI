/**
 * Word numbering -> nested bulletList / orderedList.
 *
 * Word has no list container: a "list" is a run of paragraphs that each point (w:numPr) at a numbering definition
 * (w:num -> w:abstractNum -> w:lvl). `readNumbering` reads the definitions, `groupListParagraphs` turns a flat sequence
 * of paragraphs into the editor's nested lists.
 *
 * Nothing is rewritten. Every list item holds the very paragraph node `readParagraph` produced, so its `ooxml`
 * provenance and `isBlockUntouched` hold inside the listItem. What a writer needs to rebuild the numbering:
 *   - the definitions: the package's untouched `word/numbering.xml` (`NumberingMap.part`, `DocxPackage.original`),
 *     found per list through `attrs.wordNumId`; like styles.xml they are not copied anywhere else;
 *   - each paragraph's own `<w:numPr>` (numId + ilvl): in its original `<w:p>`, `preservation.blocks[blockId]`;
 *   - numbering a style carries (a "List Bullet" style with no direct numPr): the untouched styles.xml.
 */
import type { JSONContent } from '@tiptap/core';
import { recordFeature, type ImportReport } from '../fidelity';
import { parseXml } from '../preserve/xml';
import { specNormalizeNode } from '../../extensions/schemaSpecs';
import { warnOnce, type ReadContext } from './context';
import { childElements, firstW, int, isW, round4, wAttr } from './ooxml';
import { mainDocumentPart, relatedParts } from './opc';
import { DocxOpenError, type DocxPackage } from './package';
import type { ParagraphDraft } from './paragraphs';
import { twipsToIn } from './units';

/** The `type` attribute of an HTML `<ol>`; null is decimal. */
export type OrderedListType = 'a' | 'A' | 'i' | 'I';

export interface NumberingLevel {
  /** False only for `w:numFmt="bullet"`. Every other format (including `none`) is a numbered list. */
  ordered: boolean;
  /** `w:numFmt`, e.g. decimal, lowerLetter, bullet. */
  format: string;
  /** First number at this level (`w:start`, or the `w:startOverride` of the `w:num`). Spec default when absent: 0. */
  start: number;
  /** `w:lvlText`, e.g. `%1.` or `(%1)`. */
  text: string;
  /** The `<ol type>` that matches `format`; null for decimal, bullets and formats the model has no equivalent for. */
  listType: OrderedListType | null;
  /** Left indent of the level's text in inches, when the definition gives one. */
  indentIn?: number;
  /** `w:pStyle`: a paragraph style that is tied to this level. */
  pStyle?: string;
  /** `w:lvlRestart` is present on a level below the first: a restart rule the editor does not apply. */
  restartRule?: true;
  /** The list the editor shows has the same labels as Word would show for this level. */
  exact: boolean;
  /** Why not, in a sentence the author can read. */
  approximation?: string;
}

export interface NumberingDef {
  abstractNumId: number | null;
  /** The `w:num` has `w:lvlOverride`s: Word then counts it on its own instead of sharing the abstractNum's count. */
  hasOverride: boolean;
  levels: Map<number, NumberingLevel>;
}

/** numId -> definition, plus what grouping needs beyond the brief's map. */
export interface NumberingMap extends Map<number, NumberingDef> {
  /** Word style id -> the numbering that style carries (`w:style/w:pPr/w:numPr`), resolved through basedOn. */
  styleNumPr: Map<string, { numId?: number; ilvl?: number }>;
  /** The part the definitions were read from (the original of it is `DocxPackage.original`); null when there is none. */
  part: string | null;
}

const LIST_TYPE: Record<string, OrderedListType | null> = {
  decimal: null,
  lowerLetter: 'a',
  upperLetter: 'A',
  lowerRoman: 'i',
  upperRoman: 'I',
};

function approximationOf(format: string, text: string, ilvl: number): string | undefined {
  if (format === 'bullet') return undefined;
  if (!(format in LIST_TYPE)) {
    return `The numbering format "${format}" is not supported; the list is shown as 1., 2., 3. The original numbering is kept for export.`;
  }
  if (text !== `%${ilvl + 1}.`) {
    return `A numbered list uses the label pattern "${text}", which the editor shows as plain numbers followed by a period. The original numbering is kept for export.`;
  }
  return undefined;
}

function readLevel(el: Element, ilvl: number, startOverride?: number): NumberingLevel {
  const val = (name: string): string | undefined => {
    const c = firstW(el, name);
    return c ? wAttr(c, 'val') : undefined;
  };
  const format = val('numFmt') ?? 'decimal';
  const text = val('lvlText') ?? '';
  const ind = firstW(firstW(el, 'pPr') ?? el, 'ind');
  const left = ind ? int(wAttr(ind, 'left') ?? wAttr(ind, 'start')) : undefined;
  const pStyle = val('pStyle');
  const restartRule = ilvl > 0 && firstW(el, 'lvlRestart') !== undefined;
  const approximation = approximationOf(format, text, ilvl);
  return {
    ordered: format !== 'bullet',
    format,
    start: startOverride ?? int(val('start')) ?? 0,
    text,
    listType: LIST_TYPE[format] ?? null,
    ...(left !== undefined ? { indentIn: round4(twipsToIn(left)) } : {}),
    ...(pStyle ? { pStyle } : {}),
    ...(restartRule ? { restartRule: true as const } : {}),
    exact: approximation === undefined,
    ...(approximation ? { approximation } : {}),
  };
}

function partDocument(pkg: DocxPackage, candidates: string[]): { doc: Document; part: string } | undefined {
  for (const part of candidates) {
    const doc = pkg.xml(part);
    if (doc) return { doc, part };
  }
  return undefined;
}

interface RawStyleNumPr {
  basedOn?: string;
  numId?: number;
  ilvl?: number;
}

function readStyleNumPr(pkg: DocxPackage, mainPart: string): Map<string, { numId?: number; ilvl?: number }> {
  const out = new Map<string, { numId?: number; ilvl?: number }>();
  let found;
  try {
    found = partDocument(pkg, [...relatedParts(pkg, mainPart, 'styles'), 'word/styles.xml']);
  } catch (e) {
    // readStyles has already reported a malformed styles part; a deferred one is not silently treated as absent
    if (e instanceof DocxOpenError && e.code === 'too-large') throw e;
    return out;
  }
  if (!found) return out;
  const raw = new Map<string, RawStyleNumPr>();
  for (const el of childElements(found.doc.documentElement)) {
    if (!isW(el, 'style') || (wAttr(el, 'type') ?? 'paragraph') !== 'paragraph') continue;
    const id = wAttr(el, 'styleId');
    if (!id || raw.has(id)) continue;
    const basedOn = firstW(el, 'basedOn');
    const numPr = firstW(firstW(el, 'pPr') ?? el, 'numPr');
    const numIdEl = numPr && firstW(numPr, 'numId');
    const ilvlEl = numPr && firstW(numPr, 'ilvl');
    raw.set(id, {
      basedOn: basedOn ? wAttr(basedOn, 'val') : undefined,
      numId: numIdEl ? int(wAttr(numIdEl, 'val')) : undefined,
      ilvl: ilvlEl ? int(wAttr(ilvlEl, 'val')) : undefined,
    });
  }
  for (const id of raw.keys()) {
    let numId: number | undefined;
    let ilvl: number | undefined;
    const seen = new Set<string>();
    for (let cur: string | undefined = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const r = raw.get(cur);
      if (!r) break;
      numId ??= r.numId;
      ilvl ??= r.ilvl;
      cur = r.basedOn;
    }
    if (numId !== undefined) out.set(id, { numId, ...(ilvl !== undefined ? { ilvl } : {}) });
  }
  return out;
}

/**
 * Read the document's numbering definitions. A document with no numbering part gives an empty map. A malformed part
 * gives an empty map and a warning (its paragraphs then read as plain paragraphs); a deferred (too large) part throws
 * `too-large` like `readStyles`, rather than silently reading as "no lists".
 */
export function readNumbering(pkg: DocxPackage, report?: ImportReport): NumberingMap {
  const map: NumberingMap = Object.assign(new Map<number, NumberingDef>(), {
    styleNumPr: new Map<string, { numId?: number; ilvl?: number }>(),
    part: null as string | null,
  });
  const mainPart = mainDocumentPart(pkg);
  map.styleNumPr = readStyleNumPr(pkg, mainPart);

  let found;
  try {
    found = partDocument(pkg, [...relatedParts(pkg, mainPart, 'numbering'), 'word/numbering.xml']);
  } catch (e) {
    if (e instanceof DocxOpenError && e.code === 'corrupt') {
      report?.warnings.push({ feature: 'part', category: 2, message: 'word/numbering.xml could not be read; numbered and bulleted paragraphs are kept as plain paragraphs.' });
      return map;
    }
    throw e;
  }
  if (!found) return map;
  map.part = found.part;
  const root = found.doc.documentElement;

  interface Abstract {
    levels: Map<number, NumberingLevel>;
    numStyleLink?: string;
  }
  const abstracts = new Map<number, Abstract>();
  for (const el of childElements(root)) {
    if (!isW(el, 'abstractNum')) continue;
    const id = int(wAttr(el, 'abstractNumId'));
    if (id === undefined || abstracts.has(id)) continue;
    const levels = new Map<number, NumberingLevel>();
    for (const lvl of childElements(el)) {
      if (!isW(lvl, 'lvl')) continue;
      const ilvl = int(wAttr(lvl, 'ilvl'));
      if (ilvl !== undefined && ilvl >= 0 && ilvl <= 8 && !levels.has(ilvl)) levels.set(ilvl, readLevel(lvl, ilvl));
    }
    const link = firstW(el, 'numStyleLink');
    abstracts.set(id, { levels, ...(link ? { numStyleLink: wAttr(link, 'val') } : {}) });
  }

  const numToAbstract = new Map<number, number>();
  for (const el of childElements(root)) {
    if (!isW(el, 'num')) continue;
    const numId = int(wAttr(el, 'numId'));
    const abs = firstW(el, 'abstractNumId');
    const absId = abs ? int(wAttr(abs, 'val')) : undefined;
    if (numId !== undefined && absId !== undefined && !numToAbstract.has(numId)) numToAbstract.set(numId, absId);
  }

  // An abstractNum with no levels of its own that points at a numbering style (w:numStyleLink) uses the levels of the
  // abstractNum the style's numId refers to.
  const levelsOf = (absId: number, depth = 0): Map<number, NumberingLevel> => {
    const a = abstracts.get(absId);
    if (!a) return new Map();
    if (a.levels.size || !a.numStyleLink || depth > 4) return a.levels;
    const target = map.styleNumPr.get(a.numStyleLink)?.numId;
    const targetAbs = target === undefined ? undefined : numToAbstract.get(target);
    return targetAbs === undefined || targetAbs === absId ? a.levels : levelsOf(targetAbs, depth + 1);
  };

  for (const el of childElements(root)) {
    if (!isW(el, 'num')) continue;
    const numId = int(wAttr(el, 'numId'));
    if (numId === undefined || map.has(numId) || !numToAbstract.has(numId)) continue;
    const absId = numToAbstract.get(numId)!;
    let hasOverride = false;
    const levels = new Map(levelsOf(absId)); // the level objects are replaced, never edited, so abstract definitions stay shared and intact
    for (const o of childElements(el)) {
      if (!isW(o, 'lvlOverride')) continue;
      hasOverride = true;
      const ilvl = int(wAttr(o, 'ilvl'));
      if (ilvl === undefined || ilvl < 0 || ilvl > 8) continue;
      const own = firstW(o, 'lvl');
      const so = firstW(o, 'startOverride');
      const startOverride = so ? int(wAttr(so, 'val')) : undefined;
      if (own) levels.set(ilvl, readLevel(own, ilvl, startOverride));
      else if (startOverride !== undefined && levels.has(ilvl)) levels.set(ilvl, { ...levels.get(ilvl)!, start: startOverride });
    }
    map.set(numId, { abstractNumId: absId, hasOverride, levels });
  }
  return map;
}

/**
 * The document's numbering definitions, read once per import: every reader that needs them (the body, table cells) calls this
 * instead of `readNumbering`, so a malformed numbering part is parsed, and warned about, a single time.
 */
export function getNumbering(ctx: ReadContext): NumberingMap {
  return (ctx.numbering ??= readNumbering(ctx.pkg, ctx.report));
}

// ─── which numbering a paragraph has ────────────────────────────────────────────────────────────────────────────

interface ParaNumPr {
  numId: number;
  ilvl: number;
}

/**
 * The numbering a paragraph really has: its own `<w:numPr>`, else the one its style carries. Read from the paragraph's
 * original `<w:p>` (`preservation.blocks`), so the node stays exactly as `readParagraph` made it. `numId 0` means
 * "explicitly not numbered" and, like no numbering at all, is null here. A paragraph without a stored original (the
 * degraded plain-text fallback of `readParagraph`) is never part of a list.
 */
function numPrOf(node: JSONContent, numbering: NumberingMap, ctx: ReadContext): ParaNumPr | null {
  const blockId = (node.attrs?.ooxml as { blockId?: string } | null | undefined)?.blockId;
  const fragment = blockId ? ctx.preservation.blocks[blockId] : undefined;
  if (!fragment) return null;
  if (!fragment.xml.includes('numPr') && !(numbering.styleNumPr.size && fragment.xml.includes('pStyle'))) return null;
  let pPr: Element | undefined;
  try {
    pPr = firstW(parseXml(fragment.xml).documentElement, 'pPr');
  } catch {
    return null;
  }
  if (!pPr) return null;
  const direct = firstW(pPr, 'numPr');
  const directId = direct && firstW(direct, 'numId');
  const directLvl = direct && firstW(direct, 'ilvl');
  const pStyle = firstW(pPr, 'pStyle');
  const styleWord = pStyle ? wAttr(pStyle, 'val') : undefined;
  const fromStyle = styleWord ? numbering.styleNumPr.get(styleWord) : undefined;
  const numId = (directId ? int(wAttr(directId, 'val')) : undefined) ?? fromStyle?.numId;
  if (numId === undefined || numId === 0) return null;
  let ilvl = (directLvl ? int(wAttr(directLvl, 'val')) : undefined) ?? fromStyle?.ilvl;
  if (ilvl === undefined && styleWord) {
    for (const [i, l] of numbering.get(numId)?.levels ?? []) if (l.pStyle === styleWord) ilvl = i;
  }
  return { numId, ilvl: Math.min(8, Math.max(0, ilvl ?? 0)) };
}

/**
 * What Word counts a numbered list's numbers by: every w:num that shares one abstractNum (and has no lvlOverride) continues the
 * same count; a w:num with a lvlOverride counts on its own. Two lists with the same key are one count in Word.
 *
 * NOT MEASURED AGAINST WORD. Two parts of this keying are reasoned, not observed, and the writer phase must measure them with
 * `npm run verify:word` and fix the key to match (contract section 14): (1) any `w:lvlOverride`, even a format-only one with no
 * `w:startOverride`, makes the whole `w:num` count on its own here; Word may key on a `startOverride` instead; (2) the key uses the
 * `w:num`'s own abstractNum, not the one reached through `w:numStyleLink`, so two numIds sharing a definition through a style link
 * get separate counters here, which Word may not do. Both change only the numbering LABEL the editor shows, never the preserved text.
 */
export function listCounterKey(numId: number, def: NumberingDef): string {
  return def.hasOverride || def.abstractNumId === null ? `n${numId}` : `a${def.abstractNumId}`;
}

// ─── grouping ───────────────────────────────────────────────────────────────────────────────────────────────

/** A list as it is built: the node, and every paragraph the group holds (so a failed validation can fall back to them). */
interface Group {
  root: JSONContent;
  members: JSONContent[];
  approximations: string[];
}

interface OpenList {
  numId: number;
  ilvl: number;
  level: NumberingLevel;
  list: JSONContent;
}

const MSG = {
  interrupted: 'A numbered list that continues earlier numbering is shown as a separate list that keeps the numbers Word shows. This happens when it was interrupted by other text (a blank paragraph between two numbered items counts), and when it shares its numbering with another list.',
  restart: 'A numbered list level has its own restart rule (w:lvlRestart), which the editor does not apply; its numbers may differ from Word\'s. The original numbering is kept for export.',
  skipped: 'A list skips a level; its deeper items are shown one level in.',
  undefinedLevel: 'A list uses a level its numbering definition does not give; it is shown with the closest level that is defined.',
  below: 'A list begins below its first level; it is shown without that indent.',
  heading: 'Heading numbers (such as 1. or 1.1) are applied by Word and are not shown in the editor; the original numbering is kept for export.',
  missing: 'A paragraph refers to a numbering definition the document does not contain; it is kept as a plain paragraph.',
};

/** An unnumbered paragraph that belongs to the list item above it: a "List Continue" style, or indented at least to the item's text. */
function continuesItem(node: JSONContent, top: OpenList): boolean {
  if (node.type !== 'paragraph') return false;
  const styleId = node.attrs?.styleId;
  if (typeof styleId === 'string' && /^list ?continue/i.test(styleId)) return true;
  const left = node.attrs?.indentLeft;
  return typeof left === 'number' && left > 0 && left + 0.005 >= (top.level.indentIn ?? 0);
}

function levelFor(def: NumberingDef, ilvl: number): { level: NumberingLevel; defined: boolean } | undefined {
  const own = def.levels.get(ilvl);
  if (own) return { level: own, defined: true };
  for (let i = ilvl - 1; i >= 0; i--) {
    const near = def.levels.get(i);
    if (near) return { level: near, defined: false };
  }
  return undefined;
}

/**
 * Turn a flat sequence of top-level blocks into nested lists.
 *
 * - A paragraph with an effective numbering (own `w:numPr`, else its style's) becomes a listItem; the list is a
 *   `bulletList` when the level's `w:numFmt` is `bullet` and an `orderedList` otherwise. `ilvl` sets the nesting,
 *   `w:start` (continued across a resumed list) sets `attrs.start`, `attrs.wordNumId` records the Word numId.
 * - An unnumbered paragraph right after a list item that is indented to the item's text (or in a List Continue style)
 *   is a further paragraph of that item. Any other block ends the list; a numbered list that resumes after it is a NEW
 *   list (an approximation: `complexNumbering`).
 * - A numbered heading stays a heading (Word draws its number); a paragraph whose numId has no definition stays a paragraph.
 * - Blocks that are not paragraphs (tables, opaque blocks, headings) pass through and end the current list.
 *
 * The paragraph nodes are placed unchanged (no copy, no re-stamp), so provenance and `isBlockUntouched` hold for every
 * item. The input array and its nodes are not modified. Call this BEFORE heading inference: list items are not top-level
 * paragraphs, so a bold short list item is never mistaken for a section title.
 */
export function groupListParagraphs(
  blocks: ReadonlyArray<Pick<ParagraphDraft, 'node'>>,
  numbering: NumberingMap,
  ctx: ReadContext,
  /**
   * counter key -> level -> the number Word has reached. Persists across interruptions: that is what makes a resumed list
   * resume. Word counts per abstractNum: every w:num that shares one (and has no lvlOverride) continues the same count,
   * while a w:num with a lvlOverride counts on its own. A caller that groups one container in several calls (the body, which a
   * table splits in two) passes the same map to each, so a list that resumes after a table still resumes.
   */
  counters: ListCounters = new Map(),
): JSONContent[] {
  const out: Array<JSONContent | Group> = [];
  let stack: OpenList[] = [];
  let group: Group | null = null;
  /** Pictures lifted out of a paragraph (`anchorBlockId`): they take no part in the list and go back before it. */
  const lifted: Array<{ node: JSONContent; host: string | null; at: number }> = [];

  const endList = () => {
    stack = [];
    group = null;
  };
  const lastItem = (list: JSONContent): JSONContent => list.content![list.content!.length - 1];

  const addItem = (node: JSONContent, np: ParaNumPr, def: NumberingDef) => {
    const found = levelFor(def, np.ilvl)!;
    const level = found.level;
    const approximations: string[] = [];

    while (stack.length && stack[stack.length - 1].ilvl > np.ilvl) stack.pop();
    const top = stack[stack.length - 1];
    let target: OpenList | undefined;
    if (top && top.ilvl === np.ilvl && top.numId === np.numId) target = top;
    else if (top && top.ilvl === np.ilvl) stack.pop(); // another list at the same level: this one is its sibling
    const parent = stack[stack.length - 1];

    // Word's number for this item: continues what this numId has reached at this level, restarts below a higher level.
    const key = listCounterKey(np.numId, def);
    const byLevel = counters.get(key) ?? new Map<number, number>();
    counters.set(key, byLevel);
    const previous = byLevel.get(np.ilvl);
    const value = previous === undefined ? level.start : previous + 1;
    byLevel.set(np.ilvl, value);
    for (const k of [...byLevel.keys()]) if (k > np.ilvl) byLevel.delete(k);

    if (!target) {
      // Notes about a list are made once, when the list is created, not once per item.
      if (!found.defined) approximations.push(MSG.undefinedLevel);
      if (!level.exact && level.approximation) approximations.push(level.approximation);
      if (level.ordered && level.restartRule) approximations.push(MSG.restart);
      const attrs: Record<string, unknown> = level.ordered
        ? { wordNumId: np.numId, start: value, type: level.listType }
        : { wordNumId: np.numId };
      const list: JSONContent = { type: level.ordered ? 'orderedList' : 'bulletList', attrs, content: [] };
      if (parent) {
        if (np.ilvl > parent.ilvl + 1) approximations.push(MSG.skipped);
        lastItem(parent.list).content!.push(list);
      } else {
        if (np.ilvl > 0) approximations.push(MSG.below);
        if (level.ordered && previous !== undefined) approximations.push(MSG.interrupted);
        group = { root: list, members: [], approximations: [] };
        out.push(group);
      }
      target = { numId: np.numId, ilvl: np.ilvl, level, list };
      stack.push(target);
    }
    target.list.content!.push({ type: 'listItem', content: [node] });
    group!.members.push(node);
    group!.approximations.push(...approximations);
  };

  for (const { node } of blocks) {
    if (node.type === 'resizableImage' && typeof node.attrs?.anchorBlockId === 'string') {
      lifted.push({ node, host: node.attrs.anchorBlockId, at: out.length });
      continue;
    }
    const np = node.type === 'paragraph' || node.type === 'heading' ? numPrOf(node, numbering, ctx) : null;
    if (np && node.type === 'heading') {
      recordFeature(ctx.report, 'complexNumbering');
      warnOnce(ctx.report, 'complexNumbering', MSG.heading, 2);
      endList();
      out.push(node);
    } else if (np && node.type === 'paragraph') {
      const def = numbering.get(np.numId);
      if (!def || !levelFor(def, np.ilvl)) {
        recordFeature(ctx.report, 'complexNumbering');
        warnOnce(ctx.report, 'complexNumbering', MSG.missing, 2);
        endList();
        out.push(node);
      } else addItem(node, np, def);
    } else if (stack.length && !np && continuesItem(node, stack[stack.length - 1])) {
      lastItem(stack[stack.length - 1].list).content!.push(node);
      group!.members.push(node);
    } else {
      endList();
      out.push(node);
    }
  }

  // Which entry holds the paragraph a lifted picture was taken from: the picture goes right before it (before the whole list, when
  // the paragraph is an item of one).
  const entryOf = new Map<string, number>();
  out.forEach((entry, i) => {
    for (const n of 'members' in entry ? (entry as Group).members : [entry as JSONContent]) {
      const id = (n.attrs?.ooxml as { blockId?: string } | null | undefined)?.blockId;
      if (id) entryOf.set(id, i);
    }
  });
  const before = new Map<number, JSONContent[]>();
  for (const l of lifted) {
    const i = Math.min((l.host !== null ? entryOf.get(l.host) : undefined) ?? l.at, out.length);
    before.set(i, [...(before.get(i) ?? []), l.node]);
  }

  const result: JSONContent[] = [];
  for (const [index, entry] of out.entries()) {
    result.push(...(before.get(index) ?? []));
    if (!('members' in entry)) {
      result.push(entry as JSONContent);
      continue;
    }
    const g = entry as Group;
    let list: JSONContent;
    try {
      list = specNormalizeNode(g.root);
    } catch {
      // Cannot happen for lists built here. If it ever does, keep every paragraph, flat and untouched.
      warnOnce(ctx.report, 'part', 'A list could not be represented exactly; its paragraphs were kept as plain paragraphs.', 2);
      result.push(...g.members);
      continue;
    }
    recordFeature(ctx.report, 'list');
    for (const message of g.approximations) {
      recordFeature(ctx.report, 'complexNumbering');
      warnOnce(ctx.report, 'complexNumbering', message, 2);
    }
    result.push(list);
  }
  result.push(...(before.get(out.length) ?? []));
  return result;
}

/** The numbers Word has reached per counter key and level; see `groupListParagraphs`. */
export type ListCounters = Map<string, Map<number, number>>;

// ─── numbering shared between the text and table cells ─────────────────────────────────────────────────────────

export const CONTINUED_LIST =
  'A numbered list that continues an earlier list in the text or in another table cell is shown starting again at its first number; Word continues the count. The original numbering is kept for export.';

/** The counter keys of ordered lists already read, by where they were: the body groups its lists with one shared count, each table cell with its own. */
const usedKeys = new WeakMap<ReadContext, { body: Set<string>; cell: Set<string> }>();

/**
 * Note the ordered lists of one container the reader has just grouped (`blocks`, in document order, nested tables left out: their
 * cells note themselves), and report a list that Word counts on from an EARLIER list somewhere else: a table-cell list continuing
 * the body's count or another cell's, or a body list continuing a cell's. Within the body the shared count already carries on, so
 * that is not reported. Call it for the body segment before the next table is read and for a cell once it is grouped, so the
 * order of the calls is document order. A continuation is `complexNumbering` (category 2), once per container that has one.
 */
export function noteListCounts(ctx: ReadContext, scope: 'body' | 'cell', blocks: JSONContent[], numbering: NumberingMap): void {
  const used = usedKeys.get(ctx) ?? { body: new Set<string>(), cell: new Set<string>() };
  usedKeys.set(ctx, used);
  const mine = new Set<string>();
  let continued = false;
  const visit = (n: JSONContent): void => {
    if (n.type === 'table') return; // a nested table's own cells have been noted by its own read
    if (n.type === 'orderedList' && typeof n.attrs?.wordNumId === 'number') {
      const def = numbering.get(n.attrs.wordNumId);
      if (def) {
        const key = listCounterKey(n.attrs.wordNumId, def);
        if (used.cell.has(key) || (scope === 'cell' && used.body.has(key))) continued = true;
        mine.add(key);
      }
    }
    (n.content ?? []).forEach(visit);
  };
  blocks.forEach(visit);
  if (continued) {
    recordFeature(ctx.report, 'complexNumbering');
    warnOnce(ctx.report, 'complexNumbering', CONTINUED_LIST, 2);
  }
  mine.forEach(k => used[scope].add(k));
}
