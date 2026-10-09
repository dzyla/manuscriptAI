import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppCtx } from './appContext';
import { titleFromFileName } from '../services/docxImport';
import { useDocxImport } from './useDocxImport';
import { textToHtml } from '../utils/textImport';
import { snapshotBeforeImport, revertLabel, isBlankHtml } from '../services/importSafety';
import { migrateLegacyCitations } from '../utils/migrateCitations';
import { db } from '../db/manuscriptDb';
import type { ImportReportRow } from '../types';
import { useDocumentStore, documentRepository } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { useSourceStore } from '../stores/useSourceStore';

/** Bringing a document in: Word (read in a worker, confirmed in a report), Markdown and text, a workspace file, and putting back the document an import replaced. */
export function useImport({ editorRef, showToast }: AppCtx, loadSettled: boolean) {
  const { title, content, importId, setTitle, setContent, setSaveState, allowOverwrite, importDocx, revertImport, persist: persistDocument } = useDocumentStore();
  const { setSuggestions, setHistory, setMessages, setAiSettings } = useAIStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── .docx import ──────────────────────────────────────────────────────────
  // The file is read in a Worker (the page stays responsive); NOTHING is written until the author confirms the report.
  // The document "Restore previous document" would bring back (the newest an import replaced), or null. Named on the button.
  const [revertTarget, setRevertTarget] = useState<{ title: string; savedAt: number } | null>(null);
  const revertTargetRef = useRef<{ title: string; savedAt: number } | null>(null);
  // What the open document's import said it kept but does not show; shown again from the File menu (null when it is not an import).
  const [storedReport, setStoredReport] = useState<ImportReportRow | null>(null);
  const [showStoredReport, setShowStoredReport] = useState(false);
  const refreshRevertAvailable = useCallback(async () => {
    let target: { title: string; savedAt: number } | null = null;
    try {
      target = await documentRepository.peekRevert();
    } catch {
      target = null;
    }
    revertTargetRef.current = target; // read straight away by the message that follows an import, before the next render
    setRevertTarget(target);
    try {
      setStoredReport(await documentRepository.getImportReport() ?? null);
    } catch {
      setStoredReport(null);
    }
  }, []);
  // also when the document's tie to an import changes (an import, a restore, New Manuscript, a workspace file ...)
  useEffect(() => { if (loadSettled) void refreshRevertAvailable(); }, [loadSettled, importId, refreshRevertAvailable]);

  const handleRevertImport = async () => {
    try {
      const doc = await revertImport();
      editorRef.current?.setDocument(doc);
      useAIStore.getState().setSuggestions([]);
      useAIStore.getState().setHistory([]); // its entries hold text of the document that was just replaced
      await refreshRevertAvailable();
      showToast('Restored the document the import replaced. "Restore previous document" again brings the import back.', 'success');
    } catch (err) {
      console.error('Restoring the replaced document failed', err);
      showToast(`Could not restore the previous document: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const docxImport = useDocxImport({
    commit: async (result, decisions) => {
      // A Version History snapshot of what is open now (the repository's own backup is the other way back).
      await snapshotBeforeImport(db, { title, content: useDocumentStore.getState().content, importing: result.fileName ?? 'a Word document' });
      const doc = await importDocx(result, decisions);
      await refreshRevertAvailable();
      return doc;
    },
    // setDocument records no undo history: Ctrl+Z cannot bring the replaced document back (the dialog says so).
    showInEditor: doc => editorRef.current?.setDocument(doc),
    onImported: () => {
      // Their text offsets, and the apply-history's old/new text, belong to the replaced document (reverting one would put that
      // document's text over the import).
      useAIStore.getState().setSuggestions([]);
      useAIStore.getState().setHistory([]);
    },
    notify: (message, type, action) => showToast(message, type, action),
    afterImportAction: () => (revertTargetRef.current ? { label: revertLabel(revertTargetRef.current), onClick: () => { void handleRevertImport(); } } : undefined),
  });

  const handleImportText = async (file: File) => {
    // Text typed into or after the placeholder is work; only no text, or exactly the placeholder, is an empty document.
    if (!isBlankHtml(content) && !window.confirm(`Replace the open document with ${file.name}? Any unsaved changes will be lost.`)) return;
    try {
      const html = textToHtml(await file.text(), file.name.toLowerCase().endsWith('.md'));
      setTitle(titleFromFileName(file.name));
      setContent(html);
      editorRef.current?.setContent(html);
      allowOverwrite(); // explicit user replacement of the document
      if (await persistDocument()) showToast(`Imported ${file.name}`, 'success');
      else showToast('Imported, but it could not be saved to local storage. Use "Save Workspace" to keep a copy.', 'error');
    } catch (err) {
      console.error('Text import failed', err);
      showToast(`Could not import ${file.name}`, 'error');
    }
  };

  const handleLoadWorkspace = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // Choosing the same file again must fire onChange again.
    if (fileInputRef.current) fileInputRef.current.value = '';
    const lowerName = file.name.toLowerCase();
    // .docm / .dotm go to the reader too, which refuses them with the reason; the old binary .doc cannot be read at all.
    if (/\.(docx|docm|dotx|dotm)$/.test(lowerName)) { void docxImport.start(file); return; }
    if (lowerName.endsWith('.doc')) { showToast('The old Word format (.doc) cannot be imported. In Word, use Save As and choose .docx, then import that.', 'error'); return; }
    if (lowerName.endsWith('.md') || lowerName.endsWith('.txt')) { void handleImportText(file); return; }
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
          // Persist to Dexie (loading a workspace is an explicit replacement of the document)
          allowOverwrite();
          if (await persistDocument()) showToast('Workspace loaded', 'success');
          else showToast('Workspace loaded, but it could not be saved to local storage. Use "Save Workspace" to keep a copy.', 'error');
        }
      } catch (err) {
        console.error("Invalid workspace file", err);
        showToast('Failed to load workspace file', 'error');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return { fileInputRef, docxImport, handleLoadWorkspace, handleRevertImport, revertTarget, storedReport, showStoredReport, setShowStoredReport };
}
