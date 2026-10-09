// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { getSchemaExtensions, htmlToDoc } from '../../extensions/schema';
import { vi } from 'vitest';
import { SelectionBar } from './SelectionBar';
import type { SelectionAI } from './SelectionAIMenu';
import { SELECTION_PRESETS } from '../shell/selectionPresets';
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

  describe('AI actions on the floating bar', () => {
    const mkAI = (over: Partial<SelectionAI> = {}): SelectionAI => ({
      words: 8, busy: false, thesaurus: null, onPreset: vi.fn(), onRewrite: vi.fn(), onInstruct: vi.fn(), onSynonyms: vi.fn(), onPickSynonym: vi.fn(), onVerify: vi.fn(), onSimilar: vi.fn(), ...over,
    });
    const preset = (l: string) => SELECTION_PRESETS.find(p => p.label === l)!;
    const openMenu = () => { click(screen.getByTestId('control-ai-menu')); };

    it('has no AI group when the editor is given no AI handlers', () => {
      render(<SelectionBar kind="text" editor={null} />);
      expect(screen.queryByTestId('control-ai-menu')).toBeNull();
      expect(screen.queryByTestId('control-ai-polish')).toBeNull();
    });

    it('Polish and Shorten are direct buttons that call the handler with their own preset', () => {
      const ai = mkAI();
      render(<SelectionBar kind="text" editor={null} ai={ai} />);
      click(screen.getByTestId('control-ai-polish'));
      expect(ai.onPreset).toHaveBeenLastCalledWith(preset('Polish'));
      click(screen.getByTestId('control-ai-shorten'));
      expect(ai.onPreset).toHaveBeenLastCalledWith(preset('Shorten'));
      expect(ai.onPreset).toHaveBeenCalledTimes(2);
    });

    it('the AI menu is closed until opened, then holds the rest in the stated order and not Polish or Shorten', () => {
      const ai = mkAI();
      render(<SelectionBar kind="text" editor={null} ai={ai} />);
      expect(screen.queryByRole('menu')).toBeNull();
      openMenu();
      const ids = screen.getAllByRole('menuitem').map(b => b.getAttribute('data-testid'));
      expect(ids).toEqual(['rewrite', 'sharpen', 'strengthen', 'critique', 'explain', 'instruct', 'synonyms', 'similar', 'verify'].map(i => `control-ai-${i}`));
      expect(screen.getAllByRole('menu')[0].querySelectorAll('.border-t')).toHaveLength(3);
    });

    it('each menu item calls its handler, and a one-shot item closes the menu', () => {
      const ai = mkAI();
      render(<SelectionBar kind="text" editor={null} ai={ai} />);
      for (const l of ['Sharpen', 'Strengthen', 'Critique', 'Explain']) {
        openMenu();
        click(screen.getByTestId(`control-ai-${l.toLowerCase()}`));
        expect(ai.onPreset).toHaveBeenLastCalledWith(preset(l));
        expect(screen.queryByRole('menu')).toBeNull();
      }
      openMenu(); click(screen.getByTestId('control-ai-rewrite')); expect(ai.onRewrite).toHaveBeenCalledTimes(1);
      openMenu(); click(screen.getByTestId('control-ai-verify')); expect(ai.onVerify).toHaveBeenCalledTimes(1);
      openMenu(); click(screen.getByTestId('control-ai-similar')); expect(ai.onSimilar).toHaveBeenCalledTimes(1);
      openMenu(); click(screen.getByTestId('control-ai-synonyms'));
      // synonyms is disabled at 8 words
      expect(ai.onSynonyms).not.toHaveBeenCalled();
    });

    it('a disabled item does not fire and says why: synonyms needs one or two words, find-similar needs six or more', () => {
      const few = mkAI({ words: 4 });
      const { unmount } = render(<SelectionBar kind="text" editor={null} ai={few} />);
      openMenu();
      const similar = screen.getByTestId('control-ai-similar') as HTMLButtonElement;
      expect(similar.disabled).toBe(true);
      expect(similar.title).toBe('Select more than a few words (six or more) to search for similar manuscripts');
      click(similar);
      expect(few.onSimilar).not.toHaveBeenCalled();
      expect((screen.getByTestId('control-ai-synonyms') as HTMLButtonElement).disabled).toBe(true);
      unmount();

      const one = mkAI({ words: 1 });
      render(<SelectionBar kind="text" editor={null} ai={one} />);
      openMenu();
      const syn = screen.getByTestId('control-ai-synonyms') as HTMLButtonElement;
      expect(syn.disabled).toBe(false);
      click(syn);
      expect(one.onSynonyms).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('menu')).toBeTruthy(); // synonyms keeps the menu open for its answer
      const many = screen.getByTestId('control-ai-similar') as HTMLButtonElement;
      expect(many.disabled).toBe(true);
    });

    it('synonym chips appear in the menu and picking one calls onPickSynonym', () => {
      const ai = mkAI({ words: 1, thesaurus: { word: 'big', synonyms: ['large'], loading: false } });
      render(<SelectionBar kind="text" editor={null} ai={ai} />);
      openMenu();
      click(screen.getByTestId('item-synonym-choice'));
      expect(ai.onPickSynonym).toHaveBeenCalledWith('large');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('the custom instruction sends text with the chosen agent', () => {
      const ai = mkAI();
      render(<SelectionBar kind="text" editor={null} ai={ai} />);
      openMenu();
      click(screen.getByTestId('control-ai-instruct'));
      fireEvent.change(screen.getByTestId('item-instruct-agent'), { target: { value: 'reviewer-2' } });
      fireEvent.change(screen.getByTestId('item-instruct-text'), { target: { value: 'Be terse' } });
      click(screen.getByTestId('item-instruct-send'));
      expect(ai.onInstruct).toHaveBeenCalledWith('Be terse', 'reviewer-2');
    });

    it('a table selection gets the table controls only, no AI group', () => {
      render(<SelectionBar kind="table" editor={null} ai={mkAI()} />);
      expect(screen.getByTestId('control-row-above')).toBeTruthy();
      expect(screen.queryByTestId('control-ai-menu')).toBeNull();
      expect(screen.queryByTestId('control-ai-polish')).toBeNull();
    });

    it('every AI control swallows mousedown (so the selection survives) and acts on click, not on press', () => {
      const ed = make('<p>Alpha beta gamma delta epsilon zeta</p>');
      ed.commands.setTextSelection({ from: 1, to: 25 });
      const ai = mkAI();
      render(<SelectionBar kind="text" editor={ed} ai={ai} />);
      const swallowed = (el: Element) => fireEvent.mouseDown(el) === false; // fireEvent returns false when preventDefault was called
      for (const id of ['control-ai-polish', 'control-ai-shorten', 'control-ai-menu']) expect(swallowed(screen.getByTestId(id)), id).toBe(true);
      expect(ai.onPreset).not.toHaveBeenCalled();
      click(screen.getByTestId('control-ai-menu'));
      for (const el of screen.getAllByRole('menuitem')) expect(swallowed(el), el.getAttribute('data-testid') ?? '').toBe(true);
      expect(ed.state.selection.from).toBe(1);
      expect(ed.state.selection.to).toBe(25);
      ed.destroy();
    });
  });
});
