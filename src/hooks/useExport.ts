import { useState } from 'react';
import type { AppCtx } from './appContext';
import { saveAs } from 'file-saver';
import TurndownService from 'turndown';
import { inlineAssetImages } from '../db/assetStore';
import { buildWorkspaceJson } from '../services/workspaceExport';
import { prefetchImages, walkNode } from '../services/astExport';
import { DocxRenderer, Packer } from '../services/docxExport';
import { LatexRenderer } from '../services/latexExport';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';
import { useSourceStore } from '../stores/useSourceStore';

export type ExportFormat = 'md' | 'docx' | 'json' | 'tex';

/** Exporting the document: Markdown, Word, LaTeX and the workspace file. All but the workspace wait behind the "Before you export" acknowledgement. */
export function useExport({ editorRef, showToast }: AppCtx) {
  const { title, content, setSaveState } = useDocumentStore();
  const { aiSettings, suggestions, messages, history } = useAIStore();
  const [pendingDownloadFormat, setPendingDownloadFormat] = useState<ExportFormat | null>(null);

  const doDownload = async (format: 'md' | 'docx' | 'json' | 'tex'): Promise<boolean> => {
    const currentContent = editorRef.current?.getHTML() || content;
    if (format === 'md') {
      const turndownService = new TurndownService();
      // Session blob: image URLs would be dead links in the exported file: inline the bytes.
      const markdown = turndownService.turndown(await inlineAssetImages(currentContent));
      saveAs(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${title.replace(/\s+/g, '_')}.md`);
    } else if (format === 'docx') {
      showToast('Exporting Word document...', 'info');
      try {
        const json = editorRef.current?.getJSON() ?? { type: 'doc', content: [] };
        const images = await prefetchImages(json as any);
        const renderer = new DocxRenderer({ title, images });
        const doc = walkNode(json as any, renderer, images) as ReturnType<DocxRenderer['doc']>;
        const blob = await Packer.toBlob(doc);
        saveAs(blob, `${title.replace(/\s+/g, '_')}.docx`);
        showToast('Word document exported', 'success');
      } catch (err) {
        showToast('Word export failed', 'error');
        console.error(err);
      }
    } else if (format === 'tex') {
      showToast('Building LaTeX package...', 'info');
      try {
        const json = editorRef.current?.getJSON() ?? { type: 'doc', content: [] };
        const images = await prefetchImages(json as any);
        const renderer = new LatexRenderer({ title, images });
        const zip = walkNode(json as any, renderer, images) as ReturnType<LatexRenderer['doc']>;
        const blob = await zip.generateAsync({ type: 'blob' });
        saveAs(blob, `${title.replace(/\s+/g, '_')}.zip`);
        showToast('LaTeX package exported', 'success');
      } catch (err) {
        showToast('LaTeX export failed', 'error');
        console.error(err);
      }
    } else {
      // Read directly from memory state — always current, no race with the Dexie write interval
      const exportedSources = useSourceStore.getState().sources;
      // Strip API keys before export — never serialize credentials into a shareable file
      const { geminiApiKey: _g, openaiApiKey: _o, anthropicApiKey: _a, localApiKey: _l, ...safeSettings } = aiSettings;
      // The file must be self-contained: inline asset-backed images (session blob: URLs die with the tab).
      try {
        const exportedContent = await inlineAssetImages(currentContent);
        // Sequential and size-capped: history items each hold two full document copies.
        const json = await buildWorkspaceJson(
          { title, content: exportedContent, suggestions, messages, aiSettings: safeSettings, sources: exportedSources },
          history,
          inlineAssetImages,
        );
        saveAs(new Blob([json], { type: 'application/json' }), 'workspace.json');
        setSaveState('Saved');
        return true;
      } catch (err) {
        console.error('Workspace export failed', err);
        showToast(`Save Workspace failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return false;
      }
    }
    return true;
  };

  const handleDownload = async (format: 'md' | 'docx' | 'json' | 'tex'): Promise<boolean> => {
    if (format !== 'json') {
      setPendingDownloadFormat(format);
      return true;
    }
    return doDownload(format);
  };

  return { pendingDownloadFormat, setPendingDownloadFormat, doDownload, handleDownload };
}
