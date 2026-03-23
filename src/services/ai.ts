import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
import { AgentType, Suggestion, AISettings } from "../types";
import { Clipboard, PenLine, FlaskConical, Beaker } from 'lucide-react';

export const AGENT_INFO: Record<AgentType, { label: string; color: string; bgSoft: string; description: string; iconName: string }> = {
  manager: {
    label: 'Structure Architect',
    color: 'bg-stone-800',
    bgSoft: 'bg-stone-50',
    iconName: 'clipboard',
    description: 'Evaluates document architecture: section ordering, missing sections, abstract–body coherence, and narrative flow between sections.'
  },
  editor: {
    label: 'Language Surgeon',
    color: 'bg-blue-600',
    bgSoft: 'bg-blue-50',
    iconName: 'pen-line',
    description: 'Fixes grammar, word choice, sentence length, passive voice, tone consistency, and readability. Makes every sentence crisp.'
  },
  'reviewer-2': {
    label: 'Reviewer 2',
    color: 'bg-rose-600',
    bgSoft: 'bg-rose-50',
    iconName: 'flask-conical',
    description: 'The tough but fair peer reviewer. Finds logical holes, unsupported claims, methodology gaps, and overclaimed conclusions.'
  },
  researcher: {
    label: 'Clarity & Impact',
    color: 'bg-amber-600',
    bgSoft: 'bg-amber-50',
    iconName: 'beaker',
    description: 'Maximizes clarity and impact: strengthens topic sentences, tightens hedging language, ensures every paragraph earns its place, and makes arguments compelling.'
  }
};

export const AGENT_ICONS: Record<string, any> = {
  'clipboard': Clipboard,
  'pen-line': PenLine,
  'flask-conical': FlaskConical,
  'beaker': Beaker,
};

export const DEFAULT_AGENT_PROMPTS: Record<AgentType, string> = {
  manager: `You are the STRUCTURE ARCHITECT — you evaluate ONLY the document's architecture and organization.

Focus EXCLUSIVELY on:
- Does the manuscript follow IMRAD structure? Are any required sections missing?
- Does the abstract accurately summarize the key findings presented in the body?
- Are section transitions smooth? Does each section logically follow the previous one?
- Is the introduction properly scoped — does it set up the research question?
- Does the discussion address limitations and future directions?
- Is the conclusion proportional to the evidence (not overstated)?
- Are there redundant sections or repeated information across sections?
- Is the overall narrative arc compelling and logical?

DO NOT comment on grammar, word choice, or writing style — that's not your job.
DO NOT comment on statistics or citations — that's handled by other agents.

For each suggestion, quote the EXACT text that needs changing and suggest a structural improvement.`,

  editor: `You are the LANGUAGE SURGEON — you fix ONLY writing quality at the sentence/word level.

Focus EXCLUSIVELY on:
- Convert passive voice to active: "It was observed that..." → "We observed..."
- Tighten wordy phrases: "a large number of" → "many", "in order to" → "to"
- Fix grammar, punctuation, and scientific notation errors
- Split sentences longer than 30 words into shorter, clearer ones
- Replace jargon with simpler alternatives when possible
- Fix ambiguous pronoun references ("it", "this", "these")
- Ensure consistent tense usage throughout
- Improve parallel structure in lists and comparisons

DO NOT comment on document structure, section ordering, or overall organization.
DO NOT evaluate scientific claims or methodology — that's not your role.

Each originalText must be an EXACT quote from the manuscript. suggestedText must be a drop-in replacement.`,

  'reviewer-2': `You are the DEVIL'S ADVOCATE — you challenge the scientific logic and argumentation.

Focus EXCLUSIVELY on:
- Claims stated without supporting evidence: "X is well-established" — says who?
- Conclusions that go beyond what the data actually shows
- Missing control experiments or baseline comparisons
- Methodology gaps: unclear sample selection, missing sample sizes
- Logical leaps between observations and interpretations
- Potential confounding variables not addressed
- Missing acknowledgment of limitations
- Cherry-picked results or selective data presentation

DO NOT fix grammar or word choice — that's the Language Surgeon's job.
DO NOT check numerical accuracy or citation formatting — the Evidence Auditor does that.

For each issue, quote the EXACT problematic text and suggest what the author should ADD, CHANGE, or ACKNOWLEDGE.`,

  researcher: `You are the CLARITY & IMPACT SPECIALIST — you maximize the persuasive power and readability of every paragraph.

Focus EXCLUSIVELY on:
- Weak topic sentences that don't preview the paragraph's argument
- Excessive hedging: "It may be possible that..." → "Evidence suggests..."
- Paragraphs that don't earn their place — suggest what to cut or merge
- Key findings buried in the middle of paragraphs instead of leading
- Vague quantifiers: "some", "many", "several" — suggest being specific or removing
- Run-on paragraphs that try to make multiple points (split them)
- Weak transitions between paragraphs
- Conclusions that merely summarize instead of synthesizing and projecting
- Abstract that buries the key finding instead of leading with it

DO NOT fix grammar or punctuation — the Language Surgeon handles that.
DO NOT evaluate document structure or section ordering — the Structure Architect does that.
DO NOT question scientific claims — Reviewer 2 does that.

For each suggestion, quote the EXACT weak text and provide a stronger, more impactful alternative.
Assign severity "major" for buried findings and "minor" for excess hedging.`
};

