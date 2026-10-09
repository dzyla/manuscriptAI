import { List, Sparkles } from 'lucide-react';
import type { OutlineItem } from './outline';

export interface OutlineProps {
  outline: OutlineItem[];
  wordCounts: Record<string, number>;
  /** Jump to a heading. Takes its text, looked up in the document at click time, so a heading that has since gone is a no-op, never a stale position. */
  onGoTo: (headingText: string) => void;
  onAnalyzeSection?: (sectionText: string, sectionTitle: string) => void;
}

export function Outline({ outline, wordCounts, onGoTo, onAnalyzeSection }: OutlineProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Document Outline</span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{outline.filter(h => h.level === 2).length} sections</span>
      </div>
      {outline.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
          <List size={28} className="mx-auto mb-3 opacity-30" />
          <p className="text-xs font-medium">No headings yet</p>
          <p className="text-[10px] mt-1 opacity-70">Use H2 headings to structure your manuscript sections</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {outline.map((heading, i) => (
            <div
              key={i}
              data-testid="control-goto-heading"
              data-level={heading.level}
              className={`group flex items-center justify-between rounded-lg transition-colors cursor-pointer hover:bg-stone-100 ${heading.level === 2 ? 'px-2 py-2' : 'pl-5 pr-2 py-1.5'}`}
              onClick={() => onGoTo(heading.text)}
              style={{ color: heading.level === 2 ? 'var(--text-primary)' : 'var(--text-secondary)' }}
            >
              <div className="flex items-center gap-2 min-w-0">
                {heading.level === 2
                  ? <span className="w-1.5 h-1.5 rounded-full bg-stone-400 shrink-0" />
                  : <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0" />}
                <span className={`truncate ${heading.level === 2 ? 'text-[12px] font-semibold' : 'text-[11px]'}`}>
                  {heading.text}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                {heading.level === 2 && wordCounts[heading.text] !== undefined && (
                  <span className="text-[9px] font-medium opacity-50">{wordCounts[heading.text]}w</span>
                )}
                {heading.level === 2 && onAnalyzeSection && (
                  <button
                    data-testid="control-analyze-section"
                    onClick={e => { e.stopPropagation(); onAnalyzeSection('', heading.text); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-stone-200"
                    title={`Analyze "${heading.text}" section`}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <Sparkles size={10} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
