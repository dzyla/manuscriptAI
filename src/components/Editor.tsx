import { useEditor, EditorContent } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import { forwardRef, useImperativeHandle, useEffect, useState, useRef } from 'react';
import { AgentType, Suggestion } from '../types';
import { GrammarChecker } from '../extensions/GrammarChecker';
import { 
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered, 
  AlignLeft, AlignCenter, AlignRight, Quote, Heading2, 
  Heading3, Undo, Redo, Clock, Sparkles, PenLine, FlaskConical, Beaker, Send, MessageSquare
} from 'lucide-react';
import { createPortal } from 'react-dom';

interface EditorProps {
  content: string;
  onChange: (content: string) => void;
  suggestions: Suggestion[];
  onSuggestionClick: (suggestionId: string) => void;
  onSelectionQuery?: (selectedText: string, instruction: string, agent: AgentType) => void;
}

export interface EditorRef {
  applySuggestion: (originalText: string, suggestedText: string) => boolean;
  revertSuggestion: (originalText: string, suggestedText: string) => boolean;
  scrollToSuggestion: (text: string, id: string) => void;
  getHTML: () => string;
  setContent: (html: string) => void;
  getSelectedText: () => string;
}

const findTextPosition = (doc: any, searchText: string): { from: number; to: number } | null => {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node: any, pos: number) => {
    if (found) return false;
    if (node.isText && node.text.includes(searchText)) {
      const offset = node.text.indexOf(searchText);
      found = { from: pos + offset, to: pos + offset + searchText.length };
      return false;
    }
    return true;
  });
  if (found) return found;

  const fullText = doc.textContent;
  const searchIdx = fullText.indexOf(searchText);
  if (searchIdx === -1) return null;

  let charsSeen = 0;
  let fromPos: number | null = null;
  let toPos: number | null = null;
  const targetEnd = searchIdx + searchText.length;

  doc.descendants((node: any, pos: number) => {
    if (toPos !== null) return false;
    if (node.isText) {
      const nodeStart = charsSeen;
      const nodeEnd = charsSeen + node.text.length;
      if (fromPos === null && searchIdx >= nodeStart && searchIdx < nodeEnd) {
        fromPos = pos + (searchIdx - nodeStart);
      }
      if (fromPos !== null && targetEnd >= nodeStart && targetEnd <= nodeEnd) {
        toPos = pos + (targetEnd - nodeStart);
      }
      charsSeen += node.text.length;
    }
    return true;
  });

  if (fromPos !== null && toPos !== null) return { from: fromPos, to: toPos };
  return null;
};

// Default quick actions per agent
const AGENT_QUICK_ACTIONS: Record<AgentType, { label: string; instruction: string; icon: any }[]> = {
  editor: [
    { label: 'Polish', instruction: 'Polish this text: fix grammar, improve clarity, tighten sentences.', icon: PenLine },
    { label: 'Simplify', instruction: 'Simplify this text: shorter sentences, simpler words, remove jargon.', icon: PenLine },
  ],
  'reviewer-2': [
    { label: 'Critique', instruction: 'Critically review this text: find unsupported claims, logical gaps, and methodology issues.', icon: FlaskConical },
    { label: 'Strengthen', instruction: 'Suggest how to make the arguments in this text stronger and more convincing.', icon: FlaskConical },
  ],
  researcher: [
    { label: 'Sharpen', instruction: 'Strengthen topic sentences and tighten hedging language. Make every sentence earn its place.', icon: Beaker },
    { label: 'Cut fluff', instruction: 'Find paragraphs or sentences that don\'t add value. Suggest what to cut, merge, or tighten.', icon: Beaker },
  ],
  manager: [
    { label: 'Review structure', instruction: 'Evaluate the structure and flow of this section. Does it fit well in the manuscript?', icon: Sparkles },
  ],
};

