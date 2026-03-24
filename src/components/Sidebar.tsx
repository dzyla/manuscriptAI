import { useState, useRef, useEffect, useMemo, createElement } from 'react';
import { AgentType, Message, Suggestion, HistoryItem, SuggestionSeverity } from '../types';
import { Send, Sparkles, Check, X, MessageSquare, History as HistoryIcon, Info, Clock, CheckCheck, XCircle, Filter, ChevronDown, ChevronUp, BookOpen, Trash2, FileText, UploadCloud } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';
import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import localforage from 'localforage';

pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
import { AGENT_INFO, AGENT_ICONS } from '../services/ai';

interface SidebarProps {
  suggestions: Suggestion[];
  messages: Message[];
  history: HistoryItem[];
  onSendMessage: (text: string, agent: AgentType) => void;
  onAcceptSuggestion: (suggestion: Suggestion) => void;
  onRejectSuggestion: (suggestion: Suggestion) => void;
  onRevertHistory: (historyId: string) => void;
  onRebuttal: (suggestionId: string, feedback: string) => void;
  onSuggestionCardClick: (suggestion: Suggestion) => void;
  onHistoryItemClick?: (item: HistoryItem) => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  isAnalyzing: boolean;
  highlightedSuggestionId?: string | null;
  analysisProgress?: { agent: string; total: number; done: number } | null;
  activeTabOverride?: 'chat' | 'suggestions' | 'history' | 'sources';
  onTabChange?: (tab: 'chat' | 'suggestions' | 'history' | 'sources') => void;
}

const SEVERITY_CONFIG: Record<SuggestionSeverity, { label: string; color: string; dotColor: string }> = {
  critical: { label: 'Critical', color: 'text-rose-700', dotColor: 'bg-rose-500' },
  major: { label: 'Major', color: 'text-amber-700', dotColor: 'bg-amber-500' },
  minor: { label: 'Minor', color: 'text-blue-600', dotColor: 'bg-blue-400' },
  style: { label: 'Style', color: 'text-stone-500', dotColor: 'bg-stone-400' },
};

function AgentIcon({ agent, size = 12 }: { agent: AgentType; size?: number }) {
  const info = AGENT_INFO[agent];
  const IconComponent = AGENT_ICONS[info?.iconName];
  if (!IconComponent) return null;
  return createElement(IconComponent, { size });
}

function DiffView({ original, suggested }: { original: string; suggested: string }) {
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      <div className="diff-remove px-2 py-1 rounded" style={{ fontSize: '11px' }}>
        {original}
      </div>
      <div className="diff-add px-2 py-1 rounded" style={{ fontSize: '11px' }}>
        {suggested}
      </div>
    </div>
  );
}

