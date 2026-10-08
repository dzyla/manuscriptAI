import { describe, it, expect } from 'vitest';
import { textToHtml } from './textImport';

describe('textToHtml', () => {
  it('splits plain text into paragraphs on blank lines, joins wrapped lines and escapes markup', () => {
    expect(textToHtml('First line\nwrapped.\n\nSecond <b>para</b> & more', false)).toBe('<p>First line wrapped.</p><p>Second &lt;b&gt;para&lt;/b&gt; &amp; more</p>');
  });
  it('treats # lines as headings and - lines as a list in Markdown only (capped at level 3)', () => {
    const md = '# Title\n\nBody.\n\n#### Deep\n\n- a\n- b';
    expect(textToHtml(md, true)).toBe('<h1>Title</h1><p>Body.</p><h3>Deep</h3><ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(textToHtml('# Not a heading', false)).toBe('<p># Not a heading</p>');
  });
  it('an empty file is one empty paragraph, and CRLF is understood', () => {
    expect(textToHtml('  \n ', false)).toBe('<p></p>');
    expect(textToHtml('a\r\n\r\nb', false)).toBe('<p>a</p><p>b</p>');
  });
});