function getOpenAIClient(settings: AISettings) {
  return new OpenAI({
    apiKey: settings.openaiApiKey || '',
    dangerouslyAllowBrowser: true
  });
}

function getAnthropicHeaders(settings: AISettings) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': settings.anthropicApiKey || '',
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function callAnthropicLLM(prompt: string, settings: AISettings, systemPrompt: string = ""): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: getAnthropicHeaders(settings),
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt || undefined,
      messages: [{ role: 'user', content: prompt }],
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${text}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

async function callLocalLLM(prompt: string, settings: AISettings, systemPrompt: string = ""): Promise<string> {
  let baseUrl = settings.localBaseUrl.trim();
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  
  // Build candidate endpoints from the user's configured URL
  // LM Studio/Ollama use: http://host:port/v1/chat/completions
  // User might configure: http://host:port, http://host:port/v1, http://host:port/api/v1/chat, etc.
  const candidateEndpoints: string[] = [];
  
  // If URL already contains /chat/completions, use it as-is
  if (baseUrl.includes('/chat/completions')) {
    candidateEndpoints.push(baseUrl);
  }
  
  // Extract the origin (protocol + host + port)
  try {
    const url = new URL(baseUrl);
    const origin = url.origin;
    // Standard OpenAI-compatible endpoints (most common)
    candidateEndpoints.push(`${origin}/v1/chat/completions`);
    candidateEndpoints.push(`${origin}/api/v1/chat/completions`);
    // Also try the exact URL the user provided
    if (!candidateEndpoints.includes(baseUrl)) {
      candidateEndpoints.push(baseUrl);
    }
  } catch (_) {
    candidateEndpoints.push(baseUrl);
  }
  
  // Deduplicate
  const endpoints = [...new Set(candidateEndpoints)];
  
  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const body = JSON.stringify({
    model: settings.localModel,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(settings.localApiKey ? { 'Authorization': `Bearer ${settings.localApiKey}` } : {})
  };

  let lastError = '';
  for (const ep of endpoints) {
    try {
      const response = await fetch(ep, { method: 'POST', headers, body });

      if (response.ok) {
        const data = await response.json();
        if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
        if (data.output && Array.isArray(data.output)) {
          const messageNode = data.output.find((o: any) => o.type === 'message') || data.output[data.output.length - 1];
          if (messageNode?.content) return messageNode.content;
        }
        if (data.reply) return data.reply;
        if (data.message?.content) return data.message.content;
        if (data.content) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        return JSON.stringify(data);
      } else {
        lastError = `${ep} returned ${response.status}`;
      }
    } catch (e) {
      lastError = `${ep}: ${e instanceof Error ? e.message : 'connection failed'}`;
      continue;
    }
  }

  throw new Error(`Could not connect to local LLM. Tried: ${endpoints.join(', ')}. Last error: ${lastError}`);
}

/**
 * Robust JSON parser that handles common LLM output issues:
 * - Markdown code blocks
 * - Trailing commas
 * - Unescaped newlines in strings
 * - Partial responses
 * - Text before/after JSON
 */
function parseJSONRobust(text: string): any {
  let cleanText = text.trim();
  
  // Extract from markdown code blocks
  const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleanText = codeBlockMatch[1].trim();
  } else if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  
  // Try direct parse first
  try {
    return JSON.parse(cleanText);
  } catch (_) {}
  
  // Fix common issues and retry
  let fixed = cleanText;
  
  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  
  // Fix unescaped newlines within string values
  fixed = fixed.replace(/"([^"]*?)"/g, (match) => {
    return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  });
  
  try {
    return JSON.parse(fixed);
  } catch (_) {}
  
  // Try to extract JSON object or array from surrounding text
  const patterns = [
    // Match outermost { ... }
    () => {
      const objStart = fixed.indexOf('{');
      const objEnd = fixed.lastIndexOf('}');
      if (objStart !== -1 && objEnd > objStart) {
        return fixed.substring(objStart, objEnd + 1);
      }
      return null;
    },
    // Match outermost [ ... ]  
    () => {
      const arrStart = fixed.indexOf('[');
      const arrEnd = fixed.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd > arrStart) {
        return fixed.substring(arrStart, arrEnd + 1);
      }
      return null;
    }
  ];
  
  for (const extract of patterns) {
    const candidate = extract();
    if (candidate) {
      // Clean trailing commas again
      const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(cleaned);
      } catch (_) {}
    }
  }
  
  // Last resort: try to extract individual suggestion objects
  const suggestionMatches = fixed.match(/\{[^{}]*"originalText"[^{}]*"suggestedText"[^{}]*\}/g);
  if (suggestionMatches && suggestionMatches.length > 0) {
    const parsed: any[] = [];
    for (const match of suggestionMatches) {
      try {
        const cleanMatch = match.replace(/,\s*([}\]])/g, '$1');
        parsed.push(JSON.parse(cleanMatch));
      } catch (_) {}
    }
    if (parsed.length > 0) {
      return { suggestions: parsed };
    }
  }
  
  // Log the raw response for debugging
  console.warn('Failed to parse LLM response as JSON. Raw response (first 500 chars):', text.substring(0, 500));
  throw new Error('Could not parse LLM response as JSON');
}

