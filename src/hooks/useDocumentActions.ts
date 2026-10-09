import type { AppCtx } from './appContext';
import type { GrantTemplate } from '../services/grantTemplates';
import type { VersionSnapshot } from '../types';
import { inlineAssetImages } from '../db/assetStore';
import { db } from '../db/manuscriptDb';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { useSourceStore } from '../stores/useSourceStore';

/** Whole-document replacements the author asks for by name: a new manuscript, a grant template, a version snapshot. */
export function useDocumentActions({ editorRef, showToast, openTab }: AppCtx, ui: { clearSourcesPanel: () => void; closeTemplatePicker: () => void }) {
  const { content, setContent, setMode, setGrantTemplateId, allowOverwrite, replaceWithHtml, resetDocument, persist: persistDocument } = useDocumentStore();
  const { clearPendingApiSources, clearSources } = useSourceStore();

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
    ui.clearSourcesPanel();

    // Clear Dexie tables. The document row is not deleted directly: it is replaced through the
    // repository below, so the previous document lands in the backup ring instead of vanishing.
    await db.sources.clear();
    await db.suggestions.clear();
    await db.chatHistory.clear();
    await db.historyItems.clear();

    // Set new content after reset
    setContent(newContent);
    editorRef.current?.setContent(newContent);
    await persistDocument().catch(err => console.error('Saving the new manuscript failed', err));

    showToast('New manuscript created', 'success');
  };

  const handleApplyGrantTemplate = async (template: GrantTemplate, html: string) => {
    editorRef.current?.setContent(html);
    setContent(html);
    setMode('grant');
    setGrantTemplateId(template.id);
    ui.closeTemplatePicker();
    allowOverwrite(); // explicit user replacement of the document
    let saved = false;
    try {
      saved = await persistDocument();
    } catch (err) {
      console.error('Persisting the applied template failed', err);
    }
    if (saved) showToast(`${template.mechanism} template applied — fill in each section`, 'success');
    else showToast('Template applied, but it could not be saved. Use "Save Workspace" to keep a copy.', 'error');
  };


  const handleRestoreSnapshot = async (snapshot: VersionSnapshot) => {
    // Snapshots are stored self-contained; older ones may still reference asset ids / blob: URLs.
    try {
      const html = await inlineAssetImages(snapshot.content);
      // Not the open document's own text: ends its tie to a .docx import (and so its package), see replaceWithHtml.
      replaceWithHtml(snapshot.title, html);
      editorRef.current?.setContent(html);
      showToast(`Restored snapshot: "${snapshot.name}"`, 'success');
      openTab('chat');
    } catch (err) {
      console.error('Snapshot restore failed', err);
      showToast('Could not restore this snapshot', 'error');
    }
  };

  return { handleNewManuscript, handleApplyGrantTemplate, handleRestoreSnapshot };
}