function CategoryBadge({ category }: { category?: string }) {
  if (!category) return null;
  const colors: Record<string, string> = {
    grammar: 'bg-blue-50 text-blue-600 border-blue-100',
    flow: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    evidence: 'bg-rose-50 text-rose-600 border-rose-100',
    impact: 'bg-rose-50 text-rose-700 border-rose-200',
    clarity: 'bg-teal-50 text-teal-600 border-teal-100',
    statistics: 'bg-amber-50 text-amber-700 border-amber-100',
    citation: 'bg-violet-50 text-violet-600 border-violet-100',
    research: 'bg-amber-50 text-amber-800 border-amber-200',
    structure: 'bg-stone-100 text-stone-600 border-stone-200',
    style: 'bg-stone-50 text-stone-500 border-stone-200',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${colors[category] || colors.style}`}>
      {category}
    </span>
  );
}

export default function Sidebar({
  suggestions,
  messages,
  history,
  onSendMessage,
  onAcceptSuggestion,
  onRejectSuggestion,
  onRevertHistory,
  onRebuttal,
  onSuggestionCardClick,
  onHistoryItemClick,
  onAcceptAll,
  onRejectAll,
  isAnalyzing,
  highlightedSuggestionId,
  analysisProgress,
  activeTabOverride,
  onTabChange,
}: SidebarProps) {
  const [input, setInput] = useState('');
  const [rebuttalTexts, setRebuttalTexts] = useState<Record<string, string>>({});
  const [activeTab, setActiveTabLocal] = useState<'chat' | 'suggestions' | 'history' | 'sources'>('chat');
  const [sources, setSources] = useState<{id: string, name: string, type: 'pdf' | 'bib', text: string}[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);

  useEffect(() => {
    localforage.getItem('manuscript-sources').then((saved: any) => {
      if (saved && Array.isArray(saved)) setSources(saved);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    localforage.setItem('manuscript-sources', sources).catch(console.error);
  }, [sources]);

  const extractTextFromPDF = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => item.str).join(' ');
      text += pageText + '\n\n';
    }
    return text;
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.pdf') || f.name.endsWith('.bib'));
    if (files.length === 0) return;

    setIsParsing(true);
    const newSources = [];

    for (const file of files) {
      try {
        if (file.name.endsWith('.pdf')) {
          const text = await extractTextFromPDF(file);
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'pdf' as const, text });
        } else if (file.name.endsWith('.bib')) {
          const text = await file.text();
          new Cite(text);
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'bib' as const, text });
        }
      } catch (err) {
        console.error('Failed to parse file:', file.name, err);
      }
    }

    if (newSources.length > 0) setSources(prev => [...prev, ...newSources]);
    setIsParsing(false);
  };

  // Sync tab from parent override
  useEffect(() => {
    if (activeTabOverride) setActiveTabLocal(activeTabOverride);
  }, [activeTabOverride]);

  const setActiveTab = (tab: 'chat' | 'suggestions' | 'history' | 'sources') => {
    setActiveTabLocal(tab);
    onTabChange?.(tab);
  };
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('manager');
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<SuggestionSeverity | 'all'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [expandedRebuttal, setExpandedRebuttal] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);
  const suggestionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightedSuggestionId) {
      // Auto-switch to suggestions tab when a highlight is clicked in the editor
      setActiveTab('suggestions');
      setTimeout(() => {
        suggestionRefs.current[highlightedSuggestionId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [highlightedSuggestionId]);

  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, activeTab]);

  const agents = Object.entries(AGENT_INFO).map(([id, info]) => ({
    id: id as AgentType,
    ...info
  }));

  const filteredSuggestions = useMemo(() => {
    if (severityFilter === 'all') return suggestions;
    return suggestions.filter(s => s.severity === severityFilter);
  }, [suggestions, severityFilter]);

  const severityCounts = useMemo(() => {
    const counts = { critical: 0, major: 0, minor: 0, style: 0 };
    suggestions.forEach(s => {
      if (s.severity && counts[s.severity] !== undefined) counts[s.severity]++;
    });
    return counts;
  }, [suggestions]);

  const handleSend = () => {
    if (!input.trim()) return;
    onSendMessage(input, selectedAgent);
    setInput('');
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface-0)' }}>
      {/* Tab bar */}
      <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
        {([
          { key: 'chat' as const, icon: <MessageSquare size={14} />, label: 'Chat' },
          { key: 'suggestions' as const, icon: <Sparkles size={14} />, label: 'Review' },
          { key: 'history' as const, icon: <Clock size={14} />, label: 'History' },
          { key: 'sources' as const, icon: <BookOpen size={14} />, label: 'Sources' },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-3.5 text-xs font-semibold flex items-center justify-center gap-1.5 transition-all duration-200 ${
              activeTab === tab.key 
                ? 'border-b-2 border-stone-800' 
                : 'hover:bg-white/50'
            }`}
            style={{ 
              color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-tertiary)',
              background: activeTab === tab.key ? 'var(--surface-1)' : 'transparent',
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.key === 'suggestions' && suggestions.length > 0 && (
              <span className="bg-stone-800 text-white text-[9px] px-1.5 py-0.5 rounded-full font-bold min-w-[18px] text-center">
                {suggestions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Analysis progress */}
      {isAnalyzing && (
        <div className="px-4 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="progress-bar rounded-full" />
          <div className="flex items-center gap-2 mt-1.5">
            <Sparkles size={10} className="animate-spin" style={{ color: 'var(--accent-blue)' }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
               {analysisProgress?.agent ? `Processing: ${analysisProgress.agent}` : 'AI agents analyzing in parallel...'}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'chat' ? (
          <div className="space-y-4">
            {/* Chat History Title */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Chat History</span>
              <button 
                onClick={() => setShowAgentInfo(!showAgentInfo)}
                className="p-1 rounded-md transition-colors hover:bg-stone-100 flex items-center gap-1 text-[10px] font-medium"
                style={{ color: 'var(--text-muted)' }}
                title="Show agent descriptions"
              >
                <Info size={12} />
                About Agents
              </button>
            </div>

            {/* Chat messages */}
            <div className="space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] p-3 text-sm leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-stone-800 text-white rounded-2xl rounded-tr-sm' 
                        : 'border rounded-2xl rounded-tl-sm shadow-sm'
                    }`}
                    style={msg.role === 'assistant' ? { borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', background: 'var(--surface-1)' } : {}}
                  >
                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <div className="markdown-chat-content whitespace-normal break-words text-[13px] leading-relaxed">
                        <ReactMarkdown
                          components={{
                            p: ({node, ...props}) => <p className="mb-2 last:mb-0" {...props} />,
                            ul: ({node, ...props}) => <ul className="list-disc pl-4 mb-2" {...props} />,
                            ol: ({node, ...props}) => <ol className="list-decimal pl-4 mb-2" {...props} />,
                            li: ({node, ...props}) => <li className="mb-1" {...props} />,
                            h2: ({node, ...props}) => <h2 className="text-[14px] font-bold mt-3 mb-1" {...props} />,
                            h3: ({node, ...props}) => <h3 className="text-[13px] font-bold mt-2 mb-1" {...props} />,
                            strong: ({node, ...props}) => <strong className="font-semibold" {...props} />,
                            em: ({node, ...props}) => <em className="italic" {...props} />
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                  {msg.agent && (
                    <div className="flex items-center gap-1 mt-1">
                      <AgentIcon agent={msg.agent} size={9} />
                      <span className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
                        {AGENT_INFO[msg.agent]?.label}
                      </span>
                    </div>
                  )}
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-2 space-y-2 w-full max-w-[85%]">
                      {msg.suggestions.map(s => (
                        <div 
                          key={s.id} 
                          className="border rounded-xl p-3 text-xs shadow-sm cursor-pointer hover:border-stone-300 transition-colors" 
                          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                          onClick={() => onSuggestionCardClick(s)}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-bold" style={{ color: 'var(--text-primary)' }}>Proposed Change</span>
                            <CategoryBadge category={s.category} />
                            <span className="text-[9px] ml-auto" style={{ color: 'var(--text-muted)' }}>Click to locate</span>
                          </div>
                          <DiffView original={s.originalText} suggested={s.suggestedText} />
                          <div className="flex gap-1.5 mt-2">
                            <button 
                              onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(s); }}
                              className="flex-1 py-1.5 bg-stone-800 text-white rounded-lg text-[11px] font-medium hover:bg-stone-700 transition-colors"
                            >
                              Accept
                            </button>
                            <button 
                              onClick={(e) => { e.stopPropagation(); onRejectSuggestion(s); }}
                              className="flex-1 py-1.5 border rounded-lg text-[11px] font-medium hover:bg-stone-50 transition-colors"
                              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {isAnalyzing && (
                <div className="flex items-center gap-2 text-xs animate-pulse" style={{ color: 'var(--text-muted)' }}>
                  <Sparkles size={12} />
                  Agent is thinking...
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>
        ) : activeTab === 'suggestions' ? (
          <div className="space-y-3">
            {/* Batch actions & filters */}
            {suggestions.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <button 
                      onClick={onAcceptAll}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                    >
                      <CheckCheck size={12} /> Accept All
                    </button>
                    <button 
                      onClick={onRejectAll}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold transition-colors bg-rose-50 text-rose-600 hover:bg-rose-100 border border-rose-200"
                    >
                      <XCircle size={12} /> Clear All
                    </button>
                  </div>
                  <button 
                    onClick={() => setShowFilters(!showFilters)}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold transition-colors hover:bg-stone-100"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <Filter size={12} />
                    {showFilters ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </button>
                </div>

                {showFilters && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="flex gap-1 flex-wrap">
                    <button
                      onClick={() => setSeverityFilter('all')}
                      className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors border ${severityFilter === 'all' ? 'bg-stone-800 text-white border-stone-800' : 'border-stone-200 text-stone-500 hover:bg-stone-50'}`}
                    >
                      All ({suggestions.length})
                    </button>
                    {(Object.entries(SEVERITY_CONFIG) as [SuggestionSeverity, typeof SEVERITY_CONFIG[SuggestionSeverity]][]).map(([key, cfg]) => (
                      severityCounts[key] > 0 && (
                        <button
                          key={key}
                          onClick={() => setSeverityFilter(key)}
                          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-colors border ${severityFilter === key ? 'bg-stone-800 text-white border-stone-800' : 'border-stone-200 hover:bg-stone-50'}`}
                          style={severityFilter !== key ? { color: 'var(--text-secondary)' } : {}}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotColor}`} />
                          {cfg.label} ({severityCounts[key]})
                        </button>
                      )
                    ))}
                  </motion.div>
                )}
              </div>
            )}

            {filteredSuggestions.length === 0 ? (
              <div className="text-center py-16" style={{ color: 'var(--text-muted)' }}>
                <Sparkles size={36} className="mx-auto mb-3 opacity-15" />
                <p className="text-sm font-medium mb-1">No suggestions yet</p>
                <p className="text-xs">Click <strong>"Analyze All"</strong> to have AI agents<br/>review your manuscript</p>
              </div>
            ) : (
              <AnimatePresence>
                {filteredSuggestions.map((s) => {
                  const severityCfg = SEVERITY_CONFIG[s.severity || 'minor'];
                  return (
                    <motion.div
                      key={s.id}
                      ref={(el) => { if (el) suggestionRefs.current[s.id] = el; }}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, scale: highlightedSuggestionId === s.id ? 1.01 : 1 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      onClick={() => onSuggestionCardClick(s)}
                      className={`suggestion-card severity-${s.severity || 'minor'} border rounded-xl p-4 space-y-3 cursor-pointer mb-3 ${
                        highlightedSuggestionId === s.id ? 'ring-2 ring-stone-800/15 border-stone-400' : ''
                      }`}
                      style={{ borderColor: highlightedSuggestionId === s.id ? undefined : 'var(--border)', background: 'var(--surface-1)' }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <AgentIcon agent={s.agent} size={11} />
                          <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-md ${AGENT_INFO[s.agent].color} text-white`}>
                            {AGENT_INFO[s.agent]?.label}
                          </span>
                          <CategoryBadge category={s.category} />
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${severityCfg.dotColor}`} />
                          <span className={`text-[9px] font-bold uppercase tracking-wider ${severityCfg.color}`}>
                            {severityCfg.label}
                          </span>
                        </div>
                      </div>

                      <DiffView original={s.originalText} suggested={s.suggestedText} />

                      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {s.explanation}
                      </p>

                      {s.section && s.section !== 'General' && (
                        <span className="inline-block text-[9px] px-1.5 py-0.5 rounded border font-medium" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}>
                          {s.section}
                        </span>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(s); }}
                          className="flex-1 py-2 bg-stone-800 text-white rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:bg-stone-700 transition-colors shadow-sm"
                        >
                          <Check size={12} /> Accept
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onRejectSuggestion(s); }}
                          className="flex-1 py-2 border rounded-lg text-[11px] font-semibold flex items-center justify-center gap-1.5 hover:bg-stone-50 transition-colors"
                          style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                        >
                          <X size={12} /> Reject
                        </button>
                      </div>
                      
                      <div className="pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }} onClick={e => e.stopPropagation()}>
                        {expandedRebuttal === s.id ? (
                          <div className="space-y-2">
                            <textarea
                              value={rebuttalTexts[s.id] || ''} 
                              onChange={e => setRebuttalTexts({...rebuttalTexts, [s.id]: e.target.value})} 
                              placeholder="Explain why you disagree with this suggestion..." 
                              className="w-full px-3 py-2 border rounded-lg text-[11px] focus:outline-none focus:ring-1 focus:ring-stone-400 resize-none min-h-[60px]"
                              style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey && rebuttalTexts[s.id]?.trim()) {
                                  e.preventDefault();
                                  onRebuttal(s.id, rebuttalTexts[s.id]);
                                  setRebuttalTexts({...rebuttalTexts, [s.id]: ''});
                                  setExpandedRebuttal(null);
                                }
                              }}
                            />
                            <div className="flex gap-1.5">
                              <button 
                                disabled={!rebuttalTexts[s.id]?.trim() || isAnalyzing} 
                                onClick={() => { onRebuttal(s.id, rebuttalTexts[s.id]); setRebuttalTexts({...rebuttalTexts, [s.id]: ''}); setExpandedRebuttal(null); }} 
                                className="px-3 py-1.5 bg-stone-800 text-white rounded-lg text-[10px] font-bold disabled:opacity-40 hover:bg-stone-700 transition-colors"
                              >
                                Send Rebuttal
                              </button>
                              <button 
                                onClick={() => setExpandedRebuttal(null)} 
                                className="px-3 py-1.5 rounded-lg text-[10px] font-medium hover:bg-stone-50 transition-colors"
                                style={{ color: 'var(--text-tertiary)' }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setExpandedRebuttal(s.id)}
                            className="text-[10px] font-medium transition-colors hover:underline flex items-center gap-1"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            <MessageSquare size={10} /> Disagree? Reply to this suggestion...
                          </button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        ) : activeTab === 'history' ? (
          <div className="space-y-3">
            {history.length === 0 ? (
              <div className="text-center py-16" style={{ color: 'var(--text-muted)' }}>
                <HistoryIcon size={36} className="mx-auto mb-3 opacity-15" />
                <p className="text-sm font-medium mb-1">No history yet</p>
                <p className="text-xs">Accepted suggestions will appear here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {history.slice().reverse().map((item) => (
                  <div 
                    key={item.id} 
                    className="border rounded-xl p-4 shadow-sm space-y-2 cursor-pointer hover:border-stone-300 transition-colors"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                    onClick={() => onHistoryItemClick?.(item)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <AgentIcon agent={item.agent} size={10} />
                        <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-md ${AGENT_INFO[item.agent].color} text-white`}>
                          {AGENT_INFO[item.agent]?.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {new Date(item.timestamp).toLocaleTimeString()}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); setExpandedHistory(expandedHistory === item.id ? null : item.id); }}
                          className="p-0.5 rounded hover:bg-stone-100 transition-colors"
                          style={{ color: 'var(--text-muted)' }}
                          title="Show changes"
                        >
                          {expandedHistory === item.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      </div>
                    </div>
                    
                    {/* Summary line */}
                    <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
                      {item.originalText.substring(0, 60)}{item.originalText.length > 60 ? '...' : ''} → {item.suggestedText.substring(0, 60)}{item.suggestedText.length > 60 ? '...' : ''}
                    </p>
                    
                    {/* Expanded diff view */}
                    {expandedHistory === item.id && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <DiffView original={item.originalText} suggested={item.suggestedText} />
                      </div>
                    )}
                    
                    <button
                      onClick={(e) => { e.stopPropagation(); onRevertHistory(item.id); }}
                      className="w-full mt-1 py-1.5 border rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors hover:bg-stone-50"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                    >
                      Revert Change
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'sources' ? (
          <div className="space-y-4 relative"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={handleFileDrop}
          >
            {isParsing && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/50 backdrop-blur-sm rounded-xl">
                <div className="flex flex-col items-center gap-2">
                  <Sparkles className="animate-spin text-blue-500" size={24} />
                  <span className="text-xs font-semibold">Parsing files...</span>
                </div>
              </div>
            )}
            <div className={`text-center py-6 border-2 border-dashed rounded-xl transition-colors ${isDragging ? 'border-blue-500 bg-blue-50/50' : ''}`} style={{ borderColor: isDragging ? 'var(--accent-blue)' : 'var(--border)' }}>
                <UploadCloud size={24} className="mx-auto mb-2 opacity-50" style={{ color: 'var(--text-muted)' }} />
                <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Drop PDFs & .bib files here</p>
                <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>These will be used to verify citations and facts</p>
            </div>

            {sources.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Uploaded Sources ({sources.length})</h3>
                    {sources.map((source) => (
                        <div key={source.id} className="flex items-center justify-between p-3 border rounded-xl shadow-sm" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                            <div className="flex items-center gap-2 overflow-hidden">
                                <FileText size={14} style={{ color: 'var(--text-tertiary)' }} />
                                <div className="truncate">
                                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{source.name}</p>
                                    <p className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>{source.type.toUpperCase()} • {Math.round(source.text.length / 1024)} KB</p>
                                </div>
                            </div>
                            <button
                                className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors" style={{ color: 'var(--text-muted)' }}
                                onClick={() => setSources(s => s.filter(src => src.id !== source.id))}
                            >
                                <Trash2 size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Chat input */}
      <div className="p-3 flex flex-col gap-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-1)' }}>
        {activeTab === 'chat' && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
            <span className="text-[9px] font-bold uppercase tracking-widest shrink-0 mr-1" style={{ color: 'var(--text-muted)' }}>Reply as:</span>
            {agents.map(agent => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgent(agent.id)}
                className={`px-2 py-1 rounded-md text-[10px] font-medium whitespace-nowrap transition-all flex items-center gap-1 ${
                  selectedAgent === agent.id ? `${agent.color} text-white` : 'border hover:bg-stone-50'
                }`}
                style={selectedAgent !== agent.id ? { borderColor: 'var(--border)', color: 'var(--text-secondary)' } : {}}
              >
                <AgentIcon agent={agent.id} size={10} />
                {agent.label}
              </button>
            ))}
          </div>
        )}
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
            placeholder={activeTab === 'chat' ? `Ask the ${AGENT_INFO[selectedAgent]?.label} agent...` : "Switch to chat to send messages..."}
            disabled={activeTab !== 'chat'}
            className="w-full p-3 pr-12 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 resize-none min-h-[64px] transition-all disabled:opacity-50"
            style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isAnalyzing || activeTab !== 'chat'}
            className="absolute right-3 bottom-3 p-2 bg-stone-800 text-white rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-all shadow-sm"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