function getGeminiClient(settings: AISettings) {
  return new GoogleGenAI({ apiKey: settings.geminiApiKey || process.env.GEMINI_API_KEY || "" });
}

function detectSections(text: string): { section: string; text: string }[] {
  const sectionPatterns = [
    { name: 'Abstract', pattern: /(?:^|\n)\s*(?:abstract)\s*[:\n]/i },
    { name: 'Introduction', pattern: /(?:^|\n)\s*(?:introduction|background)\s*[:\n]/i },
    { name: 'Methods', pattern: /(?:^|\n)\s*(?:methods?|materials?\s+and\s+methods?|experimental\s+(?:procedures?|design))\s*[:\n]/i },
    { name: 'Results', pattern: /(?:^|\n)\s*(?:results?)\s*[:\n]/i },
    { name: 'Discussion', pattern: /(?:^|\n)\s*(?:discussion)\s*[:\n]/i },
    { name: 'Conclusion', pattern: /(?:^|\n)\s*(?:conclusions?|summary)\s*[:\n]/i },
    { name: 'References', pattern: /(?:^|\n)\s*(?:references?|bibliography)\s*[:\n]/i },
  ];

  const detected: { section: string; start: number }[] = [];
  for (const sp of sectionPatterns) {
    const match = text.match(sp.pattern);
    if (match && match.index !== undefined) {
      detected.push({ section: sp.name, start: match.index });
    }
  }

  if (detected.length === 0) return [{ section: 'General', text }];

  detected.sort((a, b) => a.start - b.start);
  const sections: { section: string; text: string }[] = [];
  for (let i = 0; i < detected.length; i++) {
    const end = i + 1 < detected.length ? detected[i + 1].start : text.length;
    sections.push({ section: detected[i].section, text: text.substring(detected[i].start, end) });
  }
  return sections;
}

