import { Extension } from '@tiptap/core';

/** Block types that carry Word paragraph formatting. */
export const PARAGRAPH_FORMAT_TYPES = ['paragraph', 'heading'];

const num = (el: HTMLElement, name: string): number | null => {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const numAttr = (attrName: string, dataName: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => num(el, dataName),
  renderHTML: (attrs: Record<string, unknown>) => {
    const v = attrs[attrName];
    return typeof v === 'number' && Number.isFinite(v) ? { [dataName]: String(v) } : {};
  },
});

const RULES = ['auto', 'exact', 'atLeast'] as const;

/**
 * Word paragraph formatting that overrides the paragraph's style (spec §1, category 1):
 * the Word style it uses plus line spacing, spacing before/after (points) and indents (inches).
 * null means "inherit from the style". Scalars round-trip through HTML as data-* attributes;
 * lineSpacing is an object, so it has an explicit `rule:value` encoding.
 */
export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: PARAGRAPH_FORMAT_TYPES,
        attributes: {
          styleId: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-style-id') || null,
            renderHTML: (attrs: Record<string, unknown>) => (attrs.styleId ? { 'data-style-id': String(attrs.styleId) } : {}),
          },
          lineSpacing: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.getAttribute('data-line-spacing');
              const m = raw ? /^(auto|exact|atLeast):(-?\d+(?:\.\d+)?)$/.exec(raw) : null;
              return m ? { rule: m[1], value: Number(m[2]) } : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const ls = attrs.lineSpacing as { rule?: string; value?: number } | null;
              return ls && RULES.includes(ls.rule as (typeof RULES)[number]) && Number.isFinite(ls.value)
                ? { 'data-line-spacing': `${ls.rule}:${ls.value}` }
                : {};
            },
          },
          spaceBefore: numAttr('spaceBefore', 'data-space-before'),
          spaceAfter: numAttr('spaceAfter', 'data-space-after'),
          indentLeft: numAttr('indentLeft', 'data-indent-left'),
          indentFirstLine: numAttr('indentFirstLine', 'data-indent-first-line'),
        },
      },
    ];
  },
});
