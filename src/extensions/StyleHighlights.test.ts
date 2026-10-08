// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from './schema';
import { StyleHighlights, sentenceDecorations, replaceRangeWithText } from './StyleHighlights';
import { auditText, worstSentences } from '../services/proseAudit/metrics';
import { flattenDoc } from '../utils/textMatch';

function editorWith(html: string) {
  return new Editor({
    extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => true, getSentences: () => [] })],
    content: htmlToDoc(html),
  });
}

describe('sentenceDecorations', () => {
  it('maps a flagged sentence onto the document text it came from', () => {
    const editor = editorWith('<p>We purified the complex by gel filtration. Binding fell at low pH; the effect was large.</p>');
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    const decos = sentenceDecorations(editor.state.doc, worst);
    expect(decos).toHaveLength(1);
    const d = decos[0] as unknown as { from: number; to: number };
    expect(editor.state.doc.textBetween(d.from, d.to, ' ')).toContain('Binding fell at low pH');
    editor.destroy();
  });

  it('maps across a citation atom without drifting', () => {
    const editor = editorWith(
      '<p>The receptor binds the protein <span data-citation-node="" data-source-ids="s1" data-nums="1">[1]</span>; affinity was nanomolar in this assay.</p>',
    );
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    const d = sentenceDecorations(editor.state.doc, worst)[0] as unknown as { from: number; to: number };
    expect(editor.state.doc.textBetween(d.from, d.to, ' ')).toContain('affinity was nanomolar');
    editor.destroy();
  });

  it('maps a sentence inside a table cell', () => {
    const editor = editorWith(
      '<table><tbody><tr><td><p>The construct was expressed in insect cells; yields were low.</p></td></tr></tbody></table>',
    );
    const flat = flattenDoc(editor.state.doc);
    const worst = worstSentences(auditText(flat.text), 1);
    expect(sentenceDecorations(editor.state.doc, worst)).toHaveLength(1);
    editor.destroy();
  });

  it('drops a sentence whose offsets no longer exist', () => {
    const editor = editorWith('<p>Short text only.</p>');
    const decos = sentenceDecorations(editor.state.doc, [{ start: 500, end: 540, words: 8, tells: ['semicolon'], severity: 20 }]);
    expect(decos).toEqual([]);
    editor.destroy();
  });

  it('adds no decorations when disabled', () => {
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => false, getSentences: () => [{ start: 0, end: 10, words: 5, tells: ['semicolon'], severity: 20 }] })],
      content: htmlToDoc('<p>We purified the complex; it was pure.</p>'),
    });
    expect(decoCount(editor)).toBe(0);
    editor.commands.refreshStyleAudit();
    expect(decoCount(editor)).toBe(0);
    editor.destroy();
  });
});

function decoCount(editor: Editor): number {
  const plugin = editor.state.plugins.find(p => (p as unknown as { key: string }).key.startsWith('styleHighlights'))!;
  const set = plugin.getState(editor.state) as { find: () => unknown[] };
  return set.find().length;
}

