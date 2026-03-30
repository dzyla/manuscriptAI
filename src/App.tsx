import { useState, useCallback, useRef, useEffect, useMemo, createElement } from 'react';
import Editor, { EditorRef } from './components/Editor';
import Sidebar from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import PostDraftingView from './components/PostDraftingView';
import VersionHistoryPopup from './components/VersionHistoryPopup';
import { AgentType, Message, Suggestion, HistoryItem, AISettings, ManuscriptSource, AttachedImage, VersionSnapshot } from './types';
import { searchSimilarManuscripts } from './services/manuscriptSearch';
import { expandCitationNums, formatCitationGroup, mergeAdjacentCitations } from './services/citations';
import { analyzeText, chatWithAgent, chatWithManuscript, resolveConflicts, runJudgeAgent, rebutSuggestion, manuscriptSummary, rewriteSection, transformWithInstruction, analyzeSourceAgainstManuscript, verifyClaimAgainstSources, AGENT_INFO, AGENT_ICONS, estimateTokens } from './services/ai';
import { Sparkles, FileText, Settings, Download, Keyboard, Eye, Moon, Sun, ChevronDown, FilePlus, Coins, BookOpen, Github, Square } from 'lucide-react';
import { saveAs } from 'file-saver';
import * as mammoth from 'mammoth';
import TurndownService from 'turndown';
import { useDocumentStore } from './stores/useDocumentStore';
import { useAIStore } from './stores/useAIStore';
import { useSourceStore } from './stores/useSourceStore';
import { db } from './db/manuscriptDb';
import { migrateLegacyCitations } from './utils/migrateCitations';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function AgentIcon({ agent, size = 12 }: { agent: AgentType; size?: number }) {
  const info = AGENT_INFO[agent];
  const IconComponent = AGENT_ICONS[info?.iconName];
  if (!IconComponent) return null;
  return createElement(IconComponent, { size });
}

