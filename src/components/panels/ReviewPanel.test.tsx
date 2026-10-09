// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReviewPanel } from './ReviewPanel';
import type { ReviewRow } from './reviewRows';
import { VoiceProfileManager } from '../style/VoiceProfileManager';

afterEach(cleanup);

const rows: ReviewRow[] = [
  { id: 'grammar:0-5',  kind: 'grammar',    start: 0,  end: 5,  title: 'Grammar', evidence: 'Consider a comma.', canAct: true,  actions: ['accept', 'reject'] },
  { id: 'style:10-40',  kind: 'style',      start: 10, end: 40, title: '36 words · semicolon', evidence: '36 words · semicolon', canAct: true,  actions: ['rewrite'] },
  { id: 'suggestion:a', kind: 'suggestion', start: 50, end: 70, title: 'editor', evidence: 'Tighten it.', canAct: false, actions: ['accept', 'reject'] },
];

const noop = { onAct: () => {}, onGoTo: () => {}, chat: <div>chat here</div>, analyzing: false, onAnalyze: () => {} };

describe('ReviewPanel', () => {
  it('lists the rows in the order given', () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    const got = screen.getAllByTestId(/^row-/).map(el => el.getAttribute('data-testid'));
    expect(got).toEqual(['row-grammar', 'row-style', 'row-suggestion']);
  });

  it("shows each row's evidence verbatim", () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    expect(screen.getByText('36 words · semicolon')).toBeTruthy();
    expect(screen.getByText('Consider a comma.')).toBeTruthy();
  });

  it('scrolls to the span when a row is clicked', () => {
    const onGoTo = vi.fn();
    render(<ReviewPanel rows={rows} {...noop} onGoTo={onGoTo} />);
    fireEvent.click(screen.getByTestId('row-style'));
    expect(onGoTo).toHaveBeenCalledWith(10, 40);
  });

  it('disables the actions of a row that cannot act', () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    const row = screen.getByTestId('row-suggestion');
    expect((row.querySelector('[data-testid="control-accept"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps reject available on a row that cannot act, so a stale suggestion can still be cleared', () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    const row = screen.getByTestId('row-suggestion');
    expect((row.querySelector('[data-testid="control-reject"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports which action was taken on which row', () => {
    const onAct = vi.fn();
    render(<ReviewPanel rows={rows} {...noop} onAct={onAct} />);
    fireEvent.click(screen.getByTestId('row-style').querySelector('[data-testid="control-rewrite"]')!);
    expect(onAct).toHaveBeenCalledWith('style:10-40', 'rewrite');
  });

  it('a click on an action does not also scroll to the row', () => {
    const onGoTo = vi.fn();
    render(<ReviewPanel rows={rows} {...noop} onGoTo={onGoTo} />);
    fireEvent.click(screen.getByTestId('row-style').querySelector('[data-testid="control-rewrite"]')!);
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it('keeps chat present but collapsed', () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    const chat = screen.getByTestId('section-chat');
    expect(chat.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chat);
    expect(screen.getByText('chat here')).toBeTruthy();
  });

  it('unmounts a collapsed Chat section (keepMounted is false here on purpose; the other panels keep theirs mounted)', () => {
    render(<ReviewPanel rows={rows} {...noop} />);
    fireEvent.click(screen.getByTestId('section-chat'));
    expect(screen.getByText('chat here')).toBeTruthy();
    fireEvent.click(screen.getByTestId('section-chat'));
    expect(screen.queryByText('chat here')).toBeNull();
  });

  it('says so plainly when there is nothing to review', () => {
    render(<ReviewPanel rows={[]} {...noop} />);
    expect(screen.getByText(/nothing flagged/i)).toBeTruthy();
    expect(screen.queryByTestId(/^row-/)).toBeNull();
  });

  it('shows the first page of a long list and the true count, then the rest on request', () => {
    const many: ReviewRow[] = Array.from({ length: 500 }, (_, i) => ({ id: `style:${i}-${i + 1}`, kind: 'style', start: i, end: i + 1, title: `t${i}`, evidence: `e${i}`, canAct: true, actions: ['rewrite'] }));
    render(<ReviewPanel rows={many} {...noop} />);
    expect(screen.getAllByTestId('row-style').length).toBe(100);
    expect(screen.getByText(/500 items/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('control-show-more'));
    expect(screen.getAllByTestId('row-style').length).toBe(200);
  });

  it('replaces Analyze with Stop while an analysis runs', () => {
    const onStop = vi.fn();
    render(<ReviewPanel rows={rows} {...noop} analyzing onStop={onStop} />);
    expect(screen.queryByTestId('control-analyze')).toBeNull();
    fireEvent.click(screen.getByTestId('control-stop'));
    expect(onStop).toHaveBeenCalled();
  });

  it('runs one named agent from the agent menu', () => {
    const onAnalyze = vi.fn();
    render(<ReviewPanel rows={rows} {...noop} onAnalyze={onAnalyze} agents={[{ id: 'editor', label: 'Language Surgeon' }]} />);
    fireEvent.click(screen.getByTestId('control-analyze'));
    expect(onAnalyze).toHaveBeenLastCalledWith(undefined);
    fireEvent.click(screen.getByTestId('control-analyze-agent'));
    fireEvent.click(screen.getByTestId('control-analyze-agent-one'));
    expect(onAnalyze).toHaveBeenLastCalledWith('editor');
  });

  it('filters suggestions by severity and says how many are hidden', () => {
    const sev: ReviewRow[] = [
      { ...rows[2], id: 'suggestion:a', severity: 'minor' },
      { ...rows[2], id: 'suggestion:b', severity: 'major', start: 60, end: 70 },
      rows[1],
    ];
    render(<ReviewPanel rows={sev} {...noop} />);
    fireEvent.click(screen.getByTestId('control-filter'));
    fireEvent.click(document.querySelector('[data-severity="major"]')!);
    expect(screen.getAllByTestId('row-suggestion').length).toBe(1);
    expect(screen.queryByTestId('row-style')).toBeNull();
  });
});

describe('ReviewPanel: the style section keeps what the author typed', () => {
  it('a long paste survives collapsing and reopening the section', () => {
    render(<ReviewPanel rows={rows} {...noop} styleSection={<VoiceProfileManager />} />);
    fireEvent.click(screen.getByTestId('section-style'));
    fireEvent.click(screen.getByTestId('control-voice-samples'));
    const essay = Array.from({ length: 400 }, (_, i) => `Sentence ${i} of my own writing.`).join(' ');
    fireEvent.change(screen.getByPlaceholderText(/Paste at least/), { target: { value: essay } });
    fireEvent.click(screen.getByTestId('section-style')); // collapse
    expect(screen.getByTestId('section-style').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('section-style')); // reopen
    expect((screen.getByPlaceholderText(/Paste at least/) as HTMLTextAreaElement).value).toBe(essay);
  });
});