describe('StyleHighlights plugin', () => {
  const sentence = { start: 0, end: 10, words: 5, tells: ['semicolon'], severity: 20 };

  it('shows decorations when enabled, never alters the document, and can be toggled', () => {
    const html = '<p>We purified the complex; it was pure.</p>';
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => true, getSentences: () => [sentence] })],
      content: htmlToDoc(html),
    });
    const before = JSON.stringify(editor.getJSON());
    editor.commands.refreshStyleAudit();
    expect(decoCount(editor)).toBe(1);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(editor.getHTML()).not.toContain('style-tell');
    editor.commands.setStyleHighlightsEnabled(false);
    expect(decoCount(editor)).toBe(0);
    editor.commands.setStyleHighlightsEnabled(true);
    expect(decoCount(editor)).toBe(1);
    editor.destroy();
  });

  it('keeps a highlight on its sentence when text is inserted before it', () => {
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => true, getSentences: () => [{ ...sentence, start: 5, end: 12 }] })],
      content: htmlToDoc('<p>Hello world again.</p>'),
    });
    editor.commands.refreshStyleAudit();
    editor.commands.insertContentAt(1, 'XXX');
    const plugin = editor.state.plugins.find(p => (p as unknown as { key: string }).key.startsWith('styleHighlights'))!;
    const [d] = (plugin.getState(editor.state) as { find: () => { from: number; to: number }[] }).find();
    expect(editor.state.doc.textBetween(d.from, d.to)).toBe(' world ');
    editor.destroy();
  });

  it('debounces the re-audit report and cancels it on destroy', () => {
    vi.useFakeTimers();
    try {
      const reports: number[] = [];
      const editor = new Editor({
        extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => true, getSentences: () => [], onReport: m => reports.push(m.sentences.length), debounceMs: 100 })],
        content: htmlToDoc('<p>One sentence here.</p>'),
      });
      editor.commands.insertContentAt(1, 'A ');
      editor.commands.insertContentAt(1, 'B ');
      vi.advanceTimersByTime(99);
      expect(reports).toHaveLength(0);
      vi.advanceTimersByTime(2);
      expect(reports).toHaveLength(1);
      editor.commands.insertContentAt(1, 'C ');
      editor.destroy();
      vi.advanceTimersByTime(1000);
      expect(reports).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('replaceRangeWithText', () => {
  function plain(html: string) {
    return new Editor({ extensions: [...getSchemaExtensions()], content: htmlToDoc(html) });
  }
  const whole = (e: Editor) => ({ from: 1, to: e.state.doc.content.size - 1 });

  it('inserts text containing < and & verbatim, with no stray nodes', () => {
    const e = plain('<p>placeholder words</p>');
    const { from, to } = whole(e);
    const text = 'We observed p < 0.05 in all runs & replicates.';
    expect(replaceRangeWithText(e, from, to, text)).toBe(true);
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.child(0).childCount).toBe(1);
    expect(e.state.doc.textBetween(0, e.state.doc.content.size, '\n')).toBe(text);
    e.destroy();
  });

  it('inserts a tag-looking substring literally', () => {
    const e = plain('<p>placeholder words</p>');
    const { from, to } = whole(e);
    expect(replaceRangeWithText(e, from, to, 'the <control> group')).toBe(true);
    expect(e.state.doc.textBetween(0, e.state.doc.content.size, '\n')).toBe('the <control> group');
    expect(e.state.doc.child(0).childCount).toBe(1);
    e.destroy();
  });

  it('does not interpret real tags or entities (no marks, no entity decoding)', () => {
    for (const text of ['a <b>bold</b> &amp; c', 'x &lt; y']) {
      const e = plain('<p>placeholder words</p>');
      expect(replaceRangeWithText(e, 1, 12, text)).toBe(true);
      expect(e.state.doc.textBetween(0, e.state.doc.content.size, '\n')).toBe(text + ' words');
      expect(e.getHTML()).not.toContain('<strong>');
      e.destroy();
    }
  });

  it('turns newlines into hard breaks inside the same paragraph', () => {
    const e = plain('<p>placeholder words</p>');
    const { from, to } = whole(e);
    expect(replaceRangeWithText(e, from, to, 'One.\nTwo.')).toBe(true);
    expect(e.state.doc.childCount).toBe(1);
    const kinds: string[] = [];
    e.state.doc.child(0).forEach(n => kinds.push(n.type.name));
    expect(kinds).toEqual(['text', 'hardBreak', 'text']);
    e.destroy();
  });

  it('rejects invalid ranges and leaves the document untouched', () => {
    const e = plain('<p>placeholder words</p>');
    const before = JSON.stringify(e.getJSON());
    const size = e.state.doc.content.size;
    expect(replaceRangeWithText(e, -1, 4, 'x')).toBe(false);
    expect(replaceRangeWithText(e, 1, size + 1, 'x')).toBe(false);
    expect(replaceRangeWithText(e, 5, 5, 'x')).toBe(false);
    expect(replaceRangeWithText(e, 6, 5, 'x')).toBe(false);
    expect(JSON.stringify(e.getJSON())).toBe(before);
    e.destroy();
  });

  it('is a single undo step', () => {
    const e = new Editor({ extensions: [...getSchemaExtensions()], content: htmlToDoc('<p>placeholder words</p>') });
    const before = JSON.stringify(e.getJSON());
    expect(replaceRangeWithText(e, 1, 12, 'a < b\nand c & d')).toBe(true);
    expect(JSON.stringify(e.getJSON())).not.toBe(before);
    e.commands.undo();
    expect(JSON.stringify(e.getJSON())).toBe(before);
    e.destroy();
  });
});

