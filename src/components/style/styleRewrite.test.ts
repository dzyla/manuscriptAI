import { describe, it, expect, vi } from 'vitest';
import { performStyleRewrite, type StyleRewriteEditor } from './styleRewrite';
import type { AISettings, SentenceAudit, AuditMetrics } from '../../types';

const TEXT = 'Intro words here. Lead in sentence. The state is selected kinetically rather than thermodynamically; we measured 42 complexes [3]. Follow up sentence. Last one.';
const start = TEXT.indexOf('The state');
const sentence: SentenceAudit = { start, end: TEXT.indexOf(' Follow up'), words: 15, tells: ['semicolon'], severity: 50 };
const audit = { metrics: {} as AuditMetrics, text: TEXT };
const profile = { id: 'v', name: 'mine', createdAt: 0, sampleWords: 1, summary: { sentences: 1, meanWords: 20, pctOver35: 0, lengthCv: 0, counts: {}, rates: {} }, exampleSentences: ['We purified it.'] };
const settings = { voiceProfile: profile } as unknown as AISettings;

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
  const run = () => performStyleRewrite({ sentence, audit, getEditor: () => editor, settings, inFlight, setBusy, toast, rewrite });
  return { editor, toast, setBusy, inFlight, rewrite, run };
}

describe('performStyleRewrite', () => {
  it('passes the voice profile, the neighbouring sentences, the abort signal and the sentence text to the rewrite, and marks the right sentence busy', async () => {
    const t = setup();
    await t.run();
    const arg = (t.rewrite.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg.profile).toBe(profile);
    expect(arg.settings).toBe(settings);
    expect(arg.sentence).toBe(TEXT.slice(start, sentence.end));
    expect(arg.before).toBe('Lead in sentence.');
    expect(arg.after).toBe('Follow up sentence.');
    expect(arg.signal).toBeInstanceOf(AbortSignal);
    expect(t.setBusy).toHaveBeenNthCalledWith(1, `${sentence.start}-${sentence.end}`);
  });

  it('forwards an abort of the in-flight request', async () => {
    const t = setup();
    let seen: AbortSignal | undefined;
    t.rewrite.mockImplementationOnce((async (a: { signal?: AbortSignal }) => { seen = a.signal; t.inFlight.current?.abort(); return { text: 'x', retried: false, warnings: [] }; }) as never);
    await t.run();
    expect(seen?.aborted).toBe(true);
  });

  it('applies through the editor as it is after the model returns, not the one captured before', async () => {
    const t = setup();
    const later = { ...t.editor, replaceFlatSentence: vi.fn(() => ({ ok: true, from: 1, to: 2, citations: 0, atoms: [] })) } as StyleRewriteEditor;
    let current: StyleRewriteEditor = t.editor;
    t.rewrite.mockImplementationOnce((async () => { current = later; return { text: 'Kinetics select the state. We measured 42 complexes [3].', retried: false, warnings: [] }; }) as never);
    await performStyleRewrite({ sentence, audit, getEditor: () => current, settings, inFlight: t.inFlight, setBusy: t.setBusy, toast: t.toast, rewrite: t.rewrite as never });
    expect(later.replaceFlatSentence).toHaveBeenCalledTimes(1);
    expect(t.editor.replaceFlatSentence).not.toHaveBeenCalled();
  });

  it('applies a clean rewrite and says so', async () => {
    const t = setup();
    await t.run();
    expect(t.editor.replaceFlatSentence).toHaveBeenCalledWith(start, sentence.end, TEXT.slice(start, sentence.end), 'Kinetics select the state. We measured 42 complexes [3].');
    expect(t.toast).toHaveBeenCalledWith('Sentence rewritten. Ctrl+Z undoes it.', 'success');
    expect(t.inFlight.current).toBeNull();
    expect(t.setBusy).toHaveBeenLastCalledWith(null);
  });

  it('flags a style-only warning in the toast (facts never reach here: rewriteSentence refuses them)', async () => {
    const t = setup({}, { text: 'x y z w.', retried: true, warnings: ['The rewrite does not improve the style score.'] });
    await t.run();
    expect(t.toast.mock.calls[0][0]).toMatch(/may still read machine-like: The rewrite does not improve/);
    expect(t.toast.mock.calls[0][1]).toBe('info');
  });

  it('applies nothing and shows the reason when the rewrite is refused for a changed fact', async () => {
    const t = setup({}, new Error('The model did not produce a safe rewrite. The number 42 is missing from the rewrite.'));
    await t.run();
    expect(t.editor.replaceFlatSentence).not.toHaveBeenCalled();
    expect(t.toast).toHaveBeenCalledWith(expect.stringMatching(/safe rewrite.*number 42/), 'error');
  });

  it('does not offer a rewrite for a sentence over the word cap and never calls the model', async () => {
    const t = setup();
    await performStyleRewrite({ sentence: { ...sentence, words: 520 }, audit, getEditor: () => t.editor, settings, inFlight: t.inFlight, setBusy: t.setBusy, toast: t.toast, rewrite: t.rewrite as never });
    expect(t.rewrite).not.toHaveBeenCalled();
    expect(t.toast).toHaveBeenCalledWith(expect.stringMatching(/too long/), 'info');
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
    expect(t.toast).toHaveBeenCalledTimes(1);
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
