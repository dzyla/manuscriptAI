import { useCallback, useState } from 'react';
import type { AppCtx } from './appContext';
import { AgentType, ManuscriptSource, Message, Suggestion } from '../types';
import { searchSimilarManuscripts } from '../services/manuscriptSearch';
import { chatWithAgent, resolveConflicts, rewriteSection, transformWithInstruction, verifyClaimAgainstSources, getThesaurus, AGENT_INFO } from '../services/ai';
import { findTextSpan } from '../utils/textMatch';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { useSourceStore } from '../stores/useSourceStore';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** The AI actions that act on the selected text: ask, transform, rewrite, verify, find similar, and the synonym lookup. */
export function useSelectionAI({ editorRef, showToast, openTab }: AppCtx, highlight: (suggestionId: string | null) => void) {
  const { content } = useDocumentStore();
  const { aiSettings, setIsAnalyzing, setAnalysisProgress, addSuggestions, addMessage } = useAIStore();
  const { sources, setPendingApiSources } = useSourceStore();
  const [thesaurus, setThesaurus] = useState<{ word: string; synonyms: string[]; loading: boolean } | null>(null);

  const handleSearchSimilar = (text: string) => {
    const query = text.trim();
    if (query.length < 3) {
      showToast('Select at least a few words to search for similar manuscripts.', 'info');
      return;
    }
    openTab('sources');
    showToast('Searching for similar manuscripts…', 'info');
    searchSimilarManuscripts(query, 5)
      .then(results => {
        if (results.length === 0) {
          showToast('No similar manuscripts found for this selection.', 'info');
          return;
        }
        const sources: ManuscriptSource[] = results.map(r => ({
          id: `api-${Date.now()}-${Math.random()}`,
          name: r.title,
          type: 'api' as const,
          text: r.abstract,
          digest: r.abstract,
          apiMeta: r,
          queryText: query,
        }));
        setPendingApiSources(sources);
        showToast(`Found ${results.length} similar manuscripts`, 'success');
      })
      .catch(err => showToast(
        `Search failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        'error'
      ));
  };

  const handleVerifyClaim = async (selectedText: string) => {
    const digestedSources = sources.filter(
      s => (s.type === 'pdf' && s.digest) || s.type === 'api'
    );
    if (digestedSources.length === 0) {
      showToast('Upload and digest PDF sources first to verify claims against literature.', 'info');
      openTab('sources');
      return;
    }
    openTab('chat');
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: `Verify this claim against uploaded sources:\n"${selectedText}"` };
    addMessage(userMsg);
    setIsAnalyzing(true);
    try {
      const result = await verifyClaimAgainstSources(selectedText, digestedSources, aiSettings);
      addMessage({ id: (Date.now() + 1).toString(), role: 'assistant', content: result, agent: 'literature-reviewer' as AgentType });
    } catch (err) {
      showToast(`Verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSelectionQuery = async (selectedText: string, instruction: string, agent: AgentType) => {
    setIsAnalyzing(true);
    const fullText = (editorRef.current?.getPlainText() || stripHtml(content));
    
    // Switch the panel to chat to show the reply
    openTab('chat');
    
    // Add to chat as user message
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: `[Selected text]: "${selectedText.substring(0, 200)}${selectedText.length > 200 ? '...' : ''}"\n\n${instruction}`
    };
    addMessage(userMsg);

    try {
      const chatResult = await chatWithAgent(
        `${instruction}\n\nFocus on this specific text:\n"${selectedText}"`,
        fullText, agent, aiSettings
      );

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: chatResult.text || 'No response generated.',
        agent,
        suggestions: chatResult.suggestions || []
      };
      addMessage(assistantMsg);

      if (chatResult.suggestions && chatResult.suggestions.length > 0) {
        const resolved = await resolveConflicts(chatResult.suggestions, aiSettings);
        addSuggestions(resolved);
        showToast(`${resolved.length} suggestions from ${AGENT_INFO[agent].label}`, 'success');
      }
    } catch (error) {
      console.error('Selection query failed:', error);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
        agent
      });
      showToast(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, 'error');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
  };

  const handleTransformSelection = async (selectedText: string, instruction: string, agent: AgentType) => {
    setIsAnalyzing(true);
    const plainText = (editorRef.current?.getPlainText() || stripHtml(content));
    try {
      const transformed = await transformWithInstruction(selectedText, instruction, plainText, aiSettings);
      const span = findTextSpan(plainText, selectedText);
      const suggestion: Suggestion = {
        id: `suggestion-transform-${Date.now()}`,
        originalText: span?.matchedText ?? selectedText,
        suggestedText: transformed,
        explanation: instruction,
        agent,
        startIndex: span?.start ?? 0,
        endIndex: span?.end ?? selectedText.length,
        severity: 'major',
        category: 'clarity',
        section: 'Transform',
      };
      addSuggestions([suggestion]);
      openTab('suggestions');
      showToast('Suggestion ready — review in Suggestions tab', 'success');
    } catch (error) {
      showToast(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRewriteSection = async (selectedText: string) => {
    setIsAnalyzing(true);
    const plainText = (editorRef.current?.getPlainText() || stripHtml(content));
    try {
      const rewritten = await rewriteSection(selectedText, plainText, aiSettings);
      const span = findTextSpan(plainText, selectedText);
      const suggestion: Suggestion = {
        id: `suggestion-rewrite-${Date.now()}`,
        originalText: span?.matchedText ?? selectedText,
        suggestedText: rewritten,
        explanation: 'AI rewrite — improved clarity, flow, and scientific impact while preserving meaning.',
        agent: 'editor',
        startIndex: span?.start ?? 0,
        endIndex: span?.end ?? selectedText.length,
        severity: 'major',
        category: 'clarity',
        section: 'Rewrite',
      };
      addSuggestions([suggestion]);
      openTab('suggestions');
      highlight(suggestion.id);
      setTimeout(() => highlight(null), 2000);
      showToast('Rewrite suggestion ready — accept or reject in Review tab', 'success');
    } catch (error) {
      showToast(`Rewrite failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const selected = () => editorRef.current?.getSelectedText() ?? '';

  /** Look up alternatives for a one- or two-word selection. */
  const handleSynonyms = useCallback(async () => {
    const word = selected().trim();
    const n = word ? word.split(/\s+/).length : 0;
    if (n < 1 || n > 2) return;
    setThesaurus({ word, synonyms: [], loading: true });
    try {
      const synonyms = await getThesaurus(word, aiSettings);
      setThesaurus(t => (t && t.word === word ? { word, synonyms, loading: false } : t));
    } catch {
      setThesaurus(t => (t && t.word === word ? { word, synonyms: [], loading: false } : t));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSettings]);

  const replaceWithSynonym = (synonym: string) => {
    if (editorRef.current?.replaceSelection(synonym)) setThesaurus(null);
  };

  return { thesaurus, clearThesaurus: () => setThesaurus(null), handleSynonyms, replaceWithSynonym, handleSearchSimilar, handleVerifyClaim, handleSelectionQuery, handleTransformSelection, handleRewriteSection, selected };
}
