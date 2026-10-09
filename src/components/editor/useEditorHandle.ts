import { useImperativeHandle, type ForwardedRef, type MutableRefObject } from 'react';
import type { Editor as TipEditor, JSONContent } from '@tiptap/core';
import type { EditorRef } from '../Editor';
import { replaceRangeWithText, resolveFlatSentence, replaceFlatSentence } from '../../extensions/StyleHighlights';
import { findTextPositionRobust, flattenDoc } from '../../utils/textMatch';
import { flatRangeToPm } from '../style/styleSync';
import { sectionText, findHeadingPos, findCitationPos, idsInOrder } from './docQueries';
import { selectionInfo } from './selectionKind';
import { scrollEditorTo, flashSelection } from './scrollTo';

/** What the handle needs from the Editor component: the load/sync bookkeeping it shares, and the three pickers it can open. */
export interface HandleDeps {
  applyDocument: (doc: JSONContent) => void;
  holdExternalUpdate: () => void;
  lastExternalContent: MutableRefObject<string>;
  onChange: (html: string) => void;
  onDocChangeRef: MutableRefObject<((doc: JSONContent) => void) | undefined>;
  openCitationPicker: () => void;
  openTablePicker: (anchor?: { left: number; bottom: number }) => void;
  openImagePicker: () => void;
}

/** The Editor's imperative handle (what App and the panels call): suggestions, scrolling, citations, figures, selection and undo. */
export function useEditorHandle(ref: ForwardedRef<EditorRef>, editor: TipEditor | null, d: HandleDeps) {
  const getSelectedText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  const getSectionText = (sectionTitle: string): string => (editor ? sectionText(editor.state.doc, sectionTitle) : sectionTitle);

  useImperativeHandle(ref, () => ({
    replaceRange: (from: number, to: number, text: string) => (editor ? replaceRangeWithText(editor, from, to, text) : false),
    resolveFlatSentence: (start, end, expected) => (editor ? resolveFlatSentence(editor, start, end, expected) : { ok: false, reason: 'unmappable' }),
    replaceFlatSentence: (start, end, expected, text) => (editor ? replaceFlatSentence(editor, start, end, expected, text) : { ok: false, reason: 'unmappable' }),
    selectFlatRange: (start: number, end: number) => {
      if (!editor) return false;
      const span = flatRangeToPm(editor.state.doc, start, end);
      if (!span) return false;
      editor.chain().focus().setTextSelection({ from: span.from, to: span.to }).scrollIntoView().run();
      return true;
    },
    applySuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPositionRobust(editor.state.doc, originalText);
      if (!posMatch) return false;

      // Apply synchronously so callers reading getHTML() right after see the
      // new content (history recording and accept-all depend on this).
      editor.chain().focus()
        .setTextSelection({ from: posMatch.from, to: posMatch.to })
        .insertContent(suggestedText)
        .scrollIntoView()
        .run();

      const newHtml = editor.getHTML();
      d.lastExternalContent.current = newHtml;
      d.onChange(newHtml);

      flashSelection(); // cosmetic

      return true;
    },
    revertSuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPositionRobust(editor.state.doc, suggestedText);
      if (posMatch) {
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .insertContent(originalText)
          .run();
        const newHtml = editor.getHTML();
        d.lastExternalContent.current = newHtml;
        d.onChange(newHtml);
        return true;
      }
      return false;
    },
    scrollToSuggestion: (text) => {
      if (!editor) return;
      const posMatch = findTextPositionRobust(editor.state.doc, text);
      if (posMatch) {
        // Set selection and scroll into view
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // ProseMirror's own scrollIntoView ran above; this centres it in the scroll container (and survives an unmount).
        scrollEditorTo(editor, posMatch.from);
      }
    },
    getHTML: () => editor?.getHTML() || '',
    getPlainText: () => editor ? flattenDoc(editor.state.doc).text : '',
    getJSON: () => editor?.getJSON() ?? { type: 'doc', content: [] },
    setContent: (html: string) => {
      if (!editor) return;
      d.holdExternalUpdate();
      editor.commands.setContent(html);
      d.onDocChangeRef.current?.(editor.getJSON());
      d.lastExternalContent.current = html;
    },
    setDocument: (doc: JSONContent) => d.applyDocument(doc),
    getSelectedText,
    getCurrentSection: () => selectionInfo(editor).section,
    getCurrentSectionText: () => { const s = selectionInfo(editor).section; return s ? getSectionText(s) : null; },
    getSectionTextByTitle: (title: string) => title ? getSectionText(title) : null,
    scrollToHeading: (headingText: string) => {
      if (!editor) return;
      const pos = findHeadingPos(editor.state.doc, headingText);
      if (pos === null) return;
      editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
      scrollEditorTo(editor, pos + 1, 'top');
    },
    scrollToCitation: (num: number) => {
      if (!editor) return;
      const pos = findCitationPos(editor.state.doc, num);
      if (pos === null) return;
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
      scrollEditorTo(editor, pos);
    },
    getCitationOrder: () => (editor ? idsInOrder(editor.state.doc, 'citation') : []),
    updateCitations: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllCitationNums(registry);
    },
    getFigureOrder: () => (editor ? idsInOrder(editor.state.doc, 'figureLabel') : []),
    updateFigures: (registry: Record<string, number>) => {
      if (!editor) return;
      editor.commands.updateAllFigureNums(registry);
    },
    insertFigureLabelNode: (figureId: string, num: number) => {
      if (!editor) return;
      editor.chain().focus().insertFigureLabel(figureId, num).run();
    },
    undo: () => { editor?.chain().focus().undo().run(); },
    redo: () => { editor?.chain().focus().redo().run(); },
    openCitationPicker: d.openCitationPicker,
    openTablePicker: d.openTablePicker,
    openImagePicker: d.openImagePicker,
    replaceSelection: (text: string) => {
      if (!editor) return false;
      const { from, to } = editor.state.selection;
      if (from === to) return false;
      editor.chain().focus().setTextSelection({ from, to }).insertContent(text).run();
      d.onChange(editor.getHTML());
      return true;
    },
  }));
}
