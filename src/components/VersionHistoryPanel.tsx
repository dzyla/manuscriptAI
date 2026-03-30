import { useState, useEffect, useCallback } from 'react';
import { db } from '../db/manuscriptDb';
import type { VersionSnapshot } from '../types';
import { Clock, Plus, Trash2, RotateCcw, Eye, X } from 'lucide-react';

interface VersionHistoryPanelProps {
  currentTitle: string;
  currentContent: string;
  onRestore: (snapshot: VersionSnapshot) => void;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(html: string) {
  return stripHtml(html).split(/\s+/).filter(w => w.length > 0).length;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function VersionHistoryPanel({ currentTitle, currentContent, onRestore }: VersionHistoryPanelProps) {
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);

  const loadSnapshots = useCallback(async () => {
    const all = await db.versionSnapshots.orderBy('timestamp').reverse().toArray();
    setSnapshots(all);
  }, []);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const saveSnapshot = async () => {
    const name = newName.trim() || `Snapshot — ${new Date().toLocaleString()}`;
    setIsSaving(true);
    const snapshot: VersionSnapshot = {
      id: `snap-${Date.now()}`,
      name,
      timestamp: Date.now(),
      title: currentTitle,
      content: currentContent,
      wordCount: wordCount(currentContent),
    };
    await db.versionSnapshots.put(snapshot);
    setSnapshots(prev => [snapshot, ...prev]);
    setNewName('');
    setShowNameInput(false);
    setIsSaving(false);
  };

  const deleteSnapshot = async (id: string) => {
    await db.versionSnapshots.delete(id);
    setSnapshots(prev => prev.filter(s => s.id !== id));
    if (previewId === id) setPreviewId(null);
  };

  const previewSnapshot = snapshots.find(s => s.id === previewId);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <Clock size={14} style={{ color: 'var(--text-muted)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>Version History</span>
        </div>
        <button
          onClick={() => setShowNameInput(v => !v)}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors"
          style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
          title="Save snapshot"
        >
          <Plus size={12} />
          Save Snapshot
        </button>
      </div>

      {/* Name input */}
      {showNameInput && (
        <div className="px-4 py-2 border-b flex gap-2" style={{ borderColor: 'var(--border)' }}>
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveSnapshot(); if (e.key === 'Escape') setShowNameInput(false); }}
            placeholder={`Snapshot — ${new Date().toLocaleString()}`}
            className="flex-1 text-xs px-2 py-1.5 rounded-lg border focus:outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-0)', color: 'var(--text-primary)' }}
            autoFocus
          />
          <button
            onClick={saveSnapshot}
            disabled={isSaving}
            className="px-3 py-1 text-xs rounded-lg font-medium transition-colors"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {isSaving ? '…' : 'Save'}
          </button>
        </div>
      )}

      {/* Snapshot list */}
      <div className="flex-1 overflow-y-auto">
        {snapshots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
            <Clock size={24} style={{ color: 'var(--text-muted)' }} />
            <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>No snapshots yet</p>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Save named snapshots to checkpoint your work before major revisions.
            </p>
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {snapshots.map(snap => (
              <li key={snap.id} className="px-4 py-3 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{snap.name}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {formatDate(snap.timestamp)} · {snap.wordCount ?? wordCount(snap.content)} words
                    </p>
                    <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{snap.title}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => setPreviewId(prev => prev === snap.id ? null : snap.id)}
                      className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                      title="Preview"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <Eye size={12} />
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Restore snapshot "${snap.name}"? Current content will be replaced.`)) onRestore(snap); }}
                      className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                      title="Restore"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Delete snapshot "${snap.name}"?`)) deleteSnapshot(snap.id); }}
                      className="p-1.5 rounded-lg hover:bg-rose-50 transition-colors"
                      title="Delete"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Preview modal */}
      {previewSnapshot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="relative flex flex-col rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh]"
            style={{ background: 'var(--surface-1)', border: '1px solid var(--border)' }}>
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{previewSnapshot.name}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatDate(previewSnapshot.timestamp)}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { if (window.confirm(`Restore snapshot "${previewSnapshot.name}"?`)) { onRestore(previewSnapshot); setPreviewId(null); } }}
                  className="px-3 py-1.5 text-xs rounded-lg font-medium flex items-center gap-1 transition-colors"
                  style={{ background: 'var(--accent)', color: '#fff' }}
                >
                  <RotateCcw size={11} /> Restore
                </button>
                <button onClick={() => setPreviewId(null)} className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors" style={{ color: 'var(--text-muted)' }}>
                  <X size={14} />
                </button>
              </div>
            </div>
            <div
              className="flex-1 overflow-y-auto p-5 prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: previewSnapshot.content }}
              style={{ color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
