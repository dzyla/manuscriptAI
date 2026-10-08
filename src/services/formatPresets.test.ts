import { describe, it, expect } from 'vitest';
import { createFormat, resolveStyle, PAGE_SIZES_IN, BUILTIN_STYLE_IDS } from './formatPresets';
import type { DocFormat } from '../types';

describe('createFormat', () => {
  it('NIH preset: Arial 11, 0.5in margins, letter, single spacing', () => {
    const f = createFormat('nih');
    expect(f.preset).toBe('nih');
    expect(f.page).toEqual({ size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } });
    expect(f.defaults).toEqual({ fontFamily: 'Arial', fontSizePt: 11 });
    expect(resolveStyle(f, 'normal').lineSpacing).toEqual({ rule: 'auto', value: 1 });
  });

  it('manuscript preset: Times New Roman 12, double spacing, 1in margins', () => {
    const f = createFormat('manuscript');
    expect(f.defaults).toEqual({ fontFamily: 'Times New Roman', fontSizePt: 12 });
    expect(f.page.marginsIn.left).toBe(1);
    expect(resolveStyle(f, 'normal').lineSpacing).toEqual({ rule: 'auto', value: 2 });
  });

  it('a4 preset uses a4 paper', () => {
    expect(createFormat('a4').page.size).toBe('a4');
    expect(PAGE_SIZES_IN.a4.width).toBeCloseTo(8.27, 2);
  });

  it('every preset defines all built-in styles', () => {
    for (const p of ['nih', 'manuscript', 'a4'] as const) {
      const f = createFormat(p);
      for (const id of BUILTIN_STYLE_IDS) expect(f.styles[id]?.id).toBe(id);
    }
  });

  it('returns independent objects (no shared mutable state)', () => {
    const a = createFormat('nih');
    a.page.marginsIn.top = 2;
    expect(createFormat('nih').page.marginsIn.top).toBe(0.5);
  });
});

describe('resolveStyle', () => {
  it('heading inherits font family from normal and sets bold', () => {
    const r = resolveStyle(createFormat('nih'), 'heading1');
    expect(r.fontFamily).toBe('Arial');
    expect(r.bold).toBe(true);
    expect(r.fontSizePt).toBe(11);
  });

  it('unknown or empty style id resolves to normal', () => {
    const f = createFormat('nih');
    expect(resolveStyle(f, 'nope')).toEqual(resolveStyle(f, 'normal'));
    expect(resolveStyle(f, null)).toEqual(resolveStyle(f, 'normal'));
  });

  it('walks a custom basedOn chain, child overrides parent', () => {
    const f: DocFormat = createFormat('nih');
    f.styles.aimTitle = { id: 'aimTitle', name: 'Aim Title', type: 'paragraph', basedOn: 'heading2', italic: true, fontSizePt: 12 };
    const r = resolveStyle(f, 'aimTitle');
    expect(r).toMatchObject({ bold: true, italic: true, fontSizePt: 12, fontFamily: 'Arial' });
  });

  it('survives a basedOn cycle', () => {
    const f: DocFormat = createFormat('nih');
    f.styles.a = { id: 'a', name: 'A', type: 'paragraph', basedOn: 'b', bold: true };
    f.styles.b = { id: 'b', name: 'B', type: 'paragraph', basedOn: 'a', italic: true };
    const r = resolveStyle(f, 'a');
    expect(r.bold).toBe(true);
    expect(r.italic).toBe(true);
  });
});