type J = { type?: string; content?: J[]; text?: string };
const jsonOf = (e: Editor) => e.getJSON() as unknown as J;

describe('replaceRangeWithText preserves the surrounding block and marks', () => {
  function mk(html: string) {
    return new Editor({ extensions: [...getSchemaExtensions()], content: htmlToDoc(html) });
  }
  const firstBlock = (e: Editor) => e.getJSON().content![0];
  const texts = ['A B', 'A\nB'];

  for (const text of texts) {
    const label = text.includes('\n') ? 'multi-line' : 'single-line';

    it(`keeps a heading at the same level (${label})`, () => {
      const e = mk('<h2>First sentence here. Second one.</h2>');
      expect(replaceRangeWithText(e, 1, 21, text)).toBe(true);
      const b = firstBlock(e);
      expect(b.type).toBe('heading');
      expect(b.attrs?.level).toBe(2);
      e.destroy();
    });

    it(`keeps textAlign on a centered paragraph (${label})`, () => {
      const e = mk('<p style="text-align: center">First sentence here. Second one.</p>');
      expect(firstBlock(e).attrs?.textAlign).toBe('center');
      expect(replaceRangeWithText(e, 1, 21, text)).toBe(true);
      expect(firstBlock(e).attrs?.textAlign).toBe('center');
      expect(e.state.doc.childCount).toBe(1);
      e.destroy();
    });

    it(`keeps the ooxml provenance attribute (${label})`, () => {
      const e = mk('<p data-ooxml=\'{"blockId":"b1","sourceHash":"h1"}\'>First sentence here. Second one.</p>');
      expect(firstBlock(e).attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: 'h1' });
      expect(replaceRangeWithText(e, 1, 21, text)).toBe(true);
      expect(firstBlock(e).attrs?.ooxml).toEqual({ blockId: 'b1', sourceHash: 'h1' });
      e.destroy();
    });

    it(`keeps the replaced range's marks (${label})`, () => {
      const e = mk('<p>plain <strong>bold words</strong> tail</p>');
      expect(replaceRangeWithText(e, 7, 17, text)).toBe(true);
      const inline = (firstBlock(e).content ?? []).filter(n => n.type === 'text') as { text?: string; marks?: { type: string }[] }[];
      const boldText = inline.filter(n => n.marks?.some(m => m.type === 'bold')).map(n => n.text ?? '').join('');
      expect(boldText).toBe(text.replace('\n', ''));
      expect(inline[0].marks ?? []).toEqual([]);
      e.destroy();
    });
  }

  it('rejects a range that crosses a block boundary and leaves the document byte-identical', () => {
    for (const text of ['Z Q', 'Z\nQ']) {
      const e = mk('<p>abc def</p><p>ghi jkl</p>');
      const before = JSON.stringify(e.getJSON());
      expect(replaceRangeWithText(e, 5, 12, text)).toBe(false);
      expect(JSON.stringify(e.getJSON())).toBe(before);
      e.destroy();
    }
  });

  it('rejects multi-line text in a code block but allows single-line text there', () => {
    const e = mk('<pre><code>abc def ghi</code></pre>');
    const before = JSON.stringify(e.getJSON());
    expect(replaceRangeWithText(e, 1, 4, 'X\nY')).toBe(false);
    expect(JSON.stringify(e.getJSON())).toBe(before);
    expect(replaceRangeWithText(e, 1, 4, 'X Y')).toBe(true);
    const block = jsonOf(e).content![0];
    expect(block.type).toBe('codeBlock');
    expect(block.content).toEqual([{ type: 'text', text: 'X Y def ghi' }]);
    e.destroy();
  });

  for (const text of ['A B', 'A\nB']) {
    const label = text.includes('\n') ? 'multi-line' : 'single-line';
    it(`works inside a list item (${label})`, () => {
      const e = mk('<ul><li><p>First sentence here. Second one.</p></li></ul>');
      const from = 3; // inside ul > li > p
      expect(e.state.doc.textBetween(from, from + 20)).toBe('First sentence here.');
      expect(replaceRangeWithText(e, from, from + 20, text)).toBe(true);
      const li = jsonOf(e).content![0].content![0];
      expect(li.type).toBe('listItem');
      expect(li.content).toHaveLength(1);
      expect(li.content![0].type).toBe('paragraph');
      e.destroy();
    });

    it(`works inside a table cell (${label})`, () => {
      const e = mk('<table><tbody><tr><td><p>First sentence here. Second one.</p></td></tr></tbody></table>');
      let from = -1;
      e.state.doc.descendants((n, pos) => { if (n.isText && from < 0) from = pos; });
      expect(replaceRangeWithText(e, from, from + 20, text)).toBe(true);
      const cell = jsonOf(e).content![0].content![0].content![0];
      expect(cell.type).toBe('tableCell');
      expect(cell.content).toHaveLength(1);
      expect(cell.content![0].type).toBe('paragraph');
      e.destroy();
    });
  }

  it('rejects NaN / non-integer bounds and empty text', () => {
    const e = mk('<p>placeholder words</p>');
    expect(replaceRangeWithText(e, NaN, 5, 'x')).toBe(false);
    expect(replaceRangeWithText(e, 1, 5.5, 'x')).toBe(false);
    expect(replaceRangeWithText(e, 1, 5, '')).toBe(false);
    e.destroy();
  });

  it('normalizes a lone CR to a hard break', () => {
    const e = mk('<p>placeholder words</p>');
    expect(replaceRangeWithText(e, 1, 12, 'One.\rTwo.')).toBe(true);
    expect(e.getJSON().content![0].content!.map(n => n.type)).toEqual(['text', 'hardBreak', 'text']);
    e.destroy();
  });
});

