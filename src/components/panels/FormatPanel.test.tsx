// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FormatPanel } from './FormatPanel';
import type { DocFormat } from '../../types';
import { createFormat } from '../../services/formatPresets';
import { withPreset } from './format/formatEdit';

afterEach(cleanup);

const format: DocFormat = {
  page: { size: 'letter', orientation: 'portrait', marginsIn: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  styles: {}, defaults: { fontFamily: 'Arial', fontSizePt: 11 }, preset: 'nih',
};
const props = { format, onFormatChange: () => {}, templateId: null, onPickTemplate: () => {}, onEditInstructions: () => {} };
const last = (fn: ReturnType<typeof vi.fn>): DocFormat => fn.mock.calls[fn.mock.calls.length - 1][0];
const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

describe('FormatPanel', () => {
  it('shows the current margins in inches', () => {
    render(<FormatPanel {...props} />);
    expect((screen.getByLabelText(/left margin/i) as HTMLInputElement).value).toBe('0.5');
  });

  it('reports a margin change', () => {
    const onFormatChange = vi.fn();
    render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
    fireEvent.change(screen.getByLabelText(/left margin/i), { target: { value: '1' } });
    expect(onFormatChange).toHaveBeenCalledWith(expect.objectContaining({
      page: expect.objectContaining({ marginsIn: expect.objectContaining({ left: 1 }) }),
    }));
  });

  it('warns when a margin goes below the NIH minimum, and says the rule', () => {
    render(<FormatPanel {...props} format={{ ...format, page: { ...format.page, marginsIn: { top: 0.4, right: 0.5, bottom: 0.5, left: 0.5 } } }} />);
    expect(screen.getByText(/0\.5/)).toBeTruthy();
    expect(screen.getByTestId('margin-warning').textContent).toBe("The top margin is 0.4 in. NIH's application guide requires margins of at least 0.5 in on every side.");
  });

  it('warns when the body font is below 11pt, and says the rule', () => {
    render(<FormatPanel {...props} format={{ ...format, defaults: { fontFamily: 'Arial', fontSizePt: 10 } }} />);
    expect(screen.getByTestId('font-warning').textContent).toBe("The body font is 10 pt. NIH's application guide requires text of at least 11 pt.");
  });

  it('does not warn at exactly the NIH minimums', () => {
    render(<FormatPanel {...props} />);
    expect(screen.queryByTestId('margin-warning')).toBeNull();
    expect(screen.queryByTestId('font-warning')).toBeNull();
  });

  it('reads the body font from the Normal style, not only the defaults', () => {
    const f = createFormat('nih');
    f.styles.normal.fontSizePt = 9;
    render(<FormatPanel {...props} format={f} />);
    expect(screen.getByTestId('font-warning')).toBeTruthy();
  });

  it('offers the format presets', () => {
    render(<FormatPanel {...props} />);
    expect(screen.getByTestId('control-preset')).toBeTruthy();
  });

  it('exposes the grant template and its instructions', () => {
    render(<FormatPanel {...props} />);
    expect(screen.getByTestId('section-template')).toBeTruthy();
    fireEvent.click(screen.getByTestId('section-template'));
    expect(screen.getByTestId('control-instructions')).toBeTruthy();
  });

  it('opens the grant template section by default in grant mode, and leaves it closed for a manuscript', () => {
    const { rerender } = render(<FormatPanel {...props} mode="manuscript" onModeChange={() => {}} />);
    expect(screen.getByTestId('section-template').getAttribute('aria-expanded')).toBe('false');
    rerender(<FormatPanel {...props} mode="grant" onModeChange={() => {}} />);
    expect(screen.getByTestId('section-template').getAttribute('aria-expanded')).toBe('true');
  });

  it('renders with no format at all, and editing starts from the NIH preset', () => {
    const onFormatChange = vi.fn();
    render(<FormatPanel {...props} format={null} onFormatChange={onFormatChange} />);
    expect(screen.getByTestId('section-page')).toBeTruthy();
    type('control-margin-left', '1');
    expect(last(onFormatChange).page.marginsIn).toEqual({ top: 0.5, right: 0.5, bottom: 0.5, left: 1 });
    expect(last(onFormatChange).preset).toBe('custom');
  });

  describe('margins and font sizes', () => {
    it('accepts a margin of 0 (and warns), rejects a negative one and does not commit it', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
      type('control-margin-top', '0');
      expect(last(onFormatChange).page.marginsIn.top).toBe(0);
      onFormatChange.mockClear();
      type('control-margin-top', '-1');
      expect(onFormatChange).not.toHaveBeenCalled();
      expect(screen.getByTestId('error-margin-top')).toBeTruthy();
    });
    it('rejects a margin too large to leave a page and a blank margin', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
      type('control-margin-left', '9');
      type('control-margin-left', '');
      expect(onFormatChange).not.toHaveBeenCalled();
    });
    it('rejects a body font of 0 and of 400 and leaves the document alone', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
      for (const v of ['0', '400', '-11', '']) type('control-body-font-size', v);
      expect(onFormatChange).not.toHaveBeenCalled();
      type('control-body-font-size', '12');
      expect(last(onFormatChange).styles.normal.fontSizePt).toBe(12);
    });
    it('puts the committed value back when the box is left with a rejected draft', () => {
      render(<FormatPanel {...props} />);
      type('control-margin-top', '-1');
      fireEvent.blur(screen.getByTestId('control-margin-top'));
      expect((screen.getByTestId('control-margin-top') as HTMLInputElement).value).toBe('0.5');
      expect(screen.queryByTestId('error-margin-top')).toBeNull();
    });
    it('switching letter to A4 keeps custom margins and marks the format custom', () => {
      const onFormatChange = vi.fn();
      const f = { ...format, page: { ...format.page, marginsIn: { top: 1.25, right: 0.75, bottom: 1.25, left: 0.75 } } };
      render(<FormatPanel {...props} format={f} onFormatChange={onFormatChange} />);
      fireEvent.change(screen.getByTestId('control-page-size'), { target: { value: 'a4' } });
      expect(last(onFormatChange).page).toEqual({ size: 'a4', orientation: 'portrait', marginsIn: f.page.marginsIn });
      expect(last(onFormatChange).preset).toBe('custom');
    });
    it('a preset replaces page and styles but keeps the author\'s page limit and styles it does not define', () => {
      const onFormatChange = vi.fn();
      const f = { ...createFormat('nih'), pageLimitPages: 12, styles: { ...createFormat('nih').styles, mine: { id: 'mine', name: 'Mine', type: 'paragraph' as const } } };
      render(<FormatPanel {...props} format={f} onFormatChange={onFormatChange} />);
      fireEvent.change(screen.getByTestId('control-preset'), { target: { value: 'manuscript' } });
      const out = last(onFormatChange);
      expect(out.preset).toBe('manuscript');
      expect(out.page.marginsIn.left).toBe(1);
      expect(out.pageLimitPages).toBe(12);
      expect(out.styles.mine).toBeTruthy();
    });
  });

  describe('named styles', () => {
    it('lists the built-in styles and edits one style\'s size', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={createFormat('nih')} onFormatChange={onFormatChange} />);
      for (const id of ['normal', 'heading1', 'heading2', 'heading3', 'caption', 'bibliography']) expect(screen.getByTestId(`style-${id}`)).toBeTruthy();
      type('control-style-size-heading1', '14');
      expect(last(onFormatChange).styles.heading1.fontSizePt).toBe(14);
      expect(last(onFormatChange).styles.normal.fontSizePt).toBe(11);
    });
    it('blank size inherits for a derived style but is refused for Normal', () => {
      const onFormatChange = vi.fn();
      const f = createFormat('nih');
      f.styles.heading1.fontSizePt = 16;
      render(<FormatPanel {...props} format={f} onFormatChange={onFormatChange} />);
      type('control-style-size-heading1', '');
      expect('fontSizePt' in last(onFormatChange).styles.heading1).toBe(false);
      onFormatChange.mockClear();
      type('control-style-size-normal', '');
      expect(onFormatChange).not.toHaveBeenCalled();
    });
    it('a circular basedOn chain renders and edits without hanging', () => {
      const f = createFormat('nih');
      f.styles.heading1 = { ...f.styles.heading1, basedOn: 'heading2' };
      f.styles.heading2 = { ...f.styles.heading2, basedOn: 'heading1' };
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={f} onFormatChange={onFormatChange} />);
      type('control-style-size-heading2', '13');
      expect(last(onFormatChange).styles.heading2.fontSizePt).toBe(13);
    });
    it('a font family is committed on leaving the box, and blank inherits', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={createFormat('nih')} onFormatChange={onFormatChange} />);
      const box = screen.getByTestId('control-style-font-caption');
      fireEvent.change(box, { target: { value: 'Georgia' } });
      expect(onFormatChange).not.toHaveBeenCalled();
      fireEvent.blur(box);
      expect(last(onFormatChange).styles.caption.fontFamily).toBe('Georgia');
    });
  });

  describe('the document page limit', () => {
    it('starts unset (blank) and says no limit is set', () => {
      render(<FormatPanel {...props} />);
      expect((screen.getByTestId('control-page-limit') as HTMLInputElement).value).toBe('');
      expect(screen.getByText(/No limit is set/)).toBeTruthy();
    });
    it('stores what the author types on the format, keeping everything else', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
      type('control-page-limit', '13.5');
      expect(last(onFormatChange)).toEqual({ ...format, pageLimitPages: 13.5 });
    });
    it('blank removes the limit', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={{ ...format, pageLimitPages: 13 }} onFormatChange={onFormatChange} />);
      expect((screen.getByTestId('control-page-limit') as HTMLInputElement).value).toBe('13');
      type('control-page-limit', '');
      expect('pageLimitPages' in last(onFormatChange)).toBe(false);
    });
    it('rejects 0, a negative and a huge limit without committing', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} onFormatChange={onFormatChange} />);
      for (const v of ['0', '-5', '1000000']) { type('control-page-limit', v); expect(screen.getByTestId('error-page-limit')).toBeTruthy(); }
      expect(onFormatChange).not.toHaveBeenCalled();
    });
    it('shows the template\'s section limits as per-section guidance, never as a default or a total', () => {
      render(<FormatPanel {...props} templateId="nih-r01" />);
      const g = screen.getByTestId('page-limit-guidance').textContent!;
      expect(g).toMatch(/per section and not a document total/);
      expect(g).toMatch(/Specific Aims 1 pg/);
      expect((screen.getByTestId('control-page-limit') as HTMLInputElement).value).toBe('');
    });
    it('shows no guidance without a template', () => {
      render(<FormatPanel {...props} />);
      expect(screen.queryByTestId('page-limit-guidance')).toBeNull();
    });
  });

  it('keeps a collapsed section mounted, so a half-typed value survives', () => {
    render(<FormatPanel {...props} />);
    type('control-margin-top', '-1');
    fireEvent.click(screen.getByTestId('section-page'));
    fireEvent.click(screen.getByTestId('section-page'));
    expect((screen.getByTestId('control-margin-top') as HTMLInputElement).value).toBe('-1');
  });

  describe('the mode toggle', () => {
    it('Grant sets grant and Manuscript sets manuscript, and aria-pressed follows the mode', () => {
      const onModeChange = vi.fn();
      const { rerender } = render(<FormatPanel {...props} mode="manuscript" onModeChange={onModeChange} />);
      expect(screen.getByTestId('control-mode').getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByTestId('control-mode-manuscript').getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByTestId('control-mode'));
      expect(onModeChange).toHaveBeenLastCalledWith('grant');
      rerender(<FormatPanel {...props} mode="grant" onModeChange={onModeChange} />);
      expect(screen.getByTestId('control-mode').getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByTestId('control-mode-manuscript'));
      expect(onModeChange).toHaveBeenLastCalledWith('manuscript');
    });
  });

  describe('applying a preset', () => {
    const Host = ({ start }: { start: DocFormat }) => { const [f, setF] = useState(start); return <FormatPanel {...props} format={f} onFormatChange={setF} />; };
    it('offers Undo that restores the margins and style edits the preset replaced', () => {
      const custom = createFormat('nih');
      custom.page.marginsIn = { top: 0.6, right: 0.7, bottom: 0.8, left: 0.9 };
      custom.styles.heading1.fontSizePt = 15;
      render(<Host start={{ ...custom, preset: 'custom', pageLimitPages: 12 }} />);
      fireEvent.change(screen.getByTestId('control-preset'), { target: { value: 'manuscript' } });
      expect((screen.getByTestId('control-margin-left') as HTMLInputElement).value).toBe('1');
      expect(screen.getByTestId('preset-applied').textContent).toContain('Preset applied.');
      fireEvent.click(screen.getByTestId('control-preset-undo'));
      expect((screen.getByTestId('control-margin-left') as HTMLInputElement).value).toBe('0.9');
      expect((screen.getByTestId('control-margin-top') as HTMLInputElement).value).toBe('0.6');
      expect((screen.getByTestId('control-style-size-heading1') as HTMLInputElement).value).toBe('15');
      expect((screen.getByTestId('control-page-limit') as HTMLInputElement).value).toBe('12');
      expect(screen.queryByTestId('preset-applied')).toBeNull();
    });
    it('stops offering Undo once something else has changed the format', () => {
      render(<Host start={createFormat('nih')} />);
      fireEvent.change(screen.getByTestId('control-preset'), { target: { value: 'manuscript' } });
      type('control-margin-left', '2');
      expect(screen.queryByTestId('preset-applied')).toBeNull();
    });
    it('keeps what a Word import recorded on built-in styles, so the document stays writable', () => {
      const f = createFormat('nih');
      f.styles.normal = { ...f.styles.normal, preserved: { pPrXml: '<w:pPr/>' }, wordDefault: true, customStyle: true };
      const out = withPreset(f, 'manuscript');
      expect(out.styles.normal.preserved).toEqual({ pPrXml: '<w:pPr/>' });
      expect(out.styles.normal.wordDefault).toBe(true);
      expect(out.styles.normal.customStyle).toBe(true);
      expect(out.styles.normal.fontFamily).toBe('Times New Roman'); // the preset's own values still replace
    });
  });

  describe('style font families', () => {
    it('Normal\'s family cannot be blanked', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={createFormat('nih')} onFormatChange={onFormatChange} />);
      const box = screen.getByTestId('control-style-font-normal') as HTMLInputElement;
      fireEvent.change(box, { target: { value: '' } });
      fireEvent.blur(box);
      expect(onFormatChange).not.toHaveBeenCalled();
      expect(box.value).toBe('Arial');
    });
    it('Enter commits the family without leaving the box', () => {
      const onFormatChange = vi.fn();
      render(<FormatPanel {...props} format={createFormat('nih')} onFormatChange={onFormatChange} />);
      const box = screen.getByTestId('control-style-font-caption');
      fireEvent.change(box, { target: { value: 'Georgia' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(last(onFormatChange).styles.caption.fontFamily).toBe('Georgia');
    });
  });
});
