import { useState, useCallback, useRef, useEffect, useMemo, createElement } from 'react';
import Editor, { EditorRef } from './components/Editor';
import Sidebar from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import { AgentType, Message, Suggestion, HistoryItem, AISettings } from './types';
import { analyzeText, chatWithAgent, resolveConflicts, rebutSuggestion, manuscriptSummary, AGENT_INFO, AGENT_ICONS, estimateTokens } from './services/ai';
import { Sparkles, FileText, Settings, Download, Keyboard, Eye, Moon, Sun, ChevronDown, FilePlus, Coins, BookOpen, Github } from 'lucide-react';
import { saveAs } from 'file-saver';
import TurndownService from 'turndown';

const AUTOSAVE_KEY = 'manuscript-ai-editor-autosave';

function AgentIcon({ agent, size = 12 }: { agent: AgentType; size?: number }) {
  const info = AGENT_INFO[agent];
  const IconComponent = AGENT_ICONS[info?.iconName];
  if (!IconComponent) return null;
  return createElement(IconComponent, { size });
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorRef>(null);
  const [title, setTitle] = useState('Untitled Manuscript');
  const [content, setContent] = useState('<p>Start writing your manuscript here, or click "New Manuscript" to begin with an IMRAD template.</p>');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'assistant', content: 'Welcome! I\'m your AI Manuscript Manager. Click "Analyze All" to get feedback from our specialized agents — Language Surgeon, Reviewer 2, and Clarity & Impact — or chat with any agent individually.', agent: 'manager' }
  ]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [highlightedSuggestionId, setHighlightedSuggestionId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDistractionFree, setIsDistractionFree] = useState(false);
  const [aiSettings, setAiSettings] = useState<AISettings>({
    provider: 'local',
    geminiApiKey: '',
    openaiApiKey: '',
    anthropicApiKey: '',
    geminiModel: 'gemini-3.1-pro-preview',
    openaiModel: 'gpt-5.4-mini',
    anthropicModel: 'claude-sonnet-4-6',
    localBaseUrl: 'http://localhost:1234/v1/chat/completions',
    localApiKey: '',
    localModel: 'local-model'
  });
  const [saveState, setSaveState] = useState<'Draft' | 'Saved' | 'Auto-saved'>('Draft');
  const [analysisProgress, setAnalysisProgress] = useState<{ agent: string; total: number; done: number } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [showAnalyzeMenu, setShowAnalyzeMenu] = useState(false);
  const analyzeMenuRef = useRef<HTMLDivElement>(null);
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'suggestions' | 'history'>('chat');
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [guiZoom, setGuiZoom] = useState(1);
  const [docZoom, setDocZoom] = useState(1);
  useEffect(() => {
    document.body.style.zoom = guiZoom.toString();
  }, [guiZoom]);

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
    const plainText = content.replace(/<[^>]*>/g, ' ').trim();
    return estimateTokens(plainText);
  }, [content]);

  const showToast = useCallback((message: string, type: 'success' | 'info' | 'error' = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // Auto-save every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      const workspace = { title, content, suggestions, history, messages, aiSettings };
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(workspace));
      if (saveState === 'Draft') setSaveState('Auto-saved');
    }, 30000);
    return () => clearInterval(interval);
  }, [title, content, suggestions, history, messages, aiSettings, saveState]);

  // Load auto-save on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.content) {
          setTitle(data.title || 'Untitled Manuscript');
          setContent(data.content);
          setSuggestions(data.suggestions || []);
          setHistory(data.history || []);
          setMessages(data.messages || []);
          if (data.aiSettings) setAiSettings(data.aiSettings);
          setSaveState('Auto-saved');
        }
      }
    } catch (err) {
      console.error("Failed to load auto-save", err);
    }
  }, []);

  useEffect(() => { setSaveState('Draft'); }, [content, title]);

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
  }, [content, title, suggestions, history, messages]);

  const handleNewManuscript = () => {
    if (content.replace(/<[^>]*>/g, '').trim().length > 20) {
      if (!window.confirm('Start a new manuscript? Any unsaved changes will be lost.')) return;
    }
    const newContent = '<h2>Abstract</h2><p></p><h2>Introduction</h2><p></p><h2>Methods</h2><p></p><h2>Results</h2><p></p><h2>Discussion</h2><p></p><h2>Conclusion</h2><p></p>';
    
    // Reset all state
    setTitle('Untitled Manuscript');
    setContent(newContent);
    setSuggestions([]);
    setHistory([]);
    setMessages([
      { id: Date.now().toString(), role: 'assistant', content: 'New manuscript started with IMRAD template! Begin writing in each section, then click "Analyze All" for AI feedback.', agent: 'manager' }
    ]);
    setSaveState('Draft');
    
    // Clear autosave so old content doesn't reload
    localStorage.removeItem(AUTOSAVE_KEY);
    
    // Force editor content reset
    editorRef.current?.setContent(newContent);
    
    showToast('New manuscript created', 'success');
  };

  const handleAnalyze = async (specificAgent?: AgentType) => {
    setIsAnalyzing(true);
    setShowAnalyzeMenu(false);
    try {
      // Get the latest text directly from the editor
      const currentHtml = editorRef.current?.getHTML() || content;
      const plainText = currentHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      
      if (plainText.length < 20) {
        showToast('Write some text first before analyzing.', 'info');
        setIsAnalyzing(false);
        return;
      }
      
      if (specificAgent) {
        setAnalysisProgress({ agent: AGENT_INFO[specificAgent].label, total: 1, done: 0 });
        const result = await analyzeText(plainText, specificAgent, aiSettings, suggestions, (msg) => {
          setAnalysisProgress(prev => prev ? { ...prev, agent: `${AGENT_INFO[specificAgent].label} — ${msg}` } : null);
        });
        
        if (result.status === 'parsing_failed') {
          showToast(`⚠ ${AGENT_INFO[specificAgent].label}: Response wasn't valid JSON. Try a larger model or cloud API.`, 'error');
        } else if (result.status === 'no_suggestions') {
          showToast(`${AGENT_INFO[specificAgent].label} found no issues — nice work!`, 'info');
        }
        
        if (result.suggestions.length > 0) {
          const resolved = await resolveConflicts(result.suggestions, aiSettings);
          setSuggestions(prev => [...prev, ...resolved].sort((a, b) => a.startIndex - b.startIndex));
          showToast(`${resolved.length} suggestions from ${AGENT_INFO[specificAgent].label}`, 'success');
        }
      } else {
        // Run all agents in parallel
        const agentsToRun: AgentType[] = ['editor', 'reviewer-2', 'researcher'];
        setAnalysisProgress({ agent: 'Running all agents in parallel...', total: agentsToRun.length, done: 0 });
        
        const results = await Promise.all(
          agentsToRun.map(agent => analyzeText(plainText, agent, aiSettings, suggestions))
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
          setSuggestions(prev => [...prev, ...resolved].sort((a, b) => a.startIndex - b.startIndex));
          totalNew = resolved.length;
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
    } catch (error) {
      console.error("Analysis failed", error);
      showToast(`Analysis error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
  };

  const handleSendMessage = async (text: string, agent: AgentType) => {
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);

    setIsAnalyzing(true);
    try {
      const plainText = (editorRef.current?.getHTML() || content).replace(/<[^>]*>/g, ' ');
      const result = await chatWithAgent(text, plainText, agent, aiSettings);
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.text || "I couldn't process that request. Check your LLM connection.",
        agent,
        suggestions: result.suggestions
      };
      setMessages(prev => [...prev, assistantMsg]);
      if (result.suggestions && result.suggestions.length > 0) {
        const resolved = await resolveConflicts(result.suggestions, aiSettings);
        setSuggestions(prev => [...prev, ...resolved].sort((a, b) => a.startIndex - b.startIndex));
      }
    } catch (error) {
      console.error("Chat failed", error);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to reach LLM'}`,
        agent
      }]);
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
    setHistory(prev => [...prev, {
      id: Date.now().toString(),
      timestamp: Date.now(),
      oldContent: syncedOldContent,
      newContent,
      originalText: suggestion.originalText,
      suggestedText: suggestion.suggestedText,
      suggestionId: suggestion.id,
      agent: suggestion.agent
    }]);

    setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
    setMessages(prev => prev.map(msg => ({
      ...msg,
      suggestions: msg.suggestions?.filter(s => s.id !== suggestion.id)
    })));
  };

  const handleAcceptAll = () => {
    // Accept one by one so each one finds the right text
    const currentSuggestions = [...suggestions];
    for (const s of currentSuggestions) {
      handleAcceptSuggestion(s);
    }
    showToast(`${currentSuggestions.length} suggestions accepted`, 'success');
  };

  const handleRejectAll = () => {
    setSuggestions([]);
    setMessages(prev => prev.map(msg => ({ ...msg, suggestions: [] })));
    showToast('All suggestions cleared', 'info');
  };

  const handleRejectSuggestion = (suggestion: Suggestion) => {
    setSuggestions(prev => prev.filter(s => s.id !== suggestion.id));
    setMessages(prev => prev.map(msg => ({
      ...msg,
      suggestions: msg.suggestions?.filter(s => s.id !== suggestion.id)
    })));
  };

  const handleRebuttal = async (suggestionId: string, feedback: string) => {
    const suggestion = suggestions.find(s => s.id === suggestionId);
    if (!suggestion) return;
    setIsAnalyzing(true);
    try {
      const plainText = (editorRef.current?.getHTML() || content).replace(/<[^>]*>/g, ' ');
      const newSugs = await rebutSuggestion(suggestion, feedback, plainText, aiSettings);
      if (newSugs?.length) {
        setSuggestions(prev => {
          const copy = [...prev];
          const idx = copy.findIndex(s => s.id === suggestionId);
          if (idx !== -1) copy[idx] = newSugs[0];
          return copy.sort((a, b) => a.startIndex - b.startIndex);
        });
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
      setHistory(prev => prev.filter(h => h.id !== historyId));
      showToast('Change reverted', 'info');
    }
  };

  // Handle selection-based agent query from the editor BubbleMenu
  const handleSelectionQuery = async (selectedText: string, instruction: string, agent: AgentType) => {
    setIsAnalyzing(true);
    const fullText = (editorRef.current?.getHTML() || content).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    
    // Switch sidebar to chat to show the reply
    setSidebarTab('chat');
    
    // Add to chat as user message
    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: `[Selected text]: "${selectedText.substring(0, 200)}${selectedText.length > 200 ? '...' : ''}"\n\n${instruction}`
    };
    setMessages(prev => [...prev, userMsg]);
    
    try {
      // Use chat for a richer, contextual response
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
      setMessages(prev => [...prev, assistantMsg]);
      
      if (chatResult.suggestions && chatResult.suggestions.length > 0) {
        const resolved = await resolveConflicts(chatResult.suggestions, aiSettings);
        setSuggestions(prev => [...prev, ...resolved].sort((a, b) => a.startIndex - b.startIndex));
        showToast(`${resolved.length} suggestions from ${AGENT_INFO[agent].label}`, 'success');
      }
    } catch (error) {
      console.error('Selection query failed:', error);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown'}`,
        agent
      }]);
      showToast(`Error: ${error instanceof Error ? error.message : 'Unknown'}`, 'error');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
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
    setMessages(prev => [...prev, userMsg]);
    
    try {
      const currentHtml = editorRef.current?.getHTML() || content;
      const plainText = currentHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      
      if (plainText.length < 50) {
        showToast('Write more text first for a meaningful summary.', 'info');
        setIsAnalyzing(false);
        setAnalysisProgress(null);
        return;
      }
      
      const summary = await manuscriptSummary(plainText, aiSettings);
      
      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: summary,
        agent: 'manager'
      };
      setMessages(prev => [...prev, assistantMsg]);
      showToast('Manuscript summary generated', 'success');
    } catch (error) {
      console.error('Summary failed:', error);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `Failed to generate summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
        agent: 'manager'
      }]);
      showToast('Summary generation failed', 'error');
    } finally {
      setIsAnalyzing(false);
      setAnalysisProgress(null);
    }
  };

  const handleDownload = (format: 'md' | 'docx' | 'json') => {
    const currentContent = editorRef.current?.getHTML() || content;
    if (format === 'md') {
      const turndownService = new TurndownService();
      const markdown = turndownService.turndown(currentContent);
      saveAs(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${title.replace(/\s+/g, '_')}.md`);
    } else if (format === 'docx') {
      saveAs(new Blob([currentContent], { type: 'application/msword' }), `${title.replace(/\s+/g, '_')}.doc`);
    } else {
      const workspace = { title, content: currentContent, suggestions, history, messages, aiSettings };
      saveAs(new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' }), 'workspace.json');
      setSaveState('Saved');
    }
  };

  const handleLoadWorkspace = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.content !== undefined) {
          setTitle(data.title || 'Untitled Manuscript');
          setContent(data.content);
          setSuggestions(data.suggestions || []);
          setHistory(data.history || []);
          setMessages(data.messages || []);
          if (data.aiSettings) setAiSettings(data.aiSettings);
          setSaveState('Saved');
          // Force editor reset
          editorRef.current?.setContent(data.content);
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

  const wordCount = content.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(w => w.length > 0).length;

  return (
    <div className="flex h-screen w-screen overflow-hidden font-sans" style={{ background: 'var(--surface-0)', color: 'var(--text-primary)' }}>
      {/* Left Rail */}
      {!isDistractionFree && (
        <div className="w-14 flex flex-col items-center py-5 space-y-5 shrink-0" style={{ borderRight: '1px solid var(--border)', background: 'var(--surface-1)' }}>
          <div className="w-9 h-9 bg-stone-900 rounded-xl flex items-center justify-center text-white shadow-sm">
            <FileText size={16} />
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
                  Load Workspace (.json)
                </button>
                <button onClick={() => handleDownload('md')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>Export Markdown</button>
                <button onClick={() => handleDownload('docx')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg" style={{ color: 'var(--text-secondary)' }}>Export Word</button>
                <button onClick={() => handleDownload('json')} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg font-medium" style={{ color: 'var(--text-primary)' }}>Save Workspace</button>
              </div>
              <input type="file" ref={fileInputRef} onChange={handleLoadWorkspace} accept=".json" className="hidden" />
            </div>

            <button onClick={() => setShowShortcuts(!showShortcuts)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title="Keyboard Shortcuts" style={{ color: 'var(--text-muted)' }}>
              <Keyboard size={18} />
            </button>

            <button onClick={() => setDarkMode(!darkMode)} className="p-2 rounded-lg transition-colors hover:bg-stone-100" title={darkMode ? 'Light Mode' : 'Dark Mode'} style={{ color: 'var(--text-muted)' }}>
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
          
          <div className="flex flex-col items-center space-y-3 pb-2">
            <a href="https://github.com/dzyla/manuscriptAI" target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg transition-colors hover:bg-stone-100 flex flex-col items-center gap-1 opacity-70 hover:opacity-100" style={{ color: 'var(--text-muted)' }} title="Developer: Dawid Zyla">
              <Github size={18} />
              <span className="text-[9px] font-medium leading-[1]" style={{ color: 'var(--text-muted)' }}>Dawid</span>
            </a>
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
            <span className="text-[11px] font-medium shrink-0 hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
              {wordCount} words
            </span>
            <div id="toolbar-portal" className="flex-1 flex justify-end min-w-0 overflow-hidden" />
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
                <button
                  onClick={() => handleAnalyze()}
                  disabled={isAnalyzing}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-stone-900 text-white rounded-l-lg text-xs font-semibold hover:bg-stone-800 transition-all disabled:opacity-40 shadow-sm"
                >
                  <Sparkles size={14} className={isAnalyzing ? 'animate-spin' : ''} />
                  <span className="hidden sm:inline">{isAnalyzing ? 'Analyzing...' : 'Analyze All'}</span>
                  <span className="sm:hidden">{isAnalyzing ? '...' : 'Analyze'}</span>
                </button>
                <button
                  onClick={() => setShowAnalyzeMenu(!showAnalyzeMenu)}
                  disabled={isAnalyzing}
                  className="px-2 py-2 bg-stone-900 text-white rounded-r-lg text-xs hover:bg-stone-800 transition-all disabled:opacity-40 shadow-sm border-l border-stone-700"
                >
                  <ChevronDown size={12} />
                </button>
              </div>

              {showAnalyzeMenu && (
                <div className="absolute right-0 top-full mt-1 border rounded-xl shadow-xl z-50 p-1.5 min-w-[220px]" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                    Run Single Agent
                  </div>
                  {(Object.entries(AGENT_INFO) as [AgentType, typeof AGENT_INFO[AgentType]][]).map(([agentId, info]) => (
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
            onChange={setContent}
            suggestions={suggestions}
            onSuggestionClick={handleSuggestionClick}
            onSelectionQuery={handleSelectionQuery}
            isDistractionFree={isDistractionFree}
            docZoom={docZoom}
          />
        </main>

        {/* Bottom status bar */}
        <div className="h-7 flex items-center justify-between px-4 text-[10px] font-medium shrink-0" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
          <div className="flex items-center gap-4">
            <span>{wordCount} words</span>
            <span>~{tokenCount.toLocaleString()} tokens</span>
            <div className="flex items-center gap-2 ml-4">
              <span title="GUI Zoom">GUI:</span>
              <button onClick={() => setGuiZoom(z => Math.max(0.5, z - 0.1))} className="px-1 hover:bg-stone-200 rounded">-</button>
              <span>{Math.round(guiZoom * 100)}%</span>
              <button onClick={() => setGuiZoom(z => Math.min(2, z + 0.1))} className="px-1 hover:bg-stone-200 rounded">+</button>
              <span className="ml-2" title="Document Zoom">Doc:</span>
              <button onClick={() => setDocZoom(z => Math.max(0.5, z - 0.1))} className="px-1 hover:bg-stone-200 rounded">-</button>
              <span>{Math.round(docZoom * 100)}%</span>
              <button onClick={() => setDocZoom(z => Math.min(3, z + 0.1))} className="px-1 hover:bg-stone-200 rounded">+</button>
            </div>
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
            highlightedSuggestionId={highlightedSuggestionId}
            analysisProgress={analysisProgress}
            activeTabOverride={sidebarTab}
            onTabChange={setSidebarTab}
          />
        </div>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={aiSettings}
        onUpdateSettings={setAiSettings}
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
