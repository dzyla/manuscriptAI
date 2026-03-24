import { useState } from 'react';
import { Sparkles, Copy, Download, X } from 'lucide-react';
import { generatePostDraftingContent } from '../services/ai';
import { AISettings } from '../types';

interface PostDraftingViewProps {
  isOpen: boolean;
  onClose: () => void;
  manuscriptText: string;
  aiSettings: AISettings;
}

export default function PostDraftingView({ isOpen, onClose, manuscriptText, aiSettings }: PostDraftingViewProps) {
  const [activeTab, setActiveTab] = useState<'cover_letter' | 'rebuttal'>('cover_letter');
  const [content, setContent] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!manuscriptText || manuscriptText.length < 50) {
      setError('Not enough manuscript text to generate from.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    try {
      const result = await generatePostDraftingContent(manuscriptText, activeTab, aiSettings);
      setContent(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate content');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
  };

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeTab}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-[150] flex justify-end bg-stone-900/30 backdrop-blur-sm transition-opacity">
      <div className="w-[600px] h-full shadow-2xl flex flex-col transition-transform transform translate-x-0" style={{ background: 'var(--surface-0)' }}>

        {/* Header */}
        <div className="h-14 flex items-center justify-between px-6 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
          <h2 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Post-Drafting Assistant</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-stone-100 transition-colors" style={{ color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-6 pt-4 gap-4 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}>
          <button
            onClick={() => setActiveTab('cover_letter')}
            className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'cover_letter' ? 'border-stone-800' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
            style={activeTab === 'cover_letter' ? { color: 'var(--text-primary)' } : {}}
          >
            Cover Letter
          </button>
          <button
            onClick={() => setActiveTab('rebuttal')}
            className={`pb-3 text-sm font-semibold border-b-2 transition-colors ${activeTab === 'rebuttal' ? 'border-stone-800' : 'border-transparent text-stone-400 hover:text-stone-600'}`}
            style={activeTab === 'rebuttal' ? { color: 'var(--text-primary)' } : {}}
          >
            Rebuttal Template
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col">
          <div className="mb-4">
            <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
              {activeTab === 'cover_letter'
                ? 'Generate a persuasive cover letter to the Editor-in-Chief highlighting your core findings.'
                : 'Generate a structured point-by-point response template based on your manuscript.'}
            </p>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="flex items-center gap-2 px-4 py-2 bg-stone-900 text-white rounded-lg text-xs font-semibold hover:bg-stone-800 transition-colors disabled:opacity-50"
            >
              <Sparkles size={14} className={isGenerating ? 'animate-spin' : ''} />
              {isGenerating ? 'Generating...' : `Generate ${activeTab === 'cover_letter' ? 'Cover Letter' : 'Rebuttal'}`}
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs">
              {error}
            </div>
          )}

          <div className="flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>Generated Output</span>
              {content && (
                <div className="flex gap-2">
                  <button onClick={handleCopy} className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors" title="Copy to clipboard" style={{ color: 'var(--text-secondary)' }}><Copy size={12} /></button>
                  <button onClick={handleDownload} className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors" title="Download text" style={{ color: 'var(--text-secondary)' }}><Download size={12} /></button>
                </div>
              )}
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Your generated content will appear here. You can edit it directly."
              className="flex-1 w-full p-4 border rounded-xl text-sm focus:outline-none focus:ring-1 resize-none font-serif leading-relaxed"
              style={{ background: 'var(--surface-0)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
