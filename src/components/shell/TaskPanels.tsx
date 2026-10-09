import { BIBLIOGRAPHY_SECTION } from '../../hooks/useChat';
import { useState, useRef, useEffect, useCallback } from 'react';
import { AgentType, Message, Suggestion, HistoryItem, AISettings, AttachedImage, ManuscriptSource, VersionSnapshot } from '../../types';
import { Sparkles } from 'lucide-react';
import { StylePanel, type StylePanelProps } from '../style/StylePanel';
import { ReviewPanel, type ReviewPanelProps } from '../panels/ReviewPanel';
import { CitePanel } from '../panels/CitePanel';
import { WritePanel } from '../panels/WritePanel';
import { FormatPanel, type FormatPanelProps } from '../panels/FormatPanel';
import { useOutline } from '../panels/write/outline';
import { SuggestionDetail, RebuttalBox } from '../panels/SuggestionBody';
import { ChatSection } from '../panels/review/ChatSection';
import { useChatComposer } from '../panels/review/useChatComposer';
import { analyzeSourceAgainstManuscript } from '../../services/ai';
import type { PanelTab } from './shellLogic';

/** The panel beside the page: the active task's panel, with the other three kept mounted (hidden) so their in-progress state survives a visit elsewhere. Owns the chat composer, which the Cite panel also drives. */
interface TaskPanelsProps {
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
  activeTabOverride?: PanelTab;
  /** Props for the Style tab (sub-project H); the tab shows nothing useful without them. */
  stylePanel?: StylePanelProps;
  /** The Format panel (the 'style' tab is its home): page setup, named styles, the grant template. */
  formatPanel?: FormatPanelProps;
  /** The Review panel: one list of everything the AI and the style audit have to say, in document order, with chat folded in. */
  review?: Omit<ReviewPanelProps, 'chat' | 'analyzing' | 'highlightedRowId' | 'renderDetail' | 'renderFooter' | 'progress' | 'chatOpen' | 'onChatOpenChange' | 'zoom'>;
  /** Bumped by the host each time it wants the chat to be seen (a reply arrived); the Chat section opens. */
  chatRequest?: number;
  onTabChange?: (tab: PanelTab) => void;
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

export default function TaskPanels({
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
}: TaskPanelsProps) {
  const composer = useChatComposer(aiSettings, onSendMessage);
  const [activeTab, setActiveTabLocal] = useState<PanelTab>('chat');

  const [analyzingSourceId, setAnalyzingSourceId] = useState<string | null>(null);
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

  // The Review view is what the 'chat' and 'suggestions' tabs show now. Asking for the chat tab (analyzing a source, a source's Chat button)
  // opens the Chat section inside it.
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => { if (chatRequest) setChatOpen(true); }, [chatRequest]);
  const reviewView = !!review && (activeTab === 'chat' || activeTab === 'suggestions');
  useEffect(() => {
    if (activeTabOverride) setActiveTabLocal(activeTabOverride);
  }, [activeTabOverride]);

  const setActiveTab = (tab: PanelTab) => {
    setActiveTabLocal(tab);
    if (tab === 'chat') setChatOpen(true);
    onTabChange?.(tab);
  };
  useEffect(() => {
    if (highlightedSuggestionId) {
      // Open the Review view when a highlight is clicked in the editor; the panel scrolls its row into view.
      setActiveTab('suggestions');
    }
  }, [highlightedSuggestionId]);

  useEffect(() => {
    if (reviewView && chatOpen) {
      composer.chatEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [messages, reviewView, chatOpen]);

  const { outline, wordCounts } = useOutline(manuscriptHtml);
  const docRef = useRef({ title: documentTitle, content: manuscriptHtml });
  docRef.current = { title: documentTitle, content: manuscriptHtml };
  const getDocument = useCallback(() => docRef.current, []);
  const goToHeading = useCallback((text: string) => onScrollToSection?.(text), [onScrollToSection]);

  const suggestionFor = (rowId: string) => (rowId.startsWith('suggestion:') ? suggestions.find(s => s.id === rowId.slice('suggestion:'.length)) : undefined);
  const renderSuggestionDetail = (row: { id: string }) => { const s = suggestionFor(row.id); return s ? <SuggestionDetail s={s} /> : null; };
  const renderSuggestionFooter = (row: { id: string }) => (suggestionFor(row.id) ? <RebuttalBox suggestionId={suggestionFor(row.id)!.id} busy={isAnalyzing} onRebuttal={onRebuttal} /> : null);

  const chatNode = (
    <ChatSection c={composer} messages={messages} isAnalyzing={isAnalyzing} onStop={onStop} analyzingSourceId={analyzingSourceId}
      onSuggestionCardClick={onSuggestionCardClick} onAcceptSuggestion={onAcceptSuggestion} onRejectSuggestion={onRejectSuggestion} />
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
            styleSection={stylePanel ? <StylePanel {...stylePanel} /> : undefined}
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
          onInsertHtml={html => onAnalyzeSection?.(html, BIBLIOGRAPHY_SECTION)}
          onSourcesChange={onSourcesChange}
          externalApiSources={externalApiSources}
          onExternalSourcesMerged={onExternalSourcesMerged}
          clearSourcesTrigger={clearSourcesTrigger}
          analyzingSourceId={analyzingSourceId}
          onCompareSource={handleAnalyzeSource}
          onChatWithSource={source => {
            // Set source-only context and switch to chat
            composer.setAttachedSourceIds(new Set([source.id]));
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
