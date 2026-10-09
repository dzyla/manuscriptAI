import { useState } from 'react';
import type { Message, Suggestion } from '../../../types';
import { Sparkles, Info, BookMarked, Square, ArrowRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AGENT_INFO } from '../../../services/ai';
import { AgentIcon, CategoryBadge, DiffView } from '../suggestionParts';

/** The conversation: bubbles, the inline suggestion cards an agent reply carries, the thinking indicator. */
export function ChatMessages({ messages, isAnalyzing, onStop, analyzingSourceId, chatEndRef, onSuggestionCardClick, onAcceptSuggestion, onRejectSuggestion }: {
  messages: Message[];
  isAnalyzing: boolean;
  onStop?: () => void;
  analyzingSourceId: string | null;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  onSuggestionCardClick: (suggestion: Suggestion) => void;
  onAcceptSuggestion: (suggestion: Suggestion) => void;
  onRejectSuggestion: (suggestion: Suggestion) => void;
}) {
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  return (
      <div className="max-h-80 overflow-y-auto p-3">
          <div className="space-y-4">
            {/* Chat History Title */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Chat History</span>
              <button 
                data-testid="control-agent-info"
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
                            <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                              {s.kind === 'advisory' ? 'Issue to Address' : 'Proposed Change'}
                            </span>
                            <CategoryBadge category={s.category} />
                            <span className="text-[9px] ml-auto" style={{ color: 'var(--text-muted)' }}>Click to locate</span>
                          </div>
                          {s.kind === 'advisory' ? (
                            <div className="space-y-1.5">
                              <div className="text-[11px] leading-relaxed px-2 py-1.5 rounded italic" style={{ background: 'var(--surface-2)', color: 'var(--text-tertiary)' }}>
                                "{s.originalText.length > 180 ? s.originalText.slice(0, 180) + '…' : s.originalText}"
                              </div>
                              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{s.explanation}</p>
                              {s.recommendation && (
                                <p className="text-[11px] leading-relaxed font-medium flex gap-1.5" style={{ color: '#b45309' }}>
                                  <ArrowRight size={12} className="mt-0.5 shrink-0" />
                                  <span>{s.recommendation}</span>
                                </p>
                              )}
                            </div>
                          ) : (
                            <DiffView original={s.originalText} suggested={s.suggestedText} />
                          )}
                          <div className="flex gap-1.5 mt-2">
                            <button
                              data-testid={s.kind === 'advisory' ? 'control-card-insert-note' : 'control-card-accept'}
                              onClick={(e) => { e.stopPropagation(); onAcceptSuggestion(s); }}
                              className="flex-1 py-1.5 bg-stone-800 text-white rounded-lg text-[11px] font-medium hover:bg-stone-700 transition-colors"
                            >
                              {s.kind === 'advisory' ? 'Insert note' : 'Accept'}
                            </button>
                            <button
                              data-testid={s.kind === 'advisory' ? 'control-card-dismiss' : 'control-card-reject'}
                              onClick={(e) => { e.stopPropagation(); onRejectSuggestion(s); }}
                              className="flex-1 py-1.5 border rounded-lg text-[11px] font-medium hover:bg-stone-50 transition-colors"
                              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                            >
                              {s.kind === 'advisory' ? 'Dismiss' : 'Reject'}
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
      </div>
  );
}
