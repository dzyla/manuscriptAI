import { useState } from 'react';
import { X, FileText, ClipboardList, Sparkles, Trash2, Copy, Loader2, Scissors } from 'lucide-react';
import {
  GRANT_TEMPLATES, GrantTemplate, GrantTemplateSection, getGrantTemplate, templateToHtml,
  WORDS_PER_PAGE, wordsToPages, getCustomTemplates, saveCustomTemplate, deleteCustomTemplate, normalizeTemplate,
} from '../services/grantTemplates';
import { detectH2Sections, generateGrantTemplate } from '../services/ai';
import type { AISettings } from '../types';

// ─── Template picker modal ────────────────────────────────────────────────────

interface TemplatePickerProps {
  documentHasContent: boolean;
  aiSettings: AISettings;
  onApply: (template: GrantTemplate, html: string) => void;
  onClose: () => void;
}

export function GrantTemplatePicker({ documentHasContent, aiSettings, onApply, onClose }: TemplatePickerProps) {
  const [selectedId, setSelectedId] = useState<string>(GRANT_TEMPLATES[0].id);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [customList, setCustomList] = useState<GrantTemplate[]>(getCustomTemplates());
  const [genText, setGenText] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const allTemplates = [...GRANT_TEMPLATES, ...customList];
  const selected = allTemplates.find(t => t.id === selectedId) ?? GRANT_TEMPLATES[0];
  const isCustom = customList.some(t => t.id === selected.id);

  const handleApply = () => {
    if (documentHasContent && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    onApply(selected, templateToHtml(selected));
  };

  const handleGenerate = async () => {
    if (!genText.trim()) return;
    setGenBusy(true);
    setGenError(null);
    try {
      const raw = await generateGrantTemplate(genText, aiSettings);
      const tpl = normalizeTemplate(raw, 'ai');
      if (!tpl) throw new Error('The model returned an unusable template. Try a more specific description.');
      await saveCustomTemplate(tpl);
      setCustomList(getCustomTemplates());
      setSelectedId(tpl.id);
      setGenText('');
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Template generation failed');
    } finally {
      setGenBusy(false);
    }
  };

  const handleDuplicate = async () => {
    const copy = normalizeTemplate({ ...selected, name: `${selected.name} (copy)` }, 'custom');
    if (!copy) return;
    await saveCustomTemplate(copy);
    setCustomList(getCustomTemplates());
    setSelectedId(copy.id);
    setEditing(true);
  };

  const handleDelete = async () => {
    await deleteCustomTemplate(selected.id);
    setCustomList(getCustomTemplates());
    setSelectedId(GRANT_TEMPLATES[0].id);
    setEditing(false);
  };

  const updateSection = async (idx: number, patch: Partial<GrantTemplateSection>) => {
    const sections = selected.sections.map((s, i) => i === idx ? { ...s, ...patch } : s);
    const updated = { ...selected, sections };
    await saveCustomTemplate(updated);
    setCustomList(getCustomTemplates());
  };

  const addSection = async () => {
    const updated = { ...selected, sections: [...selected.sections, { title: 'New Section', guidance: 'Write this section.' }] };
    await saveCustomTemplate(updated);
    setCustomList(getCustomTemplates());
  };

  const removeSection = async (idx: number) => {
    const updated = { ...selected, sections: selected.sections.filter((_, i) => i !== idx) };
    await saveCustomTemplate(updated);
    setCustomList(getCustomTemplates());
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

        {/* AI template generator */}
        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            <Sparkles size={11} /> Generate template with AI
          </p>
          <textarea
            value={genText}
            onChange={e => setGenText(e.target.value)}
            rows={2}
            placeholder="Describe the grant or paste the FOA text, e.g. 'DoD CDMRP breast cancer idea award: 10-page project narrative, 1-page abstract, military relevance statement...'"
            className="w-full text-[11px] rounded-lg border p-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
          />
          {genError && <p className="text-[10px] text-rose-600 mt-1">{genError}</p>}
          <button
            onClick={handleGenerate}
            disabled={genBusy || !genText.trim()}
            className="mt-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-lg text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 flex items-center gap-1"
          >
            {genBusy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {genBusy ? 'Generating…' : 'Generate'}
          </button>
        </div>

        <div className="space-y-2 mb-4">
          {allTemplates.map(t => (
            <button
              key={t.id}
              onClick={() => { setSelectedId(t.id); setConfirmOverwrite(false); setEditing(false); }}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedId === t.id ? 'ring-2 ring-emerald-500' : ''}`}
              style={{ background: selectedId === t.id ? 'var(--surface-2)' : 'transparent', borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">{t.mechanism}</span>
                <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
                {customList.some(c => c.id === t.id) && (
                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">CUSTOM</span>
                )}
              </div>
              <p className="text-[11px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{t.description}</p>
            </button>
          ))}
        </div>

        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Sections</p>
            <div className="flex gap-1.5">
              <button onClick={handleDuplicate} className="text-[10px] font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded border hover:bg-stone-50" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }} title="Copy to My Templates for editing">
                <Copy size={10} /> Duplicate
              </button>
              {isCustom && (
                <>
                  <button onClick={() => setEditing(!editing)} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border hover:bg-stone-50 ${editing ? 'text-emerald-700 border-emerald-300' : ''}`} style={editing ? {} : { borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
                    {editing ? 'Done' : 'Edit'}
                  </button>
                  <button onClick={handleDelete} className="text-[10px] font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded border text-rose-600 hover:bg-rose-50" style={{ borderColor: 'var(--border)' }}>
                    <Trash2 size={10} /> Delete
                  </button>
                </>
              )}
            </div>
          </div>
          {editing && isCustom ? (
            <div className="space-y-2">
              {selected.sections.map((s, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <input
                    value={s.title}
                    onChange={e => updateSection(i, { title: e.target.value })}
                    className="flex-1 text-[11px] font-semibold rounded border px-1.5 py-1"
                    style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                  />
                  <input
                    type="number" min={0} step={0.5}
                    value={s.pageLimit ?? ''}
                    placeholder="pages"
                    onChange={e => updateSection(i, { pageLimit: e.target.value ? Number(e.target.value) : undefined })}
                    className="w-16 text-[11px] rounded border px-1.5 py-1"
                    style={{ background: 'var(--surface-1)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
                    title="Page limit (blank = none)"
                  />
                  <button onClick={() => removeSection(i)} className="p-1 text-rose-500 hover:bg-rose-50 rounded"><Trash2 size={11} /></button>
                </div>
              ))}
              <button onClick={addSection} className="text-[10px] font-semibold px-2 py-1 rounded border hover:bg-stone-50" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>+ Add section</button>
            </div>
          ) : (
            <ul className="space-y-1">
              {selected.sections.map(s => (
                <li key={s.title} className="text-[11px] flex items-baseline gap-2" style={{ color: 'var(--text-secondary)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.title}</span>
                  {s.pageLimit && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.pageLimit} page{s.pageLimit === 1 ? '' : 's'}</span>}
                </li>
              ))}
            </ul>
          )}
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
  /** requested when a section exceeds its page budget */
  onTrimSection?: (sectionTitle: string, budgetWords: number) => void;
  trimmingSection?: string | null;
}

export function GrantToolbar({ htmlContent, templateId, hasInstructions, onOpenTemplates, onOpenInstructions, onTrimSection, trimmingSection }: GrantToolbarProps) {
  const template = getGrantTemplate(templateId);
  const docSections = template ? detectH2Sections(htmlContent) : [];
  const budgeted = template ? template.sections.filter(s => s.pageLimit) : [];

  const chips = budgeted.map(ts => {
    const match = docSections.find(ds => ds.section.toLowerCase() === ts.title.toLowerCase());
    if (!match) return null;
    // Section text includes the title line; subtract it for the body word count
    const words = Math.max(0, match.text.split(/\s+/).filter(Boolean).length - ts.title.split(/\s+/).length);
    const budgetWords = Math.round((ts.pageLimit as number) * WORDS_PER_PAGE);
    const pages = wordsToPages(words);
    const ratio = words / budgetWords;
    const over = ratio > 1;
    const tone = over ? 'text-rose-600' : ratio > 0.85 ? 'text-amber-600' : 'text-emerald-700';
    return (
      <span key={ts.title} className="flex items-center gap-1 shrink-0" title={`${ts.title}: ${words} words ≈ ${pages} pages of ${ts.pageLimit} allowed (~${budgetWords} words)`}>
        <span className="font-semibold" style={{ color: 'var(--text-muted)' }}>{ts.title}</span>
        <span className={`font-bold ${tone}`}>{pages}/{ts.pageLimit} pg</span>
        {over && onTrimSection && (
          <button
            onClick={() => onTrimSection(ts.title, budgetWords)}
            disabled={trimmingSection !== null && trimmingSection !== undefined}
            className="flex items-center gap-0.5 px-1 py-0.5 rounded border border-rose-300 text-rose-600 bg-rose-50 hover:bg-rose-100 font-semibold disabled:opacity-50"
            title={`Over the ${ts.pageLimit}-page limit — AI-condense this section to fit`}
          >
            {trimmingSection === ts.title ? <Loader2 size={10} className="animate-spin" /> : <Scissors size={10} />} Trim
          </button>
        )}
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
