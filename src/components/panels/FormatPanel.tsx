import { memo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, Palette, Ruler } from 'lucide-react';
import type { DocFormat, DocumentMode } from '../../types';
import { GrantToolbar } from '../GrantPanel';
import { PageSection } from './format/PageSection';
import { StylesSection } from './format/StylesSection';

export interface FormatPanelProps {
  /** The document's format; null shows (and edits from) the NIH preset the editor falls back to. */
  format: DocFormat | null;
  onFormatChange: (f: DocFormat) => void;
  templateId: string | null;
  onPickTemplate: () => void;
  onEditInstructions: () => void;
  mode?: DocumentMode;
  onModeChange?: (m: DocumentMode) => void;
  hasInstructions?: boolean;
  /** The document HTML, read for the grant section page budgets. */
  htmlContent?: string;
  onTrimSection?: (sectionTitle: string, budgetWords: number) => void;
  trimmingSection?: string | null;
}

function Section({ id, label, icon, open, onToggle, children }: { id: string; label: string; icon: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="border rounded-xl overflow-hidden" style={{ borderColor: 'var(--border)' }}>
      <button
        data-testid={`section-${id}`}
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-semibold hover:bg-stone-50 transition-colors"
        style={{ color: 'var(--text-primary)', background: 'var(--surface-1)' }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        {label}
      </button>
      {/* Kept mounted when collapsed: a half-typed value belongs to the field, not to whether its section is open. */}
      <div className="p-3" style={open ? undefined : { display: 'none' }}>{children}</div>
    </div>
  );
}

/**
 * The Format panel: page setup (sheet, margins, preset, body font, the author's page limit), the named styles, and the grant template with its
 * mode, instructions and section page budgets. It stays mounted when another panel is open (the host hides it).
 */
export const FormatPanel = memo(function FormatPanel(p: FormatPanelProps) {
  const [open, setOpen] = useState({ page: true, styles: false, template: false });
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));
  const grant = p.mode === 'grant';
  return (
    <div className="space-y-3">
      <Section id="page" label="Page setup" icon={<Ruler size={13} />} open={open.page} onToggle={() => toggle('page')}>
        <PageSection format={p.format} templateId={p.templateId} onChange={p.onFormatChange} />
      </Section>
      <Section id="styles" label="Named styles" icon={<Palette size={13} />} open={open.styles} onToggle={() => toggle('styles')}>
        <StylesSection format={p.format} onChange={p.onFormatChange} />
      </Section>
      <Section id="template" label="Grant template" icon={<FileText size={13} />} open={open.template} onToggle={() => toggle('template')}>
        <div className="space-y-3">
          {p.onModeChange && (
            <div className="flex items-center rounded-lg p-0.5 w-fit" style={{ border: '1px solid var(--border)', background: 'var(--surface-2)' }}>
              <button
                onClick={() => p.onModeChange!('manuscript')}
                className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-colors ${!grant ? 'bg-white shadow text-stone-800' : ''}`}
                style={!grant ? {} : { color: 'var(--text-muted)' }}
                title="Manuscript mode — journal-style agents"
              >
                Manuscript
              </button>
              <button
                data-testid="control-mode"
                onClick={() => p.onModeChange!('grant')}
                className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-colors ${grant ? 'bg-emerald-700 text-white shadow' : ''}`}
                style={grant ? {} : { color: 'var(--text-muted)' }}
                title="Grant mode — NIH-style agents, templates, and page budgets"
              >
                Grant
              </button>
            </div>
          )}
          <GrantToolbar
            compact
            htmlContent={p.htmlContent ?? ''}
            templateId={p.templateId}
            hasInstructions={!!p.hasInstructions}
            onOpenTemplates={p.onPickTemplate}
            onOpenInstructions={p.onEditInstructions}
            onTrimSection={p.onTrimSection}
            trimmingSection={p.trimmingSection}
          />
        </div>
      </Section>
    </div>
  );
});