export default function App() {
  // ─── Zustand stores ────────────────────────────────────────────────────────
  const {
    title, content, saveState, citationRegistry,
    setTitle, setContent, setSaveState,
    insertCitation: storeInsertCitation,
    removeCitation: storeRemoveCitation,
    renumberCitations: storeRenumberCitations,
    resetDocument, persist: persistDocument, initialize: initDocument,
  } = useDocumentStore();

  const {
    aiSettings, isAnalyzing, suggestions, messages, history, analysisProgress,
    setAiSettings, setIsAnalyzing, setAnalysisProgress,
    addSuggestions, setSuggestions, removeSuggestion, clearSuggestions, updateSuggestion,
    addMessage, setMessages, updateMessageSuggestions,
    addHistoryItem, removeHistoryItem, setHistory,
    initialize: initAI,
    persistSuggestions, persistMessages, persistHistory,
  } = useAIStore();

  const {
    sources, pendingApiSources,
    setPendingApiSources, clearPendingApiSources,
    initialize: initSources, persist: persistSources,
    clearSources,
  } = useSourceStore();

  // ─── Refs (imperative handles, not shared state) ───────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorRef>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ─── UI-only state (stays local, not in stores) ────────────────────────────
  const [clearSourcesTrigger, setClearSourcesTrigger] = useState(0);
  const [highlightedSuggestionId, setHighlightedSuggestionId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPostDraftingOpen, setIsPostDraftingOpen] = useState(false);
  const [isDistractionFree, setIsDistractionFree] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showAnalyzeMenu, setShowAnalyzeMenu] = useState(false);
  const analyzeMenuRef = useRef<HTMLDivElement>(null);
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'suggestions' | 'history' | 'sources' | 'outline'>('chat');
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [zoom, setZoom] = useState(100);
  const [editorWidth, setEditorWidth] = useState<'normal' | 'wide' | 'full'>('normal');
  const [currentAgent, setCurrentAgent] = useState<AgentType>('manager');
  const [pendingDownloadFormat, setPendingDownloadFormat] = useState<'md' | 'docx' | 'json' | 'tex' | null>(null);

  // Resize handler for Sidebar
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      setSidebarWidth(Math.min(Math.max(startWidth + delta, 280), 800));
    };
    
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  // Dark mode
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);
  useEffect(() => {
    const saved = localStorage.getItem('manuscript-dark-mode');
    if (saved === 'true') setDarkMode(true);
  }, []);
  useEffect(() => {
    localStorage.setItem('manuscript-dark-mode', String(darkMode));
  }, [darkMode]);

  // Close analyze menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (analyzeMenuRef.current && !analyzeMenuRef.current.contains(e.target as Node)) {
        setShowAnalyzeMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Token count
  const tokenCount = useMemo(() => {
    const plainText = stripHtml(content);
    return estimateTokens(plainText);
  }, [content]);

  const showToast = useCallback((message: string, type: 'success' | 'info' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // Initialize all stores on mount (loads from Dexie, migrating from localforage if needed)
  useEffect(() => {
    Promise.all([initDocument(), initAI(), initSources()]).then(() => {
      // After loading, apply citation migration to content if needed
      const { content: loadedContent, citationRegistry: reg } = useDocumentStore.getState();
      if (Object.keys(reg).length > 0 && !loadedContent.includes('data-citation-node')) {
        const migrated = migrateLegacyCitations(loadedContent, reg);
        if (migrated !== loadedContent) {
          useDocumentStore.getState().setContent(migrated);
          editorRef.current?.setContent(migrated);
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save every 30s to Dexie (granular — only changed tables are written)
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        await persistDocument();
        await persistSuggestions();
        await persistMessages();
        await persistHistory();
        await persistSources();
        if (saveState === 'Draft') setSaveState('Auto-saved');
      } catch (e) {
        showToast('Auto-save failed. Use "Save Workspace" to download a backup file.', 'error');
      }
    }, 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleDownload('json');
        setSaveState('Saved');
        showToast('Workspace saved', 'success');
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        handleAnalyze();
      }
      if (e.key === '?' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewManuscript = async () => {
    if (content.replace(/<[^>]*>/g, '').trim().length > 20) {
      if (!window.confirm('Start a new manuscript? Any unsaved changes will be lost.')) return;
    }
    const newContent = '<h2>Abstract</h2><p></p><h2>Introduction</h2><p></p><h2>Methods</h2><p></p><h2>Results</h2><p></p><h2>Discussion</h2><p></p><h2>Conclusion</h2><p></p>';

    // Reset all stores
    resetDocument();
    useAIStore.getState().setSuggestions([]);
    useAIStore.getState().setHistory([]);
    useAIStore.getState().setMessages([
      { id: Date.now().toString(), role: 'assistant', content: 'New manuscript started with IMRAD template! Begin writing in each section, then click "Analyze All" for AI feedback.', agent: 'manager' }
    ]);
    clearPendingApiSources();
    clearSources();
    setClearSourcesTrigger(n => n + 1);

    // Clear Dexie tables
    await db.documents.delete('current');
    await db.sources.clear();
    await db.suggestions.clear();
    await db.chatHistory.clear();
    await db.historyItems.clear();

    // Set new content after reset
    setContent(newContent);
    editorRef.current?.setContent(newContent);

    showToast('New manuscript created', 'success');
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
    setShowAnalyzeMenu(false);
    try {
      // Get the latest text directly from the editor
      const htmlContent = editorRef.current?.getHTML() || content;
      const plainText = stripHtml(htmlContent);

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

        if (result.status === 'parsing_failed') {
          showToast(`⚠ ${AGENT_INFO[specificAgent].label}: Response wasn't valid JSON. Try a larger model or cloud API.`, 'error');
        } else if (result.status === 'no_suggestions') {
          showToast(`${AGENT_INFO[specificAgent].label} found no issues — nice work!`, 'info');
        }

        if (result.suggestions.length > 0) {
          const resolved = await resolveConflicts(result.suggestions, aiSettings);
          addSuggestions(resolved);
          showToast(`${resolved.length} suggestions from ${AGENT_INFO[specificAgent].label}`, 'success');
        }
      } else {
        // Run all agents in parallel
        const agentsToRun: AgentType[] = ['editor', 'reviewer-2', 'researcher'];
        setAnalysisProgress({ agent: 'Running all agents in parallel...', total: agentsToRun.length, done: 0 });

        const results = await Promise.all(
          agentsToRun.map(agent => analyzeText(plainText, agent, aiSettings, suggestions, undefined, htmlContent, signal))
        );
        
        let totalNew = 0;
        let combinedSuggestions: Suggestion[] = [];
        let failures: string[] = [];
        let zeroes: string[] = [];

        results.forEach((res, idx) => {
          if (res.status === 'parsing_failed') failures.push(AGENT_INFO[agentsToRun[idx]].label);
          else if (res.status === 'no_suggestions') zeroes.push(AGENT_INFO[agentsToRun[idx]].label);
          combinedSuggestions = [...combinedSuggestions, ...res.suggestions];
        });

        if (combinedSuggestions.length > 0) {
          const resolved = await resolveConflicts(combinedSuggestions, aiSettings);
          addSuggestions(resolved);
          totalNew = resolved.length;
          // Run judge agent in the background to remove overlapping lower-impact suggestions
          const resolvedIds = new Set(resolved.map(s => s.id));
          runJudgeAgent(resolved, aiSettings).then(judged => {
            if (judged.length < resolved.length) {
              const judgedIds = new Set(judged.map(s => s.id));
              setSuggestions(useAIStore.getState().suggestions.filter(s => !resolvedIds.has(s.id) || judgedIds.has(s.id)));
              showToast(`Judge selected ${judged.length} best suggestions (${resolved.length - judged.length} overlapping removed)`, 'info');
            }
          }).catch(() => {});
        }

        // Provide clear feedback
        const msgs: string[] = [];
        if (totalNew > 0) msgs.push(`${totalNew} suggestions found`);
        if (failures.length > 0) msgs.push(`JSON parse failed: ${failures.join(', ')}`);
        if (zeroes.length > 0 && totalNew === 0) msgs.push(`No issues found by: ${zeroes.join(', ')}`);
        
        if (failures.length > 0) {
          showToast(msgs.join(' · '), 'error');
        } else if (totalNew > 0) {
          showToast(msgs.join(' · '), 'success');
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

  const handleSendMessage = async (text: string, agent: AgentType, attachedSources?: Array<{ name: string; text: string }>, images?: AttachedImage[]) => {
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text, images };
    addMessage(userMsg);

    // Resolve manuscript scope: __full__ sends full text, __section__ sends current section only
    const fullText = stripHtml(editorRef.current?.getHTML() || content);
    const extraSources = (attachedSources || []).filter(s => s.name !== '__full__' && s.name !== '__section__');

    const hasFullScope   = attachedSources?.some(s => s.name === '__full__');
    const hasSectionScope = attachedSources?.some(s => s.name === '__section__');
    const sectionText = hasSectionScope ? editorRef.current?.getCurrentSectionText() : null;
    const sectionTitle = hasSectionScope ? editorRef.current?.getCurrentSection() : null;

    // Build the manuscript context to pass as the primary text argument
    let manuscriptArg = fullText; // default: always send full (for agent context)
    const sourcesWithContext: Array<{ name: string; text: string }> = [...extraSources];

    if (hasSectionScope && sectionText) {
      sourcesWithContext.unshift({ name: `Section: ${sectionTitle ?? 'Current'}`, text: sectionText });
    } else if (hasFullScope || (!hasFullScope && !hasSectionScope)) {
      sourcesWithContext.unshift({ name: 'Full Manuscript', text: fullText });
    }

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    setIsAnalyzing(true);
    try {
      const result = agent === 'manuscript-ai'
        ? await chatWithManuscript(text, manuscriptArg, aiSettings, sourcesWithContext.length > 0 ? sourcesWithContext : undefined, images, signal)
        : await chatWithAgent(text, manuscriptArg, agent, aiSettings, sourcesWithContext.length > 0 ? sourcesWithContext : undefined, images, signal);
      const suggestions: Suggestion[] | undefined = 'suggestions' in result ? (result as any).suggestions : undefined;
      const newSugs: Suggestion[] | undefined = 'suggestions' in result ? (result as any).suggestions : undefined;
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.text || "I couldn't process that request. Check your LLM connection.",
        agent,
        suggestions: newSugs,
      };
      addMessage(assistantMsg);
      if (newSugs && newSugs.length > 0) {
        const resolved = await resolveConflicts(newSugs, aiSettings);
        addSuggestions(resolved);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') return; // stopped by user
      console.error("Chat failed", error);
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to reach LLM'}`,
        agent
      });
    } finally {
      abortRef.current = null;
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeImage = (dataUrl: string, prompt: string, contextText?: string) => {
    const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!match) return;
    const rawMime = match[1];
    const allowed: AttachedImage['mimeType'][] = ['image/jpeg', 'image/png', 'image/webp'];
    const mimeType: AttachedImage['mimeType'] = allowed.includes(rawMime as AttachedImage['mimeType'])
      ? (rawMime as AttachedImage['mimeType'])
      : 'image/png';
    const base64 = match[2];
    const img: AttachedImage = { id: Date.now().toString(), name: 'figure', base64, mimeType, dataUrl };
    const fullPrompt = contextText?.trim()
      ? `${prompt}\n\nContext from the manuscript around this figure:\n"""\n${contextText.trim()}\n"""`
      : prompt;
    handleSendMessage(fullPrompt, 'manuscript-ai', undefined, [img]);
    setSidebarTab('chat');
  };

  const handleAnalyzeSection = async (sectionText: string, sectionTitle: string) => {
    // Special sentinel: bibliography insertion from the Sources tab
    if (sectionTitle === '__bibliography__') {
      const currentHtml = editorRef.current?.getHTML() || content;
      editorRef.current?.setContent(currentHtml + sectionText);
      setContent(currentHtml + sectionText);
      showToast('Bibliography appended to manuscript', 'success');
      return;
    }
    setSidebarTab('chat');
    // If called from the Outline tab (no text), extract text from the editor
    const textToAnalyze = sectionText || (() => {
      const html = editorRef.current?.getHTML() || content;
      const h2Re = /<h2[^>]*>(.*?)<\/h2>/gi;
      const matches = [...html.matchAll(h2Re)];
      const idx = matches.findIndex(m => m[1].replace(/<[^>]*>/g, '').trim() === sectionTitle);
      if (idx === -1) return stripHtml(html);
      const start = (matches[idx].index ?? 0) + matches[idx][0].length;
      const end = idx + 1 < matches.length ? (matches[idx + 1].index ?? html.length) : html.length;
      return html.slice(start, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    })();

    const userMsg: Message = {
      id: Date.now().toString(), role: 'user',
      content: `Analyze the "${sectionTitle}" section for clarity, scientific rigor, and flow.`,
    };
    addMessage(userMsg);
    setIsAnalyzing(true);
    try {
      const result = await chatWithManuscript(
        `Analyze the "${sectionTitle}" section in detail. Focus on: clarity, scientific rigor, logical flow, and any specific weaknesses. Be concrete and actionable.`,
        `[Section: ${sectionTitle}]\n\n${textToAnalyze}`,
        aiSettings,
      );
      addMessage({ id: (Date.now() + 1).toString(), role: 'assistant', content: result.text, agent: 'manuscript-ai' as AgentType });
    } catch (err) {
      console.error('Section analysis failed', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleInsertCitation = (sourceId: string): number => {
    return storeInsertCitation(sourceId);
  };

  const renumberCitations = useCallback(() => {
    const html = editorRef.current?.getHTML();
    if (!html) return;
    const { newHtml } = storeRenumberCitations(html);
    if (newHtml !== html) {
      editorRef.current?.setContent(newHtml);
      setContent(newHtml);
    }
  }, [storeRenumberCitations, setContent]);

  const removeCitation = useCallback((sourceId: string) => {
    const html = editorRef.current?.getHTML() || '';
    const { newHtml } = storeRemoveCitation(sourceId, html);
    if (newHtml !== html) {
      editorRef.current?.setContent(newHtml);
      setContent(newHtml);
    }
  }, [storeRemoveCitation, setContent]);

  const handleScrollToCitation = useCallback((num: number) => {
    editorRef.current?.scrollToCitation(num);
  }, []);

  const handleSearchSimilar = (text: string) => {
    const query = text.trim();
    if (query.length < 3) {
      showToast('Select at least a few words to search for similar manuscripts.', 'info');
      return;
    }
    setSidebarTab('sources');
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
      setSidebarTab('sources');
      return;
    }
    setSidebarTab('chat');
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

  const handleAcceptSuggestion = (suggestion: Suggestion) => {
    const syncedOldContent = editorRef.current?.getHTML() || content;
    const handledByEditor = editorRef.current?.applySuggestion(suggestion.originalText, suggestion.suggestedText);

    if (!handledByEditor) {
      // Fallback: try raw HTML replacement
      const newContent = content.replace(suggestion.originalText, suggestion.suggestedText);
      if (newContent !== content) {
        setContent(newContent);
      } else {
        showToast('Could not find the text to replace. It may have been edited.', 'info');
      }
    }

    const newContent = editorRef.current?.getHTML() || content;
    addHistoryItem({
      id: Date.now().toString(),
      timestamp: Date.now(),
      oldContent: syncedOldContent,
      newContent,
      originalText: suggestion.originalText,
      suggestedText: suggestion.suggestedText,
      suggestionId: suggestion.id,
      agent: suggestion.agent,
    });

    removeSuggestion(suggestion.id);
  };

  const handleAcceptAll = () => {
    const currentSuggestions = [...suggestions];
    for (const s of currentSuggestions) {
      handleAcceptSuggestion(s);
    }
    showToast(`${currentSuggestions.length} suggestions accepted`, 'success');
  };

  const handleRejectAll = () => {
    clearSuggestions();
    showToast('All suggestions cleared', 'info');
  };

  const handleRejectSuggestion = (suggestion: Suggestion) => {
    removeSuggestion(suggestion.id);
  };

  const handleRebuttal = async (suggestionId: string, feedback: string) => {
    const suggestion = suggestions.find(s => s.id === suggestionId);
    if (!suggestion) return;
    setIsAnalyzing(true);
    try {
      const plainText = stripHtml(editorRef.current?.getHTML() || content);
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

  const handleRevertHistory = (historyId: string) => {
    const item = history.find(h => h.id === historyId);
    if (item) {
      const handledByEditor = editorRef.current?.revertSuggestion(item.originalText, item.suggestedText);
      if (!handledByEditor) {
        setContent(item.oldContent);
        editorRef.current?.setContent(item.oldContent);
      }
      removeHistoryItem(historyId);
      showToast('Change reverted', 'info');
    }
  };

  // Handle selection-based agent query from the editor BubbleMenu
  const handleSelectionQuery = async (selectedText: string, instruction: string, agent: AgentType) => {
    setIsAnalyzing(true);
    const fullText = stripHtml(editorRef.current?.getHTML() || content);
    
    // Switch sidebar to chat to show the reply
    setSidebarTab('chat');
    
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
    const plainText = stripHtml(editorRef.current?.getHTML() || content);
    try {
      const transformed = await transformWithInstruction(selectedText, instruction, plainText, aiSettings);
      const suggestion: Suggestion = {
        id: `suggestion-transform-${Date.now()}`,
        originalText: selectedText,
        suggestedText: transformed,
        explanation: instruction,
        agent,
        startIndex: plainText.indexOf(selectedText),
        endIndex: plainText.indexOf(selectedText) + selectedText.length,
        severity: 'major',
        category: 'clarity',
        section: 'Transform',
      };
      addSuggestions([suggestion]);
      setSidebarTab('suggestions');
      showToast('Suggestion ready — review in Suggestions tab', 'success');
    } catch (error) {
      showToast(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRewriteSection = async (selectedText: string) => {
    setIsAnalyzing(true);
    const plainText = stripHtml(editorRef.current?.getHTML() || content);
    try {
      const rewritten = await rewriteSection(selectedText, plainText, aiSettings);
      const suggestion: Suggestion = {
        id: `suggestion-rewrite-${Date.now()}`,
        originalText: selectedText,
        suggestedText: rewritten,
        explanation: 'AI rewrite — improved clarity, flow, and scientific impact while preserving meaning.',
        agent: 'editor',
        startIndex: plainText.indexOf(selectedText),
        endIndex: plainText.indexOf(selectedText) + selectedText.length,
        severity: 'major',
        category: 'clarity',
        section: 'Rewrite',
      };
      addSuggestions([suggestion]);
      setSidebarTab('suggestions');
      setHighlightedSuggestionId(suggestion.id);
      setTimeout(() => setHighlightedSuggestionId(null), 2000);
      showToast('Rewrite suggestion ready — accept or reject in Review tab', 'success');
    } catch (error) {
      showToast(`Rewrite failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeSource = async (analysisText: string, sourceName: string) => {
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: `Compare reference paper "${sourceName}" against my manuscript`,
    };
    const assistantMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: analysisText,
      agent: 'literature-reviewer',
    };
    addMessage(userMsg);
    addMessage(assistantMsg);
    setSidebarTab('chat');
    showToast(`Literature analysis of "${sourceName}" ready`, 'success');
  };

  // Manuscript Summary & Big Gaps — high-level review
  const handleManuscriptSummary = async () => {
    setIsAnalyzing(true);
    setSidebarTab('chat');
    setAnalysisProgress({ agent: 'Generating manuscript summary...', total: 1, done: 0 });
    
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: 'Please provide a comprehensive manuscript summary and identify the biggest gaps.'
    };
    addMessage(userMsg);

    try {
      const plainText = stripHtml(editorRef.current?.getHTML() || content);

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

  const doDownload = async (format: 'md' | 'docx' | 'json' | 'tex') => {
    const currentContent = editorRef.current?.getHTML() || content;
    if (format === 'md') {
      const turndownService = new TurndownService();
      const markdown = turndownService.turndown(currentContent);
      saveAs(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${title.replace(/\s+/g, '_')}.md`);
    } else if (format === 'docx') {
      saveAs(new Blob([currentContent], { type: 'application/msword' }), `${title.replace(/\s+/g, '_')}.doc`);
    } else if (format === 'tex') {
      setIsAnalyzing(true);
      showToast('Converting to LaTeX...', 'info');
      try {
        const turndownService = new TurndownService();
        const markdown = turndownService.turndown(currentContent);
        // Fallback to simple LLM conversion to avoid heavy pandoc-wasm dependency
        const { chatWithAgent } = await import('./services/ai');
        const prompt = "Convert the following academic manuscript (Markdown) into a clean, well-structured LaTeX document suitable for a generic academic journal. Include a preamble with standard packages (article class, geometry, graphicx, hyperref). Put the title as '"+title+"'. Ensure all sections, bolding, italics, and lists are properly converted. Return ONLY the raw LaTeX code, starting with \\documentclass and ending with \\end{document}.";
        const result = await chatWithAgent(prompt, markdown, 'editor', aiSettings);
        let tex = result.text.replace(/```(latex|tex)?\n/g, '').replace(/\n```/g, '');
        saveAs(new Blob([tex], { type: 'application/x-tex' }), `${title.replace(/\s+/g, '_')}.tex`);
        showToast('LaTeX conversion complete', 'success');
      } catch (err) {
        showToast('LaTeX conversion failed', 'error');
        console.error(err);
      } finally {
        setIsAnalyzing(false);
      }
    } else {
      const exportedSources = await db.sources.toArray().catch(() => []);
      // Strip API keys before export — never serialize credentials into a shareable file
      const { geminiApiKey: _g, openaiApiKey: _o, anthropicApiKey: _a, localApiKey: _l, ...safeSettings } = aiSettings;
      const workspace = { title, content: currentContent, suggestions, history, messages, aiSettings: safeSettings, sources: exportedSources };
      saveAs(new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }), 'workspace.json');
      setSaveState('Saved');
    }
  };

  const handleDownload = async (format: 'md' | 'docx' | 'json' | 'tex') => {
    if (format !== 'json') {
      setPendingDownloadFormat(format);
      return;
    }
    await doDownload(format);
  };

  const handleLoadWorkspace = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.content !== undefined) {
          const reg: Record<string, number> = data.citationRegistry || {};
          // Apply citation migration if the content has legacy [N] patterns
          let loadedContent = data.content;
          if (Object.keys(reg).length > 0 && !loadedContent.includes('data-citation-node')) {
            loadedContent = migrateLegacyCitations(loadedContent, reg);
          }
          setTitle(data.title || 'Untitled Manuscript');
          setContent(loadedContent);
          setSuggestions(data.suggestions || []);
          setHistory(data.history || []);
          setMessages(data.messages && data.messages.length > 0 ? data.messages : useAIStore.getState().messages);
          if (data.aiSettings) setAiSettings(data.aiSettings);
          if (data.sources?.length) {
            useSourceStore.getState().setSources(data.sources);
            await useSourceStore.getState().persist();
          }
          setSaveState('Saved');
          editorRef.current?.setContent(loadedContent);
          // Persist to Dexie
          await persistDocument();
          showToast('Workspace loaded', 'success');
        }
      } catch (err) {
        console.error("Invalid workspace file", err);
        showToast('Failed to load workspace file', 'error');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSuggestionClick = (suggestionId: string) => {
    setHighlightedSuggestionId(suggestionId);
    setTimeout(() => setHighlightedSuggestionId(null), 1500);
  };

  const handleRestoreSnapshot = (snapshot: VersionSnapshot) => {
    setTitle(snapshot.title);
    setContent(snapshot.content);
    editorRef.current?.setContent(snapshot.content);
    showToast(`Restored snapshot: "${snapshot.name}"`, 'success');
    setSidebarTab('chat');
  };

  const wordCount = stripHtml(content).split(/\s+/).filter(w => w.length > 0).length;

  return (
    <div className="flex h-screen w-screen overflow-hidden font-sans" style={{ background: 'var(--surface-0)', color: 'var(--text-primary)' }}>
      {/* Left Rail */}
      {!isDistractionFree && (
        <div className="w-14 flex flex-col items-center py-5 space-y-5 shrink-0" style={{ borderRight: '1px solid var(--border)', background: 'var(--surface-1)' }}>
          <div className="relative group">
            <div className="w-9 h-9 bg-stone-900 rounded-xl flex items-center justify-center text-white shadow-sm cursor-pointer" title="Manuscript AI Editor">
              <FileText size={16} />
            </div>
            <div className="absolute left-full ml-2 top-0 border rounded-xl shadow-xl hidden group-hover:block z-50 p-3" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', width: '260px' }}>
              <div className="space-y-2">
                <div>
                  <p className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Manuscript AI Editor</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>VC by Dawid Zyla · github.com/dzyla/manuscriptAI</p>
                </div>
                <div className="border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-semibold">AI tools assist, not decide.</span> All AI suggestions may contain errors, hallucinations, or scientifically incorrect statements. The researcher is solely responsible for verifying correctness, ensuring scientific accuracy, and maintaining the integrity of the manuscript. Use these tools to brainstorm and improve — always apply your expert judgment.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col items-center space-y-3">
            <button onClick={handleNewManuscript} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title="New Manuscript" style={{ color: 'var(--text-muted)' }}>
              <FilePlus size={18} />
            </button>

            <div className="relative group">
              <button className="p-2 rounded-lg transition-colors hover:bg-stone-100" style={{ color: 'var(--text-muted)' }}>
                <Download size={18} />
              </button>
              <div className="absolute left-full ml-2 top-0 border rounded-xl shadow-xl hidden group-hover:block z-50 p-1.5 min-w-[200px]" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                <button onClick={() => fileInputRef.current?.click()} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg font-bold" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', marginBottom: '4px', paddingBottom: '8px' }}>
                  Load Document (.json, .docx, .md, .txt)
                </button>
                <button onClick={() => handleDownload('md')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>Export Markdown</button>
                <button onClick={() => handleDownload('docx')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>Export Word</button>
                <button onClick={() => handleDownload('tex')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>AI Convert to LaTeX</button>
                <button onClick={() => handleDownload('json')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg font-medium" style={{ color: 'var(--text-primary)' }}>Save Workspace</button>
              </div>
              <input type="file" ref={fileInputRef} onChange={handleLoadWorkspace} accept=".json,.docx,.md,.txt" className="hidden" />
            </div>

            <button onClick={() => setIsPostDraftingOpen(true)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title="Post-Drafting: Rebuttal & Cover Letter" style={{ color: 'var(--text-muted)' }}>
              <BookOpen size={18} />
            </button>

            <button onClick={() => setShowShortcuts(!showShortcuts)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title="Keyboard Shortcuts" style={{ color: 'var(--text-muted)' }}>
              <Keyboard size={18} />
            </button>

            <button onClick={() => setDarkMode(!darkMode)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title={darkMode ? 'Light Mode' : 'Dark Mode'} style={{ color: 'var(--text-muted)' }}>
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>

          </div>
          
          <div className="flex flex-col items-center space-y-3 pb-2">
            <a href="https://github.com/dzyla/manuscriptAI" target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg transition-colors hover:bg-stone-100 flex flex-col items-center gap-0.5 opacity-70 hover:opacity-100" style={{ color: 'var(--text-muted)' }} title="VC by Dawid Zyla — github.com/dzyla/manuscriptAI">
              <Github size={18} />
              <span className="text-[8px] font-semibold leading-[1]" style={{ color: 'var(--text-muted)' }}>VC by</span>
              <span className="text-[8px] font-semibold leading-[1]" style={{ color: 'var(--text-muted)' }}>D. Zyla</span>
            </a>
            <div className="w-9 flex flex-col items-center gap-0.5 text-center opacity-60 hover:opacity-100 cursor-default" title="AI may make mistakes. Researcher is responsible for scientific correctness.">
              <span className="text-[6px] font-bold uppercase tracking-wider leading-tight text-center" style={{ color: 'var(--text-muted)', writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: '60px' }}>AI · Verify All</span>
            </div>
            <button onClick={() => setIsSettingsOpen(true)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" style={{ color: 'var(--text-muted)' }}>
              <Settings size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <header className="h-14 flex items-center justify-between px-4 sm:px-6 shrink-0 gap-2" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-1)' }}>
          <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => persistDocument()}
              className="text-sm font-semibold tracking-tight bg-transparent focus:outline-none focus:ring-1 rounded px-1.5 -mx-1.5 py-0.5 min-w-0 flex-shrink"
              style={{ color: 'var(--text-primary)', maxWidth: '200px' }}
              placeholder="Untitled Manuscript"
            />
            <span className={`text-[9px] px-2 py-0.5 rounded-md uppercase font-bold tracking-widest transition-colors shrink-0 ${
              saveState === 'Saved' ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' :
              saveState === 'Auto-saved' ? 'bg-blue-50 text-blue-500 border border-blue-200' :
              'text-stone-400 border'
            }`}
            style={saveState === 'Draft' ? { background: 'var(--surface-2)', borderColor: 'var(--border)' } : {}}
            >
              {saveState}
            </span>
            <VersionHistoryPopup
              currentTitle={title}
              currentContent={content}
              onRestore={handleRestoreSnapshot}
            />
            <span className="text-[11px] font-medium shrink-0 hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
              {wordCount} words
            </span>
            <div className="flex-1" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
                        {/* Zoom Controls */}
            <div className="hidden lg:flex items-center gap-1 rounded-lg p-1 mr-2" style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              <button
                onClick={() => setZoom(z => Math.max(50, z - 10))}
                className="px-1.5 rounded text-xs font-medium transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-1)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title="Zoom Out"
              >−</button>
              <span className="text-[10px] font-bold px-1 w-10 text-center" style={{ color: 'var(--text-primary)' }} title="Text Zoom">{zoom}%</span>
              <button
                onClick={() => setZoom(z => Math.min(200, z + 10))}
                className="px-1.5 rounded text-xs font-medium transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-1)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title="Zoom In"
              >+</button>
            </div>
            {/* Editor width toggle */}
            <div className="hidden lg:flex items-center gap-0.5 rounded-lg p-1 mr-1" style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              {(['normal', 'wide', 'full'] as const).map(w => (
                <button
                  key={w}
                  onClick={() => setEditorWidth(w)}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                  style={{
                    background: editorWidth === w ? 'var(--text-primary)' : 'transparent',
                    color: editorWidth === w ? 'var(--surface-1)' : 'var(--text-secondary)',
                  }}
                  title={`Editor width: ${w}`}
                >
                  {w === 'normal' ? '◫' : w === 'wide' ? '⬛' : '⬜'}
                </button>
              ))}
            </div>

            <button
              onClick={() => setIsDistractionFree(!isDistractionFree)}
              className={`p-2 rounded-lg transition-all ${isDistractionFree ? 'bg-stone-800 text-white' : 'hover:bg-stone-50'}`}
              title="Focus Mode"
              style={!isDistractionFree ? { color: 'var(--text-muted)' } : {}}
            >
              <Eye size={15} />
            </button>
            <div className="w-px h-6 hidden sm:block" style={{ background: 'var(--border)' }} />

            {/* Analyze button with dropdown */}
            <div className="relative" ref={analyzeMenuRef}>
              <div className="flex">
                {isAnalyzing ? (
                  <button
                    onClick={stopRequest}
                    className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-rose-600 text-white rounded-lg text-xs font-semibold hover:bg-rose-700 transition-all shadow-sm"
                  >
                    <Square size={12} className="fill-white" />
                    <span>Stop</span>
                  </button>
                ) : (
                  <>
                <button
                  onClick={() => handleAnalyze()}
                  disabled={isAnalyzing}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-stone-900 text-white rounded-l-lg text-xs font-semibold hover:bg-stone-800 transition-all disabled:opacity-40 shadow-sm"
                >
                  <Sparkles size={14} className={isAnalyzing ? 'animate-spin' : ''} />
                  <span className="hidden sm:inline">Analyze All</span>
                  <span className="sm:hidden">Analyze</span>
                </button>
                <button
                  onClick={() => setShowAnalyzeMenu(!showAnalyzeMenu)}
                  disabled={isAnalyzing}
                  className="px-2 py-2 bg-stone-900 text-white rounded-r-lg text-xs hover:bg-stone-800 transition-all disabled:opacity-40 shadow-sm border-l border-stone-700"
                >
                  <ChevronDown size={12} />
                </button>
                  </>
                )}
              </div>

              {showAnalyzeMenu && (
                <div className="absolute right-0 top-full mt-1 border rounded-xl shadow-xl z-50 p-1.5 min-w-[220px]" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                    Run Single Agent
                  </div>
                  {(Object.entries(AGENT_INFO) as [AgentType, typeof AGENT_INFO[AgentType]][])
                    .filter(([agentId]) => agentId !== 'literature-reviewer' && agentId !== 'manuscript-ai' && agentId !== 'citation-checker')
                    .map(([agentId, info]) => (
                      <button
                        key={agentId}
                        onClick={() => handleAnalyze(agentId)}
                        className="w-full text-left px-3 py-2 text-xs rounded-lg flex items-center gap-2 transition-colors hover:bg-stone-50"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <AgentIcon agent={agentId} size={14} />
                        <span className="font-medium">{info.label}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>

            {/* Summary & Gaps button */}
            <button
              onClick={handleManuscriptSummary}
              disabled={isAnalyzing}
              className="flex items-center gap-1.5 px-3 py-2 border rounded-lg text-xs font-semibold transition-all disabled:opacity-40 hover:bg-stone-50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              title="Generate a high-level manuscript review with strengths, weaknesses, and recommendations"
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">Summary & Gaps</span>
            </button>
          </div>
        </header>

        {/* Editor Area */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8" style={{ background: 'var(--surface-0)' }}>
          <Editor
            ref={editorRef}
            content={content}
            onChange={(html) => setContent(html)}
            suggestions={suggestions}
            onSuggestionClick={handleSuggestionClick}
            onSelectionQuery={handleSelectionQuery}
            onRewriteSection={handleRewriteSection}
            onTransformSelection={handleTransformSelection}
            onAnalyzeSection={handleAnalyzeSection}
            onVerifyClaim={handleVerifyClaim}
            onSearchSimilar={handleSearchSimilar}
            sources={sources}
            citationRegistry={citationRegistry}
            onInsertCitation={handleInsertCitation}
            isDistractionFree={isDistractionFree}
            editorZoom={zoom}
            editorWidth={editorWidth}
            currentAgent={currentAgent}
            aiSettings={aiSettings}
            onAnalyzeImage={handleAnalyzeImage}
          />
        </main>

        {/* Bottom status bar */}
        <div className="h-7 flex items-center justify-between px-4 text-[10px] font-medium shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-4">
            <span>{wordCount} words</span>
            <span>~{tokenCount.toLocaleString()} tokens</span>
            <span>{suggestions.length} suggestions</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Coins size={10} />
              {aiSettings.provider === 'local' ? 'Local' : aiSettings.provider === 'anthropic' ? 'Claude' : aiSettings.provider === 'openai' ? 'OpenAI' : 'Gemini'}
            </span>
            {aiSettings.provider === 'local' && <span className="truncate max-w-[120px]">{aiSettings.localModel}</span>}
          </div>
        </div>
      </div>

      {/* Sidebar — responsive width */}
      {!isDistractionFree && (
        <div className="shrink-0 relative h-full border-t md:border-t-0 md:border-l max-w-full flex flex-col" style={{ width: typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : `${sidebarWidth}px`, minWidth: '280px', borderColor: 'var(--border)' }}>
          {/* Drag handle */}
          <div 
            className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-col-resize transition-colors opacity-0 hover:opacity-50 z-50 hidden md:block"
            onMouseDown={handleMouseDown}
            style={{ backgroundColor: 'var(--accent-blue)' }}
          />
          <Sidebar
            suggestions={suggestions}
            messages={messages}
            history={history}
            onSendMessage={handleSendMessage}
            onAcceptSuggestion={handleAcceptSuggestion}
            onRejectSuggestion={handleRejectSuggestion}
            onRevertHistory={handleRevertHistory}
            onRebuttal={handleRebuttal}
            onSuggestionCardClick={(s) => editorRef.current?.scrollToSuggestion(s.originalText, s.id)}
            onHistoryItemClick={(item) => editorRef.current?.scrollToSuggestion(item.suggestedText || item.originalText, item.id)}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
            isAnalyzing={isAnalyzing}
            onStop={stopRequest}
            highlightedSuggestionId={highlightedSuggestionId}
            analysisProgress={analysisProgress}
            activeTabOverride={sidebarTab}
            onTabChange={setSidebarTab}
            onAgentChange={setCurrentAgent}
            manuscriptContent={stripHtml(content)}
            manuscriptHtml={content}
            onScrollToSection={(heading) => editorRef.current?.scrollToHeading(heading)}
            onAnalyzeSection={handleAnalyzeSection}
            onSourcesChange={() => {}} // sources managed by useSourceStore
            aiSettings={aiSettings}
            onAnalyzeSource={handleAnalyzeSource}
            contentZoom={zoom}
            externalApiSources={pendingApiSources.length ? pendingApiSources : undefined}
            onExternalSourcesMerged={clearPendingApiSources}
            clearSourcesTrigger={clearSourcesTrigger}
            citationRegistry={citationRegistry}
            onRenumberCitations={renumberCitations}
            onRemoveCitation={removeCitation}
            onScrollToCitation={handleScrollToCitation}
            documentHTML={content}
          />
        </div>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={aiSettings}
        onUpdateSettings={(s) => { setAiSettings(s); localStorage.setItem('manuscript-ai-settings', JSON.stringify(s)); }}
      />
      <PostDraftingView
        isOpen={isPostDraftingOpen}
        onClose={() => setIsPostDraftingOpen(false)}
        manuscriptText={stripHtml(content)}
        aiSettings={aiSettings}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[200]">
          <div className={`toast-enter px-4 py-2.5 rounded-xl text-xs font-medium shadow-lg border flex items-center gap-2 max-w-md ${
            toast.type === 'success' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
            toast.type === 'error' ? 'bg-rose-50 text-rose-700 border-rose-200' :
            'border-stone-200'
          }`}
          style={toast.type === 'info' ? { background: 'var(--surface-1)', color: 'var(--text-secondary)' } : {}}
          >
            {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'} {toast.message}
          </div>
        </div>
      )}

      {/* Export disclaimer modal */}
      {pendingDownloadFormat && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm" />
          <div className="relative rounded-2xl shadow-2xl p-6 max-w-sm w-full border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
            <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Before You Export</h3>
            <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text-secondary)' }}>
              AI tools assist in drafting and editing, but they can produce errors, hallucinations, or scientifically incorrect statements. By downloading this manuscript you confirm that:
            </p>
            <ul className="text-xs space-y-1.5 mb-5 list-none">
              {[
                'You have reviewed all AI-generated content for accuracy.',
                'You take sole responsibility for the scientific correctness and integrity of this work.',
                'AI suggestions are a starting point — not a substitute for expert judgment.',
              ].map(item => (
                <li key={item} className="flex items-start gap-2" style={{ color: 'var(--text-primary)' }}>
                  <span className="text-emerald-600 font-bold shrink-0">✓</span>{item}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingDownloadFormat(null)}
                className="flex-1 py-2 border rounded-xl text-xs font-semibold transition-colors hover:bg-stone-50"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => { const fmt = pendingDownloadFormat; setPendingDownloadFormat(null); await doDownload(fmt); }}
                className="flex-1 py-2 bg-stone-900 text-white rounded-xl text-xs font-semibold hover:bg-stone-800 transition-colors"
              >
                I Acknowledge — Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts modal */}
      {showShortcuts && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4" onClick={() => setShowShortcuts(false)}>
          <div className="absolute inset-0 bg-stone-900/30 backdrop-blur-sm" />
          <div className="relative rounded-2xl shadow-2xl p-6 max-w-sm w-full border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
            <h3 className="text-sm font-bold mb-4" style={{ color: 'var(--text-primary)' }}>Keyboard Shortcuts</h3>
            <div className="space-y-2 text-xs">
              {[
                ['Ctrl+S', 'Save workspace'],
                ['Ctrl+Shift+A', 'Analyze with all agents'],
                ['Ctrl+?', 'Toggle shortcuts'],
                ['Ctrl+B', 'Bold'],
                ['Ctrl+I', 'Italic'],
                ['Ctrl+U', 'Underline'],
              ].map(([key, desc]) => (
                <div key={key} className="flex justify-between items-center py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{desc}</span>
                  <kbd className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold border" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}>{key}</kbd>
                </div>
              ))}
            </div>
            <button onClick={() => setShowShortcuts(false)} className="mt-4 w-full py-2 bg-stone-800 text-white rounded-xl text-xs font-semibold hover:bg-stone-700 transition-colors">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
