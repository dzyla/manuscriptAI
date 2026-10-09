import { useState, useRef, useEffect } from 'react';
import { AgentType, AISettings, AttachedImage } from '../../../types';
import { useSourceStore } from '../../../stores/useSourceStore';
import { AGENT_INFO, localModelSupportsVision } from '../../../services/ai';

/**
 * The chat's composer state. It lives in the host (TaskPanels), not in the section: the Cite panel drives it (attach a source, chat about one)
 * and it must survive the Chat section being collapsed.
 */
export function useChatComposer(aiSettings: AISettings | undefined, onSendMessage: (text: string, agent: AgentType, attachedSources?: Array<{ name: string; text: string }>, images?: AttachedImage[]) => void) {
  const { sources } = useSourceStore();
  const [input, setInput] = useState('');
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [attachedSourceIds, setAttachedSourceIds] = useState<Set<string>>(new Set(['__full__']));
  const sourcePickerRef = useRef<HTMLDivElement>(null);
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [visionWarning, setVisionWarning] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentType>('manager');
  const [agentMode, setAgentMode] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showSourcePicker) return;
    const handleClick = (e: MouseEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(e.target as Node)) setShowSourcePicker(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSourcePicker]);

  const agents = Object.entries(AGENT_INFO)
    .filter(([id]) => id !== 'manuscript-ai' && id !== 'literature-reviewer' && id !== 'citation-checker')
    .map(([id, info]) => ({ id: id as AgentType, ...info }));

  const handleSend = () => {
    if (!input.trim() && attachedImages.length === 0) return;
    const attached: Array<{ name: string; text: string }> = [];
    // Scope sentinels — resolved to actual text by App.tsx handleSendMessage
    if (attachedSourceIds.has('__full__'))    attached.push({ name: '__full__',    text: '' });
    if (attachedSourceIds.has('__section__')) attached.push({ name: '__section__', text: '' });
    sources.forEach(src => {
      if (attachedSourceIds.has(src.id)) attached.push({ name: src.name, text: src.text });
    });
    const imagesToSend = attachedImages.length > 0 ? [...attachedImages] : undefined;
    onSendMessage(input, agentMode ? selectedAgent : 'manuscript-ai', attached.length > 0 ? attached : undefined, imagesToSend);
    setInput('');
    setAttachedImages([]);
    setVisionWarning(null);
    setShowSourcePicker(false);
  };

  const handleImageFiles = async (files: File[]) => {
    const supported = ['image/jpeg', 'image/png', 'image/webp'];
    const imageFiles = files.filter(f => supported.includes(f.type));
    if (imageFiles.length === 0) return;

    // Warn for local models without apparent vision support
    if (aiSettings?.provider === 'local') {
      const modelName = aiSettings.localModel || '';
      if (!localModelSupportsVision(modelName)) {
        setVisionWarning(
          `"${modelName || 'this model'}" may not support vision. Use a VLM (e.g. qwen2-vl, llava) in LM Studio for image input. The request will be sent anyway — the model will error if unsupported.`
        );
      } else {
        setVisionWarning(null);
      }
    } else {
      setVisionWarning(null);
    }

    const newImages: AttachedImage[] = [];
    for (const file of imageFiles) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      bytes.forEach(b => { binary += String.fromCharCode(b); });
      const base64 = btoa(binary);
      const dataUrl = `data:${file.type};base64,${base64}`;
      newImages.push({
        id: Date.now().toString() + Math.random(),
        name: file.name,
        base64,
        mimeType: file.type as AttachedImage['mimeType'],
        dataUrl,
      });
    }
    setAttachedImages(prev => [...prev, ...newImages]);
  };

  return {
    sources, input, setInput, showSourcePicker, setShowSourcePicker, attachedSourceIds, setAttachedSourceIds, sourcePickerRef, imageUploadRef,
    attachedImages, setAttachedImages, visionWarning, setVisionWarning, selectedAgent, setSelectedAgent, agentMode, setAgentMode, chatEndRef, agents, handleSend, handleImageFiles,
  };
}
export type ChatComposer = ReturnType<typeof useChatComposer>;