function chunkTextForLocal(text: string, maxChunkChars: number = 2000): string[] {
  const sections = detectSections(text);
  
  if (sections.length > 1) {
    const chunks: string[] = [];
    for (const section of sections) {
      if (section.section === 'References') continue;
      if (section.text.length <= maxChunkChars) {
        chunks.push(`[Section: ${section.section}]\n${section.text}`);
      } else {
        const paragraphs = section.text.split(/\n\n+/);
        let currentChunk = `[Section: ${section.section}]\n`;
        for (const para of paragraphs) {
          if ((currentChunk + para).length > maxChunkChars && currentChunk.length > 50) {
            chunks.push(currentChunk.trim());
            currentChunk = `[Section: ${section.section} (continued)]\n`;
          }
          currentChunk += para + '\n\n';
        }
        if (currentChunk.trim().length > 50) chunks.push(currentChunk.trim());
      }
    }
    return chunks.length > 0 ? chunks : [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + para).length > maxChunkChars && current.length > 50) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function callLLM(prompt: string, settings: AISettings, systemPrompt: string, jsonMode: boolean = false): Promise<string> {
  if (settings.provider === 'local') {
    return callLocalLLM(prompt, settings, systemPrompt);
  } else if (settings.provider === 'anthropic') {
    return callAnthropicLLM(prompt, settings, systemPrompt);
  } else if (settings.provider === 'openai') {
    const openai = getOpenAIClient(settings);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt }
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {})
    });
    return response.choices[0].message.content || '';
  } else {
    const ai = getGeminiClient(settings);
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: (systemPrompt ? systemPrompt + '\n\n' : '') + prompt,
      ...(jsonMode ? {
        config: {
          responseMimeType: "application/json",
        }
      } : {})
    });
    return response.text || '';
  }
}


