// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { SemanticSearchResult } from '../../types';
import { searchSimilarManuscripts } from '../../services/manuscriptSearch';
import { useSourceStore } from '../../stores/useSourceStore';
import TaskPanels from './TaskPanels';

vi.mock('../../services/manuscriptSearch', async (orig) => ({ ...(await orig<typeof import('../../services/manuscriptSearch')>()), searchSimilarManuscripts: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), version: 'test' }));
class InertWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
beforeEach(() => { (globalThis as any).Worker = InertWorker; Element.prototype.scrollIntoView = () => {}; useSourceStore.setState({ sources: [] }); });
afterEach(cleanup);

const paper: SemanticSearchResult = { title: 'Paper 1', authors: 'A', journal: 'J', doi: '10.1/1', abstract: 'abs', year: 2020, score: 0.9, source: 'PubMed' };
const base: ComponentProps<typeof TaskPanels> = {
  suggestions: [], messages: [], history: [], onSendMessage: vi.fn(), onAcceptSuggestion: vi.fn(), onRejectSuggestion: vi.fn(),
  onRevertHistory: vi.fn(), onRebuttal: vi.fn(), onSuggestionCardClick: vi.fn(), isAnalyzing: false, onRestoreSnapshot: vi.fn(),
  review: { rows: [], onGoTo: vi.fn(), onAct: vi.fn(), onAnalyze: vi.fn() },
};
const view = (tab: ComponentProps<typeof TaskPanels>['activeTabOverride']) => <TaskPanels {...base} activeTabOverride={tab} />;
const chatExpanded = () => screen.getByTestId('section-chat').getAttribute('aria-expanded') === 'true';
const ensureChat = (open: boolean) => { if (chatExpanded() !== open) fireEvent.click(screen.getByTestId('section-chat')); };
const shown = (id: string) => (screen.getByTestId(id) as HTMLElement).style.display !== 'none';

describe('TaskPanels keeps each task\'s in-progress state while another task is open', () => {
  it('a half-written chat message, an attached source scope and a Cite search survive a tour of the other panels and a collapsed Chat', async () => {
    (searchSimilarManuscripts as any).mockResolvedValue([paper]);
    const { rerender } = render(view('chat'));

    // Chat: open the section, type, attach the "Current Section" scope.
    ensureChat(true);
    const box = () => screen.getByPlaceholderText(/^Ask /) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'half-written thought' } });
    fireEvent.click(screen.getByTestId('control-attach-sources'));
    fireEvent.click(screen.getByTestId('control-scope-section'));
    fireEvent.click(screen.getByTestId('control-attach-sources')); // close the picker so the chip is the only "Current Section"
    expect(screen.getByText('Current Section')).toBeTruthy();

    // Collapse Chat (the section unmounts; the composer state lives in the host).
    ensureChat(false);
    expect(screen.queryByPlaceholderText(/^Ask /)).toBeNull();

    // Cite: run a search.
    rerender(view('sources'));
    await waitFor(() => expect(shown('cite-view')).toBe(true));
    fireEvent.click(screen.getByTestId('section-search'));
    fireEvent.change(screen.getByTestId('control-query'), { target: { value: 'crispr screens' } });
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText('Paper 1')).toBeTruthy());

    // Tour: write, format, review.
    for (const [tab, id] of [['outline', 'write-view'], ['style', 'format-view']] as const) {
      rerender(view(tab));
      await waitFor(() => expect(shown(id)).toBe(true));
      expect(shown('cite-view')).toBe(false);
    }
    rerender(view('suggestions'));
    await waitFor(() => expect(shown('review-view')).toBe(true));

    // Back in Review: reopen Chat. The text and the attachment are still there.
    ensureChat(true);
    expect(box().value).toBe('half-written thought');
    expect(screen.getByText('Current Section')).toBeTruthy();

    // Back in Cite: the search and its results are still there.
    rerender(view('sources'));
    await waitFor(() => expect(shown('cite-view')).toBe(true));
    expect(screen.getByText('Paper 1')).toBeTruthy();
    expect((screen.getByTestId('control-query') as HTMLInputElement).value).toBe('crispr screens');
  });

  it('sending clears the composer and passes the scope sentinel, text and agent to the host', () => {
    const onSendMessage = vi.fn();
    render(<TaskPanels {...base} onSendMessage={onSendMessage} activeTabOverride="chat" />);
    ensureChat(true);
    const box = screen.getByPlaceholderText(/^Ask /) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('control-send'));
    expect(onSendMessage).toHaveBeenCalledWith('hello', 'manuscript-ai', [{ name: '__full__', text: '' }], undefined);
    expect(box.value).toBe('');
  });
});
