import type { Message, Suggestion } from '../../../types';
import { Send, Sparkles, Check, X, BookOpen, FileText, Plus, List, AlertTriangle, Search, ImagePlus } from 'lucide-react';
import { AGENT_INFO } from '../../../services/ai';
import { AgentIcon } from '../suggestionParts';
import { ChatMessages } from './ChatMessages';
import type { ChatComposer } from './useChatComposer';

/** The Chat section's body: the conversation above, the composer (mode, agent, context, images, input) below. */
export function ChatSection({ c, messages, isAnalyzing, onStop, analyzingSourceId, onSuggestionCardClick, onAcceptSuggestion, onRejectSuggestion }: {
  c: ChatComposer;
  messages: Message[];
  isAnalyzing: boolean;
  onStop?: () => void;
  analyzingSourceId: string | null;
  onSuggestionCardClick: (suggestion: Suggestion) => void;
  onAcceptSuggestion: (suggestion: Suggestion) => void;
  onRejectSuggestion: (suggestion: Suggestion) => void;
}) {
  const { sources, input, setInput, showSourcePicker, setShowSourcePicker, attachedSourceIds, setAttachedSourceIds, sourcePickerRef, imageUploadRef,
    attachedImages, setAttachedImages, visionWarning, setVisionWarning, selectedAgent, agentMode, setAgentMode, chatEndRef, agents, handleSend, handleImageFiles } = c;
  const handleAgentChange = c.setSelectedAgent;
  return (
    <>
      <ChatMessages messages={messages} isAnalyzing={isAnalyzing} onStop={onStop} analyzingSourceId={analyzingSourceId} chatEndRef={chatEndRef}
        onSuggestionCardClick={onSuggestionCardClick} onAcceptSuggestion={onAcceptSuggestion} onRejectSuggestion={onRejectSuggestion} />
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
}
