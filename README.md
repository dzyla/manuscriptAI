# Manuscript AI Editor

An AI-powered writing assistant for scientific manuscripts. Built with React, TipTap, and support for multiple LLM providers.

![License](https://img.shields.io/badge/license-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue) ![React](https://img.shields.io/badge/React-19-blue)

## Features

- **Rich text editor** with IMRAD template, formatting toolbar, and dark mode
- **4 specialized AI agents** that analyze your manuscript in parallel:
  - 🏗️ **Structure Architect** — document organization and section flow
  - ✂️ **Language Surgeon** — grammar, word choice, and readability
  - 😈 **Devil's Advocate** — scientific logic and unsupported claims
  - 🔍 **Evidence Auditor** — statistics, citations, and numerical accuracy
- **Multi-provider support**: Google Gemini, OpenAI, Anthropic Claude, or any local LLM (Ollama, LM Studio, etc.)
- **Inline suggestion highlighting** with accept/reject workflow
- **Chat with individual agents** for targeted feedback
- **Auto-save** with workspace export/import (JSON, Markdown, Word)
- **Token counter** and word statistics

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ 
- npm or yarn
- (Optional) A local LLM server like [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/)

### Install & Run

```bash
git clone <your-repo-url>
cd manuscript-ai-editor
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Configure AI Provider

Click the **⚙ Settings** icon (bottom of left sidebar) to configure:

| Provider | Setup |
|----------|-------|
| **Local LLM** (default) | Point to your LM Studio / Ollama endpoint (e.g., `http://localhost:1234/v1/chat/completions`) |
| **Google Gemini** | Enter your [Gemini API key](https://makersuite.google.com/app/apikey) |
| **OpenAI** | Enter your [OpenAI API key](https://platform.openai.com/api-keys) |
| **Anthropic Claude** | Enter your [Anthropic API key](https://console.anthropic.com/settings/keys) |

### Environment Variables (Optional)

Create a `.env` file to set a default Gemini key:

```
GEMINI_API_KEY=your_key_here
```

## Local LLM Tips

- Use models with **8B+ parameters** for best results (e.g., Llama 3.1 8B, Mistral 7B)
- Smaller models (3-4B) will work but may produce fewer or malformed suggestions
- The app chunks long texts automatically for local models
- If you see "JSON parse failed" errors, try a larger model or a cloud provider

## Server Hosting & APIs

This is a **client-side only** React application. There is no custom backend required to run it — the browser talks directly to the AI providers.

### How APIs Work When Hosted
- **API Keys:** Keys entered in the "Settings" menu are stored securely in the user's browser `localStorage`. They are never sent to your hosting server.
- **External Providers:** Requests to OpenAI, Anthropic, or Gemini go directly from the user's browser to the provider.
- **Local APIs:** If a user enters `http://localhost:1234/v1/chat/completions` in the Local URL setting, the app will try to connect to the *user's* local machine. If you want to host an open-source LLM on your server for all users, expose it publicly (e.g., `https://api.yourdomain.com/v1/...`) and users can paste that URL in the Settings menu.

### Option 1: Static Web Host (Recommended)
Compile the React code into static HTML/JS:
```bash
npm run build
```
Upload the contents of `dist/` to any static web host: Vercel, Netlify, GitHub Pages, Apache, or Nginx.

### Option 2: Express / Node.js Server
If you prefer to serve the app from your own Node.js server:
1. Run `npm run build`
2. Create `server.js` in the project root:
```javascript
const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

app.listen(8080, () => console.log('ManuscriptAI running on port 8080'));
```
3. Run `node server.js`

### Option 3: Desktop App (Electron)
```bash
npm run build:electron
```
This produces an executable AppImage for Linux in the `release/` folder. Configure `electron-builder` in `package.json` for Windows/macOS.


## Project Structure

```
src/
├── App.tsx                   # Main app with layout, state management, analysis logic
├── components/
│   ├── Editor.tsx            # TipTap rich text editor with highlighting
│   ├── Sidebar.tsx           # Chat, suggestions review, and history tabs
│   └── SettingsModal.tsx     # Provider configuration and agent prompt customization
├── services/
│   └── ai.ts                 # LLM integration, agent prompts, JSON parsing
├── types.ts                  # TypeScript interfaces
└── index.css                 # Design system with light/dark themes
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save workspace |
| `Ctrl+Shift+A` | Analyze with all agents |
| `Ctrl+?` | Show shortcuts |
| `Ctrl+B/I/U` | Bold / Italic / Underline |

## License

MIT
