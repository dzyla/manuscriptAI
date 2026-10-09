// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { getImageContext } from './figureContext';

const make = (html: string) => new Editor({ extensions: getSchemaExtensions(), content: htmlToDoc(html) });
/** Put a figure at the end of the first paragraph and select it. */
function withFigure(html: string) {
  const ed = make(html);
  const end = ed.state.doc.firstChild!.nodeSize - 1;
  ed.commands.setTextSelection(end);
  ed.chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
  let pos = -1; ed.state.doc.descendants((n, p) => { if (n.type.name === 'resizableImage') pos = p; });
  ed.commands.setNodeSelection(pos);
  return ed;
}

describe('getImageContext', () => {
  it('is empty with no editor, with a caret, and for a figure with no caption and no neighbouring text', () => {
    expect(getImageContext(null)).toBe('');
    const lone = make('<p></p>');
    lone.chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
    lone.commands.setNodeSelection(0);
    expect(getImageContext(lone)).toBe('');
    const caret = make('<p>Alpha beta</p>');
    caret.commands.setTextSelection(3);
    expect(getImageContext(caret)).toBe('');
  });

  it('prefers a "Figure ..." caption after the figure, else before it', () => {
    const after = withFigure('<p>Intro text.</p><p>Figure 1. Binding curves.</p><p>Later text.</p>');
    expect(getImageContext(after)).toBe('Figure 1. Binding curves.');
    const before = withFigure('<p>Figure 2. Before.</p><p>Plain text.</p>');
    expect(getImageContext(before)).toBe('Figure 2. Before.');
  });

  it('falls back to the paragraph on each side when there is no caption', () => {
    const ed = withFigure('<p>The curve rises.</p><p>It then falls.</p>');
    expect(getImageContext(ed)).toBe('The curve rises.\nIt then falls.');
  });

  it('for a text range around a figure, gives the text in the range and skips the figure', () => {
    const ed = withFigure('<p>Before words.</p><p>After words.</p>');
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size - 1 });
    expect(getImageContext(ed)).toBe('Before words. After words.');
  });
});