describe('StyleHighlights audit gating', () => {
  it('schedules no audit while disabled, and does once enabled; a throwing consumer is contained', () => {
    vi.useFakeTimers();
    try {
      const reports: number[] = [];
      let throwOnReport = false;
      const editor = new Editor({
        extensions: [...getSchemaExtensions(), StyleHighlights.configure({
          getEnabled: () => false,
          getSentences: () => [],
          onReport: m => { if (throwOnReport) throw new Error('boom'); reports.push(m.sentences.length); },
          debounceMs: 50,
        })],
        content: htmlToDoc('<p>One sentence here.</p>'),
      });
      editor.commands.insertContentAt(1, 'A ');
      vi.advanceTimersByTime(500);
      expect(reports).toHaveLength(0);

      editor.commands.setStyleHighlightsEnabled(true);
      editor.commands.insertContentAt(1, 'B ');
      vi.advanceTimersByTime(60);
      expect(reports).toHaveLength(1);

      throwOnReport = true;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      editor.commands.insertContentAt(1, 'C ');
      expect(() => vi.advanceTimersByTime(60)).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
      editor.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not write the enabled override on a can() dry run', () => {
    const editor = new Editor({
      extensions: [...getSchemaExtensions(), StyleHighlights.configure({ getEnabled: () => false, getSentences: () => [{ start: 0, end: 10, words: 5, tells: ['semicolon'], severity: 20 }] })],
      content: htmlToDoc('<p>We purified the complex; it was pure.</p>'),
    });
    expect(editor.can().setStyleHighlightsEnabled(true)).toBe(true);
    editor.commands.refreshStyleAudit();
    expect(decoCount(editor)).toBe(0);
    editor.destroy();
  });
});
