import { useState, useRef, useEffect, useMemo, createElement } from 'react';
import { AgentType, Message, Suggestion, HistoryItem, SuggestionSeverity, AISettings, AttachedImage } from '../types';
import { Send, Sparkles, Check, X, MessageSquare, History as HistoryIcon, Info, CheckCheck, XCircle, Filter, ChevronDown, ChevronUp, BookOpen, Trash2, FileText, UploadCloud, FolderOpen, BookMarked, Plus, List, AlertTriangle, CheckCircle2, Library, Search, ExternalLink, Copy, Zap, RefreshCw, ImagePlus, Square, ArrowRight, Hash } from 'lucide-react';
import { SemanticSearchResult, ManuscriptSource, PdfMatchScore } from '../types';
import { searchSimilarManuscripts, resultToBibtex, doiToUrl } from '../services/manuscriptSearch';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { wrap } from 'comlink';
import type { DocxWorkerApi } from '../workers/docxWorker';

import { Cite } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import { useSourceStore } from '../stores/useSourceStore';
import { digestSourceForManuscript, digestApiSource, extractPdfAbstractAea, scorePdfMatches, analyzeSourceAgainstManuscript, AGENT_INFO, AGENT_ICONS, localModelSupportsVision } from '../services/ai';
import { detectOrphanedCitations, formatBibliography, BIB_STYLE_LABELS, type BibStyle, type CitationAnalysis, countCitationOccurrences } from '../services/citations';

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
  activeTabOverride?: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline';
  onTabChange?: (tab: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline') => void;
  onAgentChange?: (agent: AgentType) => void;
  manuscriptContent?: string;
  manuscriptHtml?: string;
  onScrollToSection?: (headingText: string) => void;
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
  onStop,
  highlightedSuggestionId,
  analysisProgress,
  activeTabOverride,
  onTabChange,
  onAgentChange,
  manuscriptContent = '',
  manuscriptHtml = '',
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
  const { sources, addSources, updateSource, clearSources } = useSourceStore();
  const [input, setInput] = useState('');
  const [rebuttalTexts, setRebuttalTexts] = useState<Record<string, string>>({});
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [attachedSourceIds, setAttachedSourceIds] = useState<Set<string>>(new Set(['__full__']));
  const sourcePickerRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTabLocal] = useState<'chat' | 'suggestions' | 'history' | 'sources' | 'outline'>('chat');

  // ─── Web Workers (Comlink) ───────────────────────────────────────────────────
  // PDF parsing runs on the main thread (pdfjs spawns its own internal worker).
  // DOCX parsing still uses a Comlink worker to keep mammoth off the main thread.
  const docxWorkerRef = useRef<ReturnType<typeof wrap<DocxWorkerApi>> | null>(null);
  useEffect(() => {
    const rawDocx = new Worker(new URL('../workers/docxWorker.ts', import.meta.url), { type: 'module' });
    docxWorkerRef.current = wrap<DocxWorkerApi>(rawDocx);
    return () => { rawDocx.terminate(); };
  }, []);
  // Pending PDF match confirmations: sourceId → { results, matchIndex, scores? }
  const [pendingPdfMatches, setPendingPdfMatches] = useState<Record<string, { results: SemanticSearchResult[]; matchIndex: number; scores?: PdfMatchScore[] }>>({});
  // API source cards: which tab is active ('summary' default) + which are currently being digested
  const [sourceActiveTabs, setSourceActiveTabs] = useState<Record<string, 'summary' | 'abstract'>>({});
  const [digestingApiIds, setDigestingApiIds] = useState<Set<string>>(new Set());
  const [reDigestingIds, setReDigestingIds] = useState<Set<string>>(new Set());
  const [pdfSourceTabs, setPdfSourceTabs] = useState<Record<string, 'summary' | 'abstract'>>({});
  const [extractingAbstractIds, setExtractingAbstractIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parsingFileName, setParsingFileName] = useState<string | null>(null);
  const [digestingId, setDigestingId] = useState<string | null>(null);
  const [analyzingSourceId, setAnalyzingSourceId] = useState<string | null>(null);
  const [pdfManualSearch, setPdfManualSearch] = useState<Record<string, string>>({});
  const [pdfSearching, setPdfSearching] = useState<Set<string>>(new Set());
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [globalSearchResults, setGlobalSearchResults] = useState<SemanticSearchResult[]>([]);
  const [isGlobalSearching, setIsGlobalSearching] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  // Reference manager state
  const [refSearch, setRefSearch] = useState('');
  const [refSort, setRefSort] = useState<'order' | 'author' | 'year'>('order');
  const [expandedRefIds, setExpandedRefIds] = useState<Set<string>>(new Set());
  const [visionWarning, setVisionWarning] = useState<string | null>(null);

  const runGlobalSearch = () => {
    const q = globalSearchQuery.trim();
    if (q.length < 3) return;
    setIsGlobalSearching(true);
    setGlobalSearchResults([]);
    setGlobalSearchError(null);
    searchSimilarManuscripts(q, 10)
      .then(r => setGlobalSearchResults(r))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const isCors = msg.includes('status 0') || msg.includes('CORS') || msg.includes('fetch') || msg.includes('NetworkError') || msg.includes('Failed to fetch');
        setGlobalSearchError(isCors
          ? 'Search API unreachable — CORS preflight failed. Apply nginx-cors.conf on the server (see repo) and reload nginx.'
          : `Search failed: ${msg}`
        );
      })
      .finally(() => setIsGlobalSearching(false));
  };

  // Citation management state
  const [citationAnalyses, setCitationAnalyses] = useState<Record<string, CitationAnalysis>>({});
  const [checkingCitationsId, setCheckingCitationsId] = useState<string | null>(null);
  const [bibStyle, setBibStyle] = useState<BibStyle>('apa');
  const [insertingBib, setInsertingBib] = useState(false);

  // Notify App.tsx of source changes (kept for backward compatibility while App.tsx is migrated)
  useEffect(() => {
    onSourcesChange?.(sources);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  type PdfWorkerResult = { type: 'result'; text: string } | { type: 'error'; message: string };

  const extractTextFromPDF = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      file.arrayBuffer().then(data => {
        const worker = new Worker(
          new URL('../workers/pdfWorker.ts', import.meta.url),
          { type: 'module' }
        );
        worker.onmessage = (e: MessageEvent<PdfWorkerResult>) => {
          worker.terminate();
          if (e.data.type === 'result') resolve(e.data.text);
          else reject(new Error(e.data.message));
        };
        worker.onerror = (err: ErrorEvent) => {
          worker.terminate();
          reject(new Error(err.message ?? String(err)));
        };
        // Transfer the ArrayBuffer to the worker (zero-copy)
        try {
          worker.postMessage({ type: 'extract', payload: data }, [data]);
        } catch (err) {
          worker.terminate();
          reject(err);
        }
      }).catch(reject);
    });
  };

  const processFiles = async (files: File[]) => {
    const supported = ['.pdf', '.bib', '.txt', '.md', '.docx'];
    const filtered = files.filter(f => supported.some(ext => f.name.toLowerCase().endsWith(ext)));
    if (filtered.length === 0) return;

    setIsParsing(true);
    const newSources: typeof sources = [];

    for (const file of filtered) {
      setParsingFileName(file.name);
      const nameLower = file.name.toLowerCase();
      try {
        if (nameLower.endsWith('.pdf')) {
          const text = await extractTextFromPDF(file);
          if (!text || text.trim().length === 0) {
            throw new Error(`No text found in "${file.name}" — is it a scanned image-only PDF?`);
          }
          const id = Date.now().toString() + Math.random();
          newSources.push({ id, name: file.name, type: 'pdf' as const, text, queryText: undefined });
        } else if (nameLower.endsWith('.bib')) {
          const text = await file.text();
          new Cite(text);
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'bib' as const, text });
        } else if (nameLower.endsWith('.docx')) {
          let text: string;
          if (docxWorkerRef.current) {
            text = await docxWorkerRef.current.extractText(await file.arrayBuffer());
          } else {
            // Fallback if worker not ready
            const mammoth = await import('mammoth');
            const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
            text = result.value;
          }
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'text' as const, text });
        } else if (nameLower.endsWith('.txt') || nameLower.endsWith('.md')) {
          const text = await file.text();
          newSources.push({ id: Date.now().toString() + Math.random(), name: file.name, type: 'text' as const, text });
        }
      } catch (err) {
        console.error('Failed to parse file:', file.name, err);
      }
    }
    setParsingFileName(null);

    if (newSources.length > 0) {
      addSources(newSources);
      // Full pipeline for PDFs and text documents:
      // digest → Abstract Extraction Agent → DB search → scoring agent
      if (aiSettings) {
        for (const src of newSources) {
          if (src.type === 'pdf' || src.type === 'text') {
            const srcId = src.id;

            // Step 1 — Digest
            setDigestingId(srcId);
            setParsingFileName(`Digesting ${src.name}...`);
            let digest = '';
            try {
              digest = await digestApiSource(src.text, src.name, aiSettings);
              updateSource(srcId, { digest });
            } catch (_) {}
            setDigestingId(null);

            // Step 2 — Abstract Extraction Agent (AEA)
            setParsingFileName(`Extracting abstract for ${src.name}...`);
            let abstractText = '';
            try {
              abstractText = await extractPdfAbstractAea(src.text, src.name, aiSettings);
              updateSource(srcId, { abstractText });
            } catch (_) {}

            // Step 3 — Database search (prefer abstract over digest for query)
            setParsingFileName(`Searching database for ${src.name}...`);
            const searchQuery = (abstractText && abstractText.length > 50 && !abstractText.startsWith('Abstract not available'))
              ? abstractText.slice(0, 700)
              : digest.replace(/\*\*[^*]+\*\*:?/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);

            if (searchQuery.length >= 3) {
              try {
                const results = await searchSimilarManuscripts(searchQuery, 10);
                if (results.length > 0) {
                  const top10 = results.slice(0, 10);
                  // Set results immediately so the UI shows while scoring runs
                  setPendingPdfMatches(prev => ({ ...prev, [srcId]: { results: top10, matchIndex: 0 } }));

                  // Step 4 — Scoring agent (async, updates UI when done)
                  const queryForScoring = (abstractText && !abstractText.startsWith('Abstract not available'))
                    ? abstractText
                    : digest;
                  scorePdfMatches(src.name, queryForScoring, top10, aiSettings)
                    .then(scores => {
                      if (scores.length > 0) {
                        // Re-order results by score, update matchIndex to 0
                        const ordered = scores.map(s => top10[s.index]).filter(Boolean);
                        setPendingPdfMatches(prev => {
                          const existing = prev[srcId];
                          if (!existing) return prev;
                          return { ...prev, [srcId]: { results: ordered, matchIndex: 0, scores } };
                        });
                      }
                    })
                    .catch(() => {});
                }
              } catch (_) {}
            }

            setParsingFileName(null);
          }
        }
      }
    }
    setIsParsing(false);
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    await processFiles(Array.from(e.dataTransfer.files));
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    await processFiles(files);
    if (fileUploadRef.current) fileUploadRef.current.value = '';
  };

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

  const handleCheckCitations = (source: { id: string; text: string }) => {
    setCheckingCitationsId(source.id);
    try {
      const analysis = detectOrphanedCitations(source.text, manuscriptContent);
      setCitationAnalyses(prev => ({ ...prev, [source.id]: analysis }));
    } catch (e) {
      console.error('Citation check failed:', e);
    } finally {
      setCheckingCitationsId(null);
    }
  };

  // Merge API sources delivered by App.tsx and auto-generate AI summaries
  useEffect(() => {
    if (!externalApiSources?.length) return;

    // Deduplicate by DOI against existing store sources
    const existingDois = new Set(sources.map(s => s.apiMeta?.doi).filter(Boolean));
    const toAdd = externalApiSources.filter(s => !s.apiMeta?.doi || !existingDois.has(s.apiMeta.doi));
    if (toAdd.length) addSources(toAdd);
    onExternalSourcesMerged?.();

    // Fire-and-forget digest for each new source
    if (aiSettings) {
      for (const src of externalApiSources) {
        setDigestingApiIds(prev => new Set([...prev, src.id]));
        digestApiSource(src.text, src.name, aiSettings)
          .then(digest => { updateSource(src.id, { digest }); })
          .catch(() => {})
          .finally(() => {
            setDigestingApiIds(prev => { const next = new Set(prev); next.delete(src.id); return next; });
          });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalApiSources]);

  // Clear all sources when a new manuscript is started
  useEffect(() => {
    if (!clearSourcesTrigger) return; // 0 = initial mount, skip
    clearSources();
    setPendingPdfMatches({});
  }, [clearSourcesTrigger]);

  const handleExtractAbstract = async (source: ManuscriptSource) => {
    if (!aiSettings || extractingAbstractIds.has(source.id)) return;
    setExtractingAbstractIds(prev => new Set([...prev, source.id]));
    try {
      const abstractText = await extractPdfAbstractAea(source.text ?? '', source.name, aiSettings);
      updateSource(source.id, { abstractText });
    } catch (_) {
      updateSource(source.id, { abstractText: 'Abstract not available.' });
    }
    setExtractingAbstractIds(prev => { const next = new Set(prev); next.delete(source.id); return next; });
  };

  const handleReDigestSource = async (source: ManuscriptSource) => {
    if (!aiSettings || reDigestingIds.has(source.id)) return;
    setReDigestingIds(prev => new Set([...prev, source.id]));
    try {
      const digest = await digestApiSource(source.text ?? '', source.name, aiSettings);
      updateSource(source.id, { digest });
    } catch (_) {}
    setReDigestingIds(prev => { const next = new Set(prev); next.delete(source.id); return next; });
  };

  const handleInsertBibliography = (bibSourceText: string, onInsert: (html: string) => void) => {
    setInsertingBib(true);
    try {
      const html = formatBibliography(bibSourceText, bibStyle);
      onInsert(html);
    } catch (e) {
      console.error('Bibliography format failed:', e);
    } finally {
      setInsertingBib(false);
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

  useEffect(() => {
    if (activeTabOverride) setActiveTabLocal(activeTabOverride);
  }, [activeTabOverride]);

  const setActiveTab = (tab: 'chat' | 'suggestions' | 'history' | 'sources' | 'outline') => {
    setActiveTabLocal(tab);
    onTabChange?.(tab);
  };
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('manager');
  const [agentMode, setAgentMode] = useState(false);
  const handleAgentChange = (agent: AgentType) => {
    setSelectedAgent(agent);
    onAgentChange?.(agent);
  };
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
      // Wait for tab switch + DOM render before scrolling
      setTimeout(() => {
        suggestionRefs.current[highlightedSuggestionId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  }, [highlightedSuggestionId]);

  useEffect(() => {
    if (activeTab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, activeTab]);

  const agents = Object.entries(AGENT_INFO)
    .filter(([id]) => id !== 'manuscript-ai' && id !== 'literature-reviewer' && id !== 'citation-checker')
    .map(([id, info]) => ({ id: id as AgentType, ...info }));

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

  // Parse headings from manuscript HTML for the Outline tab
  const outline = useMemo(() => {
    if (!manuscriptHtml) return [];
    const re = /<h([23])[^>]*>(.*?)<\/h[23]>/gi;
    return [...manuscriptHtml.matchAll(re)].map(m => ({
      level: parseInt(m[1]),
      text: m[2].replace(/<[^>]*>/g, '').trim(),
    }));
  }, [manuscriptHtml]);

  // Word count per H2 section
  const h2WordCounts = useMemo(() => {
    if (!manuscriptHtml) return {} as Record<string, number>;
    const h2Re = /<h2[^>]*>(.*?)<\/h2>/gi;
    const h2Matches = [...manuscriptHtml.matchAll(h2Re)];
    const counts: Record<string, number> = {};
    h2Matches.forEach((m, i) => {
      const title = m[1].replace(/<[^>]*>/g, '').trim();
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < h2Matches.length ? (h2Matches[i + 1].index ?? manuscriptHtml.length) : manuscriptHtml.length;
      const text = manuscriptHtml.slice(start, end).replace(/<[^>]*>/g, ' ');
      counts[title] = text.split(/\s+/).filter(w => w.length > 0).length;
    });
    return counts;
  }, [manuscriptHtml]);

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

  return (
    <div className="w-full h-full flex flex-col overflow-hidden" style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface-0)' }}>
      {/* Tab bar */}
      <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
        {([
          { key: 'chat' as const, icon: <MessageSquare size={14} />, label: 'Chat' },
          { key: 'suggestions' as const, icon: <Sparkles size={14} />, label: 'Review' },
          { key: 'history' as const, icon: <HistoryIcon size={14} />, label: 'History' },
          { key: 'sources' as const, icon: <BookOpen size={14} />, label: 'Sources' },
          { key: 'outline' as const, icon: <List size={14} />, label: 'Outline' },
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

      <div
        className="flex-1 overflow-y-auto p-4"
        style={{ fontSize: `${contentZoom}%` }}
      >
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
          <div className="space-y-4"
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
            onDrop={handleFileDrop}
          >
            {(isParsing || digestingId || digestingApiIds.size > 0) && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
                <Sparkles className="animate-spin text-blue-500 shrink-0" size={14} />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {isParsing ? 'Parsing files...' : 'Generating AI summary...'}
                  </span>
                  {parsingFileName && <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{parsingFileName}</p>}
                  {(digestingId || digestingApiIds.size > 0) && !parsingFileName && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Summarizing in context of your manuscript</p>}
                </div>
              </div>
            )}
            {analyzingSourceId && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
                <Sparkles className="animate-spin text-violet-500 shrink-0" size={14} />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>Comparing manuscripts...</span>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Literature Reviewer is analyzing support &amp; contradictions</p>
                </div>
              </div>
            )}
            <div
              className={`text-center py-6 border-2 border-dashed rounded-xl transition-colors cursor-pointer ${isDragging ? 'border-blue-500 bg-blue-50/50' : 'hover:border-stone-400 hover:bg-stone-50/50'}`}
              style={{ borderColor: isDragging ? 'var(--accent-blue)' : 'var(--border)' }}
              onClick={() => fileUploadRef.current?.click()}
            >
              <UploadCloud size={24} className="mx-auto mb-2 opacity-50" style={{ color: 'var(--text-muted)' }} />
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Drop or click to upload sources</p>
              <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>PDF, .bib, .docx, .txt, .md — AI-digested automatically</p>
              <div className="mt-2 flex items-center justify-center gap-1.5">
                <button
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-semibold border transition-colors hover:bg-stone-100"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                  onClick={(e) => { e.stopPropagation(); fileUploadRef.current?.click(); }}
                >
                  <FolderOpen size={11} /> Browse files
                </button>
              </div>
            </div>
            <input
              ref={fileUploadRef}
              type="file"
              accept=".pdf,.bib,.txt,.md,.docx"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />

            {/* Manual manuscript search */}
            <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                <Search size={12} style={{ color: 'var(--text-muted)' }} />
                <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Find Manuscripts</span>
              </div>
              <div className="p-3 space-y-2">
                <div className="flex gap-1.5">
                  <input
                    value={globalSearchQuery}
                    onChange={e => { setGlobalSearchQuery(e.target.value); setGlobalSearchError(null); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && globalSearchQuery.trim().length >= 3) runGlobalSearch();
                    }}
                    placeholder="Title, keywords, or paste abstract…"
                    className="flex-1 text-[11px] px-2.5 py-1.5 border rounded-lg focus:outline-none"
                    style={{ borderColor: globalSearchError ? '#f87171' : 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
                  />
                  <button
                    disabled={isGlobalSearching || globalSearchQuery.trim().length < 3}
                    onClick={runGlobalSearch}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-40"
                    style={{ background: 'var(--accent-blue)', color: '#fff' }}
                  >
                    {isGlobalSearching ? <Sparkles size={11} className="animate-spin" /> : <Search size={11} />}
                    {isGlobalSearching ? '' : 'Search'}
                  </button>
                </div>
                {globalSearchError && (
                  <p className="text-[10px] px-1" style={{ color: '#ef4444' }}>{globalSearchError}</p>
                )}

                {/* Results */}
                {globalSearchResults.length > 0 && (
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pr-0.5">
                    {globalSearchResults.map((r, i) => {
                      const alreadyAdded = sources.some(s => s.apiMeta?.doi && s.apiMeta.doi === r.doi);
                      return (
                        <div key={i} className="border rounded-lg p-2 space-y-0.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-0)' }}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-[11px] font-semibold leading-tight flex-1" style={{ color: 'var(--text-primary)' }}>{r.title}</p>
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                              {Math.round(r.score * 100)}%
                            </span>
                          </div>
                          <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>{r.authors}</p>
                          <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                            {r.journal}{r.year ? `, ${r.year}` : ''}
                          </p>
                          <div className="flex items-center gap-1.5 pt-0.5">
                            <button
                              disabled={alreadyAdded}
                              onClick={() => {
                                if (alreadyAdded) return;
                                const src: ManuscriptSource = {
                                  id: `api-${Date.now()}-${Math.random()}`,
                                  name: r.title,
                                  type: 'api',
                                  text: r.abstract,
                                  apiMeta: r,
                                  queryText: globalSearchQuery.trim(),
                                };
                                addSources([src]);
                                // Fire-and-forget digest
                                if (aiSettings) {
                                  setDigestingApiIds(prev => new Set([...prev, src.id]));
                                  digestApiSource(src.text, src.name, aiSettings)
                                    .then(digest => updateSource(src.id, { digest }))
                                    .catch(() => {})
                                    .finally(() => setDigestingApiIds(prev => { const n = new Set(prev); n.delete(src.id); return n; }));
                                }
                              }}
                              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold transition-colors disabled:opacity-40"
                              style={{ background: alreadyAdded ? 'var(--surface-2)' : 'var(--accent-blue)', color: alreadyAdded ? 'var(--text-muted)' : '#fff' }}
                            >
                              <Plus size={9} />
                              {alreadyAdded ? 'Added' : 'Add source'}
                            </button>
                            {r.doi && (
                              <a href={doiToUrl(r.doi)} target="_blank" rel="noreferrer"
                                className="flex items-center gap-1 text-[10px] hover:underline"
                                style={{ color: 'var(--accent-blue)' }}>
                                <ExternalLink size={9} /> DOI
                              </a>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!isGlobalSearching && !globalSearchError && globalSearchQuery.trim().length >= 3 && globalSearchResults.length === 0 && (
                  <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-muted)' }}>No results — try different keywords</p>
                )}
              </div>
            </div>

            {/* Bibliography Formatter — shown when at least one .bib source is loaded */}
            {sources.some(s => s.type === 'bib') && (
              <div className="border rounded-xl p-3 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                <div className="flex items-center gap-2">
                  <Library size={13} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Auto-format Bibliography</span>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={bibStyle}
                    onChange={e => setBibStyle(e.target.value as BibStyle)}
                    className="flex-1 text-[11px] rounded-lg px-2 py-1.5 border focus:outline-none"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-secondary)' }}
                  >
                    {(Object.entries(BIB_STYLE_LABELS) as [BibStyle, string][]).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const bibSource = sources.find(s => s.type === 'bib');
                      if (!bibSource) return;
                      handleInsertBibliography(bibSource.text, (html) => {
                        // Notify parent to append bibliography HTML to the editor
                        onAnalyzeSection?.(`<h2>References</h2>${html}`, '__bibliography__');
                      });
                    }}
                    disabled={insertingBib}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
                    style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  >
                    <Library size={11} />
                    {insertingBib ? 'Formatting...' : 'Insert'}
                  </button>
                </div>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  Appends a formatted bibliography to the end of your manuscript.
                </p>
              </div>
            )}

            {/* Reference Manager */}
            {citationRegistry && Object.keys(citationRegistry).length > 0 && (() => {
              // Build sorted + filtered reference list
              const allEntries = Object.entries(citationRegistry).map(([id, numRaw]) => {
                const num = numRaw as number;
                const src = sources.find(s => s.id === id);
                const author = src?.apiMeta?.authors?.split(/[,;]/)[0]?.trim() ?? src?.name.replace(/\.(pdf|txt|md|docx)$/i, '') ?? '';
                const year = src?.apiMeta?.year ?? 0;
                const title = src?.apiMeta?.title ?? src?.name ?? '';
                const count = documentHTML ? countCitationOccurrences(documentHTML, num) : 0;
                return { id, num, src, author, year, title, count };
              });

              const filtered = allEntries.filter(e => {
                if (!refSearch.trim()) return true;
                const q = refSearch.toLowerCase();
                return e.author.toLowerCase().includes(q) || e.title.toLowerCase().includes(q) || String(e.year).includes(q);
              });

              const sorted = [...filtered].sort((a, b) => {
                if (refSort === 'author') return a.author.localeCompare(b.author);
                if (refSort === 'year') return b.year - a.year;
                return a.num - b.num;
              });

              return (
                <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
                  {/* Header */}
                  <div className="px-3 pt-2.5 pb-2 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <BookMarked size={13} style={{ color: 'var(--text-muted)' }} />
                        <span className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Reference Manager</span>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                          {allEntries.length}
                        </span>
                      </div>
                      <button
                        onClick={onRenumberCitations}
                        title="Renumber citations in document order"
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold"
                        style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                      >
                        <RefreshCw size={9} /> Sync order
                      </button>
                    </div>

                    {/* Search + sort row */}
                    <div className="flex gap-1.5">
                      <div className="flex-1 flex items-center gap-1.5 px-2 py-1 rounded-lg" style={{ background: 'var(--surface-0)', border: '1px solid var(--border)' }}>
                        <Search size={10} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                        <input
                          value={refSearch}
                          onChange={e => setRefSearch(e.target.value)}
                          placeholder="Search references…"
                          className="flex-1 bg-transparent text-[11px] outline-none"
                          style={{ color: 'var(--text-primary)' }}
                        />
                        {refSearch && (
                          <button onClick={() => setRefSearch('')} style={{ color: 'var(--text-muted)' }}>
                            <X size={10} />
                          </button>
                        )}
                      </div>
                      <select
                        value={refSort}
                        onChange={e => setRefSort(e.target.value as any)}
                        className="text-[10px] rounded-lg px-1.5 outline-none"
                        style={{ background: 'var(--surface-0)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                      >
                        <option value="order"># Order</option>
                        <option value="author">Author</option>
                        <option value="year">Year</option>
                      </select>
                    </div>
                  </div>

                  {/* Reference list */}
                  <div className="divide-y max-h-[480px] overflow-y-auto" style={{ borderColor: 'var(--border)' }}>
                    {sorted.length === 0 && (
                      <p className="px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>No references match.</p>
                    )}
                    {sorted.map(({ id, num, src, author, year, title, count }) => {
                      const isExpanded = expandedRefIds.has(id);
                      const doi = src?.apiMeta?.doi;
                      const journal = src?.apiMeta?.journal;
                      const abstract = src?.digest || src?.text?.slice(0, 300);
                      return (
                        <div key={id} style={{ background: 'var(--surface-0)' }}>
                          <div className="flex items-start gap-2 px-3 py-2.5">
                            {/* Citation number badge */}
                            <span
                              className="text-[10px] font-bold tabular-nums shrink-0 mt-0.5 min-w-[20px] text-center rounded-md px-1 py-0.5 cursor-pointer"
                              style={{ background: 'var(--accent-blue)', color: '#fff' }}
                              title="Jump to first citation"
                              onClick={() => onScrollToCitation?.(num)}
                            >
                              {num}
                            </span>

                            <div className="flex-1 min-w-0">
                              {/* Author + year */}
                              <div className="flex items-baseline gap-1.5 flex-wrap">
                                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                  {author || '(unknown)'}
                                </span>
                                {year > 0 && (
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({year})</span>
                                )}
                              </div>
                              {/* Title */}
                              {title && (
                                <p className={`text-[10px] mt-0.5 ${isExpanded ? '' : 'truncate'}`} style={{ color: 'var(--text-secondary)' }}>
                                  {title}
                                </p>
                              )}
                              {/* Journal */}
                              {journal && isExpanded && (
                                <p className="text-[10px] mt-0.5 italic" style={{ color: 'var(--text-muted)' }}>{journal}</p>
                              )}
                              {/* DOI */}
                              {doi && isExpanded && (
                                <a href={doiToUrl(doi)} target="_blank" rel="noreferrer"
                                  className="text-[9px] hover:underline flex items-center gap-0.5 mt-0.5"
                                  style={{ color: 'var(--accent-blue)' }}>
                                  <ExternalLink size={8} /> {doi}
                                </a>
                              )}
                              {/* Abstract/digest snippet */}
                              {abstract && isExpanded && (
                                <p className="text-[10px] mt-1.5 leading-relaxed line-clamp-4" style={{ color: 'var(--text-muted)', borderLeft: '2px solid var(--border)', paddingLeft: '6px' }}>
                                  {abstract}
                                </p>
                              )}
                              {/* Meta row: citation count + expand toggle */}
                              <div className="flex items-center gap-2 mt-1">
                                {count > 0 && (
                                  <span className="flex items-center gap-0.5 text-[9px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                    <Hash size={8} /> {count}×
                                  </span>
                                )}
                                {(title || doi || abstract) && (
                                  <button
                                    onClick={() => setExpandedRefIds(prev => {
                                      const s = new Set(prev);
                                      s.has(id) ? s.delete(id) : s.add(id);
                                      return s;
                                    })}
                                    className="text-[9px]"
                                    style={{ color: 'var(--accent-blue)' }}
                                  >
                                    {isExpanded ? 'Less' : 'More'}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Action buttons */}
                            <div className="flex flex-col gap-1 shrink-0">
                              <button
                                onClick={() => onScrollToCitation?.(num)}
                                title="Jump to citation in document"
                                className="p-1 rounded hover:opacity-80"
                                style={{ color: 'var(--accent-blue)' }}
                              >
                                <ArrowRight size={11} />
                              </button>
                              <button
                                onClick={() => onRemoveCitation?.(id)}
                                title="Remove citation"
                                className="p-1 rounded hover:opacity-80"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                <X size={11} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1.5 px-3 py-2 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
                    <button
                      onClick={() => {
                        const entries = Object.entries(citationRegistry).sort((a, b) => a[1] - b[1]);
                        const lines = entries.map(([id, num]) => {
                          const src = sources.find(s => s.id === id);
                          if (!src) return `<li>[${num}] (source not found)</li>`;
                          if (src.apiMeta) {
                            const m = src.apiMeta;
                            const doiPart = m.doi ? ` doi:${m.doi}` : '';
                            return `<li>[${num}] ${m.authors}${m.year ? ` (${m.year})` : ''}. ${m.title}. <em>${m.journal}</em>.${doiPart}</li>`;
                          }
                          return `<li>[${num}] ${src.name.replace(/\.(pdf|txt|md|docx)$/i, '')}</li>`;
                        });
                        onAnalyzeSection?.(`<h2>References</h2><ol>${lines.join('')}</ol>`, '__bibliography__');
                      }}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold"
                      style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                    >
                      <BookMarked size={11} />
                      Insert reference list
                    </button>
                  </div>
                </div>
              );
            })()}

            {sources.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
                  Sources ({sources.length})
                  {sources.some(s => s.type === 'api') && (
                    <span className="ml-1.5 normal-case font-medium" style={{ color: 'var(--accent-blue)' }}>
                      · {sources.filter(s => s.type === 'api').length} from search
                    </span>
                  )}
                </h3>
                {sources.map((source) => (
                  <div key={source.id} className="rounded-xl shadow-sm overflow-hidden" style={{ border: source.type === 'api' ? '1.5px solid rgba(139,92,246,0.5)' : '1px solid var(--border)', background: source.type === 'api' ? 'var(--surface-2)' : 'var(--surface-1)', boxShadow: source.type === 'api' ? '0 2px 8px rgba(124,58,237,0.08)' : undefined }}>
                    <div className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-2 overflow-hidden">
                        {source.type === 'api' ? <Search size={14} style={{ color: '#7c3aed' }} className="shrink-0" /> : <FileText size={14} style={{ color: 'var(--text-tertiary)' }} className="shrink-0" />}
                        <div className="truncate">
                          <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{source.name}</p>
                          <p className="text-[9px]" style={{ color: 'var(--text-tertiary)' }}>
                            {source.type === 'api' ? (
                              <>
                                <span className="text-violet-600 font-semibold">{source.apiMeta?.source}</span>
                                {source.apiMeta?.year && <span> · {source.apiMeta.year}</span>}
                                {source.apiMeta && (
                                  <span className={`ml-1 font-semibold ${source.apiMeta.score >= 0.8 ? 'text-emerald-600' : source.apiMeta.score >= 0.7 ? 'text-amber-600' : 'text-stone-500'}`}>
                                    · {(source.apiMeta.score * 100).toFixed(0)}% match
                                  </span>
                                )}
                              </>
                            ) : (
                              <>
                                {source.type.toUpperCase()} • {Math.round(source.text.length / 1024)} KB
                                {source.digest && <span className="ml-1 text-emerald-600 font-semibold">• digested</span>}
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                      <button
                        className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors shrink-0" style={{ color: 'var(--text-muted)' }}
                        onClick={() => {
                          useSourceStore.getState().removeSource(source.id);
                          setPendingPdfMatches(prev => { const { [source.id]: _, ...rest } = prev; return rest; });
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {/* PDF match confirmation UI */}
                    {source.type === 'pdf' && (() => {
                      const hasPending = !!pendingPdfMatches[source.id];
                      const isSearching = pdfSearching.has(source.id);
                      const manualQuery = pdfManualSearch[source.id] ?? '';

                      const runManualSearch = () => {
                        const q = manualQuery.trim();
                        if (q.length < 3) return;
                        setPdfSearching(prev => new Set([...prev, source.id]));
                        const srcId = source.id;
                        searchSimilarManuscripts(q, 10)
                          .then(results => {
                            if (results.length > 0) {
                              const top10 = results.slice(0, 10);
                              setPendingPdfMatches(prev => ({ ...prev, [srcId]: { results: top10, matchIndex: 0 } }));
                              // Run scoring agent if AI settings available
                              if (aiSettings) {
                                const queryForScoring = source.abstractText && !source.abstractText.startsWith('Abstract not available')
                                  ? source.abstractText
                                  : source.digest ?? q;
                                scorePdfMatches(source.name, queryForScoring, top10, aiSettings)
                                  .then(scores => {
                                    if (scores.length > 0) {
                                      const ordered = scores.map(s => top10[s.index]).filter(Boolean);
                                      setPendingPdfMatches(prev => {
                                        const existing = prev[srcId];
                                        if (!existing) return prev;
                                        return { ...prev, [srcId]: { results: ordered, matchIndex: 0, scores } };
                                      });
                                    }
                                  })
                                  .catch(() => {});
                              }
                            }
                          })
                          .catch(() => {})
                          .finally(() => setPdfSearching(prev => { const s = new Set(prev); s.delete(srcId); return s; }));
                      };

                      return (
                        <div className="px-3 pb-3 space-y-2">
                          {/* Manual search row */}
                          <div className="flex gap-1.5">
                            <input
                              value={manualQuery}
                              onChange={e => setPdfManualSearch(prev => ({ ...prev, [source.id]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') runManualSearch(); }}
                              placeholder="Search paper title or keywords…"
                              className="flex-1 text-[10px] px-2 py-1.5 border rounded-lg focus:outline-none"
                              style={{ borderColor: 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
                            />
                            <button
                              onClick={runManualSearch}
                              disabled={isSearching || manualQuery.trim().length < 3}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-40"
                              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                            >
                              <Search size={10} />
                              {isSearching ? '…' : 'Search'}
                            </button>
                          </div>

                          {hasPending && (() => {
                            const match = pendingPdfMatches[source.id];
                            const result = match.results[match.matchIndex];
                            if (!result) return null;
                            // Find score entry for the current result (scores are already in display order)
                            const currentScore = match.scores?.[match.matchIndex];
                            const hasScore = currentScore && currentScore.score >= 0;
                            return (
                              <div className="p-2.5 rounded-lg border space-y-1.5" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-[10px] font-bold text-amber-700 flex items-center gap-1">
                                    <Zap size={10} />
                                    Is this your paper? ({match.matchIndex + 1}/{match.results.length})
                                  </p>
                                  {hasScore && (
                                    <span
                                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                                      style={{
                                        background: currentScore.score >= 70 ? 'var(--accent-green-soft, #d1fae5)' : currentScore.score >= 40 ? 'var(--accent-yellow-soft, #fef9c3)' : 'var(--surface-3, #f1f5f9)',
                                        color: currentScore.score >= 70 ? '#065f46' : currentScore.score >= 40 ? '#713f12' : 'var(--text-muted)',
                                      }}
                                    >
                                      {currentScore.score}/100
                                    </span>
                                  )}
                                </div>
                                <p className="text-[11px] font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
                                  {result.title}
                                </p>
                                <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={result.authors}>
                                  {result.authors}
                                </p>
                                <p className="text-[10px] italic" style={{ color: 'var(--text-tertiary)' }}>
                                  {result.journal}{result.year ? `, ${result.year}` : ''}
                                </p>
                                {hasScore && currentScore.reason && (
                                  <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                                    {currentScore.reason}
                                  </p>
                                )}
                                <div className="flex gap-1.5 pt-0.5">
                                  <button
                                    onClick={() => {
                                      updateSource(source.id, { name: result.title, apiMeta: result });
                                      setPendingPdfMatches(prev => { const { [source.id]: _, ...rest } = prev; return rest; });
                                    }}
                                    className="flex-1 py-1 rounded text-[10px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
                                  >
                                    Yes, this is it
                                  </button>
                                  {match.matchIndex + 1 < match.results.length && (
                                    <button
                                      onClick={() => setPendingPdfMatches(prev => ({
                                        ...prev,
                                        [source.id]: { ...prev[source.id], matchIndex: prev[source.id].matchIndex + 1 }
                                      }))}
                                      className="flex-1 py-1 border rounded text-[10px] font-semibold transition-colors hover:bg-stone-50"
                                      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                                    >
                                      Try next
                                    </button>
                                  )}
                                  <button
                                    onClick={() => setPendingPdfMatches(prev => { const { [source.id]: _, ...rest } = prev; return rest; })}
                                    className="px-2 py-1 border rounded text-[10px] transition-colors hover:bg-stone-50"
                                    style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                                  >
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}

                    {/* API source metadata + tabbed Summary / Abstract */}
                    {source.type === 'api' && source.apiMeta && (() => {
                      const m = source.apiMeta;
                      const doiUrl = m.doi ? doiToUrl(m.doi) : null;
                      const activeTab = sourceActiveTabs[source.id] ?? 'summary';
                      const isDigesting = digestingApiIds.has(source.id);

                      return (
                        <div className="space-y-0">
                          {/* Meta row: authors, journal, DOI, query */}
                          <div className="px-3 pb-2 space-y-1">
                            {source.queryText && (
                              <p className="text-[9px] italic truncate" style={{ color: 'var(--text-muted)' }} title={`Query: ${source.queryText}`}>
                                Query: "{source.queryText.slice(0, 60)}{source.queryText.length > 60 ? '…' : ''}"
                              </p>
                            )}
                            <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={m.authors}>
                              {m.authors}
                            </p>
                            <p className="text-[10px] italic" style={{ color: 'var(--text-tertiary)' }}>
                              {m.journal}
                            </p>
                            {doiUrl && (
                              <a
                                href={doiUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-800 hover:underline truncate"
                              >
                                <ExternalLink size={10} className="shrink-0" />
                                <span className="truncate">{m.doi}</span>
                              </a>
                            )}
                          </div>

                          {/* Tabs */}
                          <div className="flex items-center border-b mx-3" style={{ borderColor: 'var(--border)' }}>
                            {(['summary', 'abstract'] as const).map(tab => (
                              <button
                                key={tab}
                                onClick={() => setSourceActiveTabs(prev => ({ ...prev, [source.id]: tab }))}
                                className={`px-3 py-1 text-[10px] font-semibold capitalize transition-colors ${
                                  activeTab === tab
                                    ? 'border-b-2 -mb-px border-violet-500 text-violet-700'
                                    : 'text-stone-400 hover:text-stone-600'
                                }`}
                              >
                                {tab}
                              </button>
                            ))}
                            {aiSettings && activeTab === 'summary' && (
                              <button
                                onClick={() => handleReDigestSource(source)}
                                disabled={reDigestingIds.has(source.id) || digestingApiIds.has(source.id)}
                                className="ml-auto p-0.5 rounded hover:bg-stone-100 transition-colors disabled:opacity-40"
                                title="Regenerate AI summary"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                <RefreshCw size={10} className={reDigestingIds.has(source.id) ? 'animate-spin' : ''} />
                              </button>
                            )}
                          </div>

                          {/* Tab content */}
                          <div className="px-3 pt-2 pb-3">
                            {activeTab === 'summary' ? (
                              (isDigesting || reDigestingIds.has(source.id)) ? (
                                <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'rgba(139,92,246,0.06)', color: 'var(--text-muted)' }}>
                                  <Sparkles size={11} className="animate-spin text-violet-400 shrink-0" />
                                  {reDigestingIds.has(source.id) ? 'Regenerating summary…' : 'Generating summary…'}
                                </div>
                              ) : source.digest ? (
                                <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                                    ul: ({...props}) => <ul className="list-disc pl-4 space-y-0.5" {...props} />,
                                    li: ({...props}) => <li {...props} />,
                                    p: ({...props}) => <p className="mb-1 last:mb-0" {...props} />,
                                  }}>
                                    {source.digest}
                                  </ReactMarkdown>
                                </div>
                              ) : (
                                <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                                  {aiSettings ? 'Summary not available.' : 'Configure an AI provider in Settings to generate summaries.'}
                                </p>
                              )
                            ) : (
                              /* Abstract tab */
                              <div className="text-[10px] leading-relaxed p-2 rounded-lg" style={{ background: 'rgba(139,92,246,0.06)', color: 'var(--text-secondary)', border: '1px solid rgba(139,92,246,0.12)' }}>
                                {m.abstract}
                              </div>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div className="px-3 pb-3 flex gap-1.5">
                            <button
                              onClick={() => navigator.clipboard.writeText(resultToBibtex(m))}
                              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-semibold transition-colors"
                              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                              title="Copy BibTeX entry to clipboard"
                            >
                              <Copy size={10} /> BibTeX
                            </button>
                            {aiSettings && (
                              <button
                                disabled={!!analyzingSourceId}
                                onClick={() => handleAnalyzeSource(source)}
                                className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-semibold transition-colors disabled:opacity-50"
                                style={{ background: 'rgba(109,40,217,0.08)', color: '#6d28d9', border: '1px solid rgba(109,40,217,0.2)' }}
                              >
                                <BookMarked size={10} />
                                {analyzingSourceId === source.id ? 'Analyzing…' : 'Compare'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {source.type === 'bib' && (
                      <div className="px-3 pb-3 space-y-2">
                        <button
                          onClick={() => handleCheckCitations(source)}
                          disabled={checkingCitationsId === source.id}
                          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
                          style={{ background: 'var(--teal-soft, #f0fdfa)', color: 'var(--teal-700, #0f766e)', border: '1px solid var(--teal-200, #99f6e4)' }}
                        >
                          <CheckCircle2 size={12} />
                          {checkingCitationsId === source.id ? 'Checking...' : 'Check Citations'}
                        </button>
                        {citationAnalyses[source.id] && (() => {
                          const a = citationAnalyses[source.id];
                          return (
                            <div className="space-y-2 text-[11px]">
                              <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                <CheckCircle2 size={11} className="text-emerald-500" />
                                {a.citedInText.length} cited · {a.unusedInBib.length} unused · {a.orphanedInText.length} unmatched
                              </div>
                              {a.orphanedInText.length > 0 && (
                                <div className="p-2 rounded-lg" style={{ background: 'var(--rose-soft, #fff1f2)', border: '1px solid #fecdd3' }}>
                                  <div className="flex items-center gap-1 text-[10px] font-bold text-rose-600 mb-1"><AlertTriangle size={10} /> Not in .bib file</div>
                                  {a.orphanedInText.map(c => <div key={c} className="text-rose-700 font-mono text-[10px]">{c}</div>)}
                                </div>
                              )}
                              {a.unusedInBib.length > 0 && (
                                <div className="p-2 rounded-lg" style={{ background: 'var(--amber-soft, #fffbeb)', border: '1px solid #fde68a' }}>
                                  <div className="flex items-center gap-1 text-[10px] font-bold text-amber-600 mb-1"><AlertTriangle size={10} /> Unused .bib entries</div>
                                  {a.unusedInBib.slice(0, 5).map(e => <div key={e.key} className="text-amber-700 text-[10px] truncate" title={e.title}>{e.authorYear} — {e.title}</div>)}
                                  {a.unusedInBib.length > 5 && <div className="text-amber-600 text-[10px]">+{a.unusedInBib.length - 5} more</div>}
                                </div>
                              )}
                              {a.numericCitations.length > 0 && (
                                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                  {a.numericCitations.length} numeric citation(s) found — cross-check manually
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    {(source.type === 'pdf' || source.type === 'text') && aiSettings && (
                      <div className="px-3 pb-3 flex gap-2">
                        <button
                          disabled={!!analyzingSourceId}
                          onClick={() => handleAnalyzeSource(source)}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50"
                          style={{
                            background: analyzingSourceId === source.id ? 'var(--surface-2)' : 'var(--violet-soft, #f5f3ff)',
                            color: 'var(--violet-700, #6d28d9)',
                            border: '1px solid var(--violet-200, #ddd6fe)'
                          }}
                        >
                          <BookMarked size={12} />
                          {analyzingSourceId === source.id ? 'Analyzing...' : 'Compare'}
                        </button>
                        <button
                          onClick={() => {
                            // Set source-only context and switch to chat
                            setAttachedSourceIds(new Set([source.id]));
                            setActiveTab('chat');
                          }}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-colors"
                          style={{
                            background: 'var(--accent-blue-soft)',
                            color: 'var(--accent-blue)',
                            border: '1px solid rgba(59,111,212,0.2)'
                          }}
                        >
                          <MessageSquare size={12} />
                          Chat
                        </button>
                      </div>
                    )}
                    {source.type !== 'api' && source.apiMeta && (
                      <div className="px-3 pb-2 space-y-0.5">
                        <p className="text-[11px] font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>{source.apiMeta.title}</p>
                        <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }} title={source.apiMeta.authors}>{source.apiMeta.authors}</p>
                        <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                          {source.apiMeta.journal}{source.apiMeta.year ? `, ${source.apiMeta.year}` : ''}
                        </p>
                        {source.apiMeta.doi && (
                          <a href={doiToUrl(source.apiMeta.doi)} target="_blank" rel="noreferrer"
                            className="text-[10px] hover:underline flex items-center gap-1"
                            style={{ color: 'var(--accent-blue)' }}>
                            <ExternalLink size={9} />
                            {source.apiMeta.doi}
                          </a>
                        )}
                      </div>
                    )}
                    {source.type !== 'api' && aiSettings && (() => {
                      const pdfTab = pdfSourceTabs[source.id] ?? 'summary';
                      const isRedigesting = reDigestingIds.has(source.id) || digestingId === source.id;
                      const isExtractingAbstract = extractingAbstractIds.has(source.id);
                      return (
                        <div>
                          {/* Tabs row */}
                          <div className="flex items-center border-b border-t mx-3" style={{ borderColor: 'var(--border)' }}>
                            {(['summary', 'abstract'] as const).map(tab => (
                              <button
                                key={tab}
                                onClick={() => {
                                  setPdfSourceTabs(prev => ({ ...prev, [source.id]: tab }));
                                  // Lazy-extract abstract on first click if not yet fetched,
                                  // or if the stored result is any prior failure string and the
                                  // source now has real text (e.g. PDF re-uploaded after parsing fix).
                                  const isFailure = !source.abstractText ||
                                    source.abstractText.startsWith('Abstract not available') ||
                                    source.abstractText.startsWith('PDF text could not');
                                  const hasText = (source.text?.trim().length ?? 0) > 20;
                                  if (tab === 'abstract' && isFailure && hasText && !isExtractingAbstract) {
                                    updateSource(source.id, { abstractText: undefined });
                                    handleExtractAbstract(source);
                                  }
                                }}
                                className={`px-3 py-1 text-[10px] font-semibold capitalize transition-colors ${
                                  pdfTab === tab
                                    ? 'border-b-2 -mb-px border-blue-500 text-blue-700'
                                    : 'text-stone-400 hover:text-stone-600'
                                }`}
                              >
                                {tab}
                              </button>
                            ))}
                            {/* Refresh button — context-sensitive to active tab */}
                            <button
                              onClick={() => {
                                if (pdfTab === 'summary') {
                                  handleReDigestSource(source);
                                } else {
                                  updateSource(source.id, { abstractText: undefined });
                                  handleExtractAbstract(source);
                                }
                              }}
                              disabled={pdfTab === 'summary' ? isRedigesting : isExtractingAbstract}
                              className="ml-auto p-0.5 rounded hover:bg-stone-100 transition-colors disabled:opacity-40"
                              title={pdfTab === 'summary' ? 'Regenerate AI summary' : 'Re-extract abstract'}
                              style={{ color: 'var(--text-muted)' }}
                            >
                              <RefreshCw size={10} className={(pdfTab === 'summary' ? isRedigesting : isExtractingAbstract) ? 'animate-spin' : ''} />
                            </button>
                          </div>

                          {/* Tab content */}
                          <div className="px-3 pt-2 pb-3">
                            {pdfTab === 'summary' ? (
                              isRedigesting ? (
                                <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                                  <Sparkles size={11} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
                                  Regenerating summary…
                                </div>
                              ) : source.digest ? (
                                <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                                    ul: ({...props}) => <ul className="list-disc pl-4 space-y-0.5" {...props} />,
                                    li: ({...props}) => <li {...props} />,
                                    p: ({...props}) => <p className="mb-1 last:mb-0" {...props} />,
                                  }}>
                                    {source.digest}
                                  </ReactMarkdown>
                                </div>
                              ) : (
                                <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                                  No summary yet. Click <RefreshCw size={9} className="inline" /> to generate.
                                </p>
                              )
                            ) : (
                              /* Abstract tab */
                              isExtractingAbstract ? (
                                <div className="flex items-center gap-2 p-2 rounded-lg text-[10px]" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                                  <Sparkles size={11} className="animate-spin shrink-0" style={{ color: 'var(--accent-blue)' }} />
                                  Extracting abstract…
                                </div>
                              ) : source.abstractText ? (
                                <div className="text-[11px] leading-relaxed p-2 rounded-lg" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                                  {source.abstractText}
                                </div>
                              ) : (
                                <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>
                                  Click <RefreshCw size={9} className="inline" /> to extract abstract from the document.
                                </p>
                              )
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'outline' ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Document Outline</span>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{outline.filter(h => h.level === 2).length} sections</span>
            </div>
            {outline.length === 0 ? (
              <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
                <List size={28} className="mx-auto mb-3 opacity-30" />
                <p className="text-xs font-medium">No headings found</p>
                <p className="text-[10px] mt-1 opacity-70">Use H2 headings to structure your manuscript sections</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {outline.map((heading, i) => (
                  <div
                    key={i}
                    className={`group flex items-center justify-between rounded-lg transition-colors cursor-pointer hover:bg-stone-100 ${heading.level === 2 ? 'px-2 py-2' : 'pl-5 pr-2 py-1.5'}`}
                    onClick={() => onScrollToSection?.(heading.text)}
                    style={{ color: heading.level === 2 ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {heading.level === 2
                        ? <span className="w-1.5 h-1.5 rounded-full bg-stone-400 shrink-0" />
                        : <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0" />}
                      <span className={`truncate ${heading.level === 2 ? 'text-[12px] font-semibold' : 'text-[11px]'}`}>
                        {heading.text}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {heading.level === 2 && h2WordCounts[heading.text] !== undefined && (
                        <span className="text-[9px] font-medium opacity-50">{h2WordCounts[heading.text]}w</span>
                      )}
                      {heading.level === 2 && onAnalyzeSection && (
                        <button
                          onClick={e => { e.stopPropagation(); onAnalyzeSection('', heading.text); }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-stone-200"
                          title={`Analyze "${heading.text}" section`}
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <Sparkles size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {/* Chat input */}
      <div className="flex flex-col" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-1)' }}>

        {/* Mode switcher — Manuscript AI (default) vs Agent mode */}
        {activeTab === 'chat' && (
          <div className="flex items-stretch" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button
              onClick={() => setAgentMode(false)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-semibold transition-all ${!agentMode ? 'border-b-2 border-emerald-600' : 'hover:bg-stone-50'}`}
              style={{ color: !agentMode ? 'var(--accent-green)' : 'var(--text-muted)' }}
            >
              <AgentIcon agent="manuscript-ai" size={12} />
              Manuscript AI
            </button>
            <div style={{ width: '1px', background: 'var(--border-subtle)' }} />
            <button
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
          {activeTab === 'chat' && agentMode && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
              <span className="text-[9px] font-bold uppercase tracking-widest shrink-0 mr-1" style={{ color: 'var(--text-muted)' }}>Reply as:</span>
              {agents.map(agent => (
                <button
                  key={agent.id}
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
          {activeTab === 'chat' && (
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
          {activeTab === 'chat' && attachedImages.length > 0 && (
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
          {activeTab === 'chat' && visionWarning && (
            <div className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg text-[10px] leading-snug" style={{ background: '#fef9c3', color: '#854d0e' }}>
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>{visionWarning}</span>
              <button onClick={() => setVisionWarning(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100"><X size={10} /></button>
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
                activeTab !== 'chat' ? 'Switch to chat to send messages...' :
                !attachedSourceIds.has('__manuscript__') && attachedSourceIds.size > 0
                  ? 'Ask about the attached source document...'
                  : agentMode
                    ? `Ask the ${AGENT_INFO[selectedAgent]?.label} — produces suggestions...`
                    : 'Ask Manuscript AI anything about your manuscript...'
              }
              disabled={activeTab !== 'chat'}
              className="w-full p-3 pr-24 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-stone-800/10 resize-none min-h-[64px] transition-all disabled:opacity-50"
              style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
            {/* Image attach button */}
            {activeTab === 'chat' && (
              <button
                onClick={() => imageUploadRef.current?.click()}
                className="absolute right-20 bottom-3 p-2 rounded-lg transition-all hover:bg-stone-200"
                style={{ color: attachedImages.length > 0 ? 'var(--accent-blue)' : 'var(--text-muted)' }}
                title="Attach image (JPEG, PNG, WebP)"
              >
                <ImagePlus size={14} />
              </button>
            )}
            {/* Source picker button */}
            {activeTab === 'chat' && (
              <div className="absolute right-12 bottom-3" ref={sourcePickerRef}>
                <button
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
              onClick={handleSend}
              disabled={(!input.trim() && attachedImages.length === 0) || isAnalyzing || activeTab !== 'chat'}
              className="absolute right-3 bottom-3 p-2 bg-stone-800 text-white rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-all shadow-sm"
            >
              <Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
