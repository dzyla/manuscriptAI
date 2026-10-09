// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { SemanticSearchResult } from '../../types';
import { searchSimilarManuscripts } from '../../services/manuscriptSearch';
import { useSourceStore } from '../../stores/useSourceStore';
import { CitePanel } from './CitePanel';

vi.mock('../../services/manuscriptSearch', async (orig) => ({ ...(await orig<typeof import('../../services/manuscriptSearch')>()), searchSimilarManuscripts: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn(), version: 'test' }));
const search = vi.mocked(searchSimilarManuscripts);

class InertWorker { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }
beforeEach(() => { (globalThis as any).Worker = InertWorker; search.mockReset(); useSourceStore.setState({ sources: [] }); });
afterEach(cleanup);

const paper: SemanticSearchResult = { title: 'Paper 1', authors: 'A', journal: 'J', doi: '10.1/1', abstract: 'abs', year: 2020, score: 0.9, source: 'PubMed' };
const props = { onCompareSource: vi.fn(), onChatWithSource: vi.fn() };
const expanded = (id: string) => screen.getByTestId(`section-${id}`).getAttribute('aria-expanded');

describe('CitePanel', () => {
  it('opens on the library, with search and references collapsed', () => {
    render(<CitePanel {...props} />);
    expect([expanded('library'), expanded('search'), expanded('references')]).toEqual(['true', 'false', 'false']);
  });

  it('collapsing a section keeps its state: a search made, collapsed and reopened is still there', async () => {
    search.mockResolvedValue([paper]);
    render(<CitePanel {...props} />);
    fireEvent.click(screen.getByTestId('section-search'));
    fireEvent.change(screen.getByTestId('control-query'), { target: { value: 'crispr screens' } });
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText('Paper 1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('section-search'));
    expect(expanded('search')).toBe('false');
    fireEvent.click(screen.getByTestId('section-search'));
    expect(screen.getByText('Paper 1')).toBeTruthy();
    expect((screen.getByTestId('control-query') as HTMLInputElement).value).toBe('crispr screens');
  });

  it('a search that finishes while its section is collapsed still lands', async () => {
    let finish: (r: SemanticSearchResult[]) => void = () => {};
    search.mockReturnValue(new Promise(res => { finish = res; }));
    render(<CitePanel {...props} />);
    fireEvent.click(screen.getByTestId('section-search'));
    fireEvent.change(screen.getByTestId('control-query'), { target: { value: 'crispr screens' } });
    fireEvent.click(screen.getByTestId('control-run-search'));
    fireEvent.click(screen.getByTestId('section-search'));
    await act(async () => { finish([paper]); });
    fireEvent.click(screen.getByTestId('section-search'));
    expect(screen.getByText('Paper 1')).toBeTruthy();
  });

  it('adding a search result puts it in the library', async () => {
    search.mockResolvedValue([paper]);
    render(<CitePanel {...props} />);
    fireEvent.click(screen.getByTestId('section-search'));
    fireEvent.change(screen.getByTestId('control-query'), { target: { value: 'crispr screens' } });
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => screen.getByTestId('control-add-result'));
    fireEvent.click(screen.getByTestId('control-add-result'));
    const [added] = useSourceStore.getState().sources;
    expect(added).toMatchObject({ name: 'Paper 1', type: 'api', queryText: 'crispr screens' });
  });

  it('tells the host about the library each time it changes, and empties it for a new manuscript', async () => {
    const onSourcesChange = vi.fn();
    const { rerender } = render(<CitePanel {...props} onSourcesChange={onSourcesChange} clearSourcesTrigger={0} />);
    act(() => { useSourceStore.getState().addSources([{ id: 's', name: 'n.txt', type: 'text', text: 'x' }]); });
    expect(onSourcesChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 's' })]);
    rerender(<CitePanel {...props} onSourcesChange={onSourcesChange} clearSourcesTrigger={1} />);
    await waitFor(() => expect(useSourceStore.getState().sources).toEqual([]));
  });

  it('merges sources the host delivers, once, without duplicating a DOI', () => {
    const onMerged = vi.fn();
    useSourceStore.setState({ sources: [{ id: 'old', name: 'Old', type: 'api', text: 'x', apiMeta: paper }] });
    const incoming = [
      { id: 'dup', name: 'Dup', type: 'api' as const, text: 'x', apiMeta: paper },
      { id: 'new', name: 'New', type: 'api' as const, text: 'x', apiMeta: { ...paper, doi: '10.1/2' } },
    ];
    render(<CitePanel {...props} externalApiSources={incoming} onExternalSourcesMerged={onMerged} />);
    expect(useSourceStore.getState().sources.map(s => s.id)).toEqual(['old', 'new']);
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it('shows the reference list once the document has citations', () => {
    useSourceStore.setState({ sources: [{ id: 'a', name: 'Paper A', type: 'api', text: 'x', apiMeta: { ...paper, title: 'Paper A' } }] });
    render(<CitePanel {...props} citationRegistry={{ a: 1 }} />);
    fireEvent.click(screen.getByTestId('section-references'));
    expect(screen.getAllByTitle('Jump to first citation')).toHaveLength(1);
  });
});
