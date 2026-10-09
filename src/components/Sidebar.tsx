import { useState, useRef, useEffect, useCallback, createElement } from 'react';
import { AgentType, Message, Suggestion, HistoryItem, SuggestionSeverity, AISettings, AttachedImage } from '../types';
import { Send, Sparkles, Check, X, MessageSquare, Info, CheckCheck, XCircle, Filter, BookOpen, FileText, BookMarked, Plus, List, AlertTriangle, Search, ImagePlus, Square, ArrowRight } from 'lucide-react';
import { ManuscriptSource, VersionSnapshot } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { StylePanel, type StylePanelProps } from './style/StylePanel';
import { ReviewPanel, type ReviewPanelProps } from './panels/ReviewPanel';
import { CitePanel } from './panels/CitePanel';
import { WritePanel } from './panels/WritePanel';
import { FormatPanel, type FormatPanelProps } from './panels/FormatPanel';
import { useOutline } from './panels/write/outline';
import { SuggestionDetail, RebuttalBox } from './panels/SuggestionBody';
import { AgentIcon, CategoryBadge, DiffView } from './panels/suggestionParts';

import { useSourceStore } from '../stores/useSourceStore';
import { digestSourceForManuscript, analyzeSourceAgainstManuscript, AGENT_INFO, AGENT_ICONS, localModelSupportsVision } from '../services/ai';

