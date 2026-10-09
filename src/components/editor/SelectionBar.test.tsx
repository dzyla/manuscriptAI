// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { SelectionBar } from './SelectionBar';
import { blockOptions } from './blocks';
import { BUILTIN_STYLE_IDS } from '../../services/formatPresets';
import { createFormat } from '../../services/formatPresets';

afterEach(cleanup);

const make = (html: string) => new Editor({ extensions: getSchemaExtensions(), content: htmlToDoc(html) });
const click = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el); };

describe('SelectionBar', () => {
  it('shows nothing at all with no selection', () => {
    const { container } = render(<SelectionBar kind="none" editor={null} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('shows inline, block and alignment controls for a text selection', () => {
    render(<SelectionBar kind="text" editor={null} />);
    for (const id of ['bold', 'italic', 'underline', 'block-type', 'align']) expect(screen.getByTestId(`control-${id}`)).toBeTruthy();
  });

  it('shows table controls for a table selection and no text controls', () => {
    render(<SelectionBar kind="table" editor={null} />);
    expect(screen.getByTestId('control-row-above')).toBeTruthy();
    expect(screen.queryByTestId('control-bold')).toBeNull();
  });

  it('shows no bar controls for a figure selection: those live on the figure', () => {
    const { container } = render(<SelectionBar kind="figure" editor={null} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('the block list is the Format panel\'s named styles that the editor can apply, then quote and the two lists', () => {
    const f = createFormat('nih');
    const labels = blockOptions(f).map(o => o.label);
    expect(labels).toEqual(['Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote', 'Bullet list', 'Numbered list']);
    // every named style the editor can apply is in the list, under the document's own name for it
    for (const id of BUILTIN_STYLE_IDS.filter(i => i === 'normal' || i.startsWith('heading'))) expect(labels).toContain(f.styles[id].name);
    // a document that renames a style is followed
    const renamed = { ...f, styles: { ...f.styles, heading2: { ...f.styles.heading2, name: 'Section heading' } } };
    expect(blockOptions(renamed).map(o => o.label)).toContain('Section heading');
  });

  describe('acting on a real editor', () => {
    it('bold toggles the mark on the selected words and shows as pressed', () => {
      const ed = make('<p>Alpha beta gamma</p>');
      ed.commands.setTextSelection({ from: 1, to: 6 });
      render(<SelectionBar kind="text" editor={ed} />);
      const bold = screen.getByTestId('control-bold');
      expect(bold.getAttribute('aria-pressed')).toBe('false');
      click(bold);
      expect(ed.isActive('bold')).toBe(true);
      expect(bold.getAttribute('aria-pressed')).toBe('true');
      click(bold);
      expect(ed.isActive('bold')).toBe(false);
      ed.destroy();
    });

    it('the block selector turns a paragraph into a heading, a list and back to Normal, and leaves the text alone', () => {
      const ed = make('<p>Alpha beta gamma</p>');
      ed.commands.setTextSelection({ from: 1, to: 6 });
      render(<SelectionBar kind="text" editor={ed} />);
      const sel = screen.getByTestId('control-block-type') as HTMLSelectElement;
      fireEvent.change(sel, { target: { value: 'heading2' } });
      expect(ed.isActive('heading', { level: 2 })).toBe(true);
      fireEvent.change(sel, { target: { value: 'bullet' } });
      expect(ed.isActive('bulletList')).toBe(true);
      expect(ed.isActive('heading')).toBe(false);
      fireEvent.change(sel, { target: { value: 'normal' } });
      expect(ed.isActive('bulletList')).toBe(false);
      expect(ed.isActive('paragraph')).toBe(true);
      expect(ed.state.doc.textContent).toBe('Alpha beta gamma');
      ed.destroy();
    });

    it('alignment applies to the block and the table controls change the table', () => {
      const ed = make('<p>Alpha beta</p>');
      ed.commands.setTextSelection({ from: 1, to: 6 });
      const { rerender } = render(<SelectionBar kind="text" editor={ed} />);
      fireEvent.change(screen.getByTestId('control-align'), { target: { value: 'center' } });
      expect(ed.isActive({ textAlign: 'center' })).toBe(true);
      ed.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false });
      rerender(<SelectionBar kind="table" editor={ed} />);
      const rows = () => { let n = 0; ed.state.doc.descendants(x => { if (x.type.name === 'tableRow') n++; }); return n; };
      expect(rows()).toBe(2);
      click(screen.getByTestId('control-row-below'));
      expect(rows()).toBe(3);
      click(screen.getByTestId('control-delete-row'));
      expect(rows()).toBe(2);
      click(screen.getByTestId('control-delete-table'));
      expect(rows()).toBe(0);
      ed.destroy();
    });
  });
});
