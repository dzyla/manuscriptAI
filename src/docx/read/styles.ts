/**
 * word/styles.xml -> the app's DocFormat.
 *
 * What StyleDef models (font, size, bold/italic, colour, spacing, indents, alignment, basedOn/next)
 * is mapped; everything else is kept verbatim in `StyleDef.preserved` (pPrXml / rPrXml for the
 * unmodelled property children, extraXml for the other w:style children such as w:link, w:uiPriority
 * or table properties). An element is only dropped from the preserved XML when EVERY attribute on it
 * was understood; an element with attributes the model cannot express (w:spacing w:beforeLines,
 * w:rFonts w:eastAsia, w:color w:themeColor, ...) is kept whole as well, so nothing is lost even
 * though the modelled value is also present. basedOn chains are kept as chains, never flattened.
 *
 * Known limit: DocFormat has no home for docDefaults beyond font family/size, so the rest of
 * w:docDefaults stays only in the original styles.xml part (DocxPackage.original).
 *
 * `format.page` is a placeholder (the NIH preset page): readStyles never sees the document body.
 * The caller replaces it with readPageSetup(body).page.
 */
import type { DocFormat, LineSpacing, StyleDef } from '../../types';
import { createFormat } from '../../services/formatPresets';
import { recordFeature, type ImportReport } from '../fidelity';
import { captureChildren } from '../preserve/xml';
import { DocxOpenError, type DocxPackage } from './package';
import { mainDocumentPart, relatedParts } from './opc';
import { halfPointsToPt, twipsToIn } from './units';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export interface StylesResult {
  format: DocFormat;
  /** Word w:styleId -> the app's style id, for the styles the document itself defines. */
  styleIdByWordId: Map<string, string>;
  /** App style id -> heading level, for the document's own heading styles. */
  headingLevelByStyleId: Map<string, 1 | 2 | 3>;
  /**
   * App style ids that exist in `format.styles` but NOT in the document's styles.xml (the preset's
   * built-ins the document lacks, and a synthesised `normal`). A writer must not emit these as the
   * document's own styles. Every id not in this set came from the document.
   */
  backfilled: Set<string>;
}

type StyleType = StyleDef['type'];
/** Word's English built-in style names (lower-case) -> the app's built-in style ids. */
const BUILTIN_BY_NAME: ReadonlyMap<string, string> = new Map([
  ['normal', 'normal'],
  ['heading 1', 'heading1'],
  ['heading 2', 'heading2'],
  ['heading 3', 'heading3'],
  ['caption', 'caption'],
  ['bibliography', 'bibliography'],
]);

const flag = (v: string | undefined): boolean => ['1', 'true', 'on'].includes((v ?? '').trim().toLowerCase());

const STYLE_TYPES: ReadonlySet<string> = new Set<StyleType>(['paragraph', 'character', 'table', 'numbering']);

// ─── small DOM helpers ───────────────────────────────────────────────────────

function childElements(parent: Element): Element[] {
  const out: Element[] = [];
  for (let c = parent.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c as Element);
  return out;
}

const isW = (el: Element, local: string): boolean => el.namespaceURI === W && el.localName === local;

const wAttr = (el: Element, name: string): string | undefined => (el.hasAttributeNS(W, name) ? el.getAttributeNS(W, name) : undefined);

/** True when every attribute on `el` is a w: attribute named in `allowed` (xmlns declarations are not attributes of the model). */
function onlyAttrs(el: Element, allowed: readonly string[]): boolean {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
    if (a.namespaceURI !== W || !allowed.includes(a.localName)) return false;
  }
  return true;
}

const int = (s: string | undefined): number | undefined => (s !== undefined && /^-?\d+$/.test(s.trim()) ? Number(s) : undefined);

