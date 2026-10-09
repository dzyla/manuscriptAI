// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ManuscriptSource, AISettings } from '../../../types';
import { useSourceStore } from '../../../stores/useSourceStore';
import { Library, type LibraryProps } from './Library';
import type { SourceUpload } from './useSourceUpload';

vi.mock('../../../services/manuscriptSearch', async (orig) => ({ ...(await orig<typeof import('../../../services/manuscriptSearch')>()), searchSimilarManuscripts: vi.fn(async () => []) }));

afterEach(cleanup);
beforeEach(() => { useSourceStore.setState({ sources: [] }); });

const upload = (over: Partial<SourceUpload> = {}): SourceUpload => ({
  isDragging: false, setIsDragging: vi.fn(), isParsing: false, parsingFileName: null, digestingId: null,
  fileUploadRef: { current: null }, processFiles: vi.fn(async () => {}), handleFileDrop: vi.fn(async () => {}), handleFileInput: vi.fn(async () => {}), ...over,
});
const text: ManuscriptSource = { id: 'x1', name: 'A paper', type: 'text', text: 'body', digest: 'summary' };
const pdf: ManuscriptSource = { id: 'p1', name: 'scan.pdf', type: 'pdf', text: 'Body of the paper' };
const ai = { provider: 'gemini' } as unknown as AISettings;
const props = (over: Partial<LibraryProps> = {}): LibraryProps => ({
  sources: [], manuscriptContent: '', upload: upload(), digestingApiIds: new Set(), pendingMatches: {}, onPendingMatchesChange: vi.fn(), onCompare: vi.fn(), onChat: vi.fn(), ...over,
});

describe('Library', () => {
  it('offers an upload control', () => {
    render(<Library {...props()} />);
    expect(screen.getByTestId('control-upload')).toBeTruthy();
  });

  it('lists each source once', () => {
    render(<Library {...props({ sources: [text] })} />);
    expect(screen.getAllByText('A paper')).toHaveLength(1);
  });

  it('reports the file chosen for upload', () => {
    const u = upload();
    const { container } = render(<Library {...props({ upload: u })} />);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'p.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(u.handleFileInput).toHaveBeenCalledTimes(1);
    expect((u.handleFileInput as any).mock.calls[0][0].target.files[0]).toBe(file);
  });

  it('says so when the library is empty', () => {
    render(<Library {...props()} />);
    expect(screen.getByText(/no sources yet/i)).toBeTruthy();
  });

  it('shows what an upload in progress is doing', () => {
    render(<Library {...props({ upload: upload({ isParsing: true, parsingFileName: 'big.pdf' }) })} />);
    expect(screen.getByText('Parsing files...')).toBeTruthy();
    expect(screen.getByText('big.pdf')).toBeTruthy();
  });

  it('a source with no digest says there is none yet instead of showing an empty box', () => {
    render(<Library {...props({ aiSettings: ai, sources: [{ ...text, digest: undefined }] })} />);
    expect(screen.getByText(/No summary yet/)).toBeTruthy();
  });

  it('removing a source empties the store and drops its pending PDF match', () => {
    useSourceStore.setState({ sources: [pdf] });
    const onPendingMatchesChange = vi.fn();
    render(<Library {...props({ sources: [pdf], onPendingMatchesChange })} />);
    fireEvent.click(screen.getByTestId('control-remove-source'));
    expect(useSourceStore.getState().sources).toEqual([]);
    const updater = onPendingMatchesChange.mock.calls[0][0] as (p: Record<string, unknown>) => Record<string, unknown>;
    expect(updater({ p1: { results: [], matchIndex: 0 }, other: { results: [], matchIndex: 0 } })).toEqual({ other: { results: [], matchIndex: 0 } });
  });

  it('a PDF with no match found offers the manual search and no confirmation', () => {
    render(<Library {...props({ sources: [pdf] })} />);
    expect(screen.queryByText(/Is this your paper/)).toBeNull();
    const search = screen.getByTestId('control-match-pdf') as HTMLButtonElement;
    expect(search.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Search paper title or keywords…'), { target: { value: 'crispr' } });
    expect(search.disabled).toBe(false);
  });

  it('a pending PDF match can be confirmed, skipped and dismissed', () => {
    useSourceStore.setState({ sources: [pdf] });
    const results = [1, 2].map(n => ({ title: `Paper ${n}`, authors: 'A', journal: 'J', doi: `10.1/${n}`, abstract: 'x', year: 2020, score: 0.9, source: 'PubMed' }));
    const onPendingMatchesChange = vi.fn();
    render(<Library {...props({ sources: [pdf], pendingMatches: { p1: { results, matchIndex: 0 } }, onPendingMatchesChange })} />);
    expect(screen.getByText('Is this your paper? (1/2)')).toBeTruthy();
    fireEvent.click(screen.getByTestId('control-match-next'));
    const step = onPendingMatchesChange.mock.calls[0][0] as (p: any) => any;
    expect(step({ p1: { results, matchIndex: 0 } }).p1.matchIndex).toBe(1);
    fireEvent.click(screen.getByTestId('control-match-yes'));
    expect(useSourceStore.getState().sources[0].name).toBe('Paper 1');
    fireEvent.click(screen.getByTestId('control-match-dismiss'));
    expect(onPendingMatchesChange).toHaveBeenCalledTimes(3);
  });
});
