import { useEffect, useState } from 'react';
import { Clock, Eye, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type { VersionSnapshot } from '../../../types';
import { deleteSnapshot, formatSnapshotDate, restoreOrExplain, saveSnapshot, useSnapshots, wordCount } from '../../../services/versionSnapshots';

export interface VersionsProps {
  getDocument: () => { title: string; content: string };
  onCount?: (n: number) => void;
  onRestore: (snapshot: VersionSnapshot) => void | Promise<void>;
}

/** Named snapshots of the whole document: save, preview, restore, delete. The same operations as the top-bar popup, over the same table. */
export function Versions({ getDocument, onCount, onRestore }: VersionsProps) {
  const snapshots = useSnapshots(); // live: a save or delete in the top-bar popup shows here without reopening
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { onCount?.(snapshots.length); }, [snapshots.length, onCount]);

  const save = async () => {
    setSaving(true);
    try {
      const doc = getDocument();
      await saveSnapshot(doc.title, doc.content, name);
      setName('');
    } finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    await deleteSnapshot(id);
    if (previewId === id) setPreviewId(null);
  };
  const restore = (snap: VersionSnapshot, message: string) => {
    if (window.confirm(message)) { void restoreOrExplain(snap.id, onRestore); setPreviewId(null); }
  };
  const preview = snapshots.find(s => s.id === previewId);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void save(); }}
          placeholder="Name this snapshot (optional)"
          aria-label="Snapshot name"
          className="flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg border focus:outline-none"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)', color: 'var(--text-primary)' }}
        />
        <button
          data-testid="control-save-version"
          onClick={() => void save()}
          disabled={saving}
          title="Save snapshot"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium shrink-0"
          style={{ background: 'var(--accent-blue-soft)', color: 'var(--accent-blue)', opacity: saving ? 0.6 : 1 }}
        >
          <Plus size={11} />
          Save
        </button>
      </div>

      {snapshots.length === 0 ? (
        <div className="flex flex-col items-center py-6 gap-2 text-center">
          <Clock size={22} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
          <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>No snapshots yet</p>
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>Save named snapshots to checkpoint your work before major revisions.</p>
        </div>
      ) : (
        <ul>
          {snapshots.map((snap, i) => (
            <li key={snap.id} className="py-2" style={{ borderBottom: i < snapshots.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{snap.name}</p>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {formatSnapshotDate(snap.timestamp)}<span className="mx-1 opacity-40">·</span>{snap.wordCount ?? wordCount(snap.content)} words
                  </p>
                </div>
                <div className="flex gap-0.5 shrink-0 mt-0.5">
                  <button data-testid="control-preview-version" onClick={() => setPreviewId(p => p === snap.id ? null : snap.id)} className="p-1.5 rounded-lg" title="Preview" style={{ color: 'var(--text-muted)' }}><Eye size={12} /></button>
                  <button data-testid="control-restore-version" onClick={() => restore(snap, `Restore snapshot "${snap.name}"? Current content will be replaced.`)} className="p-1.5 rounded-lg" title="Restore" style={{ color: 'var(--text-muted)' }}><RotateCcw size={12} /></button>
                  <button data-testid="control-delete-version" onClick={() => { if (window.confirm(`Delete snapshot "${snap.name}"?`)) void remove(snap.id); }} className="p-1.5 rounded-lg" title="Delete" style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.55)' }}>
          <div className="relative flex flex-col rounded-2xl shadow-2xl w-full" style={{ maxWidth: '760px', maxHeight: '82vh', background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{preview.name}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{formatSnapshotDate(preview.timestamp)} · {preview.wordCount ?? wordCount(preview.content)} words</p>
              </div>
              <div className="flex gap-2">
                <button
                  data-testid="control-restore-from-preview"
                  onClick={() => restore(preview, `Restore snapshot "${preview.name}"?`)}
                  className="px-3 py-1.5 text-xs rounded-lg font-medium flex items-center gap-1.5"
                  style={{ background: 'var(--accent-blue)', color: '#fff' }}
                >
                  <RotateCcw size={11} /> Restore
                </button>
                <button data-testid="control-close-preview" onClick={() => setPreviewId(null)} title="Close preview" className="p-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}><X size={15} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: preview.content }} style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-editor)' }} />
          </div>
        </div>
      )}
    </div>
  );
}
