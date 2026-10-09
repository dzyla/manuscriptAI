import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { AppCtx } from './appContext';
import { AgentType, AuditMetrics, SentenceAudit, Suggestion } from '../types';
import { AGENT_INFO } from '../services/ai';
import { auditText, flaggedSentences, MAX_REWRITE_WORDS } from '../services/proseAudit/metrics';
import { reviewRows, styleRowId } from '../components/panels/reviewRows';
import { performStyleRewrite } from '../components/style/styleRewrite';
import { sentencesToDraw, auditMatchesDoc } from '../components/style/styleSync';
import { voiceFigure } from '../components/shell/shellLogic';
import type { RailTask } from '../components/shell/Rail';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';

/**
 * The style audit (sub-project H) and the Review list built from it: one list of suggestions and flagged sentences in document order,
 * each row's action withheld once its anchor has gone stale.
 */
export function useStyleReview({ editorRef, showToast }: AppCtx, railTask: RailTask | null, act: { accept: (s: Suggestion) => void; reject: (s: Suggestion) => void }) {
  const { docJson, importId } = useDocumentStore();
  const { aiSettings, suggestions, history } = useAIStore();
  // Style audit (sub-project H). `text` is the exact editor text the metrics were computed from, so
  // sentence offsets are only ever applied to a document that still matches (see styleSentences below).
  const [styleAudit, setStyleAudit] = useState<{ metrics: AuditMetrics; text: string } | null>(null);
  const [drawStyleHighlights, setDrawStyleHighlights] = useState(false);
  const [rewritingId, setRewritingId] = useState<string | null>(null);
  const rewriteAbort = useRef<AbortController | null>(null);

  // ─── Style audit wiring (sub-project H) ────────────────────────────────────
  // The editor only audits (and reports) while its style plugin is enabled, so the plugin is on whenever
  // the Style tab is open or highlights are shown. Highlights themselves are drawn only when the user opts in.
  // The review list shows flagged sentences as rows, so the audit also runs while the Review task is open.
  const styleAuditOn = drawStyleHighlights || railTask === 'review';

  // The plugin reports on edits only; run one audit when metrics are switched on so the panel is
  // populated immediately instead of after the first keystroke.
  useEffect(() => {
    if (!styleAuditOn || !editorRef.current) return;
    const text = editorRef.current.getPlainText();
    setStyleAudit({ metrics: auditText(text), text });
  }, [styleAuditOn]);

  // Reports arrive from the editor's debounce timer immediately after it audited the document, so the
  // editor text read here is the audited text.
  const handleStyleAudit = useCallback((metrics: AuditMetrics) => {
    setStyleAudit({ metrics, text: editorRef.current?.getPlainText() ?? '' });
  }, []);

  // Sentences go back into the editor as offsets into the audited text. If the document has changed since
  // the audit, offsets would be drawn in the wrong place, so they are withheld; the editor's debounce has
  // already queued a fresh report for that edit, which replaces them.
  const styleSentences = useMemo(
    () => sentencesToDraw(styleAudit, editorRef.current?.getPlainText(), drawStyleHighlights),
    [drawStyleHighlights, styleAudit],
  );

  const handleStyleJump = useCallback((s: SentenceAudit) => {
    if (!auditMatchesDoc(styleAudit, editorRef.current?.getPlainText()) || !editorRef.current?.selectFlatRange(s.start, s.end)) {
      showToast('The document changed since this sentence was measured. The panel is refreshing.', 'info');
    }
  }, [styleAudit, showToast]);

  useEffect(() => () => rewriteAbort.current?.abort(), []);

  // Rewrite one flagged sentence in the author's voice; the guards and the apply step live in performStyleRewrite.
  const handleStyleRewrite = useCallback(
    (s: SentenceAudit) => performStyleRewrite({
      sentence: s, audit: styleAudit, getEditor: () => editorRef.current, settings: aiSettings,
      inFlight: rewriteAbort, setBusy: setRewritingId, toast: showToast,
    }),
    [aiSettings, styleAudit, showToast],
  );


  const voiceProfile = aiSettings.voiceProfile;
  const currentText = useMemo(() => editorRef.current?.getPlainText(), [docJson]); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceDistance = useMemo(
    () => voiceFigure(styleAudit, currentText, voiceProfile),
    [styleAudit, currentText, voiceProfile],
  );

  // ─── Review panel: one list, in document order ─────────────────────────────
  // Suggestions and style flags both index the editor's plain text (flattenDoc). Both go stale as the document changes, so the rows
  // are re-derived against the current text and a row whose anchor is gone has its action disabled rather than aimed at the wrong span.
  const flagged = useMemo(() => (styleAuditOn && styleAudit ? flaggedSentences(styleAudit.metrics, 12) : []), [styleAuditOn, styleAudit]);
  const styleCurrent = auditMatchesDoc(styleAudit, currentText);
  const styleBlocked = useMemo(() => {
    const blocked = new Map<string, string>();
    const ed = editorRef.current;
    if (!ed || !styleCurrent || !currentText) return blocked;
    for (const f of flagged) {
      if (f.words > MAX_REWRITE_WORDS) { blocked.set(styleRowId(f), 'Too long to rewrite in one step. Split it by hand first.'); continue; }
      const r = ed.resolveFlatSentence(f.start, f.end, currentText.slice(f.start, f.end));
      if (r.ok === false) blocked.set(styleRowId(f), 'This sentence holds something a rewrite would lose (a line break, an empty citation or an inline object). Rewrite it by hand.');
    }
    return blocked;
  }, [flagged, styleCurrent, currentText]);
  const appliedIds = useMemo(() => new Set(history.map(h => h.suggestionId)), [history]);
  const deferredText = useDeferredValue(currentText);
  const rows = useMemo(
    () => reviewRows({ suggestions, flagged, grammar: [], plainText: deferredText ?? '', appliedIds, styleCurrent: styleCurrent && deferredText === currentText, styleBlocked }),
    [suggestions, flagged, deferredText, currentText, appliedIds, styleCurrent, styleBlocked],
  );
  const reviewAgents = useMemo(
    () => (Object.entries(AGENT_INFO) as [AgentType, typeof AGENT_INFO[AgentType]][])
      .filter(([id]) => id !== 'literature-reviewer' && id !== 'manuscript-ai' && id !== 'citation-checker')
      .map(([id, info]) => ({ id, label: info.label })),
    [],
  );
  const handleReviewAct = (rowId: string, action: 'accept' | 'reject' | 'rewrite') => {
    const row = rows.find(r => r.id === rowId);
    if (!row || (action !== 'reject' && !row.canAct)) return;
    if (row.kind === 'suggestion') {
      const sug = suggestions.find(x => `suggestion:${x.id}` === rowId);
      if (!sug) return;
      if (action === 'accept') act.accept(sug); else act.reject(sug);
    } else if (row.kind === 'style' && action === 'rewrite') {
      const f = flagged.find(x => styleRowId(x) === rowId);
      if (f) handleStyleRewrite(f);
    }
  };
  const handleReviewLocate = (row: { id: string; kind: string }) => {
    if (row.kind === 'suggestion') {
      const sug = suggestions.find(x => `suggestion:${x.id}` === row.id);
      if (sug) editorRef.current?.scrollToSuggestion(sug.originalText, sug.id);
    } else if (row.kind === 'style') {
      const f = flagged.find(x => styleRowId(x) === row.id);
      if (f) handleStyleJump(f);
    }
  };

  return { styleAudit, styleAuditOn, drawStyleHighlights, setDrawStyleHighlights, rewritingId, styleSentences, handleStyleAudit, handleStyleJump, handleStyleRewrite, voiceDistance, rows, reviewAgents, handleReviewAct, handleReviewLocate };
}