interface SidebarProps {
  suggestions: Suggestion[];
  messages: Message[];
  history: HistoryItem[];
  onSendMessage: (text: string, agent: AgentType, attachedSources?: Array<{ name: string; text: string }>, images?: AttachedImage[]) => void;
  onAcceptSuggestion: (suggestion: Suggestion) => void;
  onRejectSuggestion: (suggestion: Suggestion) => void;
  onRevertHistory: (historyId: string) => void;
  onRebuttal: (suggestionId: string, feedback: string) => void;
  onSuggestionCardClick: (suggestion: Suggestion) => void;
  onHistoryItemClick?: (item: HistoryItem) => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  isAnalyzing: boolean;
  onStop?: () => void;
  highlightedSuggestionId?: string | null;
  analysisProgress?: { agent: string; total: number; done: number } | null;
  activeTabOverride?: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style';
  /** Props for the Style tab (sub-project H); the tab shows nothing useful without them. */
  stylePanel?: StylePanelProps;
  /** The Format panel (the 'style' tab is its home): page setup, named styles, the grant template. */
  formatPanel?: FormatPanelProps;
  /** The Review panel: one list of everything the AI and the style audit have to say, in document order, with chat folded in. */
  review?: Omit<ReviewPanelProps, 'chat' | 'analyzing' | 'highlightedRowId' | 'renderDetail' | 'renderFooter' | 'progress' | 'chatOpen' | 'onChatOpenChange' | 'zoom'>;
  /** Bumped by the host each time it wants the chat to be seen (a reply arrived); the Chat section opens. */
  chatRequest?: number;
  onTabChange?: (tab: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style') => void;
  onAgentChange?: (agent: AgentType) => void;
  manuscriptContent?: string;
  manuscriptHtml?: string;
  onScrollToSection?: (headingText: string) => void;
  documentTitle?: string;
  onRestoreSnapshot: (snapshot: VersionSnapshot) => void | Promise<void>;
  onAnalyzeSection?: (sectionText: string, sectionTitle: string) => void;
  onSourcesChange?: (sources: ManuscriptSource[]) => void;
  aiSettings?: AISettings;
  onAnalyzeSource?: (analysis: string, sourceName: string) => void;
  contentZoom?: number;
  externalApiSources?: ManuscriptSource[];
  onExternalSourcesMerged?: () => void;
  clearSourcesTrigger?: number;
  citationRegistry?: Record<string, number>;
  onRenumberCitations?: () => void;
  onRemoveCitation?: (sourceId: string) => void;
  onScrollToCitation?: (num: number) => void;
  documentHTML?: string;
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
  onStop,
  highlightedSuggestionId,
  analysisProgress,
  activeTabOverride,
  stylePanel,
  formatPanel,
  review,
  chatRequest,
  onTabChange,
  onAgentChange,
  manuscriptContent = '',
  manuscriptHtml = '',
  documentTitle = '',
  onRestoreSnapshot,
  onScrollToSection,
  onAnalyzeSection,
  onSourcesChange,
  aiSettings,
  onAnalyzeSource,
  contentZoom = 100,
  externalApiSources,
  onExternalSourcesMerged,
  clearSourcesTrigger,
  citationRegistry,
  onRenumberCitations,
  onRemoveCitation,
  onScrollToCitation,
  documentHTML = '',
}: SidebarProps) {
  // ─── Zustand source store ────────────────────────────────────────────────────
  const { sources } = useSourceStore();
  const [input, setInput] = useState('');
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [attachedSourceIds, setAttachedSourceIds] = useState<Set<string>>(new Set(['__full__']));
  const sourcePickerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTabLocal] = useState<'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style'>('chat');

  const [analyzingSourceId, setAnalyzingSourceId] = useState<string | null>(null);
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [visionWarning, setVisionWarning] = useState<string | null>(null);
  const handleAnalyzeSource = async (source: { id: string; name: string; text: string }) => {
    if (!aiSettings || analyzingSourceId) return;
    setAnalyzingSourceId(source.id);
    setActiveTab('chat');
    try {
      const analysis = await analyzeSourceAgainstManuscript(source.text, source.name, manuscriptContent, aiSettings);
      onAnalyzeSource?.(analysis, source.name);
    } catch (err) {
      onAnalyzeSource?.(`Failed to analyze "${source.name}": ${err instanceof Error ? err.message : 'Unknown error'}`, source.name);
    } finally {
      setAnalyzingSourceId(null);
    }
  };

  // Sync tab from parent override
  useEffect(() => {
    if (!showSourcePicker) return;
    const handleClick = (e: MouseEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(e.target as Node)) {
        setShowSourcePicker(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSourcePicker]);

  // The Review view is what the 'chat' and 'suggestions' tabs show now. Asking for the chat tab (analyzing a source, a source's Chat button)
  // opens the Chat section inside it.
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => { if (chatRequest) setChatOpen(true); }, [chatRequest]);
  const reviewView = !!review && (activeTab === 'chat' || activeTab === 'suggestions');
  useEffect(() => {
    if (activeTabOverride) setActiveTabLocal(activeTabOverride);
  }, [activeTabOverride]);

  const setActiveTab = (tab: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline' | 'style') => {
    setActiveTabLocal(tab);
    if (tab === 'chat') setChatOpen(true);
    onTabChange?.(tab);
  };
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('manager');
  const [agentMode, setAgentMode] = useState(false);
  const handleAgentChange = (agent: AgentType) => {
    setSelectedAgent(agent);
    onAgentChange?.(agent);
  };
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightedSuggestionId) {
      // Open the Review view when a highlight is clicked in the editor; the panel scrolls its row into view.
      setActiveTab('suggestions');
    }
  }, [highlightedSuggestionId]);

  useEffect(() => {
    if (reviewView && chatOpen) {
      chatEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [messages, reviewView, chatOpen]);

  const agents = Object.entries(AGENT_INFO)
    .filter(([id]) => id !== 'manuscript-ai' && id !== 'literature-reviewer' && id !== 'citation-checker')
    .map(([id, info]) => ({ id: id as AgentType, ...info }));

  const { outline, wordCounts } = useOutline(manuscriptHtml);
  const docRef = useRef({ title: documentTitle, content: manuscriptHtml });
  docRef.current = { title: documentTitle, content: manuscriptHtml };
  const getDocument = useCallback(() => docRef.current, []);
  const goToHeading = useCallback((text: string) => onScrollToSection?.(text), [onScrollToSection]);

  const handleSend = () => {
    if (!input.trim() && attachedImages.length === 0) return;
    const attached: Array<{ name: string; text: string }> = [];
    // Scope sentinels — resolved to actual text by App.tsx handleSendMessage
    if (attachedSourceIds.has('__full__'))    attached.push({ name: '__full__',    text: '' });
    if (attachedSourceIds.has('__section__')) attached.push({ name: '__section__', text: '' });
    sources.forEach(src => {
      if (attachedSourceIds.has(src.id)) {
        attached.push({ name: src.name, text: src.text });
      }
    });
    const imagesToSend = attachedImages.length > 0 ? [...attachedImages] : undefined;
    onSendMessage(input, agentMode ? selectedAgent : 'manuscript-ai', attached.length > 0 ? attached : undefined, imagesToSend);
    setInput('');
    setAttachedImages([]);
    setVisionWarning(null);
    setShowSourcePicker(false);
  };

  const handleImageFiles = async (files: File[]) => {
    const supported = ['image/jpeg', 'image/png', 'image/webp'];
    const imageFiles = files.filter(f => supported.includes(f.type));
    if (imageFiles.length === 0) return;

    // Warn for local models without apparent vision support
    if (aiSettings?.provider === 'local') {
      const modelName = aiSettings.localModel || '';
      if (!localModelSupportsVision(modelName)) {
        setVisionWarning(
          `"${modelName || 'this model'}" may not support vision. Use a VLM (e.g. qwen2-vl, llava) in LM Studio for image input. The request will be sent anyway — the model will error if unsupported.`
        );
      } else {
        setVisionWarning(null);
      }
    } else {
      setVisionWarning(null);
    }

    const newImages: AttachedImage[] = [];
    for (const file of imageFiles) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      bytes.forEach(b => { binary += String.fromCharCode(b); });
      const base64 = btoa(binary);
      const dataUrl = `data:${file.type};base64,${base64}`;
      newImages.push({
        id: Date.now().toString() + Math.random(),
        name: file.name,
        base64,
        mimeType: file.type as AttachedImage['mimeType'],
        dataUrl,
      });
    }
    setAttachedImages(prev => [...prev, ...newImages]);
  };

  const suggestionFor = (rowId: string) => (rowId.startsWith('suggestion:') ? suggestions.find(s => s.id === rowId.slice('suggestion:'.length)) : undefined);
  const renderSuggestionDetail = (row: { id: string }) => { const s = suggestionFor(row.id); return s ? <SuggestionDetail s={s} /> : null; };
  const renderSuggestionFooter = (row: { id: string }) => (suggestionFor(row.id) ? <RebuttalBox suggestionId={suggestionFor(row.id)!.id} busy={isAnalyzing} onRebuttal={onRebuttal} /> : null);

  // The chat lives inside the Review panel's collapsible Chat section. Its state stays here, in Sidebar, because the Sources tab
  // drives it (attach a source, analyze a source) and it must survive the section being collapsed.
  const chatNode = (
    <>
      <div className="max-h-80 overflow-y-auto p-3">
          <div className="space-y-4">
            {/* Chat History Title */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Chat History</span>
              <button 
                data-testid="control-agent-info"
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
                        : msg.agent === 'manuscript-ai'
                          ? 'border rounded-2xl rounded-tl-sm shadow-sm'
                          : 'border rounded-2xl rounded-tl-sm shadow-sm'
                    }`}
                    style={msg.role === 'assistant'
                      ? msg.agent === 'manuscript-ai'
                        ? { borderColor: 'rgba(21,128,61,0.2)', color: 'var(--text-primary)', background: 'rgba(240,253,244,0.6)' }
                        : { borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', background: 'var(--surface-1)' }
                      : {}
                    }
                  >
                    {msg.role === 'user' ? (
                      <div className="space-y-2">
                        {msg.images && msg.images.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {msg.images.map(img => (
                              <img
                                key={img.id}
                                src={img.dataUrl}
                                alt={img.name}
                                className="rounded-lg object-cover border border-white/20"
                                style={{ maxWidth: '120px', maxHeight: '90px' }}
                                title={img.name}
                              />
                            ))}
                          </div>
                        )}
                        {msg.content && <p className="whitespace-pre-wrap">{msg.content}</p>}
                      </div>
                    ) : (
                      <div className="markdown-chat-content whitespace-normal break-words text-[13px] leading-relaxed">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({node, ...props}) => <p className="mb-2 last:mb-0" {...props} />,
                            ul: ({node, ...props}) => <ul className="list-disc pl-4 mb-2" {...props} />,
                            ol: ({node, ...props}) => <ol className="list-decimal pl-4 mb-2" {...props} />,
                            li: ({node, ...props}) => <li className="mb-1" {...props} />,
                            h2: ({node, ...props}) => <h2 className="text-[14px] font-bold mt-3 mb-1" {...props} />,
                            h3: ({node, ...props}) => <h3 className="text-[13px] font-bold mt-2 mb-1" {...props} />,
                            strong: ({node, ...props}) => <strong className="font-semibold" {...props} />,
                            em: ({node, ...props}) => <em className="italic" {...props} />,
                            table: () => null,
                            thead: () => null,
                            tbody: () => null,
                            tr: () => null,
                            th: () => null,
                            td: () => null,
                            code: ({node, ...props}) => <code className="px-1 py-0.5 rounded text-[11px] font-mono" style={{ background: 'var(--surface-2)' }} {...props} />,
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
                      <span
                        className="text-[9px] uppercase tracking-wider font-semibold"
                        style={{ color: msg.agent === 'manuscript-ai' ? 'var(--accent-green)' : 'var(--text-muted)' }}
                      >
                        {AGENT_INFO[msg.agent]?.label}
                      </span>
                    </div>
                  )}
                  {msg.suggestions && msg.suggestions.length > 0 && msg.agent !== 'manuscript-ai' && (
                    <div className="mt-2 space-y-2 w-full max-w-[85%]">
                      {msg.suggestions.map(s => (
                        <div 
                          key={s.id} 
                          className="border rounded-xl p-3 text-xs shadow-sm cursor-pointer hover:border-stone-300 transition-colors" 
                          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                          onClick={() => onSuggestionCardClick(s)}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                              {s.kind === 'advisory' ? 'Issue to Address' : 'Proposed Change'}
                            </span>
                            <CategoryBadge category={s.category} />
                            <span className="text-[9px] ml-auto" style={{ color: 'var(--text-muted)' }}>Click to locate</span>
                          </div>
                          {s.kind === 'advisory' ? (
                            <div className="space-y-1.5">
                              <div className="text-[11px] leading-relaxed px-2 py-1.5 rounded italic" style={{ background: 'var(--surface-2)', color: 'var(--text-tertiary)' }}>
                                "{s.originalText.length > 180 ? s.originalText.slice(0, 180) + '…' : s.originalText}"
                              </div>
                              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{s.explanation}</p>
                              {s.recommendation && (
                                <p className="text-[11px] leading-relaxed font-medium flex gap-1.5" style={{ color: '#b45309' }}>
                                  <ArrowRight size={12} className="mt-0.5 shrink-0" />
                                  <span>{s.recommendation}</span>
                                </p>
                              )}
                            </div>
                          ) : (
                            <DiffView original={s.originalText} suggested={s.suggestedText} />
                          )}
                          <div className="flex gap-1.5 mt-2">
                            <button
                              data-testid={s.kind === 'advisory' ? 'control-card-insert-note' : 'control-card-accept'}
                              onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(s); }}
                              className="flex-1 py-1.5 bg-stone-800 text-white rounded-lg text-[11px] font-medium hover:bg-stone-700 transition-colors"
                            >
                              {s.kind === 'advisory' ? 'Insert note' : 'Accept'}
                            </button>
                            <button
                              data-testid={s.kind === 'advisory' ? 'control-card-dismiss' : 'control-card-reject'}
                              onClick={(e) => { e.stopPropagation(); onRejectSuggestion(s); }}
                              className="flex-1 py-1.5 border rounded-lg text-[11px] font-medium hover:bg-stone-50 transition-colors"
                              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                            >
                              {s.kind === 'advisory' ? 'Dismiss' : 'Reject'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {isAnalyzing && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 text-xs animate-pulse" style={{ color: 'var(--text-muted)' }}>
                    <Sparkles size={12} />
                    Agent is thinking...
                  </div>
                  {onStop && (
                    <button
                      onClick={onStop}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold transition-colors"
                      style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626', border: '1px solid rgba(220,38,38,0.3)' }}
                      title="Stop request"
                    >
                      <Square size={9} className="fill-red-600" />
                      Stop
                    </button>
                  )}
                </div>
              )}
              {analyzingSourceId && (
                <div className="flex items-start gap-2 border rounded-2xl rounded-tl-sm p-3 shadow-sm animate-pulse" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <BookMarked size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-purple)' }} />
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Literature Reviewer is analyzing the reference paper against your manuscript...
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>
      </div>
      <div className="flex flex-col" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-1)' }}>

        {/* Mode switcher — Manuscript AI (default) vs Agent mode */}
        {(
          <div className="flex items-stretch" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button
              data-testid="control-chat-mode"
              onClick={() => setAgentMode(false)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-semibold transition-all ${!agentMode ? 'border-b-2 border-emerald-600' : 'hover:bg-stone-50'}`}
              style={{ color: !agentMode ? 'var(--accent-green)' : 'var(--text-muted)' }}
            >
              <AgentIcon agent="manuscript-ai" size={12} />
              Manuscript AI
            </button>
            <div style={{ width: '1px', background: 'var(--border-subtle)' }} />
            <button
              data-testid="control-agent-mode"
              onClick={() => setAgentMode(true)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-semibold transition-all ${agentMode ? 'border-b-2 border-stone-700' : 'hover:bg-stone-50'}`}
              style={{ color: agentMode ? 'var(--text-primary)' : 'var(--text-muted)' }}
            >
              <Sparkles size={11} />
              Agents
            </button>
          </div>
        )}

        <div className="p-3 flex flex-col gap-2">
          {/* Agent selector row — only in agent mode */}
          {agentMode && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              <span className="text-[9px] font-bold uppercase tracking-widest shrink-0 mr-1" style={{ color: 'var(--text-muted)' }}>Reply as:</span>
              {agents.map(agent => (
                <button
                  key={agent.id}
                  data-testid="control-agent"
                  onClick={() => handleAgentChange(agent.id)}
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

          {/* Context chips */}
          {(
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] font-bold uppercase tracking-widest shrink-0" style={{ color: 'var(--text-muted)' }}>Context:</span>
              {attachedSourceIds.has('__full__') && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border" style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>Full Manuscript</span>
              )}
              {attachedSourceIds.has('__section__') && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border" style={{ background: '#fef9c3', color: '#854d0e', borderColor: '#fde68a' }}>Current Section</span>
              )}
              {sources.filter(s => attachedSourceIds.has(s.id)).map(s => (
                <span key={s.id} className="text-[9px] px-1.5 py-0.5 rounded-full font-medium truncate max-w-[110px] border" style={{ background: 'var(--accent-blue-soft)', color: 'var(--accent-blue)', borderColor: 'rgba(59,111,212,0.25)' }} title={s.name}>{s.name}</span>
              ))}
              {attachedSourceIds.size === 0 && (
                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>none — use + to attach</span>
              )}
            </div>
          )}

          {/* Image preview strip */}
          {attachedImages.length > 0 && (
            <div className="flex flex-wrap gap-1.5 p-1">
              {attachedImages.map(img => (
                <div key={img.id} className="relative group">
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="rounded-lg object-cover border"
                    style={{ width: '56px', height: '42px', borderColor: 'var(--border)' }}
                    title={img.name}
                  />
                  <button
                    onClick={() => setAttachedImages(prev => prev.filter(i => i.id !== img.id))}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-stone-700 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove image"
                  >
                    <X size={8} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Vision warning */}
          {visionWarning && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg text-[10px] leading-snug" style={{ background: '#fef9c3', color: '#854d0e' }}>
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{visionWarning}</span>
              <button data-testid="control-vision-warning" onClick={() => setVisionWarning(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100"><X size={10} /></button>
            </div>
          )}

          {/* Textarea + buttons */}
          <div className="relative">
            {/* Hidden image file input */}
            <input
              ref={imageUploadRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files) { handleImageFiles(Array.from(e.target.files)); e.target.value = ''; } }}
            />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
              onPaste={(e) => {
                // Support pasting images from clipboard
                const items = Array.from(e.clipboardData.items);
                const imageItems = items.filter(item => item.type.startsWith('image/'));
                if (imageItems.length > 0) {
                  e.preventDefault();
                  const files = imageItems.map(item => item.getAsFile()).filter((f): f is File => f !== null);
                  handleImageFiles(files);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files);
                handleImageFiles(files);
              }}
              onDragOver={(e) => e.preventDefault()}
              placeholder={
                                !attachedSourceIds.has('__manuscript__') && attachedSourceIds.size > 0
                  ? 'Ask about the attached source document...'
                  : agentMode
                    ? `Ask the ${AGENT_INFO[selectedAgent]?.label} — produces suggestions...`
                    : 'Ask Manuscript AI anything about your manuscript...'
              }
              className="w-full p-3 pr-24 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 resize-none min-h-[64px] transition-all disabled:opacity-50"
              style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
            {/* Image attach button */}
            {(
              <button
                data-testid="control-attach-image"
                onClick={() => imageUploadRef.current?.click()}
                className="absolute right-20 bottom-3 p-2 rounded-lg transition-all hover:bg-stone-200"
                style={{ color: attachedImages.length > 0 ? 'var(--accent-blue)' : 'var(--text-muted)' }}
                title="Attach image (JPEG, PNG, WebP)"
              >
                <ImagePlus size={14} />
              </button>
            )}
            {/* Source picker button */}
            {(
              <div className="absolute right-12 bottom-3" ref={sourcePickerRef}>
                <button
                  data-testid="control-attach-sources"
                  onClick={() => setShowSourcePicker(p => !p)}
                  className="p-2 rounded-lg transition-all hover:bg-stone-200"
                  style={{ color: sources.some(s => attachedSourceIds.has(s.id)) ? 'var(--accent-blue)' : 'var(--text-muted)' }}
                  title="Attach context sources"
                >
                  <Plus size={14} />
                </button>
                {showSourcePicker && (
                  <div className="absolute bottom-full right-0 mb-1 border rounded-xl shadow-xl z-50 overflow-hidden w-64" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
                    <p className="text-[9px] font-bold uppercase tracking-widest px-3 py-2 border-b" style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}>Attach context</p>
                    <div className="max-h-64 overflow-y-auto p-1">
                      {/* Manuscript scope — mutually exclusive */}
                      <div className="px-2 pt-1 pb-0.5">
                        <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Manuscript scope</p>
                      </div>
                      <button
                        data-testid="control-scope-full"
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                        onClick={() => setAttachedSourceIds(prev => { const next = new Set(prev); next.delete('__section__'); if (next.has('__full__')) next.delete('__full__'); else next.add('__full__'); return next; })}
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${attachedSourceIds.has('__full__') ? 'bg-stone-800 border-stone-800' : ''}`} style={{ borderColor: 'var(--border)' }}>
                          {attachedSourceIds.has('__full__') && <Check size={9} className="text-white" />}
                        </span>
                        <FileText size={11} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                        <div className="flex-1 min-w-0 text-left">
                          <p className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>Full Manuscript</p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Send the entire document</p>
                        </div>
                      </button>
                      <button
                        data-testid="control-scope-section"
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                        onClick={() => setAttachedSourceIds(prev => { const next = new Set(prev); next.delete('__full__'); if (next.has('__section__')) next.delete('__section__'); else next.add('__section__'); return next; })}
                      >
                        <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${attachedSourceIds.has('__section__') ? 'bg-stone-800 border-stone-800' : ''}`} style={{ borderColor: 'var(--border)' }}>
                          {attachedSourceIds.has('__section__') && <Check size={9} className="text-white" />}
                        </span>
                        <List size={11} className="shrink-0" style={{ color: '#854d0e' }} />
                        <div className="flex-1 min-w-0 text-left">
                          <p className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>Current Section</p>
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Only the section at the cursor</p>
                        </div>
                      </button>
                      {sources.filter(s => s.type === 'pdf' || s.type === 'api' || s.type === 'text').length > 0 && (
                        <div className="px-2 pt-2 pb-0.5 border-t mt-1" style={{ borderColor: 'var(--border)' }}>
                          <p className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Additional sources</p>
                        </div>
                      )}

                      {/* PDF, text and API sources */}
                      {sources.filter(s => s.type === 'pdf' || s.type === 'api' || s.type === 'text').map(src => {
                        const isPdf = src.type === 'pdf';
                        const isText = src.type === 'text';
                        // Primary label: matched title > stripped filename > raw name
                        const label = src.apiMeta?.title
                          ?? src.name.replace(/\.(pdf|txt|md|docx)$/i, '').replace(/[-_]/g, ' ')
                          .replace(/\s+/g, ' ').trim();
                        // Secondary label: author+year for matched/api sources
                        const sub = src.apiMeta
                          ? `${src.apiMeta.authors?.split(/[,;]/)[0]?.trim() ?? ''}${src.apiMeta.year ? `, ${src.apiMeta.year}` : ''}`
                          : null;
                        const ext = src.name.split('.').pop()?.toUpperCase() ?? '';
                        return (
                          <button
                            key={src.id}
                            data-testid="control-attach-one-source"
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                            onClick={() => setAttachedSourceIds(prev => { const next = new Set(prev); if (next.has(src.id)) next.delete(src.id); else next.add(src.id); return next; })}
                          >
                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${attachedSourceIds.has(src.id) ? 'bg-stone-800 border-stone-800' : ''}`} style={{ borderColor: 'var(--border)' }}>
                              {attachedSourceIds.has(src.id) && <Check size={9} className="text-white" />}
                            </span>
                            {isPdf
                              ? <BookOpen size={11} className="shrink-0" style={{ color: 'var(--accent-blue)' }} />
                              : isText
                                ? <FileText size={11} className="shrink-0" style={{ color: '#16a34a' }} />
                                : <Search size={11} className="shrink-0" style={{ color: '#7c3aed' }} />}
                            <div className="flex-1 min-w-0 text-left">
                              <p className="text-[11px] font-medium truncate leading-tight" style={{ color: 'var(--text-primary)' }}>{label}</p>
                              {sub && <p className="text-[9px] truncate leading-tight" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
                            </div>
                            <span className="text-[8px] shrink-0 px-1 py-0.5 rounded" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                              {isPdf ? 'PDF' : isText ? ext : 'paper'}
                            </span>
                          </button>
                        );
                      })}

                      {sources.filter(s => s.type === 'pdf' || s.type === 'api' || s.type === 'text').length === 0 && (
                        <p className="text-[10px] px-2 py-2 text-center" style={{ color: 'var(--text-muted)' }}>Upload PDFs or search for papers<br/>in the Sources tab</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              data-testid="control-send"
              onClick={handleSend}
              disabled={(!input.trim() && attachedImages.length === 0) || isAnalyzing}
              className="absolute right-3 bottom-3 p-2 bg-stone-800 text-white rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-all shadow-sm"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface-0)' }}>
      {/* Analysis progress */}
      {isAnalyzing && !reviewView && (
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


      {/* The review view stays mounted when another task is open, so its expanded sections and selection survive a visit elsewhere. */}
      {review && (
        <div className="flex-1 min-h-0 flex flex-col" style={reviewView ? undefined : { display: 'none' }} data-testid="review-view">
          <ReviewPanel
            key={review.docKey ?? 'review'}
            {...review}
            analyzing={isAnalyzing}
            highlightedRowId={highlightedSuggestionId ? `suggestion:${highlightedSuggestionId}` : null}
            chat={chatNode}
            chatOpen={chatOpen}
            onChatOpenChange={setChatOpen}
            progress={analysisProgress?.agent ? `Processing: ${analysisProgress.agent}` : 'AI agents analyzing in parallel...'}
            renderDetail={renderSuggestionDetail}
            renderFooter={renderSuggestionFooter}
            styleSection={stylePanel ? <StylePanel {...stylePanel} showWorst={false} /> : undefined}
            zoom={contentZoom}
          />
        </div>
      )}

      {/* The cite view stays mounted when another task is open: a search, an upload or a digest in progress keeps running, and its results are still there when the panel comes back. */}
      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ fontSize: `${contentZoom}%`, ...(activeTab === 'sources' ? {} : { display: 'none' }) }}
        data-testid="cite-view"
      >
        <CitePanel
          aiSettings={aiSettings}
          manuscriptContent={manuscriptContent}
          documentHTML={documentHTML}
          citationRegistry={citationRegistry}
          onRenumberCitations={onRenumberCitations}
          onRemoveCitation={onRemoveCitation}
          onScrollToCitation={onScrollToCitation}
          onInsertHtml={html => onAnalyzeSection?.(html, '__bibliography__')}
          onSourcesChange={onSourcesChange}
          externalApiSources={externalApiSources}
          onExternalSourcesMerged={onExternalSourcesMerged}
          clearSourcesTrigger={clearSourcesTrigger}
          analyzingSourceId={analyzingSourceId}
          onCompareSource={handleAnalyzeSource}
          onChatWithSource={source => {
            // Set source-only context and switch to chat
            setAttachedSourceIds(new Set([source.id]));
            setActiveTab('chat');
          }}
        />
      </div>

      {/* The write view stays mounted when another task is open: its sections keep their state (an expanded change, a half-typed snapshot name). */}
      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ fontSize: `${contentZoom}%`, ...(activeTab === 'outline' || activeTab === 'history' ? {} : { display: 'none' }) }}
        data-testid="write-view"
      >
        <WritePanel
          outline={outline}
          wordCounts={wordCounts}
          history={history}
          onGoTo={goToHeading}
          onAnalyzeSection={onAnalyzeSection}
          onRevertHistory={onRevertHistory}
          onHistoryItemClick={onHistoryItemClick}
          getDocument={getDocument}
          onRestore={onRestoreSnapshot}
          reveal={activeTab === 'history' ? 'history' : undefined}
        />
      </div>

      {/* The format view stays mounted when another task is open: a half-typed margin or limit keeps its place. */}
      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ fontSize: `${contentZoom}%`, ...(activeTab === 'style' ? {} : { display: 'none' }) }}
        data-testid="format-view"
      >
        {formatPanel ? <FormatPanel {...formatPanel} /> : null}
      </div>
    </div>
  );
}
