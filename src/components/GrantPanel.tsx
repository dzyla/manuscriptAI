import { useState } from 'react';
import { X, FileText, ClipboardList } from 'lucide-react';
import { GRANT_TEMPLATES, GrantTemplate, getGrantTemplate, templateToHtml, WORDS_PER_PAGE } from '../services/grantTemplates';
import { detectH2Sections } from '../services/ai';

// ─── Template picker modal ────────────────────────────────────────────────────

interface TemplatePickerProps {
  documentHasContent: boolean;
  onApply: (template: GrantTemplate, html: string) => void;
  onClose: () => void;
}

export function GrantTemplatePicker({ documentHasContent, onApply, onClose }: TemplatePickerProps) {
  const [selectedId, setSelectedId] = useState<string>(GRANT_TEMPLATES[0].id);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const selected = getGrantTemplate(selectedId)!;

  const handleApply = () => {
    if (documentHasContent && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    onApply(selected, templateToHtml(selected));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border shadow-2xl p-6"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Choose grant template"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <FileText size={16} /> New Grant from Template
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-stone-100" style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 mb-4">
          {GRANT_TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => { setSelectedId(t.id); setConfirmOverwrite(false); }}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedId === t.id ? 'ring-2 ring-emerald-500' : ''}`}
              style={{ background: selectedId === t.id ? 'var(--surface-2)' : 'transparent', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{t.mechanism}</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
              </div>
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{t.description}</p>
            </button>
          ))}
        </div>

        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>Sections</p>
          <ul className="space-y-1">
            {selected.sections.map(s => (
              <li key={s.title} className="text-[11px] flex items-baseline gap-2" style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.title}</span>
                {s.pageLimit && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.pageLimit} page{s.pageLimit === 1 ? '' : 's'}</span>}
              </li>
            ))}
          </ul>
        </div>

        {confirmOverwrite && (
          <p className="text-[11px] mb-3 font-semibold text-rose-600">
            The current document is not empty. Applying this template will REPLACE its content. Click again to confirm.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Cancel</button>
          <button
            onClick={handleApply}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg text-white ${confirmOverwrite ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-700 hover:bg-emerald-800'}`}
          >
            {confirmOverwrite ? 'Replace document' : 'Use template'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Grant instructions modal ─────────────────────────────────────────────────

interface InstructionsModalProps {
  value: string;
  onSave: (text: string) => void;
  onClose: () => void;
}

export function GrantInstructionsModal({ value, onSave, onClose }: InstructionsModalProps) {
  const [text, setText] = useState(value);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-2xl border shadow-2xl p-6"
        style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Grant instructions"
      >
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <ClipboardList size={16} /> Grant Instructions
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-stone-100" style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Paste the funding opportunity requirements, review criteria, or your own rules here.
          Every AI agent follows these instructions while this document is in grant mode.
          They are saved with the document.
        </p>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={12}
          placeholder={'Examples:\n- This is a resubmission; emphasize responses to prior critique.\n- FOA PAR-26-123 requires a milestone plan per aim.\n- Write for a study section with mixed immunology/computational expertise.'}
          className="w-full text-xs rounded-xl border p-3 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-lg border" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>Cancel</button>
          <button onClick={() => onSave(text)} className="px-3 py-1.5 text-xs font-semibold rounded-lg text-white bg-emerald-700 hover:bg-emerald-800">Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Grant toolbar: template/instructions buttons + per-section page budgets ──

interface GrantToolbarProps {
  htmlContent: string;
  templateId: string | null;
  hasInstructions: boolean;
  onOpenTemplates: () => void;
  onOpenInstructions: () => void;
}

export function GrantToolbar({ htmlContent, templateId, hasInstructions, onOpenTemplates, onOpenInstructions }: GrantToolbarProps) {
  const template = getGrantTemplate(templateId);
  const docSections = template ? detectH2Sections(htmlContent) : [];
  const budgeted = template ? template.sections.filter(s => s.pageLimit) : [];

  const chips = budgeted.map(ts => {
    const match = docSections.find(ds => ds.section.toLowerCase() === ts.title.toLowerCase());
    if (!match) return null;
    // Section text includes the title line; subtract it for the body word count
    const words = match.text.split(/\s+/).filter(Boolean).length - ts.title.split(/\s+/).length;
    const budget = Math.round((ts.pageLimit as number) * WORDS_PER_PAGE);
    const ratio = words / budget;
    const tone = ratio > 1 ? 'text-rose-600' : ratio > 0.85 ? 'text-amber-600' : 'text-emerald-700';
    return (
      <span key={ts.title} className="flex items-center gap-1 shrink-0" title={`${ts.title}: ~${ts.pageLimit} page limit ≈ ${budget} words`}>
        <span className="font-semibold" style={{ color: 'var(--text-muted)' }}>{ts.title}</span>
        <span className={`font-bold ${tone}`}>{Math.max(0, words)}/{budget}</span>
      </span>
    );
  }).filter(Boolean);

  return (
    <div
      className="flex items-center gap-2 px-4 sm:px-6 py-1.5 text-[10px] overflow-x-auto shrink-0"
      style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-2)' }}
    >
      <button
        onClick={onOpenTemplates}
        className="px-2 py-1 font-semibold rounded-lg border shrink-0 hover:bg-stone-50 transition-colors"
        style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', background: 'var(--surface-1)' }}
        title="Start from an NIH grant template"
      >
        <span className="flex items-center gap-1"><FileText size={11} /> Template</span>
      </button>
      <button
        onClick={onOpenInstructions}
        className={`px-2 py-1 font-semibold rounded-lg border shrink-0 transition-colors ${hasInstructions ? 'text-emerald-700 border-emerald-300 bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-stone-50'}`}
        style={hasInstructions ? {} : { borderColor: 'var(--border)', color: 'var(--text-secondary)', background: 'var(--surface-1)' }}
        title={hasInstructions ? 'Funder instructions active — all agents follow them' : 'Add funder instructions for the AI agents to follow'}
      >
        <span className="flex items-center gap-1"><ClipboardList size={11} /> Instructions{hasInstructions ? ' ✓' : ''}</span>
      </button>
      {chips.length > 0 && (
        <>
          <span className="uppercase tracking-wider font-bold shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>Page budget</span>
          <div className="flex items-center gap-4">{chips}</div>
        </>
      )}
    </div>
  );
}
