// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { TASK_TAB, TAB_TASK, railSelect, revealTab, documentPageLimit, voiceFigure, usePageEstimate, docStats } from './shellLogic';
import { createFormat } from '../../services/formatPresets';
import type { AuditMetrics } from '../../types';

const doc = (n: number) => ({
  type: 'doc',
  content: Array.from({ length: n }, () => ({ type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(150) }] })),
});

describe('rail and tab mapping', () => {
  it('maps every task to a tab that maps back to the same task', () => {
    for (const [task, tab] of Object.entries(TASK_TAB)) expect(TAB_TASK[tab]).toBe(task);
  });
  it('the initial chat tab belongs to Review, the initial rail task', () => {
    expect(TAB_TASK.chat).toBe('review');
  });
});

describe('railSelect and revealTab', () => {
  it('clicking the active task closes the panel and leaves the tab alone', () => {
    for (const t of ['write', 'cite', 'review', 'format'] as const) expect(railSelect(t, t)).toEqual({ task: null, tab: null });
  });
  it('clicking another task opens it on its own tab, from closed or from a different task', () => {
    expect(railSelect(null, 'cite')).toEqual({ task: 'cite', tab: 'sources' });
    expect(railSelect('review', 'write')).toEqual({ task: 'write', tab: 'outline' });
  });
  it('revealing any tab selects the task that owns it', () => {
    for (const tab of Object.keys(TAB_TASK) as (keyof typeof TAB_TASK)[]) expect(revealTab(tab)).toEqual({ task: TAB_TASK[tab], tab });
    expect(revealTab('history').task).toBe('write');
  });
  it('every tab round-trips through its task to a tab of the same task', () => {
    for (const tab of Object.keys(TAB_TASK) as (keyof typeof TAB_TASK)[]) expect(TAB_TASK[TASK_TAB[TAB_TASK[tab]]]).toBe(TAB_TASK[tab]);
  });
});

describe('documentPageLimit', () => {
  it('is null while the author has set none, whatever the format', () => {
    expect(documentPageLimit(null)).toBeNull();
    expect(documentPageLimit(undefined)).toBeNull();
    expect(documentPageLimit(createFormat('nih'))).toBeNull();
  });
  it('reads the author\'s own limit from the format', () => {
    expect(documentPageLimit({ ...createFormat('nih'), pageLimitPages: 13 })).toBe(13);
    expect(documentPageLimit({ ...createFormat('nih'), pageLimitPages: 13.5 })).toBe(13.5);
  });
  it('ignores a stored value that is not a sane positive number', () => {
    for (const bad of [0, -3, NaN, Infinity, 1e6, '12' as any]) expect(documentPageLimit({ ...createFormat('nih'), pageLimitPages: bad })).toBeNull();
  });
});

describe('voiceFigure', () => {
  const metrics = { summary: { sentences: 10, meanWords: 20, pctOver35: 0, lengthCv: 0.5, counts: {}, rates: {} }, sentences: [], sections: [] } as AuditMetrics;
  const profile = { id: 'v', name: 'me', createdAt: 0, sampleWords: 1000, summary: metrics.summary, exampleSentences: [] };
  it('is null with no audit', () => expect(voiceFigure(null, 'x', profile)).toBeNull());
  it('is null once the text has changed since the audit', () => {
    expect(voiceFigure({ metrics, text: 'old text' }, 'new text', profile)).toBeNull();
  });
  it('is null on the generic baseline', () => {
    expect(voiceFigure({ metrics, text: 't' }, 't', undefined)).toBeNull();
  });
  it('is a number for a current audit against a real profile', () => {
    expect(typeof voiceFigure({ metrics, text: 't' }, 't', profile)).toBe('number');
  });
});

describe('usePageEstimate', () => {
  it('follows the document format: a wider-margin A4 page holds fewer lines than the NIH letter default', () => {
    const letter = renderHook(() => usePageEstimate(doc(80), createFormat('nih'))).result.current;
    const narrow = createFormat('nih');
    narrow.page = { ...narrow.page, marginsIn: { top: 2, right: 2, bottom: 2, left: 2 } };
    const tight = renderHook(() => usePageEstimate(doc(80), narrow)).result.current;
    expect(tight.pages).toBeGreaterThan(letter.pages);
  });
  it('tolerates no document and no format', () => {
    expect(renderHook(() => usePageEstimate(null, null)).result.current.pages).toBeGreaterThanOrEqual(1);
  });
});

describe('docStats', () => {
  it('counts the text only, the top-level blocks, and a minute per 200 words rounded up', () => {
    expect(docStats(null, 0)).toEqual({ chars: 0, paragraphs: 0, readingMin: 0 });
    const d = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de', marks: [{ type: 'bold' }] }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'xy' }] }] }] },
      { type: 'paragraph' },
    ] };
    expect(docStats(d, 201)).toEqual({ chars: 7, paragraphs: 3, readingMin: 2 });
  });
});
