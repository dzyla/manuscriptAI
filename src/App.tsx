import { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import type { Editor as TipEditor } from '@tiptap/core';
import Editor, { EditorRef } from './components/Editor';
import TaskPanels from './components/shell/TaskPanels';
import { AppShell } from './components/shell/AppShell';
import { StatusBar } from './components/shell/StatusBar';
import { TopBar } from './components/shell/TopBar';
import { useTopBarItems, type MenuActions } from './components/shell/useTopBarItems';
import { Toast, StorageBanner, ExportWarning, ShortcutsModal, type ToastState } from './components/shell/AppOverlays';
import { BlockTypeSelect } from './components/editor/SelectionBar';
import { NO_SELECTION, type SelectionInfo } from './components/editor/selectionKind';
import type { RailTask } from './components/shell/Rail';
import { railSelect, revealTab, type PanelTab, documentPageLimit, usePageEstimate, useOverBudget, docStats } from './components/shell/shellLogic';
import SettingsModal from './components/SettingsModal';
import PostDraftingView from './components/PostDraftingView';
import VersionHistoryPopup from './components/VersionHistoryPopup';
import ImportReportDialog, { ImportProgressDialog } from './components/ImportReportDialog';
import { GrantTemplatePicker, GrantInstructionsModal } from './components/GrantPanel';
import { estimateTokens, setDocumentContext } from './services/ai';
import { loadCustomTemplates } from './services/grantTemplates';
import { isBlankHtml } from './services/importSafety';
import { useDocumentStore } from './stores/useDocumentStore';
import { useAIStore } from './stores/useAIStore';
import { useSourceStore } from './stores/useSourceStore';
import * as secureStorage from './services/secureStorage';
import { useAnalysis } from './hooks/useAnalysis';
import { useChat } from './hooks/useChat';
import { useSelectionAI } from './hooks/useSelectionAI';
import { useSuggestionActions } from './hooks/useSuggestionActions';
import { useStyleReview } from './hooks/useStyleReview';
import { useExport } from './hooks/useExport';
import { useImport } from './hooks/useImport';
import { useDocumentActions } from './hooks/useDocumentActions';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export default function App() {
  // ─── Zustand stores ────────────────────────────────────────────────────────
  const {
    title, content, saveState, citationRegistry, pendingDocument,
    setTitle, setContent, adoptLoadedHtml, clearPendingDocument, setDocJson,
    insertCitation: storeInsertCitation, removeCitation: storeRemoveCitation, renumberCitations: storeRenumberCitations,
    insertFigure: storeInsertFigure, renumberFigures: storeRenumberFigures,
    persist: persistDocument, initialize: initDocument,
    mode, grantInstructions, grantTemplateId, format, docJson,
    setMode, setGrantInstructions, setFormat,
    loadStatus, blockedByUnreadable, lastLoad, queueFragmentClone, importId,
  } = useDocumentStore();
  const {
    aiSettings, isAnalyzing, suggestions, messages, history, analysisProgress, setAiSettings,
    initialize: initAI, persistSuggestions, persistMessages, persistHistory,
  } = useAIStore();
  const { sources, pendingApiSources, clearPendingApiSources, initialize: initSources, persist: persistSources } = useSourceStore();

  // ─── UI-only state (stays local, not in stores) ────────────────────────────
  const editorRef = useRef<EditorRef>(null);
  const [editorInstance, setEditorInstance] = useState<TipEditor | null>(null);
  const [selection, setSelection] = useState<SelectionInfo>(NO_SELECTION);
  const [autocomplete, setAutocomplete] = useState(false);
  const [autocompleteLoading, setAutocompleteLoading] = useState(false);
  const [clearSourcesTrigger, setClearSourcesTrigger] = useState(0);
  const [highlightedSuggestionId, setHighlightedSuggestionId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPostDraftingOpen, setIsPostDraftingOpen] = useState(false);
  const [isDistractionFree, setIsDistractionFree] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('chat');
  // Rail and tab move together, one way: the legacy call sites reveal a tab through openTab, which also
  // opens its rail task. Closing the rail never touches the tab.
  const [railTask, setRailTask] = useState<RailTask | null>(revealTab('chat').task);
  const [chatRequest, setChatRequest] = useState(0);
  const openTab = useCallback((tab: PanelTab) => { const r = revealTab(tab); setPanelTab(r.tab); setRailTask(r.task); if (tab === 'chat') setChatRequest(n => n + 1); }, []);
  const [panelWidth, setPanelWidth] = useState(400);
  const [zoom, setZoom] = useState(100);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showGrantInstructions, setShowGrantInstructions] = useState(false);
  const [loadSettled, setLoadSettled] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, type: 'success' | 'info' | 'error' = 'info', action?: { label: string; onClick: () => void }) => {
    setToast({ message, type, ...(action ? { action } : {}) });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // A message with a button stays long enough to be used.
    toastTimer.current = setTimeout(() => setToast(null), action ? 20000 : 5000);
  }, []);
  const ctx = { editorRef, showToast, openTab };

  // ─── What the app does ─────────────────────────────────────────────────────
  const analysis = useAnalysis(ctx);
  const chat = useChat(ctx, analysis.abortRef);
  const sugg = useSuggestionActions(ctx);
  const selectionAI = useSelectionAI(ctx, setHighlightedSuggestionId);
  const exporter = useExport(ctx);
  const importer = useImport(ctx, loadSettled);
  const docActs = useDocumentActions(ctx, { clearSourcesPanel: () => setClearSourcesTrigger(n => n + 1), closeTemplatePicker: () => setShowTemplatePicker(false) });
  const review = useStyleReview(ctx, railTask, { accept: sugg.handleAcceptSuggestion, reject: sugg.handleRejectSuggestion });

  // Keep the AI service aware of the document mode + funder instructions,
  // so every agent/chat/rewrite prompt resolves against the right prompt set.
  useEffect(() => { setDocumentContext({ mode, grantInstructions }); }, [mode, grantInstructions]);
  useEffect(() => { void loadCustomTemplates(); }, []);

  // Resize handler for the panel
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const move = (ev: MouseEvent) => setPanelWidth(Math.min(Math.max(startWidth + (startX - ev.clientX), 280), 800));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, [panelWidth]);

  // Dark mode
  useEffect(() => { document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light'); }, [darkMode]);
  useEffect(() => { if (localStorage.getItem('manuscript-dark-mode') === 'true') setDarkMode(true); }, []);
  useEffect(() => { localStorage.setItem('manuscript-dark-mode', String(darkMode)); }, [darkMode]);

  const tokenCount = useMemo(() => estimateTokens(stripHtml(content)), [content]);

  const handleDocumentReady = useCallback(() => {
    if (!editorRef.current) return;
    const orderedFigureIds = editorRef.current.getFigureOrder();
    if (orderedFigureIds.length > 0) {
      const newRegistry = storeRenumberFigures(orderedFigureIds);
      editorRef.current.updateFigures(newRegistry);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize all stores on mount (loads from Dexie, migrating from localforage if needed)
  useEffect(() => {
    Promise.all([initDocument(), initAI(), initSources()]).then(() => {
      // First, and outside any toast/banner logic, so nothing below can keep onDocumentReady from ever firing.
      setLoadSettled(true);
      const { lastLoad } = useDocumentStore.getState();
      // Failed loads and unreadable rows get a persistent banner (rendered from store state below).
      if (lastLoad.recoveredFromBackup) {
        showToast(lastLoad.quarantined
          ? 'Your last save could not be read. Restored the most recent backup; a protected copy of the unreadable save was kept.'
          : 'Your last save could not be read. Restored the most recent backup. The unreadable save could not be protected and may be replaced by later saves.', 'error');
      }
      // Nothing here may depend on the editor's content. The loaded document reaches the editor as JSON through the
      // Editor's `pendingDocument` prop, legacy citation migration happens in the repository's legacy-row conversion
      // before the editor sees the document, and editor-dependent post-load work (figure renumbering) runs from the
      // Editor's onDocumentReady, which fires once after the document is in the editor.
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save every 30s to Dexie (granular — only changed tables are written)
  useEffect(() => {
    const interval = setInterval(async () => {
      // Never autosave before the stored document has loaded (or after loading it failed):
      // the in-memory defaults would overwrite the user's real data.
      if (useDocumentStore.getState().loadStatus !== 'ready') return;
      try {
        const docSaved = await persistDocument();
        await persistSuggestions();
        await persistMessages();
        await persistHistory();
        await persistSources();
        if (docSaved && saveState === 'Draft') useDocumentStore.getState().setSaveState('Auto-saved');
      } catch (e) {
        showToast('Auto-save failed. Use "Save Workspace" to download a backup file.', 'error');
      }
    }, 30000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveState]);

  const saveWorkspace = () => exporter.handleDownload('json').then(ok => ok).catch(err => { console.error(err); showToast('Save Workspace failed', 'error'); return false; });

  // Keyboard shortcuts. The listener is installed once and calls through a ref, so it always runs the current handlers
  // (a handler captured at mount would export, and analyze with, the settings and suggestions of the first render).
  const shortcutRef = useRef({ save: () => {}, analyze: () => {} });
  shortcutRef.current = {
    save: () => { void saveWorkspace().then(ok => { if (ok) showToast('Workspace saved', 'success'); }); },
    analyze: () => { void analysis.handleAnalyze(); },
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); shortcutRef.current.save(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') { e.preventDefault(); shortcutRef.current.analyze(); }
      if (e.key === '?' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setShowShortcuts(prev => !prev); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ─── Citations and figures ─────────────────────────────────────────────────
  const renumberCitations = useCallback(() => {
    if (!editorRef.current) return;
    const newRegistry = storeRenumberCitations(editorRef.current.getCitationOrder());
    editorRef.current.updateCitations(newRegistry);
  }, [storeRenumberCitations]);

  const removeCitation = useCallback((sourceId: string) => {
    if (!editorRef.current) return;
    const newRegistry = storeRemoveCitation(sourceId, editorRef.current.getCitationOrder());
    editorRef.current.updateCitations(newRegistry);
  }, [storeRemoveCitation]);

  const handleInsertFigure = useCallback(() => {
    const figureId = crypto.randomUUID();
    const num = storeInsertFigure(figureId);
    editorRef.current?.insertFigureLabelNode(figureId, num);
    // Defer so TipTap commits the inserted node before we walk getFigureOrder()
    setTimeout(() => {
      const orderedIds = editorRef.current?.getFigureOrder() ?? [];
      const newRegistry = storeRenumberFigures(orderedIds);
      editorRef.current?.updateFigures(newRegistry);
      const newHtml = editorRef.current?.getHTML() ?? '';
      if (newHtml) setContent(newHtml);
    }, 50);
  }, [storeInsertFigure, storeRenumberFigures, setContent]);

  const handleSuggestionClick = (suggestionId: string) => {
    setHighlightedSuggestionId(suggestionId);
    setTimeout(() => setHighlightedSuggestionId(null), 1500);
  };
  // A DOCX import (or revert) replaces the document wholesale: whatever row was selected pointed into the old text.
  useEffect(() => { setHighlightedSuggestionId(null); }, [importId]);

  const handleRailSelect = useCallback((t: RailTask) => {
    const next = railSelect(railTask, t);
    setRailTask(next.task);
    if (next.tab) setPanelTab(next.tab);
  }, [railTask]);

  // ─── The top bar ───────────────────────────────────────────────────────────
  // A word-selection's synonym answer belongs to that selection: it goes when the selection does.
  useEffect(() => { if (selection.kind !== 'text') selectionAI.clearThesaurus(); }, [selection.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const textOf = () => selectionAI.selected();
  const withText = (run: (text: string) => void) => () => { const t = textOf(); if (t.trim()) run(t); };
  // The selection's AI actions: one set of handlers for the top bar's AI menu and the floating bar on the selection.
  const selectionActions: Pick<MenuActions, 'onPreset' | 'onRewrite' | 'onInstruct' | 'onSynonyms' | 'onPickSynonym' | 'onVerify' | 'onSimilar'> = {
    onPreset: p => withText(t => { void (p.mode === 'transform' ? selectionAI.handleTransformSelection(t, p.instruction, p.agent) : selectionAI.handleSelectionQuery(t, p.instruction, p.agent)); })(),
    onRewrite: withText(t => { void selectionAI.handleRewriteSection(t); }), onInstruct: (text, agent) => withText(t => { void selectionAI.handleSelectionQuery(t, text, agent); })(),
    onSynonyms: () => { void selectionAI.handleSynonyms(); }, onPickSynonym: selectionAI.replaceWithSynonym,
    onVerify: withText(t => { void selectionAI.handleVerifyClaim(t); }), onSimilar: withText(t => selectionAI.handleSearchSimilar(t)),
  };
  const menus = useTopBarItems({
    selection, busy: isAnalyzing, autocomplete, autocompleteLoading, darkMode, focusMode: isDistractionFree, zoom, thesaurus: selectionAI.thesaurus,
    agents: review.reviewAgents, storedReport: !!importer.storedReport, revertTarget: importer.revertTarget,
    onNew: docActs.handleNewManuscript, onImport: () => importer.fileInputRef.current?.click(), onImportReport: () => importer.setShowStoredReport(true),
    onRevertImport: () => { void importer.handleRevertImport(); }, onSaveWorkspace: () => { void saveWorkspace(); }, onExport: f => { void exporter.handleDownload(f); },
    onUndo: () => editorRef.current?.undo(), onRedo: () => editorRef.current?.redo(),
    onInsertCitation: () => editorRef.current?.openCitationPicker(), onInsertImage: () => editorRef.current?.openImagePicker(),
    onInsertFigureLabel: handleInsertFigure, onInsertTable: anchor => editorRef.current?.openTablePicker(anchor),
    onAnalyze: () => { void analysis.handleAnalyze(); }, onAnalyzeAgent: a => { void analysis.handleAnalyze(a); }, onSummary: () => { void analysis.handleManuscriptSummary(); },
    onStop: analysis.stopRequest, onToggleAutocomplete: () => setAutocomplete(v => !v),
    onAnalyzeSection: () => { if (selection.section) void chat.handleAnalyzeSection(editorRef.current?.getSectionTextByTitle(selection.section) ?? '', selection.section); },
    ...selectionActions,
    onSettings: () => setIsSettingsOpen(true), onPostDrafting: () => setIsPostDraftingOpen(true), onShortcuts: () => setShowShortcuts(s => !s),
    onToggleDark: () => setDarkMode(d => !d), onToggleFocus: () => setIsDistractionFree(f => !f),
    onZoomOut: () => setZoom(z => Math.max(50, z - 10)), onZoomIn: () => setZoom(z => Math.min(200, z + 10)),
  });

  // ─── Status bar ────────────────────────────────────────────────────────────
  const pageEstimate = usePageEstimate(docJson, format);
  const overBudget = useOverBudget(content, grantTemplateId, mode === 'grant');
  const wordCount = stripHtml(content).split(/\s+/).filter(w => w.length > 0).length;
  const stats = docStats(useDeferredValue(docJson), wordCount);

  return (
    <div className="flex h-screen w-screen overflow-hidden font-sans" style={{ background: 'var(--surface-0)', color: 'var(--text-primary)' }}>
      <input type="file" ref={importer.fileInputRef} onChange={importer.handleLoadWorkspace} accept=".json,.docx,.md,.txt" className="hidden" />

      <AppShell
        hideChrome={isDistractionFree}
        keepPanelMounted
        active={railTask}
        badges={{ review: suggestions.length }}
        onSelect={handleRailSelect}
        topBar={(
          <TopBar
            title={title}
            onTitleChange={setTitle}
            onTitleBlur={() => persistDocument()}
            selection={selection.kind}
            items={menus}
            busy={isAnalyzing}
            onStop={analysis.stopRequest}
            bodyStyle={<BlockTypeSelect editor={editorInstance} format={format} testId="topbar-body-style" />}
            trailing={<VersionHistoryPopup currentTitle={title} currentContent={content} onRestore={docActs.handleRestoreSnapshot} />}
            overflowFooter={(
              <div className="mt-1 pt-2 px-3 pb-1 border-t text-[10px] leading-snug" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                <p>AI may make mistakes. The researcher is responsible for scientific correctness.</p>
                <a href="https://github.com/dzyla/manuscriptAI" target="_blank" rel="noopener noreferrer" className="underline">Manuscript AI Editor · VC by Dawid Zyla</a>
              </div>
            )}
          >
          </TopBar>
        )}
        canvas={(
          <div className="h-full overflow-y-auto p-4 sm:p-6 md:p-8" style={{ background: 'var(--surface-0)' }}>
            <Editor
              ref={editorRef}
              selectionAI={{ words: selection.words, busy: isAnalyzing, thesaurus: selectionAI.thesaurus, ...selectionActions }}
              content={content}
              format={format}
              onChange={(html) => setContent(html)}
              onDocChange={setDocJson}
              pendingDocument={pendingDocument}
              onDuplicateFragment={queueFragmentClone}
              onPendingDocumentApplied={clearPendingDocument}
              loadSettled={loadSettled}
              onDocumentReady={handleDocumentReady}
              onContentSynced={adoptLoadedHtml}
              suggestions={suggestions}
              onSuggestionClick={handleSuggestionClick}
              sources={sources}
              citationRegistry={citationRegistry}
              onInsertCitation={storeInsertCitation}
              isDistractionFree={isDistractionFree}
              editorZoom={zoom}
              aiSettings={aiSettings}
              autocompleteEnabled={autocomplete}
              onAutocompleteLoading={setAutocompleteLoading}
              onEditorReady={setEditorInstance}
              onSelectionChange={setSelection}
              onAnalyzeImage={chat.handleAnalyzeImage}
              styleSentences={review.styleSentences}
              styleAuditEnabled={review.styleAuditOn}
              onStyleAudit={review.handleStyleAudit}
            />
          </div>
        )}
        statusBar={(
          <StatusBar
            estimate={pageEstimate}
            limitPages={documentPageLimit(format)}
            overBudget={overBudget}
            words={wordCount}
            voiceDistance={review.voiceDistance}
            saveState={saveState}
            stats={stats}
            ai={{ tokens: tokenCount, suggestions: suggestions.length, provider: aiSettings.provider, localModel: aiSettings.localModel }}
          />
        )}
        panel={(
        <div className="shrink-0 relative h-full border-t md:border-t-0 md:border-l max-w-full flex flex-col" style={{ width: typeof window !== 'undefined' && window.innerWidth < 768 ? '100%' : `${panelWidth}px`, minWidth: '280px', borderColor: 'var(--border)' }}>
          {/* Drag handle */}
          <div 
            className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-col-resize transition-colors opacity-0 hover:opacity-50 z-50 hidden md:block"
            onMouseDown={handleResizeStart}
            style={{ backgroundColor: 'var(--accent-blue)' }}
          />
          <TaskPanels
            suggestions={suggestions}
            messages={messages}
            history={history}
            onSendMessage={chat.handleSendMessage}
            onAcceptSuggestion={sugg.handleAcceptSuggestion}
            onRejectSuggestion={sugg.handleRejectSuggestion}
            onRevertHistory={sugg.handleRevertHistory}
            onRebuttal={analysis.handleRebuttal}
            onSuggestionCardClick={(s) => editorRef.current?.scrollToSuggestion(s.originalText, s.id)}
            onHistoryItemClick={(item) => editorRef.current?.scrollToSuggestion(item.suggestedText || item.originalText, item.id)}
            onAcceptAll={sugg.handleAcceptAll}
            onRejectAll={sugg.handleRejectAll}
            isAnalyzing={isAnalyzing}
            onStop={analysis.stopRequest}
            highlightedSuggestionId={highlightedSuggestionId}
            analysisProgress={analysisProgress}
            activeTabOverride={panelTab}
            chatRequest={chatRequest}
            onTabChange={openTab}
            review={{
              rows: review.rows,
              docKey: importId ?? 'none',
              onAct: review.handleReviewAct,
              onGoTo: (start, end) => { editorRef.current?.selectFlatRange(start, end); },
              onLocate: review.handleReviewLocate,
              onAnalyze: (agent) => analysis.handleAnalyze(agent),
              onStop: analysis.stopRequest,
              onSummary: analysis.handleManuscriptSummary,
              agents: review.reviewAgents,
              onAcceptAll: sugg.handleAcceptAll,
              onRejectAll: sugg.handleRejectAll,
            }}
            formatPanel={{
              format,
              onFormatChange: setFormat,
              templateId: grantTemplateId,
              onPickTemplate: () => setShowTemplatePicker(true),
              onEditInstructions: () => setShowGrantInstructions(true),
              mode,
              onModeChange: setMode,
              hasInstructions: grantInstructions.trim().length > 0,
              htmlContent: content,
              onTrimSection: analysis.handleTrimSection,
              trimmingSection: analysis.trimmingSection,
            }}
            stylePanel={{
              metrics: review.styleAudit?.metrics ?? null,
              highlightsOn: review.drawStyleHighlights,
              onToggleHighlights: review.setDrawStyleHighlights,
            }}
            manuscriptContent={stripHtml(content)}
            manuscriptHtml={content}
            documentTitle={title}
            onRestoreSnapshot={docActs.handleRestoreSnapshot}
            onScrollToSection={(heading) => editorRef.current?.scrollToHeading(heading)}
            onAnalyzeSection={chat.handleAnalyzeSection}
            onSourcesChange={() => {}} // sources managed by useSourceStore
            aiSettings={aiSettings}
            onAnalyzeSource={chat.handleAnalyzeSource}
            contentZoom={zoom}
            externalApiSources={pendingApiSources.length ? pendingApiSources : undefined}
            onExternalSourcesMerged={clearPendingApiSources}
            clearSourcesTrigger={clearSourcesTrigger}
            citationRegistry={citationRegistry}
            onRenumberCitations={renumberCitations}
            onRemoveCitation={removeCitation}
            onScrollToCitation={(num) => editorRef.current?.scrollToCitation(num)}
            documentHTML={content}
          />
        </div>
        )}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={aiSettings}
        onUpdateSettings={(s) => { setAiSettings(s); void secureStorage.setItem('manuscript-ai-settings', JSON.stringify(s)); }}
      />
      {showTemplatePicker && (
        <GrantTemplatePicker
          documentHasContent={!isBlankHtml(content)}
          aiSettings={aiSettings}
          onApply={docActs.handleApplyGrantTemplate}
          onClose={() => setShowTemplatePicker(false)}
        />
      )}
      {showGrantInstructions && (
        <GrantInstructionsModal
          value={grantInstructions}
          onSave={(text) => {
            setGrantInstructions(text);
            setShowGrantInstructions(false);
            persistDocument();
            showToast(text.trim() ? 'Grant instructions saved — all agents will follow them' : 'Grant instructions cleared', 'success');
          }}
          onClose={() => setShowGrantInstructions(false)}
        />
      )}
      <PostDraftingView isOpen={isPostDraftingOpen} onClose={() => setIsPostDraftingOpen(false)} manuscriptText={stripHtml(content)} aiSettings={aiSettings} />

      {importer.showStoredReport && importer.storedReport && (
        <ImportReportDialog
          mode="view"
          result={{ report: importer.storedReport.report, headingCandidates: importer.storedReport.headingCandidates, ...(importer.storedReport.fileName ? { fileName: importer.storedReport.fileName } : {}) }}
          acceptedIndexes={importer.storedReport.acceptedHeadingIndexes}
          onConfirm={() => {}}
          onCancel={() => importer.setShowStoredReport(false)}
        />
      )}
      {importer.docxImport.state?.phase === 'reading' && (
        <ImportProgressDialog fileName={importer.docxImport.state.fileName} size={importer.docxImport.state.size} stage={importer.docxImport.state.stage} onCancel={importer.docxImport.cancelRead} />
      )}
      {importer.docxImport.state?.phase === 'review' && (
        <ImportReportDialog
          result={importer.docxImport.state.result}
          busy={importer.docxImport.state.committing}
          onCancel={importer.docxImport.cancelReview}
          onConfirm={({ acceptedHeadings }) => { void importer.docxImport.confirm(acceptedHeadings); }}
        />
      )}

      {(loadStatus === 'failed' || blockedByUnreadable) && <StorageBanner failed={loadStatus === 'failed'} quarantined={!!lastLoad.quarantined} />}
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
      {exporter.pendingDownloadFormat && (
        <ExportWarning
          format={exporter.pendingDownloadFormat}
          onCancel={() => exporter.setPendingDownloadFormat(null)}
          onConfirm={async (fmt) => { exporter.setPendingDownloadFormat(null); await exporter.doDownload(fmt); }}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}
