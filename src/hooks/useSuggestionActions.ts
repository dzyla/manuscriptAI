import type { AppCtx } from './appContext';
import { Suggestion } from '../types';
import { buildReviewNote } from '../utils/reviewNotes';
import { inlineAssetImages } from '../db/assetStore';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useAIStore } from '../stores/useAIStore';

/** Accepting, rejecting and reverting suggestions: what each does to the text, the history and the list. */
export function useSuggestionActions({ editorRef, showToast }: AppCtx) {
  const { content, setContent } = useDocumentStore();
  const { suggestions, history, addHistoryItem, removeHistoryItem, removeSuggestion, clearSuggestions } = useAIStore();

  const handleAcceptSuggestion = (suggestion: Suggestion) => {
    // Advisory suggestions never replace text. Acting on one inserts a visible
    // inline reminder next to the flagged span so the note travels with the text
    // while the author fixes it by hand — no fabricated data ever enters the doc.
    const isAdvisory = suggestion.kind === 'advisory';
    const replacement = isAdvisory
      ? suggestion.originalText + buildReviewNote(suggestion.recommendation || suggestion.explanation || 'review this')
      : suggestion.suggestedText;

    const syncedOldContent = editorRef.current?.getHTML() || content;
    const handledByEditor = editorRef.current?.applySuggestion(suggestion.originalText, replacement);

    if (!handledByEditor) {
      // Fallback: try raw HTML replacement
      const newContent = content.replace(suggestion.originalText, replacement);
      if (newContent !== content) {
        setContent(newContent);
      } else {
        showToast('Could not find the text to annotate. It may have been edited.', 'info');
      }
    }

    const newContent = editorRef.current?.getHTML() || content;
    addHistoryItem({
      id: Date.now().toString(),
      timestamp: Date.now(),
      oldContent: syncedOldContent,
      newContent,
      originalText: suggestion.originalText,
      suggestedText: replacement,
      suggestionId: suggestion.id,
      agent: suggestion.agent,
    });

    removeSuggestion(suggestion.id);
  };

  const handleAcceptAll = () => {
    // Apply bottom-up so earlier text is untouched while later suggestions
    // are located — keeps remaining anchors valid as the document changes.
    // Advisory suggestions are flag-only and are left untouched by "Accept All".
    const currentSuggestions = [...suggestions]
      .filter(s => s.kind !== 'advisory')
      .sort((a, b) => b.startIndex - a.startIndex);
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

  const handleRevertHistory = (historyId: string) => {
    const item = history.find(h => h.id === historyId);
    if (item) {
      const handledByEditor = editorRef.current?.revertSuggestion(item.originalText, item.suggestedText);
      if (!handledByEditor) {
        // Inline asset images first: an item from an earlier session may reference dead blob: URLs.
        inlineAssetImages(item.oldContent).then(html => {
          setContent(html);
          editorRef.current?.setContent(html);
        }).catch(err => {
          console.error('Could not restore history content', err);
          showToast('Could not restore the earlier content', 'error');
        });
      }
      removeHistoryItem(historyId);
      showToast('Change reverted', 'info');
    }
  };


  return { handleAcceptSuggestion, handleAcceptAll, handleRejectAll, handleRejectSuggestion, handleRevertHistory };
}
