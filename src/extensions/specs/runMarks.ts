import { Mark } from '@tiptap/core';

/** Only values that are safe to put in an inline style are mirrored into `style`; the data-* attribute always carries the value. */
const SAFE_FONT = /^[\w .,'"-]{1,80}$/;
const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

const dataAttr = (attrName: string, dataName: string, extra?: (v: unknown) => Record<string, string>) => ({
  default: null,
  parseHTML: (el: HTMLElement) => el.getAttribute(dataName) || null,
  renderHTML: (attrs: Record<string, unknown>) => {
    const v = attrs[attrName];
    return v === null || v === undefined || v === '' ? {} : { [dataName]: String(v), ...(extra?.(v) ?? {}) };
  },
});

/** Direct run formatting from Word: w:rFonts, w:sz, w:color (spec §1, category 1). */
export const FontFamilyMark = Mark.create({
  name: 'fontFamily',
  addAttributes() {
    return {
      family: dataAttr('family', 'data-font-family', v =>
        SAFE_FONT.test(String(v)) ? { style: `font-family: ${String(v)}` } : {}),
    };
  },
  parseHTML: () => [{ tag: 'span[data-font-family]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

export const FontSizeMark = Mark.create({
  name: 'fontSize',
  addAttributes() {
    return {
      sizePt: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const n = Number(el.getAttribute('data-font-size'));
          return Number.isFinite(n) && n > 0 ? n : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs.sizePt === 'number' && Number.isFinite(attrs.sizePt) && attrs.sizePt > 0
            ? { 'data-font-size': String(attrs.sizePt), style: `font-size: ${attrs.sizePt}pt` }
            : {},
      },
    };
  },
  parseHTML: () => [{ tag: 'span[data-font-size]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

export const TextColorMark = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: dataAttr('color', 'data-text-color', v => (SAFE_COLOR.test(String(v)) ? { style: `color: ${String(v)}` } : {})),
    };
  },
  parseHTML: () => [{ tag: 'span[data-text-color]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});

export const SuperscriptMark = Mark.create({
  name: 'superscript',
  excludes: 'subscript',
  parseHTML: () => [{ tag: 'sup' }],
  renderHTML: () => ['sup', 0],
});

export const SubscriptMark = Mark.create({
  name: 'subscript',
  excludes: 'superscript',
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: () => ['sub', 0],
});

/** A Word character style applied to a run (w:rStyle); `styleId` is the app's style id. */
export const CharacterStyleMark = Mark.create({
  name: 'characterStyle',
  addAttributes() {
    return { styleId: dataAttr('styleId', 'data-char-style') };
  },
  parseHTML: () => [{ tag: 'span[data-char-style]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', HTMLAttributes, 0],
});
