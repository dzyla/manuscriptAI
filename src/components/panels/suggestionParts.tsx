import { createElement } from 'react';
import type { AgentType, SuggestionSeverity } from '../../types';
import { AGENT_INFO, AGENT_ICONS } from '../../services/ai';

export const SEVERITY_CONFIG: Record<SuggestionSeverity, { label: string; color: string; dotColor: string }> = {
  critical: { label: 'Critical', color: 'text-rose-700', dotColor: 'bg-rose-500' },
  major: { label: 'Major', color: 'text-amber-700', dotColor: 'bg-amber-500' },
  minor: { label: 'Minor', color: 'text-blue-600', dotColor: 'bg-blue-400' },
  style: { label: 'Style', color: 'text-stone-500', dotColor: 'bg-stone-400' },
};

export function AgentIcon({ agent, size = 12 }: { agent: AgentType; size?: number }) {
  const info = AGENT_INFO[agent];
  const IconComponent = AGENT_ICONS[info?.iconName];
  if (!IconComponent) return null;
  return createElement(IconComponent, { size });
}

export function DiffView({ original, suggested }: { original: string; suggested: string }) {
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      <div className="diff-remove px-2 py-1 rounded" style={{ fontSize: '11px' }}>
        {original}
      </div>
      <div className="diff-add px-2 py-1 rounded" style={{ fontSize: '11px' }}>
        {suggested}
      </div>
    </div>
  );
}

export function CategoryBadge({ category }: { category?: string }) {
  if (!category) return null;
  const colors: Record<string, string> = {
    grammar: 'bg-blue-50 text-blue-600 border-blue-100',
    flow: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    evidence: 'bg-rose-50 text-rose-600 border-rose-100',
    impact: 'bg-rose-50 text-rose-700 border-rose-200',
    clarity: 'bg-teal-50 text-teal-600 border-teal-100',
    statistics: 'bg-amber-50 text-amber-700 border-amber-100',
    citation: 'bg-violet-50 text-violet-600 border-violet-100',
    research: 'bg-amber-50 text-amber-800 border-amber-200',
    structure: 'bg-stone-100 text-stone-600 border-stone-200',
    style: 'bg-stone-50 text-stone-500 border-stone-200',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${colors[category] || colors.style}`}>
      {category}
    </span>
  );
}
