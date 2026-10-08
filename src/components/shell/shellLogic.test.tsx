// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderHook } from '@testing-library/react';
import { TASK_TAB, TAB_TASK, documentPageLimit, voiceFigure, usePageEstimate } from './shellLogic';
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

describe('documentPageLimit', () => {
  it('reports no limit rather than an inferred one, in any mode or template', () => {
    expect(documentPageLimit('grant', 'nih-r01')).toBeNull();
    expect(documentPageLimit('manuscript', null)).toBeNull();
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

describe('App wiring', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  it('hands the store format to the Editor and to the page estimate', () => {
    expect(app).toMatch(/<Editor[\s\S]{0,120}format=\{format\}/);
    expect(app).toMatch(/usePageEstimate\(docJson, format\)/);
  });
  it('closing a task does not touch the sidebar tab', () => {
    expect(app).toMatch(/if \(railTask === t\) \{ setRailTask\(null\); return; \}/);
  });
});