const Editor = forwardRef<EditorRef, EditorProps>(({ content, onChange, suggestions, onSuggestionClick, onSelectionQuery }, ref) => {
  const [isMounted, setIsMounted] = useState(false);
  const [showSelectionBar, setShowSelectionBar] = useState(false);
  const [selectionInstruction, setSelectionInstruction] = useState('');
  const [selectionAgent, setSelectionAgent] = useState<AgentType>('editor');
  const isExternalUpdate = useRef(false);
  const lastExternalContent = useRef(content);
  const instructionInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setIsMounted(true); }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Start writing your manuscript here...' }),
      Highlight.configure({ multicolor: true }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false }),
      GrammarChecker,
    ],
    content,
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      const html = editor.getHTML();
      lastExternalContent.current = html;
      onChange(html);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      const hasSelection = from !== to;
      setShowSelectionBar(hasSelection);
    },
    editorProps: {
      attributes: { class: 'prose max-w-none focus:outline-none min-h-[500px]' },
    },
  });

  // Handle clicks on highlight marks via standard DOM events (more reliable than ProseMirror resolve)
  useEffect(() => {
    const editorEl = document.querySelector('.ProseMirror');
    if (!editorEl) return;

    const handleDomClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'MARK') {
        const id = target.getAttribute('data-suggestion-id');
        if (id) {
          onSuggestionClick(id);
        }
      }
    };

    editorEl.addEventListener('click', handleDomClick);
    return () => editorEl.removeEventListener('click', handleDomClick);
  }, [onSuggestionClick]);

  // Sync content from parent
  useEffect(() => {
    if (!editor) return;
    if (content !== lastExternalContent.current) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content);
      lastExternalContent.current = content;
      setTimeout(() => { isExternalUpdate.current = false; }, 0);
    }
  }, [content, editor]);

  // Apply suggestion highlighting
  useEffect(() => {
    if (!editor) return;
    const { tr } = editor.state;
    tr.removeMark(0, editor.state.doc.content.size, editor.schema.marks.highlight);
    editor.view.dispatch(tr);

    suggestions.forEach(s => {
      const color = s.agent === 'manager' ? '#1c1917' : 
                    s.agent === 'editor' ? '#3b6fd4' : 
                    s.agent === 'reviewer-2' ? '#c43d5c' :
                    s.agent === 'researcher' ? '#b8860b' : '#8a847a';
      const posMatch = findTextPosition(editor.state.doc, s.originalText);
      if (posMatch) {
        editor.chain()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .setHighlight({ color: `${color}25`, suggestionId: s.id } as any)
          .run();
      }
    });
  }, [suggestions, editor]);

  const getSelectedText = () => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, ' ');
  };

  const handleSelectionSend = (instruction: string, agent: AgentType) => {
    const text = getSelectedText();
    if (!text.trim() || !onSelectionQuery) return;
    onSelectionQuery(text, instruction, agent);
    setSelectionInstruction('');
    setShowSelectionBar(false);
  };

  useImperativeHandle(ref, () => ({
    applySuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, originalText);
      if (posMatch) {
        // First scroll to the text so user can see the change
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // Brief pause so user sees what's being replaced, then apply
        setTimeout(() => {
          editor.chain().focus()
            .setTextSelection({ from: posMatch.from, to: posMatch.to })
            .insertContent(suggestedText)
            .run();
          
          // Flash animation on the new text
          const newPosMatch = findTextPosition(editor.state.doc, suggestedText);
          if (newPosMatch) {
            editor.chain()
              .setTextSelection({ from: newPosMatch.from, to: newPosMatch.to })
              .scrollIntoView()
              .run();
          }

          // Apply DOM-level flash animation
          setTimeout(() => {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              const span = document.createElement('span');
              span.className = 'accept-flash';
              try {
                range.surroundContents(span);
                setTimeout(() => {
                  // Unwrap the flash span after animation
                  if (span.parentNode) {
                    const parent = span.parentNode;
                    while (span.firstChild) parent.insertBefore(span.firstChild, span);
                    parent.removeChild(span);
                  }
                }, 1200);
              } catch (_) {
                // Can fail if selection spans multiple elements — that's fine
              }
            }
          }, 50);

          const newHtml = editor.getHTML();
          lastExternalContent.current = newHtml;
          onChange(newHtml);
        }, 200);

        return true;
      }
      return false;
    },
    revertSuggestion: (originalText, suggestedText) => {
      if (!editor) return false;
      const posMatch = findTextPosition(editor.state.doc, suggestedText);
      if (posMatch) {
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .insertContent(originalText)
          .run();
        const newHtml = editor.getHTML();
        lastExternalContent.current = newHtml;
        onChange(newHtml);
        return true;
      }
      return false;
    },
    scrollToSuggestion: (text) => {
      if (!editor) return;
      const posMatch = findTextPosition(editor.state.doc, text);
      if (posMatch) {
        // Set selection and scroll into view
        editor.chain().focus()
          .setTextSelection({ from: posMatch.from, to: posMatch.to })
          .scrollIntoView()
          .run();

        // The editor's scrollIntoView uses the built-in ProseMirror scroll.
        // Also do a manual scroll of the parent container for reliable centering.
        setTimeout(() => {
          const coords = editor.view.coordsAtPos(posMatch.from);
          if (coords) {
            const editorDom = editor.view.dom;
            const scrollParent = editorDom.closest('.overflow-y-auto') || editorDom.parentElement?.closest('.overflow-y-auto');
            if (scrollParent) {
              const scrollRect = scrollParent.getBoundingClientRect();
              const targetY = coords.top - scrollRect.top + scrollParent.scrollTop - scrollParent.clientHeight / 3;
              scrollParent.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
            }
          }
        }, 50);
      }
    },
    getHTML: () => editor?.getHTML() || '',
    setContent: (html: string) => {
      if (!editor) return;
      isExternalUpdate.current = true;
      editor.commands.setContent(html);
      lastExternalContent.current = html;
      setTimeout(() => { isExternalUpdate.current = false; }, 0);
    },
    getSelectedText,
  }));

  if (!editor) return null;

  const wordCount = editor.state.doc.textContent.split(/\s+/).filter(w => w.length > 0).length;
  const charCount = editor.state.doc.textContent.length;
  const stats = {
    words: wordCount,
    characters: charCount,
    paragraphs: editor.state.doc.childCount,
    readingTime: Math.ceil(wordCount / 200),
  };

  const ToolbarButton = ({ onClick, isActive = false, children, title }: any) => (
    <button onClick={onClick} title={title}
      className={`p-1.5 rounded transition-colors ${isActive ? 'bg-stone-200 text-stone-900' : 'text-stone-500 hover:bg-stone-100'}`}
    >{children}</button>
  );

  return (
    <div className="w-full max-w-4xl mx-auto">
      <div className="bg-[var(--editor-bg)] min-h-[600px] shadow-[var(--editor-shadow)] rounded-sm border border-[var(--border-subtle)] transition-colors duration-300">
        
        {/* Floating Toolbar (Portal) */}
        {isMounted && createPortal(
          <div className="flex items-center gap-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg p-1 shadow-sm flex-wrap">
            <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive('bold')} title="Bold"><Bold size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive('italic')} title="Italic"><Italic size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive('underline')} title="Underline"><UnderlineIcon size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} isActive={editor.isActive('heading', { level: 2 })} title="H2"><Heading2 size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} isActive={editor.isActive('heading', { level: 3 })} title="H3"><Heading3 size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} isActive={editor.isActive('bulletList')} title="List"><List size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} isActive={editor.isActive('orderedList')} title="Numbers"><ListOrdered size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} isActive={editor.isActive('blockquote')} title="Quote"><Quote size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('left').run()} isActive={editor.isActive({ textAlign: 'left' })} title="Left"><AlignLeft size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('center').run()} isActive={editor.isActive({ textAlign: 'center' })} title="Center"><AlignCenter size={15} /></ToolbarButton>
            <div className="w-px h-4 bg-stone-200 mx-0.5" />
            <ToolbarButton onClick={() => editor.chain().focus().undo().run()} title="Undo"><Undo size={15} /></ToolbarButton>
            <ToolbarButton onClick={() => editor.chain().focus().redo().run()} title="Redo"><Redo size={15} /></ToolbarButton>
          </div>,
          document.getElementById('toolbar-portal') || document.body
        )}

        <div className="px-8 sm:px-12 md:px-16 py-12 md:py-20">
          <EditorContent editor={editor} />
        </div>

        {/* Stats Bar */}
        <div className="border-t border-[var(--border-subtle)] px-4 sm:px-8 py-3 flex items-center justify-between text-[11px] font-medium text-[var(--text-tertiary)] bg-[var(--surface-0)] rounded-b-sm">
          <div className="flex items-center gap-4 sm:gap-6">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              {stats.words} words
            </span>
            <span className="hidden sm:inline">{stats.characters} chars</span>
            <span className="hidden md:inline">{stats.paragraphs} paragraphs</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5"><Clock size={12} />{stats.readingTime} min read</span>
          </div>
        </div>
      </div>

      {/* Enhanced Bubble Menu — formatting + AI actions when text is selected */}
      <BubbleMenu editor={editor}>
        <div className="bg-stone-900 text-white rounded-xl shadow-2xl border border-stone-700 overflow-hidden" style={{ maxWidth: '420px' }}>
          {/* Formatting row */}
          <div className="flex items-center gap-0.5 p-1 border-b border-stone-700">
            <button onClick={() => editor.chain().focus().toggleBold().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('bold') ? 'text-blue-400' : ''}`}><Bold size={14} /></button>
            <button onClick={() => editor.chain().focus().toggleItalic().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('italic') ? 'text-blue-400' : ''}`}><Italic size={14} /></button>
            <button onClick={() => editor.chain().focus().toggleUnderline().run()} className={`p-1.5 rounded hover:bg-stone-800 ${editor.isActive('underline') ? 'text-blue-400' : ''}`}><UnderlineIcon size={14} /></button>
            <div className="w-px h-4 bg-stone-700 mx-1" />
            {/* Quick agent actions */}
            {Object.entries(AGENT_QUICK_ACTIONS).map(([agentId, actions]) => (
              actions.slice(0, 1).map(action => (
                <button
                  key={`${agentId}-${action.label}`}
                  onClick={() => handleSelectionSend(action.instruction, agentId as AgentType)}
                  className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1 whitespace-nowrap"
                  title={action.instruction}
                >
                  <action.icon size={11} />
                  {action.label}
                </button>
              ))
            ))}
            <button
              onClick={() => { setShowSelectionBar(true); setTimeout(() => instructionInputRef.current?.focus(), 100); }}
              className="px-2 py-1.5 rounded hover:bg-stone-800 text-[10px] font-medium flex items-center gap-1"
              title="Custom instruction for selected text"
            >
              <MessageSquare size={11} />
              Ask AI
            </button>
          </div>
          
          {/* Custom instruction input — shown when "Ask AI" clicked */}
          {showSelectionBar && (
            <div className="flex items-center gap-1 p-1.5">
              <select
                value={selectionAgent}
                onChange={e => setSelectionAgent(e.target.value as AgentType)}
                className="bg-stone-800 text-white text-[10px] rounded px-1.5 py-1 border border-stone-600 focus:outline-none"
              >
                <option value="editor">Language Surgeon</option>
                <option value="reviewer-2">Reviewer 2</option>
                <option value="researcher">Clarity & Impact</option>
                <option value="manager">Structure</option>
              </select>
              <input
                ref={instructionInputRef}
                value={selectionInstruction}
                onChange={e => setSelectionInstruction(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && selectionInstruction.trim()) handleSelectionSend(selectionInstruction, selectionAgent); }}
                placeholder="e.g. Make this more concise..."
                className="flex-1 bg-stone-800 text-white text-[11px] rounded px-2 py-1 border border-stone-600 focus:outline-none focus:border-stone-400 placeholder-stone-500 min-w-[160px]"
              />
              <button
                onClick={() => handleSelectionSend(selectionInstruction || 'Suggest improvements for this text.', selectionAgent)}
                className="p-1.5 rounded bg-blue-600 hover:bg-blue-500 transition-colors"
              >
                <Send size={12} />
              </button>
            </div>
          )}
        </div>
      </BubbleMenu>
    </div>
  );
});

export default Editor;
