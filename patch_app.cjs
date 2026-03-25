const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf8');

content = content.replace("import { saveAs } from 'file-saver';", "import { saveAs } from 'file-saver';\nimport * as mammoth from 'mammoth';");

const oldHandleLoadWorkspace = `  const handleLoadWorkspace = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.content !== undefined) {
          setTitle(data.title || 'Untitled Manuscript');
          setContent(data.content);
          setSuggestions(data.suggestions || []);
          setHistory(data.history || []);
          setMessages(data.messages || []);
          if (data.aiSettings) setAiSettings(data.aiSettings);
          if (data.sources) await localforage.setItem('manuscript-sources', data.sources);
          setSaveState('Saved');
          // Force editor reset
          editorRef.current?.setContent(data.content);
          showToast('Workspace loaded', 'success');
        }
      } catch (err) {
        showToast('Invalid workspace file', 'error');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };`;

const newHandleLoadWorkspace = `  const handleLoadWorkspace = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.json')) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target?.result as string);
          if (data.content !== undefined) {
            setTitle(data.title || 'Untitled Manuscript');
            setContent(data.content);
            setSuggestions(data.suggestions || []);
            setHistory(data.history || []);
            setMessages(data.messages || []);
            if (data.aiSettings) setAiSettings(data.aiSettings);
            if (data.sources) await localforage.setItem('manuscript-sources', data.sources);
            setSaveState('Saved');
            // Force editor reset
            editorRef.current?.setContent(data.content);
            showToast('Workspace loaded', 'success');
          }
        } catch (err) {
          showToast('Invalid workspace file', 'error');
        }
      };
      reader.readAsText(file);
    } else if (file.name.endsWith('.docx')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setTitle(file.name.replace('.docx', ''));
        setContent(result.value);
        editorRef.current?.setContent(result.value);
        showToast('Document loaded', 'success');
      } catch (err) {
        showToast('Error loading document', 'error');
      }
    } else if (file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        const html = text.split('\\n\\n').map(p => \`<p>\${p.replace(/\\n/g, '<br/>')}</p>\`).join('');
        setTitle(file.name.replace(/\\.(txt|md)$/, ''));
        setContent(html);
        editorRef.current?.setContent(html);
        showToast('Document loaded', 'success');
      };
      reader.readAsText(file);
    } else {
      showToast('Unsupported file type', 'error');
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  };`;

content = content.replace(oldHandleLoadWorkspace, newHandleLoadWorkspace);

const oldMenu = `                <button onClick={() => fileInputRef.current?.click()} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg font-bold" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', marginBottom: '4px', paddingBottom: '8px' }}>
                  Load Workspace (.json)
                </button>`;

const newMenu = `                <button onClick={() => fileInputRef.current?.click()} className="w-full text-left px-3 py-2 text-xs hover:bg-stone-50 rounded-lg font-bold" style={{ color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', marginBottom: '4px', paddingBottom: '8px' }}>
                  Load Document (.json, .docx, .md, .txt)
                </button>`;

content = content.replace(oldMenu, newMenu);

content = content.replace('accept=".json"', 'accept=".json,.docx,.md,.txt"');

fs.writeFileSync('src/App.tsx', content);
