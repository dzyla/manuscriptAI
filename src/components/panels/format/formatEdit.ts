import type { DocFormat, FormatPreset, PageSetup, StyleDef } from '../../../types';
import { BUILTIN_STYLE_IDS, createFormat, resolveStyle } from '../../../services/formatPresets';

/** NIH's application guide: margins of at least half an inch on every side, body text of at least 11 pt. */
export const NIH_MIN_MARGIN_IN = 0.5;
export const NIH_MIN_BODY_PT = 11;
/** The ranges the panel accepts. Outside them a value is a typo (a 400 pt font, a negative margin), not a layout. */
export const MARGIN_RANGE = { min: 0, max: 3 } as const;
export const FONT_RANGE = { min: 6, max: 72 } as const;

export type Side = keyof PageSetup['marginsIn'];
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

/** A number from typed text inside [min, max], or null (blank, not a number, or out of range). */
export function parseBounded(text: string, min: number, max: number): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** No stored format: the panel shows, and edits start from, the NIH preset the editor falls back to. */
export const baseFormat = (f: DocFormat | null): DocFormat => f ?? createFormat('nih');

export function withMargin(f: DocFormat, side: Side, inches: number): DocFormat {
  return { ...f, preset: 'custom', page: { ...f.page, marginsIn: { ...f.page.marginsIn, [side]: inches } } };
}

/** Margins stay as they are: only the sheet changes. */
export function withPageSize(f: DocFormat, size: PageSetup['size']): DocFormat {
  return size === f.page.size ? f : { ...f, preset: 'custom', page: { ...f.page, size } };
}

/**
 * A preset replaces the page, the defaults and the built-in styles. Styles the preset does not define stay, and a built-in style keeps what a Word import
 * recorded about it (its preserved XML and Word flags), so the document can still be written back. The page limit is the author's and is kept.
 */
export function withPreset(f: DocFormat, preset: Exclude<FormatPreset, 'custom'>): DocFormat {
  const next = createFormat(preset);
  const styles: Record<string, StyleDef> = { ...f.styles };
  for (const [id, s] of Object.entries(next.styles)) {
    const old = f.styles[id];
    styles[id] = old ? { ...s, ...(old.preserved ? { preserved: old.preserved } : {}), ...(old.wordDefault ? { wordDefault: old.wordDefault } : {}), ...(old.customStyle ? { customStyle: old.customStyle } : {}) } : s;
  }
  return { ...next, styles, ...(f.pageLimitPages !== undefined ? { pageLimitPages: f.pageLimitPages } : {}) };
}

const STYLE_NAMES: Record<string, string> = { normal: 'Normal', heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3', caption: 'Caption', bibliography: 'Bibliography' };
export const styleName = (f: DocFormat, id: string): string => f.styles[id]?.name ?? STYLE_NAMES[id] ?? id;
export const builtinStyleIds = (): readonly string[] => BUILTIN_STYLE_IDS;

/** Set or clear (undefined) one style's own font or size. A cleared style inherits through its basedOn chain. */
export function withStyleField(f: DocFormat, id: string, patch: { fontFamily?: string | undefined; fontSizePt?: number | undefined }): DocFormat {
  const cur: StyleDef = f.styles[id] ?? { id, name: styleName(f, id), type: 'paragraph' };
  const next: StyleDef = { ...cur, ...patch };
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete next[k];
  return { ...f, preset: 'custom', styles: { ...f.styles, [id]: next } };
}

/** The body font size as the document resolves it (the Normal style, through its chain and the defaults). */
export const bodyFontPt = (f: DocFormat): number => resolveStyle(f, 'normal').fontSizePt;

export function marginWarning(f: DocFormat): string | null {
  const low = SIDES.filter(s => f.page.marginsIn[s] < NIH_MIN_MARGIN_IN);
  if (!low.length) return null;
  return `The ${low.map(s => `${s} margin is ${f.page.marginsIn[s]} in`).join(', ').replace(/, ([^,]*)$/, ' and $1')}. NIH's application guide requires margins of at least ${NIH_MIN_MARGIN_IN} in on every side.`;
}

export function fontWarning(f: DocFormat): string | null {
  const pt = bodyFontPt(f);
  return pt < NIH_MIN_BODY_PT ? `The body font is ${pt} pt. NIH's application guide requires text of at least ${NIH_MIN_BODY_PT} pt.` : null;
}
