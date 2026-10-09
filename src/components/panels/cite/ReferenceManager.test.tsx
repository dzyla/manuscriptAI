// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ManuscriptSource } from '../../../types';
import { ReferenceManager } from './ReferenceManager';

afterEach(cleanup);

const api = (id: string, title: string, authors: string, year: number): ManuscriptSource =>
  ({ id, name: title, type: 'api', text: 'abstract', apiMeta: { title, authors, journal: 'J', doi: `10.1/${id}`, abstract: 'abstract', year, score: 1, source: 'PubMed' } });
const sources = [api('a', 'Alpha paper', 'Abe A', 2022), api('b', 'Beta paper', 'Zed B', 2018)];
const registry = { a: 2, b: 1 };
const order = () => screen.getAllByTitle('Jump to first citation').map(e => e.textContent);
const titles = () => screen.getAllByText(/ paper$/).map(e => e.textContent);

describe('ReferenceManager', () => {
  it('lists the references in citation-number order', () => {
    render(<ReferenceManager sources={sources} citationRegistry={registry} />);
    expect(order()).toEqual(['1', '2']);
    expect(titles()).toEqual(['Beta paper', 'Alpha paper']);
  });

  it('sorts by author or by year', () => {
    render(<ReferenceManager sources={sources} citationRegistry={registry} />);
    fireEvent.change(screen.getByTestId('control-sort-references'), { target: { value: 'author' } });
    expect(titles()).toEqual(['Alpha paper', 'Beta paper']); // Abe before Zed; by number Beta (1) comes first
    fireEvent.change(screen.getByTestId('control-sort-references'), { target: { value: 'year' } });
    expect(titles()).toEqual(['Alpha paper', 'Beta paper']); // newest first
    fireEvent.change(screen.getByTestId('control-sort-references'), { target: { value: 'order' } });
    expect(titles()).toEqual(['Beta paper', 'Alpha paper']);
  });

  it('filters, says when nothing matches, and clears the filter', () => {
    render(<ReferenceManager sources={sources} citationRegistry={registry} />);
    fireEvent.change(screen.getByTestId('control-filter-references'), { target: { value: 'alpha' } });
    expect(titles()).toEqual(['Alpha paper']);
    fireEvent.change(screen.getByTestId('control-filter-references'), { target: { value: 'nothing' } });
    expect(screen.getByText('No references match.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('control-clear-reference-filter'));
    expect(titles()).toHaveLength(2);
  });

  it('renumbering fires the callback', () => {
    const onRenumberCitations = vi.fn();
    render(<ReferenceManager sources={sources} citationRegistry={registry} onRenumberCitations={onRenumberCitations} />);
    fireEvent.click(screen.getByTestId('control-renumber'));
    expect(onRenumberCitations).toHaveBeenCalledTimes(1);
  });

  it('jumps to and removes a citation by its number and source', () => {
    const onScrollToCitation = vi.fn(), onRemoveCitation = vi.fn();
    render(<ReferenceManager sources={sources} citationRegistry={registry} onScrollToCitation={onScrollToCitation} onRemoveCitation={onRemoveCitation} />);
    fireEvent.click(screen.getAllByTestId('control-goto-citation')[1]);
    expect(onScrollToCitation).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getAllByTestId('control-remove-citation')[0]);
    expect(onRemoveCitation).toHaveBeenCalledWith('b');
  });

  it('expands a row to show its journal and DOI', () => {
    render(<ReferenceManager sources={sources} citationRegistry={registry} />);
    expect(screen.queryByText('10.1/b')).toBeNull();
    fireEvent.click(screen.getAllByTestId('control-expand-reference')[0]);
    expect(screen.getByText('10.1/b')).toBeTruthy();
  });

  it('inserts the reference list in citation order', () => {
    const onInsertHtml = vi.fn();
    render(<ReferenceManager sources={sources} citationRegistry={registry} onInsertHtml={onInsertHtml} />);
    fireEvent.click(screen.getByTestId('control-insert-reference-list'));
    const html = onInsertHtml.mock.calls[0][0] as string;
    expect(html.startsWith('<h2>References</h2><ol>')).toBe(true);
    expect(html.indexOf('[1]')).toBeLessThan(html.indexOf('[2]'));
  });

  it('formats a bibliography from a loaded .bib in the chosen style', () => {
    const onInsertHtml = vi.fn();
    const bib: ManuscriptSource = { id: 'k', name: 'refs.bib', type: 'bib', text: '@article{k, title={A title}, author={Doe, Jane}, year={2020}, journal={J}}' };
    render(<ReferenceManager sources={[bib]} onInsertHtml={onInsertHtml} />);
    fireEvent.change(screen.getByTestId('control-bib-style'), { target: { value: 'vancouver' } });
    fireEvent.click(screen.getByTestId('control-format-bibliography'));
    expect(onInsertHtml.mock.calls[0][0]).toMatch(/^<h2>References<\/h2>/);
    expect(onInsertHtml.mock.calls[0][0]).toContain('A title');
  });

  it('offers no formatter without a .bib and says so with no references', () => {
    render(<ReferenceManager sources={[]} />);
    expect(screen.queryByTestId('control-bib-style')).toBeNull();
    expect(screen.getByText(/No references yet/)).toBeTruthy();
  });

  it('draws a 200-entry reference list', () => {
    const many = Array.from({ length: 200 }, (_, i) => api(`s${i}`, `Paper ${i}`, `Author ${i}`, 2000 + (i % 20)));
    const reg = Object.fromEntries(many.map((s, i) => [s.id, i + 1]));
    render(<ReferenceManager sources={many} citationRegistry={reg} documentHTML={'<p>' + many.map((_, i) => `[${i + 1}]`).join(' ') + '</p>'} />);
    expect(screen.getAllByTitle('Jump to first citation')).toHaveLength(200);
    expect(order()[199]).toBe('200');
  });

  it('a registry entry whose source is gone still lists, so renumbering can be seen to need fixing', () => {
    render(<ReferenceManager sources={[]} citationRegistry={{ ghost: 1 }} />);
    expect(order()).toEqual(['1']);
  });
});
