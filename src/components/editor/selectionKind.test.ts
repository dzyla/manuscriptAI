// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { selectionInfo, NO_SELECTION, sameSelection } from './selectionKind';

const make = (html: string) => new Editor({ extensions: getSchemaExtensions(), content: htmlToDoc(html) });
const figure = (ed: Editor) => ed.chain().insertContent({ type: 'resizableImage', attrs: { src: 'data:image/png;base64,AAAA' } }).run();
const figurePos = (ed: Editor) => { let pos = -1; ed.state.doc.descendants((n, p) => { if (n.type.name === 'resizableImage') pos = p; }); return pos; };

describe('selectionInfo', () => {
  it('is none for no editor, a destroyed editor, and a caret in plain text', () => {
    expect(selectionInfo(null)).toEqual(NO_SELECTION);
    const ed = make('<p>Alpha beta</p>');
    ed.commands.setTextSelection(3);
    expect(selectionInfo(ed).kind).toBe('none');
    ed.destroy();
    expect(selectionInfo(ed)).toEqual(NO_SELECTION);
  });

  it('is text for a range, with its word count and the section it starts in', () => {
    const ed = make('<h2>Intro</h2><p>Alpha beta gamma delta</p><h2>Methods</h2><p>Zeta eta</p>');
    ed.commands.setTextSelection({ from: 8, to: 24 });
    expect(selectionInfo(ed)).toEqual({ kind: 'text', words: 3, section: 'Intro' });
    ed.destroy();
  });

  it('is text for a range that spans two blocks, and the section is where it starts', () => {
    const ed = make('<h2>Intro</h2><p>Alpha beta</p><h2>Methods</h2><p>Zeta eta</p>');
    const end = ed.state.doc.content.size - 2;
    ed.commands.setTextSelection({ from: 9, to: end });
    const info = selectionInfo(ed);
    expect(info.kind).toBe('text');
    expect(info.section).toBe('Intro');
    expect(info.words).toBeGreaterThan(3);
    ed.destroy();
  });

  it('is table for a caret in a cell, but text for words selected inside a cell (the author wants bold, not a row)', () => {
    const ed = make('<p>Cell text</p>');
    ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    expect(selectionInfo(ed).kind).toBe('table');
    ed.commands.insertContent('Words here');
    const { from } = ed.state.selection;
    ed.commands.setTextSelection({ from: from - 10, to: from - 5 });
    expect(selectionInfo(ed).kind).toBe('text');
    ed.destroy();
  });

  it('is table for a selection of whole cells', () => {
    const ed = make('<p>x</p>');
    ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
    const cells: number[] = [];
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'tableCell') cells.push(p); });
    ed.view.dispatch(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, cells[0], cells[3])));
    expect(selectionInfo(ed).kind).toBe('table');
    ed.destroy();
  });

  it('is figure for a selected figure, and for a text range that spans one (the figure wins: text actions would be aimed at a picture)', () => {
    const ed = make('<p>Before text</p><p>After text</p>');
    ed.commands.setTextSelection(12); // end of the first paragraph: the figure then sits between the two
    figure(ed);
    ed.commands.setNodeSelection(figurePos(ed));
    expect(selectionInfo(ed).kind).toBe('figure');
    ed.commands.setTextSelection({ from: 2, to: ed.state.doc.content.size - 2 });
    expect(selectionInfo(ed).kind).toBe('figure');
    ed.destroy();
  });

  it('compares selections by kind, word count and section', () => {
    expect(sameSelection({ kind: 'text', words: 2, section: 'A' }, { kind: 'text', words: 2, section: 'A' })).toBe(true);
    expect(sameSelection({ kind: 'text', words: 2, section: 'A' }, { kind: 'text', words: 3, section: 'A' })).toBe(false);
    expect(sameSelection(NO_SELECTION, { kind: 'none', words: 0, section: 'A' })).toBe(false);
  });
});
