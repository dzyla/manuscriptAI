import { useRef, useState } from 'react';
import type { AppCtx } from './appContext';
import { AgentType, Suggestion } from '../types';
import { analyzeText, resolveConflicts, runJudgeAgent, verifySuggestions, dedupeAdvisories, rebutSuggestion, manuscriptSummary, trimSectionToLimit, AGENT_INFO } from '../services/ai';
import { freshDetectorSuggestions } from '../services/detectors';
import { findTextSpan } from '../utils/textMatch';
import { WORDS_PER_PAGE } from '../services/grantTemplates';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { Message } from '../types';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Running the review agents, the manuscript summary, a suggestion rebuttal and the grant section trim. `abortRef` is shared with the chat so Stop reaches both. */
export function useAnalysis({ editorRef, showToast, openTab }: AppCtx) {
  const { content, mode } = useDocumentStore();
  const { aiSettings, suggestions, setIsAnalyzing, setAnalysisProgress, addSuggestions, addMessage, updateSuggestion } = useAIStore();
  const abortRef = useRef<AbortController | null>(null);
  const [trimmingSection, setTrimmingSection] = useState<string | null>(null);

  const handleTrimSection = async (sectionTitle: string, budgetWords: number) => {
    const sectionText = editorRef.current?.getSectionTextByTitle(sectionTitle);
    if (!sectionText) { showToast('Section not found in document', 'error'); return; }
    // Body only — getSectionTextByTitle prepends the title line
    const body = sectionText.split('\n\n').slice(1).join('\n\n').trim();
    if (!body) return;
    setTrimmingSection(sectionTitle);
    try {
      const trimmed = await trimSectionToLimit(body, sectionTitle, budgetWords, aiSettings);
      if (!trimmed || trimmed === body) { showToast('Trim produced no change', 'info'); return; }
      const plainText = editorRef.current?.getPlainText() || stripHtml(content);
      const span = findTextSpan(plainText, body);
      addSuggestions([{
        id: `suggestion-trim-${Date.now()}`,
        originalText: span?.matchedText ?? body,
        suggestedText: trimmed,
        explanation: `Condensed "${sectionTitle}" to fit its ${Math.round(budgetWords / WORDS_PER_PAGE * 10) / 10}-page NIH limit (~${budgetWords} words).`,
        agent: 'editor',
        startIndex: span?.start ?? 0,
        endIndex: span?.end ?? body.length,
        severity: 'major',
        category: 'structure',
        section: sectionTitle,
      }]);
      openTab('suggestions');
      showToast(`Trim ready for "${sectionTitle}" — review in Suggestions`, 'success');
    } catch (e) {
      showToast(`Trim failed: ${e instanceof Error ? e.message : 'Unknown error'}`, 'error');
    } finally {
      setTrimmingSection(null);
    }
  };


  const stopRequest = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsAnalyzing(false);
    setAnalysisProgress(null);
    showToast('Request stopped.', 'info');
  };

  const handleAnalyze = async (specificAgent?: AgentType) => {
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setIsAnalyzing(true);
    try {
      // Get the latest text directly from the editor.
      // getPlainText is the canonical representation (same one used for anchoring).
      const htmlContent = editorRef.current?.getHTML() || content;
      const plainText = editorRef.current?.getPlainText() || stripHtml(htmlContent);

      if (plainText.length < 20) {
        showToast('Write some text first before analyzing.', 'info');
        setIsAnalyzing(false);
        return;
      }

      if (specificAgent) {
        setAnalysisProgress({ agent: AGENT_INFO[specificAgent].label, total: 1, done: 0 });
        const result = await analyzeText(plainText, specificAgent, aiSettings, suggestions, (msg) => {
          const prev = useAIStore.getState().analysisProgress;
          setAnalysisProgress(prev ? { ...prev, agent: `${AGENT_INFO[specificAgent].label} — ${msg}` } : null);
        }, htmlContent, signal);

        if (result.status === 'server_error') {
          showToast(`✕ ${AGENT_INFO[specificAgent].label}: ${result.errorMessage ?? 'Server error'}`, 'error');
        } else if (result.status === 'parsing_failed') {
          showToast(`⚠ ${AGENT_INFO[specificAgent].label}: Response wasn't valid JSON. Try a larger model or cloud API.`, 'error');
        } else if (result.status === 'no_suggestions') {
          showToast(`${AGENT_INFO[specificAgent].label} found no issues — nice work!`, 'info');
        }

        if (result.suggestions.length > 0) {
          const resolved = await resolveConflicts(result.suggestions, aiSettings);
          addSuggestions(resolved);
          const salvageNote = result.salvaged ? ` · ${result.salvaged} recovered by fuzzy match` : '';
          showToast(`${resolved.length} suggestions from ${AGENT_INFO[specificAgent].label}${salvageNote}`, 'success');
        }
      } else {
        // Run all agents in parallel. The crew is mode-aware: manuscripts get
        // statistics + internal-consistency review; grants get statistics but
        // skip cross-section consistency (aims pages read differently).
        const agentsToRun: AgentType[] = mode === 'grant'
          ? ['editor', 'reviewer-2', 'researcher', 'statistician']
          : ['editor', 'reviewer-2', 'researcher', 'statistician', 'consistency'];
        setAnalysisProgress({ agent: 'Running all agents in parallel...', total: agentsToRun.length, done: 0 });

        const results = await Promise.all(
          agentsToRun.map(agent => analyzeText(plainText, agent, aiSettings, suggestions, undefined, htmlContent, signal))
        );
        
        let totalNew = 0;
        let combinedSuggestions: Suggestion[] = [];
        let parseFailures: string[] = [];
        let serverErrors: { label: string; msg: string }[] = [];
        let zeroes: string[] = [];

        results.forEach((res, idx) => {
          const label = AGENT_INFO[agentsToRun[idx]].label;
          if (res.status === 'server_error') serverErrors.push({ label, msg: res.errorMessage ?? 'Server error' });
          else if (res.status === 'parsing_failed') parseFailures.push(label);
          else if (res.status === 'no_suggestions') zeroes.push(label);
          combinedSuggestions = [...combinedSuggestions, ...res.suggestions];
        });

        // Deterministic detectors run regardless of provider — they never miss
        // and never fabricate, so they set a recall floor under the LLM agents.
        const detectorAdvisories = freshDetectorSuggestions(plainText);

        // Advisory suggestions (flag-only) bypass the Judge/verifier, which are
        // built around edit ORIGINAL→REPLACE reasoning. Detector advisories go
        // first so they win any span collision with an LLM advisory.
        const advisories = dedupeAdvisories([
          ...detectorAdvisories,
          ...combinedSuggestions.filter(s => s.kind === 'advisory'),
        ]);
        const edits = combinedSuggestions.filter(s => s.kind !== 'advisory');

        if (edits.length > 0 || advisories.length > 0) {
          let judged: Suggestion[] = [];
          let verifiedDropped = 0;
          if (edits.length > 0) {
            const resolved = await resolveConflicts(edits, aiSettings);
            // Run the Judge BEFORE displaying, so overlapping cards are removed
            // up front instead of visibly vanishing a few seconds after they appear.
            judged = resolved;
            try {
              setAnalysisProgress({ agent: 'Judge selecting best suggestions…', total: agentsToRun.length, done: agentsToRun.length });
              judged = await runJudgeAgent(resolved, aiSettings, signal);
            } catch (e) {
              if ((e as any)?.name === 'AbortError') throw e;
              judged = resolved; // Judge failure is non-fatal; show everything
            }
            // Quality gate: drop edits that don't preserve meaning or don't improve.
            try {
              setAnalysisProgress({ agent: 'Verifying suggestion quality…', total: agentsToRun.length, done: agentsToRun.length });
              const v = await verifySuggestions(judged, aiSettings, signal);
              judged = v.kept;
              verifiedDropped = v.dropped;
            } catch (e) {
              if ((e as any)?.name === 'AbortError') throw e;
            }
          }
          const finalSuggestions = [...judged, ...advisories];
          addSuggestions(finalSuggestions);
          totalNew = finalSuggestions.length;
          const removed = (edits.length - judged.length);
          if (removed > 0) {
            const verifyNote = verifiedDropped > 0 ? `, ${verifiedDropped} failed quality check` : '';
            showToast(`Kept ${finalSuggestions.length} suggestions (${removed} filtered${verifyNote})`, 'info');
          }
        }

        // Surface failures with specific diagnostics
        if (serverErrors.length > 0) {
          // All server errors share the same root cause — show it once with agent list
          const agentList = serverErrors.map(e => e.label).join(', ');
          const diagnosis = serverErrors[0].msg; // root cause is the same for all
          const prefix = totalNew > 0 ? `${totalNew} suggestions found · ` : '';
          showToast(`${prefix}✕ ${agentList}: ${diagnosis}`, 'error');
        } else if (parseFailures.length > 0) {
          const prefix = totalNew > 0 ? `${totalNew} suggestions found · ` : '';
          showToast(`${prefix}⚠ JSON parse failed: ${parseFailures.join(', ')}. Try a larger model or cloud API.`, 'error');
        } else if (totalNew > 0) {
          const zeroNote = zeroes.length > 0 ? ` · No issues from: ${zeroes.join(', ')}` : '';
          const totalSalvaged = results.reduce((n, r) => n + (r.salvaged ?? 0), 0);
          const salvageNote = totalSalvaged > 0 ? ` · ${totalSalvaged} recovered by fuzzy match` : '';
          showToast(`${totalNew} suggestions found${zeroNote}${salvageNote}`, 'success');
        } else {
          showToast('No suggestions from any agent. Your text looks good!', 'info');
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return; // stopped by user — already handled by stopRequest
      console.error("Analysis failed", error);
      showToast(`Analysis error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      abortRef.current = null;
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
  };

  const handleRebuttal = async (suggestionId: string, feedback: string) => {
    const suggestion = suggestions.find(s => s.id === suggestionId);
    if (!suggestion) return;
    setIsAnalyzing(true);
    try {
      const plainText = (editorRef.current?.getPlainText() || stripHtml(content));
      const newSugs = await rebutSuggestion(suggestion, feedback, plainText, aiSettings);
      if (newSugs?.length) {
        updateSuggestion(suggestionId, newSugs[0]);
        showToast('Suggestion refined', 'success');
      }
    } catch (e) {
      console.error("Rebuttal failed", e);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleManuscriptSummary = async () => {
    setIsAnalyzing(true);
    openTab('chat');
    setAnalysisProgress({ agent: 'Generating manuscript summary...', total: 1, done: 0 });
    
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: 'Please provide a comprehensive manuscript summary and identify the biggest gaps.'
    };
    addMessage(userMsg);

    try {
      const plainText = (editorRef.current?.getPlainText() || stripHtml(content));

      if (plainText.length < 50) {
        showToast('Write more text first for a meaningful summary.', 'info');
        setIsAnalyzing(false);
        setAnalysisProgress(null);
        return;
      }

      const summary = await manuscriptSummary(plainText, aiSettings);
      addMessage({ id: (Date.now() + 1).toString(), role: 'assistant', content: summary, agent: 'manager' });
      showToast('Manuscript summary generated', 'success');
    } catch (error) {
      console.error('Summary failed:', error);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Failed to generate summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
        agent: 'manager'
      });
      showToast('Summary generation failed', 'error');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
  };

  return { abortRef, stopRequest, handleAnalyze, handleManuscriptSummary, handleRebuttal, handleTrimSection, trimmingSection };
}
