import type { DocFormat, FormatPreset, PageSetup, ResolvedStyle, StyleDef } from '../types';

export const PAGE_SIZES_IN: Record<PageSetup['size'], { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.27, height: 11.69 },
};

export const BUILTIN_STYLE_IDS = ['normal', 'heading1', 'heading2', 'heading3', 'caption', 'bibliography'] as const;

interface PresetSpec {
  size: PageSetup['size'];
  marginIn: number;
  fontFamily: string;
  fontSizePt: number;
  lineMultiple: number;
}

const PRESETS: Record<Exclude<FormatPreset, 'custom'>, PresetSpec> = {
  nih: { size: 'letter', marginIn: 0.5, fontFamily: 'Arial', fontSizePt: 11, lineMultiple: 1 },
  manuscript: { size: 'letter', marginIn: 1, fontFamily: 'Times New Roman', fontSizePt: 12, lineMultiple: 2 },
  a4: { size: 'a4', marginIn: 1, fontFamily: 'Arial', fontSizePt: 11, lineMultiple: 1 },
};

function builtinStyles(spec: PresetSpec): Record<string, StyleDef> {
  const s: StyleDef[] = [
    {
      id: 'normal', name: 'Normal', type: 'paragraph',
      fontFamily: spec.fontFamily, fontSizePt: spec.fontSizePt,
      lineSpacing: { rule: 'auto', value: spec.lineMultiple },
      spaceBeforePt: 0, spaceAfterPt: 0, align: 'left',
    },
    { id: 'heading1', name: 'Heading 1', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, spaceBeforePt: 6, spaceAfterPt: 3 },
    { id: 'heading2', name: 'Heading 2', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, spaceBeforePt: 6, spaceAfterPt: 3 },
    { id: 'heading3', name: 'Heading 3', type: 'paragraph', basedOn: 'normal', next: 'normal', bold: true, italic: true, spaceBeforePt: 3, spaceAfterPt: 0 },
    { id: 'caption', name: 'Caption', type: 'paragraph', basedOn: 'normal', fontSizePt: Math.max(spec.fontSizePt - 1, 9), spaceAfterPt: 3 },
    { id: 'bibliography', name: 'Bibliography', type: 'paragraph', basedOn: 'normal', indent: { hangingIn: 0.25 } },
  ];
  return Object.fromEntries(s.map(x => [x.id, x]));
}

export function createFormat(preset: Exclude<FormatPreset, 'custom'>): DocFormat {
  const spec = PRESETS[preset];
  const m = spec.marginIn;
  return {
    page: { size: spec.size, orientation: 'portrait', marginsIn: { top: m, right: m, bottom: m, left: m } },
    styles: builtinStyles(spec),
    defaults: { fontFamily: spec.fontFamily, fontSizePt: spec.fontSizePt },
    preset,
  };
}

/** Collect the basedOn chain from root ancestor to the style itself (cycle-safe). */
function styleChain(format: DocFormat, styleId: string): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let cur: StyleDef | undefined = format.styles[styleId];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.basedOn ? format.styles[cur.basedOn] : undefined;
  }
  return chain;
}

export function resolveStyle(format: DocFormat, styleId: string | null | undefined): ResolvedStyle {
  const id = styleId && format.styles[styleId] ? styleId : 'normal';
  const base: ResolvedStyle = {
    fontFamily: format.defaults.fontFamily,
    fontSizePt: format.defaults.fontSizePt,
    bold: false,
    italic: false,
    color: '#000000',
    lineSpacing: { rule: 'auto', value: 1 },
    spaceBeforePt: 0,
    spaceAfterPt: 0,
    indent: { leftIn: 0, firstLineIn: 0, hangingIn: 0 },
    align: 'left',
  };
  const chain = styleChain(format, id);
  // Ensure 'normal' is the implicit root for paragraph styles without an explicit basedOn chain to it.
  if (id !== 'normal' && chain[0]?.id !== 'normal' && format.styles.normal) chain.unshift(format.styles.normal);
  for (const s of chain) {
    if (s.fontFamily !== undefined) base.fontFamily = s.fontFamily;
    if (s.fontSizePt !== undefined) base.fontSizePt = s.fontSizePt;
    if (s.bold !== undefined) base.bold = s.bold;
    if (s.italic !== undefined) base.italic = s.italic;
    if (s.color !== undefined) base.color = s.color;
    if (s.lineSpacing !== undefined) base.lineSpacing = { ...s.lineSpacing };
    if (s.spaceBeforePt !== undefined) base.spaceBeforePt = s.spaceBeforePt;
    if (s.spaceAfterPt !== undefined) base.spaceAfterPt = s.spaceAfterPt;
    if (s.indent) base.indent = { ...base.indent, ...s.indent };
    if (s.align !== undefined) base.align = s.align;
  }
  return base;
}
