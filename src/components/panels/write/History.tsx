import { useState } from 'react';
import { ChevronDown, ChevronUp, History as HistoryIcon } from 'lucide-react';
import type { HistoryItem } from '../../../types';
import { AGENT_INFO } from '../../../services/ai';
import { AgentIcon, DiffView } from '../suggestionParts';

export interface HistoryProps {
  history: HistoryItem[];
  onRevert: (historyId: string) => void;
  onItemClick?: (item: HistoryItem) => void;
}

/** The applied-suggestion history, newest first. Lifted unchanged from the old history tab. */
export function History({ history, onRevert, onItemClick }: HistoryProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (history.length === 0) {
    return (
      <div className="text-center py-16" style={{ color: 'var(--text-muted)' }}>
        <HistoryIcon size={36} className="mx-auto mb-3 opacity-15" />
        <p className="text-sm font-medium mb-1">No history yet</p>
        <p className="text-xs">Accepted suggestions will appear here</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {history.slice().reverse().map((item) => (
        <div
          key={item.id}
          data-testid="control-locate-change"
          className="border rounded-xl p-4 shadow-sm space-y-2 cursor-pointer hover:border-stone-300 transition-colors"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
          onClick={() => onItemClick?.(item)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <AgentIcon agent={item.agent} size={10} />
              <span className={`text-[9px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-md ${AGENT_INFO[item.agent].color} text-white`}>
                {AGENT_INFO[item.agent]?.label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {new Date(item.timestamp).toLocaleTimeString()}
              </span>
              <button
                data-testid="control-show-changes"
                onClick={(e) => { e.stopPropagation(); setExpanded(expanded === item.id ? null : item.id); }}
                className="p-0.5 rounded hover:bg-stone-100 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="Show changes"
              >
                {expanded === item.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>
          </div>

          {/* Summary line */}
          <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
            {item.originalText.substring(0, 60)}{item.originalText.length > 60 ? '...' : ''} → {item.suggestedText.substring(0, 60)}{item.suggestedText.length > 60 ? '...' : ''}
          </p>

          {/* Expanded diff view */}
          {expanded === item.id && (
            <div onClick={(e) => e.stopPropagation()}>
              <DiffView original={item.originalText} suggested={item.suggestedText} />
            </div>
          )}

          <button
            data-testid="control-revert-change"
            onClick={(e) => { e.stopPropagation(); onRevert(item.id); }}
            className="w-full mt-1 py-1.5 border rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors hover:bg-stone-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
          >
            Revert Change
          </button>
        </div>
      ))}
    </div>
  );
}
