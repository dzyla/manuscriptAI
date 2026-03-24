# Manuscript AI Editor

An AI-powered writing assistant for scientific manuscripts, built as a desktop app (Electron) and web app (React + TipTap).

VC by [Dawid Zyla](https://github.com/dzyla/manuscriptAI) — github.com/dzyla/manuscriptAI

![License](https://img.shields.io/badge/license-MIT-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue) ![React](https://img.shields.io/badge/React-19-blue)

---

## How the Agent Pipeline Works

Understanding the full workflow helps you get the most out of the editor.

### Step 1 — Write your manuscript

Use the TipTap rich-text editor. Paste an existing draft or start from the IMRAD template (New Manuscript). The editor supports headings, lists, bold/italic, and text alignment.

### Step 2 — Analyze All (parallel agents)

Click **Analyze All** to run 3 specialized agents simultaneously against your entire manuscript:

```
Your Manuscript
      │
      ├──► Structure Architect  ─►  Structure & logic suggestions
      ├──► Language Surgeon     ─►  Grammar & clarity suggestions
      └──► Devil's Advocate     ─►  Scientific rigor suggestions
                                          │
                                          ▼
                                    Judge Agent (background)
                                    Removes overlapping suggestions,
                                    keeps highest-impact ones
                                          │
                                          ▼
                                  Suggestions Panel
```

Each agent has a distinct job and is explicitly forbidden from duplicating the others' work:

| Agent | Role | Focuses on |
|-------|------|------------|
| **Structure Architect** | Document architecture | IMRAD structure, section flow, logic gaps, abstract accuracy |
| **Language Surgeon** | Sentence-level writing | Passive voice, wordiness, grammar, ambiguous pronouns |
| **Devil's Advocate** | Scientific rigor | Unsupported claims, over-stated conclusions, missing methodology |
| **Clarity & Impact** | Reader persuasion | Buried findings, excessive hedging, weak topic sentences |

For **local LLMs** (Ollama, LM Studio), the manuscript is chunked by section before sending to stay within context limits. For cloud APIs, the full manuscript is sent in one request.

### Step 3 — Review suggestions

The **Suggestions** tab in the sidebar shows all proposed changes sorted by position. Each card shows:
- The original text (with diff highlighting)
- The suggested replacement
- Severity (critical / major / minor / style)
- Category (grammar, flow, evidence, clarity, etc.)

Click **Accept** to apply the change to your manuscript. Click anywhere in a highlighted passage in the editor to jump directly to that suggestion card.

### Step 4 — Chat with agents

Use the **Chat** tab to ask questions or request targeted feedback. Type a message and select an agent to reply. The agent uses your full manuscript as context.

Chat generates inline suggestions **only when you explicitly ask** to edit or rewrite text (e.g., "rewrite this paragraph" or "fix this sentence"). General questions get plain conversational replies.

### Step 5 — Bubble menu actions (selected text)

Select any text in the editor to open the **floating bubble menu**. Six task-specific actions are available, each hardwired to the right agent regardless of which agent is selected in the chat box:

| Action | Agent | What it does |
|--------|-------|-------------|
| Polish | Language Surgeon | Grammar + tightening |
| Shorten | Language Surgeon | Cut for concision |
| Critique | Devil's Advocate | Find weaknesses |
| Strengthen | Devil's Advocate | Better evidence/argument |
| Sharpen | Clarity & Impact | Stronger topic sentence |
| Explain | Clarity & Impact | Clearer exposition |

Each bubble action produces an **accept/reject suggestion** — not a chat message.

**Rewrite** (toolbar button): Rewrites the selected passage entirely. Also produces an accept/reject suggestion.

**Thesaurus** (single word selected): Shows synonyms from the LLM.

### Step 6 — Reference paper analysis (PDF sources)

Upload reference PDFs via the **Sources** tab:

```
Upload PDF  ──►  PDF.js extracts text  ──►  LLM digests in context of your manuscript
                                                      │
                  ┌───────────────────────────────────┘
                  ▼
          "Compare against manuscript"
                  │
                  ▼
          Literature Reviewer agent
          Sends: reference text + your manuscript
          Returns: Supported Claims / Contradicted Claims / Should Be Cited / Summary
                  │
                  ▼
          Chat tab (with loading indicator)
```

Multiple PDFs are processed sequentially with per-file progress. Drag-and-drop or click to upload. `.bib` files (BibTeX) are also supported for reference management.

### Step 7 — Post-drafting (Rebuttal & Cover Letter)

Click the **Book** icon in the left rail (or the Download menu) to open the **Post-Drafting Assistant**. This module generates:
- A **rebuttal letter** responding to reviewer comments
- A **cover letter** tailored to a target journal

### Judge Agent (background)

After "Analyze All" completes and initial suggestions are shown, a **Judge Agent** runs automatically in the background. It:
1. Detects overlapping suggestions (where one passage is flagged by multiple agents)
2. For each conflict group, asks the LLM which suggestion is most impactful
3. Removes lower-priority duplicates and shows a notification ("X overlapping removed")

This keeps the suggestions list focused and actionable.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- npm
- (Optional) A local LLM server: [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/)

### Install & Run (web)

```bash
git clone https://github.com/dzyla/manuscriptAI
cd manuscript-ai-editor
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Desktop App (Electron)

```bash
npm run build:electron
```

Produces an AppImage for Linux in `release/`. Configure `electron-builder` in `package.json` for Windows/macOS.

---

## Configure AI Provider

Click **⚙ Settings** (bottom-left) to configure:

| Provider | Setup |
|----------|-------|
| **Local LLM** (default) | LM Studio / Ollama endpoint, e.g. `http://localhost:1234/v1/chat/completions` |
| **Google Gemini** | [Gemini API key](https://makersuite.google.com/app/apikey) |
| **OpenAI** | [OpenAI API key](https://platform.openai.com/api-keys) |
| **Anthropic Claude** | [Anthropic API key](https://console.anthropic.com/settings/keys) |

### Local LLM Tips

- Use **8B+ parameter** models for reliable JSON output (Llama 3.1 8B, Mistral Nemo, Qwen 2.5 7B)
- Smaller models (3-4B) work but may produce malformed JSON → "JSON parse failed" toast
- The app auto-chunks long manuscripts by IMRAD section for local models
- All API keys are stored in browser `localStorage` — never sent to any backend

---

## Workspace Save & Load

**Save Workspace** (Download menu or `Ctrl+S`) exports a `.json` file containing:
- Manuscript content (HTML)
- All suggestions (pending and applied)
- Chat history
- AI settings
- Uploaded PDF sources (text + AI digest)

**Load Workspace** restores everything including PDF sources.

---

## Project Structure

```
src/
├── App.tsx                     # Layout, state, analysis orchestration
├── components/
│   ├── Editor.tsx              # TipTap editor, bubble menu, highlight click
│   ├── Sidebar.tsx             # Chat, suggestions, history, PDF sources
│   ├── PostDraftingView.tsx    # Rebuttal & cover letter generator
│   └── SettingsModal.tsx       # Provider & agent prompt customization
├── services/
│   └── ai.ts                   # All LLM calls, agent prompts, judge agent
├── extensions/
│   └── GrammarChecker.ts       # TipTap extension for grammar underlines
├── types.ts                    # TypeScript interfaces
└── index.css                   # Design system (light/dark, editor styles)
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save workspace |
| `Ctrl+Shift+A` | Analyze with all agents |
| `Ctrl+?` | Show shortcuts |
| `Ctrl+B/I/U` | Bold / Italic / Underline |

---

## License

MIT
