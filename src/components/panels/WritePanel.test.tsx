// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { WritePanel, type WritePanelProps } from './WritePanel';
import { deriveOutline, deriveH2WordCounts } from './write/outline';
import { db } from '../../db/manuscriptDb';
import type { HistoryItem } from '../../types';

afterEach(async () => { cleanup(); await db.versionSnapshots.clear(); });

const outline = [{ level: 2, text: 'SPECIFIC AIMS' }, { level: 3, text: 'Aim 1' }];
const item = { id: 'h1', timestamp: 1, oldContent: '', newContent: '', originalText: 'Alpha', suggestedText: 'Beta', suggestionId: 's', agent: 'editor' } as HistoryItem;
const base = (over: Partial<WritePanelProps> = {}): WritePanelProps => ({
  outline: [], history: [], onGoTo: () => {}, onRevertHistory: () => {}, getDocument: () => ({ title: 'T', content: '<p>x</p>' }), onRestore: () => {}, ...over,
});

describe('WritePanel', () => {
  it('shows the outline with its heading levels', () => {
    render(<WritePanel {...base({ outline })} />);
    const items = screen.getAllByTestId('control-goto-heading');
    expect(items).toHaveLength(2);
    expect(items[1].getAttribute('data-level')).toBe('3');
  });

  it('jumps to a heading by its text when it is clicked', () => {
    const onGoTo = vi.fn();
    render(<WritePanel {...base({ outline, onGoTo })} />);
    fireEvent.click(screen.getAllByTestId('control-goto-heading')[1]);
    expect(onGoTo).toHaveBeenCalledWith('Aim 1');
  });

  it('analyzes one H2 section without also jumping to it', () => {
    const onGoTo = vi.fn(), onAnalyzeSection = vi.fn();
    render(<WritePanel {...base({ outline, onGoTo, onAnalyzeSection })} />);
    fireEvent.click(screen.getByTestId('control-analyze-section'));
    expect(onAnalyzeSection).toHaveBeenCalledWith('', 'SPECIFIC AIMS');
    expect(onGoTo).not.toHaveBeenCalled();
  });

  it('keeps history collapsed but mounted', () => {
    render(<WritePanel {...base({ history: [item] })} />);
    const section = screen.getByTestId('section-history');
    expect(section.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('control-revert-change')).toBeTruthy(); // present in the DOM, hidden by CSS
    fireEvent.click(section);
    expect(section.getAttribute('aria-expanded')).toBe('true');
  });

  it('reverts an applied change, and locates it, without one click triggering the other', () => {
    const onRevertHistory = vi.fn(), onHistoryItemClick = vi.fn();
    render(<WritePanel {...base({ history: [item], onRevertHistory, onHistoryItemClick })} />);
    fireEvent.click(screen.getByTestId('control-revert-change'));
    expect(onRevertHistory).toHaveBeenCalledWith('h1');
    expect(onHistoryItemClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('control-locate-change'));
    expect(onHistoryItemClick).toHaveBeenCalledWith(item);
  });

  it('says so when nothing has been applied', () => {
    render(<WritePanel {...base()} />);
    expect(screen.getByText('No history yet')).toBeTruthy();
  });

  it('says so when the document has no headings', () => {
    render(<WritePanel {...base()} />);
    expect(screen.getByText(/no headings yet/i)).toBeTruthy();
  });

  it('keeps an empty heading as a row rather than dropping it', () => {
    render(<WritePanel {...base({ outline: [{ level: 2, text: '' }] })} />);
    expect(screen.getAllByTestId('control-goto-heading')).toHaveLength(1);
  });

  it('renders 200 headings', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ level: 2, text: `H${i}` }));
    const t0 = Date.now();
    render(<WritePanel {...base({ outline: many })} />);
    expect(screen.getAllByTestId('control-goto-heading')).toHaveLength(200);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('opens the requested section when revealed', () => {
    const { rerender } = render(<WritePanel {...base()} />);
    expect(screen.getByTestId('section-history').getAttribute('aria-expanded')).toBe('false');
    rerender(<WritePanel {...base({ reveal: 'history' })} />);
    expect(screen.getByTestId('section-history').getAttribute('aria-expanded')).toBe('true');
  });

  it('saves a snapshot of the document as it is when Save is pressed, then restores it', async () => {
    const onRestore = vi.fn();
    const doc = { title: 'T1', content: '<p>one two</p>' };
    render(<WritePanel {...base({ getDocument: () => doc, onRestore })} />);
    fireEvent.click(screen.getByTestId('section-versions'));
    fireEvent.change(screen.getByLabelText('Snapshot name'), { target: { value: 'Before importing' } });
    doc.content = '<p>one two three</p>'; // typing after render, before Save: the snapshot takes what is there now
    fireEvent.click(screen.getByTestId('control-save-version'));
    await screen.findByText('Before importing');
    expect((await db.versionSnapshots.toArray())[0].content).toBe('<p>one two three</p>');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByTestId('control-restore-version'));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ name: 'Before importing', title: 'T1' })));
  });

  it('does not restore when the confirmation is declined', async () => {
    await db.versionSnapshots.add({ id: 'v1', name: 'Draft 1', timestamp: 1, title: 'T', content: '<p>x</p>', wordCount: 1 });
    const onRestore = vi.fn();
    render(<WritePanel {...base({ onRestore })} />);
    await screen.findByText('Draft 1'); // loaded while collapsed
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByTestId('control-restore-version'));
    expect(onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('control-delete-version'));
    expect(await db.versionSnapshots.count()).toBe(1);
  });

  it('previews a snapshot and restores from the preview', async () => {
    await db.versionSnapshots.add({ id: 'v1', name: 'Draft 1', timestamp: 1, title: 'T', content: '<p>PREVIEWED</p>', wordCount: 1 });
    const onRestore = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WritePanel {...base({ onRestore })} />);
    fireEvent.click(await screen.findByTestId('control-preview-version'));
    expect(screen.getByText('PREVIEWED')).toBeTruthy();
    fireEvent.click(screen.getByTestId('control-restore-from-preview'));
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('PREVIEWED')).toBeNull());
  });
});

describe('outline derivation', () => {
  it('finds H2 and H3 headings, strips inline markup, and ignores other levels', () => {
    expect(deriveOutline('<h1>T</h1><h2>A <em>b</em></h2><p>x</p><h3 id="z">C</h3><h4>no</h4>')).toEqual([{ level: 2, text: 'A b' }, { level: 3, text: 'C' }]);
  });
  it('is empty for no document and for a document without headings', () => {
    expect(deriveOutline('')).toEqual([]);
    expect(deriveOutline('<p>just text</p>')).toEqual([]);
  });
  it('counts words per H2 section up to the next H2', () => {
    expect(deriveH2WordCounts('<h2>A</h2><p>one two</p><h3>sub</h3><p>three</p><h2>B</h2><p>four</p>')).toEqual({ A: 4, B: 1 });
  });
});
