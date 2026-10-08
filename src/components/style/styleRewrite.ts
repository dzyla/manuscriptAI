import { auditMatchesDoc, type StyleAuditSnapshot } from './styleSync';
import { sentenceId } from './StylePanel';
import { MAX_REWRITE_WORDS } from '../../services/proseAudit/metrics';
import { rewriteSentence, neighbourSentences } from '../../services/proseAudit/rewrite';
import type { FlatSentenceTarget } from '../../extensions/StyleHighlights';
import type { AISettings, SentenceAudit } from '../../types';

type Toast = (message: string, type?: 'success' | 'info' | 'error') => void;

export interface StyleRewriteEditor {
  getPlainText: () => string;
  resolveFlatSentence: (start: number, end: number, expected: string) => FlatSentenceTarget;
  replaceFlatSentence: (start: number, end: number, expected: string, text: string) => FlatSentenceTarget;
}

const REFUSALS: Record<string, string> = {
  'hard-break': 'This sentence contains a line break. Rewrite it by hand.',
  'empty-citation': 'This sentence contains a citation with no number. Rewrite it by hand.',
  'inline-node': 'This sentence contains an inline object (a figure label or similar). Rewrite it by hand.',
  citations: 'The rewrite changed the citations in this sentence, so it was not applied.',
  stale: 'The sentence changed while it was being rewritten, so nothing was applied.',
  unmappable: 'That sentence cannot be located in the document. Re-run the style check.',
};

/**
 * Rewrite one flagged sentence and apply it as one undoable editor transaction. The guards live in rewriteSentence; this
 * checks that the audit still matches the document, refuses what cannot be applied safely, and tells the user which.
 * `inFlight` is shared across calls so a second click while a rewrite runs is ignored.
 */
export async function performStyleRewrite(args: {
  sentence: SentenceAudit;
  audit: StyleAuditSnapshot | null;
  /** Read the editor each time it is needed: the handle is recreated with the TipTap editor, and the model takes seconds. */
  getEditor: () => StyleRewriteEditor | null;
  settings: AISettings;
  inFlight: { current: AbortController | null };
  setBusy: (id: string | null) => void;
  toast: Toast;
  rewrite?: typeof rewriteSentence;
}): Promise<void> {
  const { sentence: s, audit, getEditor, settings, inFlight, setBusy, toast } = args;
  const rewrite = args.rewrite ?? rewriteSentence;
  const editor = getEditor();
  if (!editor || inFlight.current) return;
  if (s.words > MAX_REWRITE_WORDS) {
    toast('That sentence is too long to rewrite in one step. Split it by hand first.', 'info');
    return;
  }
  const plain = editor.getPlainText();
  if (!auditMatchesDoc(audit, plain)) {
    toast('The document changed since this sentence was measured. The panel is refreshing.', 'info');
    return;
  }
  const text = plain.slice(s.start, s.end);
  const target = editor.resolveFlatSentence(s.start, s.end, text);
  if (target.ok === false) {
    toast(REFUSALS[target.reason] ?? REFUSALS.unmappable, target.reason === 'stale' ? 'error' : 'info');
    return;
  }
  const ac = new AbortController();
  inFlight.current = ac;
  setBusy(sentenceId(s));
  try {
    const result = await rewrite({ sentence: text, ...neighbourSentences(plain, s.start, s.end), profile: settings.voiceProfile, settings, signal: ac.signal });
    // The model took seconds; apply only if the sentence is still exactly where it was and the citations still match.
    const live = getEditor();
    const applied = live ? live.replaceFlatSentence(s.start, s.end, text, result.text) : ({ ok: false, reason: 'unmappable' } as const);
    if (applied.ok === false) {
      toast(REFUSALS[applied.reason] ?? REFUSALS.unmappable, 'error');
      return;
    }
    toast(
      result.warnings.length ? `Rewritten, but it may still read machine-like: ${result.warnings[0]} Ctrl+Z undoes it.` : 'Sentence rewritten. Ctrl+Z undoes it.',
      result.warnings.length ? 'info' : 'success',
    );
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) toast(e instanceof Error ? e.message : 'Rewrite failed.', 'error');
  } finally {
    inFlight.current = null;
    setBusy(null);
  }
}