/** OOXML on/off value: absent val = true. */
function onOff(el: Element): boolean | undefined {
  const v = wAttr(el, 'val')?.trim().toLowerCase();
  if (v === undefined) return true;
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  return undefined;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ─── property containers ─────────────────────────────────────────────────────

type ThemeFonts = () => { major?: string; minor?: string };
type Props = Partial<Omit<StyleDef, 'id' | 'name' | 'type' | 'basedOn' | 'next' | 'preserved'>>;

interface Read {
  props: Props;
  /** Children the model did not (fully) understand. */
  residual: Element[];
}

function readRPr(rPr: Element, theme: ThemeFonts): Read {
  const props: Props = {};
  const residual: Element[] = [];
  for (const el of childElements(rPr)) {
    let consumed = false;
    if (isW(el, 'rFonts') && props.fontFamily === undefined) {
      const ascii = wAttr(el, 'ascii');
      const hAnsi = wAttr(el, 'hAnsi');
      const themed = (a?: string): string | undefined =>
        a === undefined ? undefined : theme()[a.toLowerCase().startsWith('minor') ? 'minor' : 'major'];
      const family = ascii || themed(wAttr(el, 'asciiTheme')) || hAnsi || themed(wAttr(el, 'hAnsiTheme'));
      if (family) {
        props.fontFamily = family;
        consumed = ascii !== undefined && onlyAttrs(el, ['ascii', 'hAnsi']) && (hAnsi === undefined || hAnsi === ascii);
      }
    } else if (isW(el, 'sz') && props.fontSizePt === undefined) {
      const hp = int(wAttr(el, 'val'));
      if (hp !== undefined && hp > 0) {
        props.fontSizePt = halfPointsToPt(hp);
        consumed = onlyAttrs(el, ['val']);
      }
    } else if ((isW(el, 'b') && props.bold === undefined) || (isW(el, 'i') && props.italic === undefined)) {
      const v = onOff(el);
      if (v !== undefined) {
        props[el.localName === 'b' ? 'bold' : 'italic'] = v;
        consumed = onlyAttrs(el, ['val']);
      }
    } else if (isW(el, 'color') && props.color === undefined) {
      const val = wAttr(el, 'val');
      if (val !== undefined && /^[0-9a-fA-F]{6}$/.test(val)) {
        props.color = `#${val.toLowerCase()}`;
        consumed = onlyAttrs(el, ['val']);
      }
    }
    if (!consumed) residual.push(el);
  }
  return { props, residual };
}

const JC: Record<string, NonNullable<StyleDef['align']>> = { left: 'left', center: 'center', right: 'right', both: 'justify' };

function readPPr(pPr: Element): Read {
  const props: Props = {};
  const residual: Element[] = [];
  for (const el of childElements(pPr)) {
    let consumed = false;
    if (isW(el, 'spacing') && props.spaceBeforePt === undefined && props.spaceAfterPt === undefined && props.lineSpacing === undefined) {
      const before = int(wAttr(el, 'before'));
      const after = int(wAttr(el, 'after'));
      const line = int(wAttr(el, 'line'));
      const rule = wAttr(el, 'lineRule') ?? 'auto';
      let ok = onlyAttrs(el, ['before', 'after', 'line', 'lineRule']);
      if (before !== undefined && before >= 0) props.spaceBeforePt = before / 20;
      else if (wAttr(el, 'before') !== undefined) ok = false;
      if (after !== undefined && after >= 0) props.spaceAfterPt = after / 20;
      else if (wAttr(el, 'after') !== undefined) ok = false;
      if (line !== undefined && line > 0 && (rule === 'auto' || rule === 'exact' || rule === 'atLeast')) {
        const ls: LineSpacing = rule === 'auto' ? { rule, value: round4(line / 240) } : { rule, value: line / 20 };
        props.lineSpacing = ls;
      } else if (wAttr(el, 'line') !== undefined || wAttr(el, 'lineRule') !== undefined) ok = false;
      consumed = ok;
    } else if (isW(el, 'ind') && props.indent === undefined) {
      const left = int(wAttr(el, 'left'));
      const first = int(wAttr(el, 'firstLine'));
      const hang = int(wAttr(el, 'hanging'));
      const ind: NonNullable<StyleDef['indent']> = {};
      if (left !== undefined) ind.leftIn = twipsToIn(left);
      if (first !== undefined && first >= 0) ind.firstLineIn = twipsToIn(first);
      if (hang !== undefined && hang >= 0) ind.hangingIn = twipsToIn(hang);
      if (Object.keys(ind).length) {
        props.indent = ind;
        // Word lets hanging override firstLine; keep the original element whenever both are present.
        const unread =
          (wAttr(el, 'left') !== undefined && ind.leftIn === undefined) ||
          (wAttr(el, 'firstLine') !== undefined && ind.firstLineIn === undefined) ||
          (wAttr(el, 'hanging') !== undefined && ind.hangingIn === undefined);
        consumed = onlyAttrs(el, ['left', 'firstLine', 'hanging']) && !unread && !(ind.firstLineIn !== undefined && ind.hangingIn !== undefined);
      }
    } else if (isW(el, 'jc') && props.align === undefined) {
      const mapped = JC[wAttr(el, 'val') ?? ''];
      if (mapped) {
        props.align = mapped;
        consumed = onlyAttrs(el, ['val']);
      }
    }
    if (!consumed) residual.push(el);
  }
  return { props, residual };
}

// ─── ids ─────────────────────────────────────────────────────────────────────

/** Heading1 -> heading1, ListParagraph -> listParagraph, TOCHeading -> tocHeading, TOC1 -> toc1. */
export function toAppStyleId(wordId: string): string {
  if (/^[A-Z0-9]+$/.test(wordId)) return wordId.toLowerCase();
  return wordId.replace(/^[A-Z]+(?=[A-Z][a-z])|^[A-Z]/, m => m.toLowerCase());
}

// ─── part location ───────────────────────────────────────────────────────────

function readThemeFonts(pkg: DocxPackage, mainPart: string): { major?: string; minor?: string } {
  for (const part of [...relatedParts(pkg, mainPart, 'theme'), 'word/theme/theme1.xml']) {
    try {
      const doc = pkg.xml(part);
      if (!doc) continue;
      const face = (scheme: string): string | undefined => {
        const font = doc.getElementsByTagNameNS(A, scheme)[0];
        const latin = font && font.getElementsByTagNameNS(A, 'latin')[0];
        return latin?.getAttribute('typeface') || undefined;
      };
      const out = { major: face('majorFont'), minor: face('minorFont') };
      pkg.releaseXml(part);
      return out;
    } catch {
      /* the theme only supplies a font name; a corrupt or deferred one just leaves it unresolved */
    }
  }
  return {};
}

// ─── main ────────────────────────────────────────────────────────────────────

interface Rec {
  el: Element;
  wordId: string;
  appId: string;
  type: StyleType;
  name: string;
  basedOnWord?: string;
  outline?: number;
}

function partWarning(report: ImportReport | undefined, message: string): void {
  report?.warnings.push({ feature: 'part', category: 2, message });
}

function nihFallback(): StylesResult {
  const format = createFormat('nih');
  return { format, styleIdByWordId: new Map(), headingLevelByStyleId: new Map(), backfilled: new Set(Object.keys(format.styles)) };
}

export function readStyles(pkg: DocxPackage, report?: ImportReport): StylesResult {
  const mainPart = mainDocumentPart(pkg);
  let doc: Document | undefined;
  let stylesPart = '';
  for (const candidate of [...relatedParts(pkg, mainPart, 'styles'), 'word/styles.xml']) {
    try {
      doc = pkg.xml(candidate);
    } catch (e) {
      // A malformed styles part degrades to the preset (the text is still importable). A deferred one
      // (too-large) is NOT treated as absent: that would silently restyle the whole document.
      if (e instanceof DocxOpenError && e.code === 'corrupt') {
        partWarning(report, 'word/styles.xml could not be read; the NIH preset styles are used instead.');
        return nihFallback();
      }
      throw e;
    }
    if (doc) {
      stylesPart = candidate;
      break;
    }
  }
  if (!doc) return nihFallback();

  let themeCache: { major?: string; minor?: string } | undefined;
  const theme: ThemeFonts = () => (themeCache ??= readThemeFonts(pkg, mainPart));

  const root = doc.documentElement;
  const nih = createFormat('nih');
  const defaults = { ...nih.defaults };

  // docDefaults: font family / size feed DocFormat.defaults; paragraph properties are folded into the
  // default paragraph style below (they are what every paragraph style ultimately inherits).
  let defaultPPr: Props = {};
  const docDefaults = childElements(root).find(e => isW(e, 'docDefaults'));
  if (docDefaults) {
    const rPr = childElements(docDefaults).find(e => isW(e, 'rPrDefault'))?.getElementsByTagNameNS(W, 'rPr')[0];
    if (rPr) {
      const { props } = readRPr(rPr, theme);
      if (props.fontFamily) defaults.fontFamily = props.fontFamily;
      if (props.fontSizePt) defaults.fontSizePt = props.fontSizePt;
    }
    const pPr = childElements(docDefaults).find(e => isW(e, 'pPrDefault'))?.getElementsByTagNameNS(W, 'pPr')[0];
    if (pPr) defaultPPr = readPPr(pPr).props;
  }

  // Pass 1: collect style records.
  const recs: Rec[] = [];
  const byWord = new Map<string, Rec>();
  for (const el of childElements(root)) {
    if (!isW(el, 'style')) continue;
    const wordId = wAttr(el, 'styleId');
    const type = wAttr(el, 'type') ?? 'paragraph';
    if (!wordId) {
      partWarning(report, 'A style without a styleId was skipped.');
      continue;
    }
    if (!STYLE_TYPES.has(type)) {
      partWarning(report, `A style of unknown type "${type}" was skipped.`);
      continue;
    }
    if (byWord.has(wordId)) {
      partWarning(report, 'A duplicate style definition was ignored; the first one is used.');
      continue;
    }
    const appId = '';
    const name = childElements(el).find(c => isW(c, 'name'));
    const basedOn = childElements(el).find(c => isW(c, 'basedOn'));
    const pPr = childElements(el).find(c => isW(c, 'pPr'));
    const outlineEl = pPr && childElements(pPr).find(c => isW(c, 'outlineLvl'));
    const rec: Rec = {
      el,
      wordId,
      appId,
      type: type as StyleType,
      name: (name && wAttr(name, 'val')) || wordId,
      basedOnWord: basedOn ? wAttr(basedOn, 'val') : undefined,
      outline: outlineEl ? int(wAttr(outlineEl, 'val')) : undefined,
    };
    recs.push(rec);
    byWord.set(wordId, rec);
  }

  // Assign app ids. Built-in styles are recognised by their w:name, which Word keeps in English whatever
  // the UI language ("heading 1" with styleId "Titre1" or "\u00dcberschrift1", "Normal" with styleId
  // "Standard"), so a localised document maps onto the app's own heading1/normal rather than gaining a
  // duplicate. Everything else gets the lower-camel of its styleId.
  const taken = new Set<string>();
  for (const rec of recs) {
    const builtin = rec.type === 'paragraph' ? BUILTIN_BY_NAME.get(rec.name.trim().toLowerCase()) : undefined;
    if (builtin && !taken.has(builtin)) {
      rec.appId = builtin;
      taken.add(builtin);
    }
  }
  for (const rec of recs) {
    if (rec.appId) continue;
    const base = toAppStyleId(rec.wordId);
    let appId = base;
    // `in Object.prototype` keeps ids like "constructor" or "__proto__" from touching the prototype chain.
    for (let n = 2; taken.has(appId) || appId in Object.prototype; n++) appId = `${base}${n}`;
    taken.add(appId);
    rec.appId = appId;
  }

  // Pass 2: map each style.
  const styles: Record<string, StyleDef> = {};
  const extras = new Map<string, Element[]>(); // appId -> extra children (kept for extraXml)
  let defaultParagraphId: string | undefined;
  for (const rec of recs) {
    const def: StyleDef = { id: rec.appId, name: rec.name, type: rec.type };
    if (flag(wAttr(rec.el, 'customStyle'))) def.customStyle = true;
    if (flag(wAttr(rec.el, 'default'))) def.wordDefault = true;
    const extra: Element[] = [];
    const preserved: NonNullable<StyleDef['preserved']> = {};
    const seen = new Set<string>();
    for (const child of childElements(rec.el)) {
      const local = child.namespaceURI === W ? child.localName : '';
      if (local === 'name' && !seen.has('name')) {
        seen.add('name');
      } else if (local === 'basedOn' && !seen.has('basedOn')) {
        seen.add('basedOn');
        const target = byWord.get(wAttr(child, 'val') ?? '');
        if (target && onlyAttrs(child, ['val'])) def.basedOn = target.appId;
        else extra.push(child); // dangling or odd: kept, never invented
      } else if (local === 'next' && !seen.has('next')) {
        seen.add('next');
        const target = byWord.get(wAttr(child, 'val') ?? '');
        if (target && onlyAttrs(child, ['val'])) def.next = target.appId;
        else extra.push(child);
      } else if ((local === 'pPr' || local === 'rPr') && !seen.has(local)) {
        seen.add(local);
        const { props, residual } = local === 'pPr' ? readPPr(child) : readRPr(child, theme);
        Object.assign(def, props);
        if (residual.length) {
          preserved[local === 'pPr' ? 'pPrXml' : 'rPrXml'] = captureChildren(child, residual);
          if (report && local === 'pPr') {
            const names = residual.map(r => r.localName);
            if (names.includes('tabs')) recordFeature(report, 'tabStops');
            if (names.some(n => ['keepNext', 'keepLines', 'pageBreakBefore', 'widowControl'].includes(n))) recordFeature(report, 'keepRules');
          }
        }
      } else {
        extra.push(child);
        if (report && child.getElementsByTagNameNS(W, 'tblBorders').length) recordFeature(report, 'tableBorders');
      }
    }
    if (extra.length) preserved.extraXml = captureChildren(rec.el, extra);
    if (preserved.pPrXml || preserved.rPrXml || preserved.extraXml) def.preserved = preserved;
    styles[rec.appId] = def;
    extras.set(rec.appId, extra);
    if (rec.type === 'paragraph' && defaultParagraphId === undefined && def.wordDefault) {
      defaultParagraphId = rec.appId;
    }
    if (report && rec.type === 'character') recordFeature(report, 'characterStyle');
    else if (report && rec.type === 'paragraph') recordFeature(report, 'paragraphStyle');
  }

  // basedOn cycles: cut the edge that closes each loop and keep it as preserved XML.
  const done = new Set<string>();
  for (const start of Object.keys(styles)) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur && !done.has(cur)) {
      const onPath = path.indexOf(cur);
      if (onPath >= 0) {
        const closer = styles[path[path.length - 1]];
        const rec = recs.find(r => r.appId === closer.id)!;
        const edge = childElements(rec.el).find(c => isW(c, 'basedOn'))!;
        delete closer.basedOn;
        const extra = [...(extras.get(closer.id) ?? []), edge];
        closer.preserved = { ...closer.preserved, extraXml: captureChildren(rec.el, extra) };
        partWarning(report, 'A style inheritance loop (basedOn) was broken.');
        break;
      }
      path.push(cur);
      cur = styles[cur].basedOn;
    }
    for (const p of path) done.add(p);
  }

  // Heading levels: own outline level, else a "heading N" name, else inherited from the base style.
  const headingLevelByStyleId = new Map<string, 1 | 2 | 3>();
  const levelOf = (rec: Rec, visiting: Set<Rec>): 1 | 2 | 3 | undefined => {
    if (rec.type !== 'paragraph' || visiting.has(rec)) return undefined;
    if (rec.outline !== undefined) return rec.outline >= 0 && rec.outline <= 2 ? ((rec.outline + 1) as 1 | 2 | 3) : undefined;
    const m = /^heading\s*([1-3])$/i.exec(rec.name.trim());
    if (m) return Number(m[1]) as 1 | 2 | 3;
    const base = rec.basedOnWord ? byWord.get(rec.basedOnWord) : undefined;
    return base ? levelOf(base, new Set(visiting).add(rec)) : undefined;
  };
  for (const rec of recs) {
    const level = levelOf(rec, new Set());
    if (level) headingLevelByStyleId.set(rec.appId, level);
  }

  const styleIdByWordId = new Map(recs.map(r => [r.wordId, r.appId] as const));
  const backfilled = new Set<string>();
  if (!styles.normal) {
    // No style named "Normal": synthesise one on top of whatever the document uses as its default.
    styles.normal = { id: 'normal', name: 'Normal', type: 'paragraph', ...(defaultParagraphId ? { basedOn: defaultParagraphId } : {}) };
    backfilled.add('normal');
  }
  // WRITER RULES (see StyleDef): (1) wordDefault/customStyle on the StyleDef win over the same attributes
  // on the root of preserved.extraXml; copy only extraXml's children. (2) derivedFromDefaults lists fields
  // that were inherited, not declared: omit them on export, and whoever edits such a field must remove it
  // from the list. (3) `backfilled` ids were never in the document's styles.xml.
  // w:docDefaults paragraph properties are what every root paragraph style inherits in Word. Copy them
  // onto root paragraph styles so the app's resolver agrees, and say so in `derivedFromDefaults`: they
  // are inherited, not authored, and a writer must not emit them back as the style's own. (Table
  // styles are not paragraph styles and are not touched.)
  for (const def of Object.values(styles)) {
    if (def.type !== 'paragraph' || def.basedOn) continue;
    const derived: NonNullable<StyleDef['derivedFromDefaults']> = [];
    for (const key of ['spaceBeforePt', 'spaceAfterPt', 'lineSpacing', 'indent', 'align'] as const) {
      if (def[key] === undefined && defaultPPr[key] !== undefined) {
        (def as any)[key] = structuredClone(defaultPPr[key]);
        derived.push(key);
      }
    }
    if (derived.length) def.derivedFromDefaults = derived;
  }
  // Built-in styles the app's toolbar and exporter rely on, if the document does not define them.
  for (const [id, def] of Object.entries(nih.styles)) {
    if (!(id in styles)) {
      styles[id] = structuredClone(def);
      backfilled.add(id);
    }
  }

  pkg.releaseXml(stylesPart); // read once; do not keep the parsed document alive
  return {
    format: { page: nih.page, styles, defaults, preset: 'custom' },
    styleIdByWordId,
    headingLevelByStyleId,
    backfilled,
  };
}
