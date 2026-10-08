import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_TEXT, isBlankText, isBlankDoc } from './placeholder';

describe('isBlankText', () => {
  it('is true for nothing and for exactly the placeholder, however its whitespace or quotes were serialised', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('  \n ')).toBe(true);
    expect(isBlankText(PLACEHOLDER_TEXT)).toBe(true);
    expect(isBlankText('Start writing your manuscript here,\n   or click "New Manuscript"  to begin\twith an IMRAD template.')).toBe(true);
    expect(isBlankText('Start writing your manuscript here, or click &quot;New Manuscript&quot; to begin with an IMRAD template.')).toBe(true);
  });
  it('is false for any text typed into, before or after it', () => {
    expect(isBlankText(PLACEHOLDER_TEXT + ' and more')).toBe(false);
    expect(isBlankText('Aims ' + PLACEHOLDER_TEXT)).toBe(false);
    expect(isBlankText('Start writing your manuscript here')).toBe(false);
  });
});

describe('isBlankDoc', () => {
  const p = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
  it('is true for empty paragraphs and headings and for the placeholder', () => {
    expect(isBlankDoc({ type: 'doc', content: [p(), { type: 'heading', attrs: { level: 1 } }] })).toBe(true);
    expect(isBlankDoc({ type: 'doc', content: [p(PLACEHOLDER_TEXT)] })).toBe(true);
  });
  it('is false for any text, and for any non-text node, however empty: a figure, a line break, a rule, a table, a list, a preserved piece', () => {
    expect(isBlankDoc({ type: 'doc', content: [p('Aims')] })).toBe(false);
    for (const type of ['resizableImage', 'horizontalRule', 'opaqueBlock', 'pageBreak']) expect(isBlankDoc({ type: 'doc', content: [p(), { type, attrs: {} }] }), type).toBe(false);
    expect(isBlankDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }] })).toBe(false);
    expect(isBlankDoc({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p()] }] }] }] })).toBe(false);
    expect(isBlankDoc({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p()] }] }] })).toBe(false);
  });
});
