// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ManuscriptSource, SemanticSearchResult } from '../../../types';
import { searchSimilarManuscripts } from '../../../services/manuscriptSearch';
import { Search } from './Search';

vi.mock('../../../services/manuscriptSearch', async (orig) => ({ ...(await orig<typeof import('../../../services/manuscriptSearch')>()), searchSimilarManuscripts: vi.fn() }));
const search = vi.mocked(searchSimilarManuscripts);

afterEach(cleanup);
beforeEach(() => { search.mockReset(); });

const paper = (n: number): SemanticSearchResult => ({ title: `Paper ${n}`, authors: `Author${n}`, journal: 'J', doi: `10.1/${n}`, abstract: 'abs', year: 2020, score: 0.9, source: 'PubMed' });
const type = (q: string) => fireEvent.change(screen.getByTestId('control-query'), { target: { value: q } });

describe('Search', () => {
  it('has a query control and will not search for fewer than three characters', () => {
    render(<Search sources={[]} onAddResult={() => {}} />);
    type('ab');
    expect((screen.getByTestId('control-run-search') as HTMLButtonElement).disabled).toBe(true);
    type('abc');
    expect((screen.getByTestId('control-run-search') as HTMLButtonElement).disabled).toBe(false);
  });

  it('submitting reports the query and draws one row per result', async () => {
    search.mockResolvedValue([paper(1), paper(2)]);
    render(<Search sources={[]} onAddResult={() => {}} />);
    type('crispr screens');
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText('Paper 1')).toBeTruthy());
    expect(search).toHaveBeenCalledWith('crispr screens', 10);
    expect(screen.getAllByTestId('control-add-result')).toHaveLength(2);
  });

  it('Enter submits too', async () => {
    search.mockResolvedValue([paper(1)]);
    render(<Search sources={[]} onAddResult={() => {}} />);
    type('crispr screens');
    fireEvent.keyDown(screen.getByTestId('control-query'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('Paper 1')).toBeTruthy());
  });

  it('says so when nothing comes back', async () => {
    search.mockResolvedValue([]);
    render(<Search sources={[]} onAddResult={() => {}} />);
    type('zzzz');
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText(/No results/)).toBeTruthy());
  });

  it('explains a network failure instead of showing an empty list', async () => {
    search.mockRejectedValue(new Error('Failed to fetch'));
    render(<Search sources={[]} onAddResult={() => {}} />);
    type('zzzz');
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText(/Search API unreachable/)).toBeTruthy());
  });

  it('adding a result reports it with the query, and a result already in the library cannot be added twice', async () => {
    search.mockResolvedValue([paper(1), paper(2)]);
    const onAddResult = vi.fn();
    const have: ManuscriptSource[] = [{ id: 'a', name: 'Paper 2', type: 'api', text: 'x', apiMeta: paper(2) }];
    render(<Search sources={have} onAddResult={onAddResult} />);
    type('  crispr  ');
    fireEvent.click(screen.getByTestId('control-run-search'));
    await waitFor(() => expect(screen.getByText('Paper 1')).toBeTruthy());
    const [first, second] = screen.getAllByTestId('control-add-result') as HTMLButtonElement[];
    expect(second.disabled).toBe(true);
    expect(second.textContent).toBe('Added');
    fireEvent.click(first);
    expect(onAddResult).toHaveBeenCalledWith(paper(1), 'crispr');
  });

  it('a search that finishes while the section is hidden still lands', async () => {
    let finish: (r: SemanticSearchResult[]) => void = () => {};
    search.mockReturnValue(new Promise(res => { finish = res; }));
    const { container } = render(<div style={{ display: 'none' }}><Search sources={[]} onAddResult={() => {}} /></div>);
    type('crispr screens');
    fireEvent.click(screen.getByTestId('control-run-search'));
    finish([paper(1)]);
    await waitFor(() => expect(container.textContent).toContain('Paper 1'));
  });
});
