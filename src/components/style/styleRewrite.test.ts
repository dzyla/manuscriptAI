import { describe, it, expect, vi } from 'vitest';
import { performStyleRewrite, type StyleRewriteEditor } from './styleRewrite';
import type { AISettings, SentenceAudit, AuditMetrics } from '../../types';

const TEXT = 'Intro words here. The state is selected kinetically rather than thermodynamically; we measured 42 complexes [3].';
const start = TEXT.indexOf('The state');
const sentence: SentenceAudit = { start, end: TEXT.length, words: 15, tells: ['semicolon'], severity: 50 };
const audit = { metrics: {} as AuditMetrics, text: TEXT };
const settings = {} as AISettings;

function setup(over: Partial<StyleRewriteEditor> = {}, rewriteResult: { text: string; retried: boolean; warnings: string[] } | Error = { text: 'Kinetics select the state. We measured 42 complexes [3].', retried: false, warnings: [] }) {
  const editor: StyleRewriteEditor = {
    getPlainText: () => TEXT,
    resolveFlatSentence: vi.fn(() => ({ ok: true, from: 1, to: 2, citations: 1, atoms: [] })),
    replaceFlatSentence: vi.fn(() => ({ ok: true, from: 1, to: 2, citations: 1, atoms: [] })),
    ...over,
  } as StyleRewriteEditor;
  const toast = vi.fn();
  const setBusy = vi.fn();
  const inFlight = { current: null as AbortController | null };
  const rewrite = vi.fn(async () => { if (rewriteResult instanceof Error) throw rewriteResult; return rewriteResult; });
  const run = () => performStyleRewrite({ sentence, audit, editor, settings, inFlight, setBusy, toast, rewrite });
  return { editor, toast, setBusy, inFlight, rewrite, run };
}

describe('performStyleRewrite', () => {
  it('applies a clean rewrite and says so', async () => {
    const t = setup();
    await t.run();
    expect(t.editor.replaceFlatSentence).toHaveBeenCalledWith(start, TEXT.length, TEXT.slice(start), 'Kinetics select the state. We measured 42 complexes [3].');
    expect(t.toast).toHaveBeenCalledWith('Sentence rewritten. Ctrl+Z undoes it.', 'success');
    expect(t.inFlight.current).toBeNull();
    expect(t.setBusy).toHaveBeenLastCalledWith(null);
  });

  it('flags a "check facts" rewrite in the toast', async () => {
    const t = setup({}, { text: 'x y z w.', retried: true, warnings: ['The number 42 is missing from the rewrite.'] });
    await t.run();
    expect(t.toast.mock.calls[0][0]).toMatch(/check facts: The number 42 is missing/);
    expect(t.toast.mock.calls[0][1]).toBe('info');
  });

  it('shows the citation toast when the editor refuses a rewrite whose citations differ', async () => {
    const t = setup({ replaceFlatSentence: vi.fn(() => ({ ok: false, reason: 'citations' })) as never });
    await t.run();
    expect(t.toast).toHaveBeenCalledWith(expect.stringMatching(/changed the citations .* not applied/), 'error');
  });

  it('shows the stale toast when the sentence changed while the model ran', async () => {
    const t = setup({ replaceFlatSentence: vi.fn(() => ({ ok: false, reason: 'stale' })) as never });
    await t.run();
    expect(t.toast).toHaveBeenCalledWith(expect.stringMatching(/changed while it was being rewritten/), 'error');
    expect(t.inFlight.current).toBeNull();
  });

  it('refuses before calling the model when the sentence cannot be rewritten safely', async () => {
    for (const reason of ['hard-break', 'empty-citation', 'inline-node'] as const) {
      const t = setup({ resolveFlatSentence: vi.fn(() => ({ ok: false, reason })) as never });
      await t.run();
      expect(t.rewrite).not.toHaveBeenCalled();
      expect(t.toast).toHaveBeenCalledTimes(1);
    }
  });

  it('does nothing but explain when the audit no longer matches the document', async () => {
    const t = setup({ getPlainText: () => TEXT + ' edited' });
    await t.run();
    expect(t.rewrite).not.toHaveBeenCalled();
    expect(t.toast).toHaveBeenCalledWith(expect.stringMatching(/changed since this sentence was measured/), 'info');
  });

  it('ignores a second click while a rewrite is running', async () => {
    const t = setup();
    const first = t.run();
    await t.run();
    await first;
    expect(t.rewrite).toHaveBeenCalledTimes(1);
    expect(t.editor.replaceFlatSentence).toHaveBeenCalledTimes(1);
  });

  it('is silent on an abort and releases the busy state on an error', async () => {
    const a = setup({}, new DOMException('aborted', 'AbortError'));
    await a.run();
    expect(a.toast).not.toHaveBeenCalled();
    expect(a.inFlight.current).toBeNull();
    const b = setup({}, new Error('The model did not produce a usable rewrite.'));
    await b.run();
    expect(b.toast).toHaveBeenCalledWith('The model did not produce a usable rewrite.', 'error');
    expect(b.setBusy).toHaveBeenLastCalledWith(null);
  });
});