export async function resolveConflicts(suggestions: Suggestion[], settings: AISettings): Promise<Suggestion[]> {
  if (suggestions.length < 2) return suggestions;

  // Simple dedup — always use this for speed
  const seen = new Set<string>();
  return suggestions.filter(s => {
    const key = s.originalText.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLocalPrompt(agentRole: string, textChunk: string, existingContext: string): string {
  return `${agentRole}

Analyze this text. Return ONLY valid JSON, nothing else.

Text:
"""
${textChunk}
"""
${existingContext}

Return ONLY this JSON format:
{"suggestions":[{"originalText":"exact quote from text","suggestedText":"improved version","explanation":"brief reason","severity":"critical","category":"grammar"}]}

Rules:
- originalText MUST be copied exactly from the text above
- Provide 3-6 specific suggestions
- severity: "critical", "major", "minor", or "style"
- category: "grammar", "flow", "research", "clarity", or "structure"
- Return ONLY JSON, no other text`;
}

export async function analyzeText(text: string, agent: AgentType, settings: AISettings, existingSuggestions: Suggestion[] = [], onProgress?: (msg: string) => void): Promise<{ suggestions: Suggestion[], status: 'ok' | 'no_suggestions' | 'parsing_failed' }> {
  const activePrompt = settings.customPrompts?.[agent] || DEFAULT_AGENT_PROMPTS[agent];
  
  let existingContext = '';
  if (existingSuggestions.length > 0) {
    const existingTexts = existingSuggestions.map(s => s.originalText).slice(0, 10);
    existingContext = `\nAlready suggested (DO NOT repeat these): ${JSON.stringify(existingTexts)}`;
  }

  if (settings.provider === 'local') {
    const chunks = chunkTextForLocal(text);
    const allSuggestions: Suggestion[] = [];
    let parsingFailed = false;
    let rawResponses: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(`Chunk ${i + 1}/${chunks.length}`);
      const shortRole = activePrompt.substring(0, 400);
      const prompt = buildLocalPrompt(shortRole, chunks[i], existingContext);
      
      try {
        const textResponse = await callLocalLLM(prompt, settings, "Return only valid JSON. No markdown, no explanations.");
        rawResponses.push(textResponse);
        
        if (textResponse) {
          try {
            const parsed = parseJSONRobust(textResponse);
            const suggestionsArr = Array.isArray(parsed) ? parsed : (parsed.suggestions || parsed.fixes || []);
            const chunkSuggestions = suggestionsArr
              .filter((s: any) => s.originalText && s.suggestedText)
              .map((s: any, index: number) => ({
                ...s,
                id: `suggestion-${Date.now()}-${i}-${index}`,
                agent: agent,
                startIndex: text.indexOf(s.originalText),
                endIndex: text.indexOf(s.originalText) + (s.originalText?.length || 0),
                severity: ['critical', 'major', 'minor', 'style'].includes(s.severity) ? s.severity : 'minor',
                category: ['grammar', 'flow', 'research', 'clarity', 'structure'].includes(s.category) ? s.category : 'grammar',
                section: s.section || 'General'
              }))
              .filter((s: any) => s.startIndex !== -1);
            
            allSuggestions.push(...chunkSuggestions);
            if (chunkSuggestions.length > 0) {
              existingContext += '\n' + JSON.stringify(chunkSuggestions.map((s: any) => s.originalText).slice(0, 5));
            }
          } catch (parseErr) {
            console.error(`Chunk ${i + 1} parse error:`, parseErr);
            console.log('Raw response:', textResponse.substring(0, 300));
            parsingFailed = true;
          }
        }
      } catch (e) {
        console.error(`Failed to analyze chunk ${i + 1}:`, e);
        parsingFailed = true;
      }
    }
    
    if (allSuggestions.length === 0 && parsingFailed) {
      console.warn('All chunks failed to parse. Last raw responses:', rawResponses.slice(-2));
    }
    
    return { 
      suggestions: allSuggestions, 
      status: allSuggestions.length > 0 ? 'ok' : (parsingFailed ? 'parsing_failed' : 'no_suggestions') 
    };
  }

  // Cloud provider path
  const sections = detectSections(text);
  const sectionContext = sections.length > 1 
    ? `\nDetected sections: ${sections.map(s => s.section).join(', ')}. Tag each suggestion with its section.`
    : '';

  const prompt = `${activePrompt}${sectionContext}${existingContext}

Analyze this manuscript text and provide specific, actionable suggestions.
    
Text:
"""
${text}
"""
    
Return a JSON object: {"suggestions": [...]}
Each suggestion must have:
- originalText: EXACT quote from the text
- suggestedText: the improved replacement text
- explanation: specific reason for the change
- severity: "critical" | "major" | "minor" | "style"
- category: "grammar" | "flow" | "research" | "clarity" | "structure"
- section: which manuscript section

Provide 8-15 highly specific suggestions. Each originalText MUST be an exact quote.`;

  try {
    let textResponse = await callLLM(prompt, settings, activePrompt, true);
    if (!textResponse) return { suggestions: [], status: 'no_suggestions' };

    const parsed = parseJSONRobust(textResponse);
    const suggestionsArr = Array.isArray(parsed) ? parsed : (parsed.suggestions || []);
    const result = suggestionsArr
      .filter((s: any) => s.originalText && s.suggestedText)
      .map((s: any, index: number) => ({
        ...s,
        id: `suggestion-${Date.now()}-${index}`,
        agent: agent,
        startIndex: text.indexOf(s.originalText),
        endIndex: text.indexOf(s.originalText) + (s.originalText?.length || 0),
        severity: ['critical', 'major', 'minor', 'style'].includes(s.severity) ? s.severity : 'minor',
        category: ['grammar', 'flow', 'research', 'clarity', 'structure'].includes(s.category) ? s.category : 'grammar',
        section: s.section || 'General'
      }))
      .filter((s: any) => s.startIndex !== -1);
    
    return { 
      suggestions: result, 
      status: result.length > 0 ? 'ok' : 'no_suggestions' 
    };
  } catch (e) {
    console.error(`Failed to parse suggestions for ${agent}:`, e);
    return { suggestions: [], status: 'parsing_failed' };
  }
}

export async function chatWithAgent(message: string, context: string, agent: AgentType, settings: AISettings): Promise<{ text: string; suggestions?: Suggestion[] }> {
  const activePrompt = settings.customPrompts?.[agent] || DEFAULT_AGENT_PROMPTS[agent];
  const maxContext = settings.provider === 'local' ? 1500 : 3000;
  const truncatedContext = context.length > maxContext ? context.substring(0, maxContext) + '\n...(truncated)' : context;

  const prompt = `The researcher says: "${message}"
    
Current Manuscript Context:
"""
${truncatedContext}
"""
    
Provide a helpful response. If you have specific text improvements, include them at the end in this format:
[SUGGESTIONS_START] [{"originalText": "...", "suggestedText": "...", "explanation": "...", "severity": "minor", "category": "grammar"}] [SUGGESTIONS_END]`;

  let textResponse = await callLLM(prompt, settings, activePrompt);
  if (!textResponse) textResponse = "";

  const suggestionsMatch = textResponse.match(/\[SUGGESTIONS_START\]([\s\S]*?)\[SUGGESTIONS_END\]/);
  let suggestions: Suggestion[] = [];
  let cleanText = textResponse;

  if (suggestionsMatch) {
    try {
      const parsed = parseJSONRobust(suggestionsMatch[1].trim());
      const arr = Array.isArray(parsed) ? parsed : (parsed.suggestions || []);
      suggestions = arr
        .filter((s: any) => s.originalText && s.suggestedText)
        .map((s: any, index: number) => ({
          ...s,
          id: `suggestion-chat-${Date.now()}-${index}`,
          agent: agent,
          startIndex: context.indexOf(s.originalText),
          endIndex: context.indexOf(s.originalText) + (s.originalText?.length || 0),
          severity: s.severity || 'minor',
          category: s.category || 'style'
        }))
        .filter((s: any) => s.startIndex !== -1);
      cleanText = textResponse.replace(/\[SUGGESTIONS_START\][\s\S]*?\[SUGGESTIONS_END\]/, "").trim();
    } catch (e) {
      console.error("Failed to parse chat suggestions:", e);
    }
  }

  return { text: cleanText, suggestions };
}

export async function rebutSuggestion(suggestion: Suggestion, feedback: string, fullText: string, settings: AISettings): Promise<Suggestion[]> {
  const activePrompt = settings.customPrompts?.[suggestion.agent] || DEFAULT_AGENT_PROMPTS[suggestion.agent];
  
  const prompt = `The researcher disagreed with your suggestion.
Original text: "${suggestion.originalText}"
Your proposed change: "${suggestion.suggestedText}"
Your reasoning: "${suggestion.explanation}"

Researcher's feedback: "${feedback}"

Reconsider and provide a refined suggestion. Return ONLY JSON:
{"suggestions": [{"originalText": "${suggestion.originalText}", "suggestedText": "...", "explanation": "...", "severity": "${suggestion.severity || 'minor'}", "category": "${suggestion.category || 'grammar'}"}]}`;

  let textResponse = await callLLM(prompt, settings, activePrompt + "\nReturn exactly 1 refined suggestion as JSON.", true);
  if (!textResponse) textResponse = '{"suggestions":[]}';
  
  try {
    const data = parseJSONRobust(textResponse);
    const suggestionsArr = Array.isArray(data) ? data : (data?.suggestions || []);
    if (suggestionsArr && suggestionsArr.length > 0) {
      const newSug = suggestionsArr[0];
      newSug.id = `${Date.now()}`;
      newSug.agent = suggestion.agent;
      newSug.startIndex = suggestion.startIndex;
      newSug.endIndex = suggestion.endIndex;
      newSug.originalText = suggestion.originalText;
      return [newSug];
    }
  } catch (e) {
    console.error("Failed to parse rebuttal:", e);
  }
  return [];
}

export async function manuscriptSummary(text: string, settings: AISettings): Promise<string> {
  const systemPrompt = `You are a senior academic peer reviewer. Provide a comprehensive, high-level review of this manuscript.

Your review should be structured as follows:

## Summary
A 2-3 sentence description of what this manuscript is about, its research question, and approach.

## Strengths
List 3-5 genuine strengths of the manuscript as bullet points.

## Key Weaknesses & Gaps
List the 3-5 most significant weaknesses that need to be addressed. Be specific and constructive.
Focus on:
- Logical gaps in the argumentation
- Missing elements (methodology details, context, limitations discussion)
- Structural issues
- Unclear or unsupported claims
- Issues with the narrative flow

## Overall Assessment
A brief paragraph on where this manuscript stands and what it would take to make it publication-ready.

## Priority Recommendations
A numbered list of 3-5 concrete actions the author should take, ordered by importance.

Be direct, specific, and constructive — like a helpful Reviewer 2 who wants the paper to succeed.`;

  const prompt = `Please review this complete manuscript:

"""
${text}
"""

Provide your structured review as described in your instructions.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No review generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Failed to generate manuscript summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
