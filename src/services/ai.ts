import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
import { AgentType, Suggestion, AISettings } from "../types";
import { Clipboard, PenLine, FlaskConical, Beaker, BookMarked, MessageCircle } from 'lucide-react';

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
  },
  'literature-reviewer': {
    label: 'Literature Reviewer',
    color: 'bg-violet-600',
    bgSoft: 'bg-violet-50',
    iconName: 'book-marked',
    description: 'Compares an uploaded reference manuscript against your manuscript. Identifies which claims are supported, contradicted, or extended by the reference work.'
  },
  'manuscript-ai': {
    label: 'Manuscript AI',
    color: 'bg-emerald-700',
    bgSoft: 'bg-emerald-50',
    iconName: 'message-circle',
    description: 'Your scholarly research assistant. Discusses, critiques, and answers questions about your manuscript or attached sources — in plain conversation, no suggestion cards.'
  }
};

export const AGENT_ICONS: Record<string, any> = {
  'clipboard': Clipboard,
  'pen-line': PenLine,
  'flask-conical': FlaskConical,
  'beaker': Beaker,
  'book-marked': BookMarked,
  'message-circle': MessageCircle,
};

// Manuscript AI: conversational, scholarly, no suggestion cards
const MANUSCRIPT_AI_SYSTEM_PROMPT = `You are Manuscript AI — an expert academic research assistant with deep knowledge of scientific writing, research methodology, and scholarly communication.

Your role is to be the researcher's intellectual peer: discuss their work critically, answer questions precisely, and help them think through problems. You have read the full manuscript provided and can speak to any part of it.

Guidelines:
- Be direct and honest. Point out weaknesses without being diplomatic to the point of uselessness.
- Quote specific phrases from the manuscript when relevant to ground your critique.
- If asked about a specific section, focus your analysis there but acknowledge related issues elsewhere.
- When comparing against attached reference papers, be analytically precise: note where claims align, diverge, or need citation.
- Use academic but accessible prose. No bullet-point lists unless explicitly asked — write in paragraphs.
- Do NOT produce structured "accept/reject" suggestion blocks. Discuss in natural prose only.
- If the researcher's question is ambiguous, interpret it charitably and answer the most useful interpretation.
- Keep responses focused: 150–400 words unless the question clearly requires more.`;

// Writing style rules applied to all agents' suggested text
const SCIENTIFIC_WRITING_RULES = `
WRITING STYLE RULES — apply to every suggested replacement text:
- Use simple, clear, professional scientific English appropriate for NIH grant applications and peer-reviewed journals.
- Do NOT use em dashes (—) or en dashes (–). Use a comma, semicolon, or rewrite the sentence instead.
- Do NOT use rhetorical questions, exclamations, or conversational filler words (e.g., "Indeed,", "Notably,", "Importantly,", "Of note,", "It is worth mentioning that").
- Use a natural mix of active and passive voice as appropriate for the section: active voice in Methods ("We measured...") and Results ("X increased..."); passive voice is acceptable when the agent of the action is unknown or unimportant ("Samples were processed...").
- Keep sentences concise (under 35 words each). Prefer one idea per sentence.
- Use precise, field-standard terminology. Avoid vague intensifiers ("very", "quite", "extremely").
- Do not start sentences with conjunctions ("But", "And", "So") in formal scientific prose.
- Numbers: spell out one through nine; use numerals for 10 and above, and always with units (e.g., "5 mg", not "five mg").`;

export const DEFAULT_AGENT_PROMPTS: Record<AgentType, string> = {
  manager: `You are the STRUCTURE ARCHITECT. You evaluate ONLY the document's architecture and logical organization.

Focus EXCLUSIVELY on:
- Does the manuscript follow IMRAD structure? Are required sections missing or misplaced?
- Does the abstract accurately and completely summarize the key findings presented in the body?
- Are section transitions logical? Does each section follow from the previous one?
- Is the introduction properly scoped, with a clear statement of the research gap and objective?
- Does the discussion address limitations and future directions explicitly?
- Is the conclusion proportional to the evidence and does not overstate findings?
- Are there redundant sections or information repeated across sections?
- Does the narrative follow a coherent arc: problem, knowledge gap, approach, contribution?

DO NOT comment on grammar, word choice, or sentence-level style.
DO NOT comment on statistics or citation formatting.

Provide HIGH-IMPACT suggestions only. Each suggestion must represent a structural change that materially improves the manuscript's completeness or logical flow. Quote the EXACT text that requires revision.
${SCIENTIFIC_WRITING_RULES}`,

  editor: `You are the LANGUAGE SURGEON. You fix ONLY writing quality at the sentence and word level.

Focus EXCLUSIVELY on the highest-impact issues:
- Convert passive constructions to active where appropriate: "It was observed that X" becomes "We observed X"
- Remove wordy hedges and filler: delete "it is important to note that"; replace "in order to" with "to"
- Split sentences longer than 35 words into two shorter, clearer sentences
- Resolve ambiguous pronoun references: "it", "this", and "these" must have unambiguous antecedents
- Eliminate nominalization bloat: "perform an analysis of" becomes "analyze"; "make a comparison of" becomes "compare"
- Correct tense inconsistencies: use past tense for completed experiments, present tense for established facts
- Fix non-parallel structures in lists and compound phrases
- Replace em dashes (—) and en dashes (–) with commas, semicolons, or restructured sentences
- Remove conversational filler: "Indeed,", "Notably,", "It is worth mentioning that", "Of note,"

DO NOT comment on document structure, section ordering, or scientific validity.

CRITICAL RULE: originalText must be copied CHARACTER-FOR-CHARACTER from the manuscript. suggestedText must be a direct, complete drop-in replacement. Provide 4-6 high-impact suggestions.
${SCIENTIFIC_WRITING_RULES}`,

  'reviewer-2': `You are REVIEWER 2. You challenge the scientific rigor and logical integrity of the manuscript.

Focus EXCLUSIVELY on the most critical scientific weaknesses:
- Claims stated as established fact without citation: "X is well established" requires a reference or qualification
- Conclusions that exceed what the data supports: "These results prove X" should be "These results suggest X"
- Missing sample sizes, statistical tests, p-values, confidence intervals, or effect sizes
- Undefined abbreviations, undefined terms, or unexplained methodological choices
- Confounding variables not addressed in the analysis or acknowledged in the discussion
- Overgeneralization: findings from a specific context or population stated as universal
- Missing alternative interpretations of the results
- Limitations section that is absent, vague, or incomplete

DO NOT fix grammar or sentence style. Focus exclusively on scientific integrity and argumentation.

For each issue: quote the EXACT problematic text, state the specific scientific weakness in one sentence, and provide a concrete revised version that addresses the problem. Assign severity: "critical" for conclusions that exceed the data; "major" for missing quantitative detail or methodology; "minor" for missing caveats or qualifications.
${SCIENTIFIC_WRITING_RULES}`,

  researcher: `You are the CLARITY AND IMPACT SPECIALIST. You maximize the precision and communicative effectiveness of each paragraph.

Focus EXCLUSIVELY on high-impact structural writing problems:
- Topic sentences that bury the main point: the first sentence of each paragraph must state its conclusion or finding
- Excessive hedging that weakens the argument: "may possibly suggest" becomes "suggests"; "could potentially indicate" becomes "indicates"
- Key findings placed in the middle of a paragraph rather than at the beginning
- Abstracts that do not state the main finding within the first two sentences
- Discussion paragraphs that merely restate results rather than interpret them in the context of the field
- Vague quantifiers used where numbers are available: "significantly improved" should cite the measured value
- Paragraphs that address two or more distinct ideas and should be split
- Weak closing sentences that merely summarize rather than state the implication or significance

DO NOT fix grammar or punctuation.
DO NOT evaluate scientific validity.

For each suggestion, quote the EXACT weak text and provide a stronger, more precise replacement. List the most impactful suggestions first. Assign severity: "major" for buried findings or a weak abstract; "minor" for excess hedging or vague quantifiers.
${SCIENTIFIC_WRITING_RULES}`,

  'literature-reviewer': `You are a SCHOLARLY LITERATURE ANALYST. You assess how a reference paper relates to the current manuscript from a scientific perspective.

Your task is NOT direct comparison. Identify the scientific relationship between the two works across these dimensions:

1. Supporting Evidence: Does the reference provide data, methods, or findings that support claims in the manuscript? Specify which claims and what evidence.

2. Differing Findings: Does the reference report results that differ from the manuscript? Analyze possible reasons, such as differences in study population, experimental conditions, sample size, or methodology. Differences are scientific nuance, not contradiction.

3. Methodological Connections: Are the methods similar, complementary, or distinct? What methodological insights from the reference are relevant to the manuscript?

4. Contextual Background: Does the reference establish field context, define standard terminology, or provide benchmarks relevant to the manuscript?

5. Uncovered Gaps: Are there findings or aspects in the reference that the manuscript does not address but should acknowledge or build upon?

6. Citation Recommendation: How should the author engage with this reference: as supporting evidence, as a contrasting finding to discuss, as a methodological precedent, or as background context?

Structure your response with these section headings:
## Relationship to Your Manuscript
## Supporting Evidence
## Differing Findings and Scientific Context
## Methodological Connections
## Recommended Citations and Usage
## Summary

Write in clear, direct scientific prose. Quote specific passages from both documents where relevant. Note that differences in findings often reflect methodological or population differences rather than errors.
${SCIENTIFIC_WRITING_RULES}`,
  'manuscript-ai': MANUSCRIPT_AI_SYSTEM_PROMPT,
};

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? text.substring(0, maxLen) + '\n...[truncated]' : text;
}

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
      model: settings.anthropicModel || 'claude-sonnet-4-6',
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
      model: settings.openaiModel || 'gpt-5.4-mini',
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
      model: settings.geminiModel || 'gemini-3.1-pro-preview',
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

  // Dedup by exact originalText
  const seen = new Set<string>();
  return suggestions.filter(s => {
    const key = s.originalText.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, major: 3, minor: 2, style: 1 };

/**
 * Judge agent: runs after all suggestions are collected, finds overlapping suggestions
 * (where originalText of one is a substring of another, or they cover the same passage),
 * and for each conflict group selects the most impactful suggestion using LLM.
 * Falls back to severity-based selection if LLM fails.
 */
export async function runJudgeAgent(suggestions: Suggestion[], settings: AISettings): Promise<Suggestion[]> {
  if (suggestions.length < 2) return suggestions;

  // Build conflict groups: two suggestions conflict if one's originalText contains or is contained by the other's,
  // or if their startIndex/endIndex ranges overlap.
  const groups: Suggestion[][] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < suggestions.length; i++) {
    if (assigned.has(suggestions[i].id)) continue;
    const group = [suggestions[i]];
    assigned.add(suggestions[i].id);
    const a = suggestions[i];
    for (let j = i + 1; j < suggestions.length; j++) {
      if (assigned.has(suggestions[j].id)) continue;
      const b = suggestions[j];
      const overlap =
        (a.startIndex !== undefined && b.startIndex !== undefined &&
          a.startIndex <= b.endIndex && b.startIndex <= a.endIndex) ||
        a.originalText.includes(b.originalText) ||
        b.originalText.includes(a.originalText);
      if (overlap) {
        group.push(b);
        assigned.add(b.id);
      }
    }
    groups.push(group);
  }

  const winners: Suggestion[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      winners.push(group[0]);
      continue;
    }

    // Try LLM judge for this conflict group
    try {
      const prompt = `You are a manuscript improvement judge. Given these overlapping suggestions for a scientific manuscript, pick the ONE suggestion that would have the MOST IMPACT on manuscript quality. Consider: severity, specificity, and scientific value.

Suggestions:
${group.map((s, i) => `[${i}] Agent: ${s.agent} | Severity: ${s.severity || 'minor'} | Category: ${s.category || 'general'}
Original: "${s.originalText.substring(0, 150)}"
Suggested: "${s.suggestedText.substring(0, 150)}"
Reason: ${s.explanation.substring(0, 100)}`).join('\n\n')}

Respond with ONLY a single number (the index of the best suggestion, e.g. "0" or "2").`;

      const response = await callLLM(prompt, settings, 'You are a concise judge. Reply with only a number.');
      const idx = parseInt(response.trim().match(/\d+/)?.[0] || '0', 10);
      winners.push(group[Math.min(idx, group.length - 1)]);
    } catch (_) {
      // Fallback: pick by severity, then by shorter originalText (more specific)
      const best = group.reduce((a, b) => {
        const rankA = SEVERITY_RANK[a.severity || 'style'] ?? 1;
        const rankB = SEVERITY_RANK[b.severity || 'style'] ?? 1;
        if (rankA !== rankB) return rankA > rankB ? a : b;
        return a.originalText.length <= b.originalText.length ? a : b;
      });
      winners.push(best);
    }
  }

  return winners;
}

function buildFullTextPrompt(agentRole: string, text: string, existingContext: string): string {
  return `${agentRole}

Analyze this manuscript. Return ONLY valid JSON, nothing else.

Manuscript:
"""
${text}
"""
${existingContext}

Return ONLY this JSON format:
{"suggestions":[{"originalText":"exact quote from text","suggestedText":"improved version","explanation":"brief reason","severity":"critical","category":"grammar"}]}

Rules:
- originalText MUST be copied CHARACTER-FOR-CHARACTER from the manuscript
- Provide 5-10 specific, high-impact suggestions covering the ENTIRE manuscript (not just the beginning)
- Cover different sections: introduction, methods, results, discussion
- severity: "critical", "major", "minor", or "style"
- category: "grammar", "flow", "research", "clarity", or "structure"
- Return ONLY JSON, no other text`;
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
    // localChunkSize === 0 means no chunking — send full manuscript in one request
    const chunkSize = settings.localChunkSize;
    const useFullText = chunkSize === 0;
    const chunks = useFullText ? [text] : chunkTextForLocal(text, chunkSize ?? 2000);
    const allSuggestions: Suggestion[] = [];
    let parsingFailed = false;
    let rawResponses: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(`Chunk ${i + 1}/${chunks.length}`);
      const shortRole = useFullText ? activePrompt : activePrompt.substring(0, 400);
      const prompt = useFullText
        ? buildFullTextPrompt(shortRole, chunks[i], existingContext)
        : buildLocalPrompt(shortRole, chunks[i], existingContext);
      
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

// Intent categories for chat messages
type ChatIntent = 'command' | 'analysis_request' | 'info_question';

function detectChatIntent(message: string): ChatIntent {
  const lower = message.toLowerCase();
  // Direct execution commands: user wants text produced/transformed
  const commandPatterns = /\b(rewrite|write|draft|create|expand|rephrase|generate|produce|compose|restructure|revise|convert|transform|make it|turn this into)\b/;
  // Analysis/improvement requests: user wants assessment + specific fixes
  const analysisPatterns = /\b(improve|how (can|do|should|to)|what('s| is) wrong|review|analyze|analyse|evaluate|assess|critique|strengthen|fix|suggest|give me feedback|what should|how would|check|identify|find)\b/;
  // Pure information questions: user wants explanation, not edits
  const infoPatterns = /\b(what (does|is|are|means?)|explain|define|tell me about|describe|what happened|why did)\b/;

  if (commandPatterns.test(lower)) return 'command';
  if (infoPatterns.test(lower) && !analysisPatterns.test(lower)) return 'info_question';
  return 'analysis_request'; // default — most research questions want analysis
}

export async function chatWithAgent(
  message: string,
  context: string,
  agent: AgentType,
  settings: AISettings,
  attachedSources?: Array<{ name: string; text: string }>
): Promise<{ text: string; suggestions?: Suggestion[] }> {
  const activePrompt = settings.customPrompts?.[agent] || DEFAULT_AGENT_PROMPTS[agent];
  const isLocal = settings.provider === 'local';
  const localLargeContext = isLocal && settings.localChunkSize === 0;

  // Context budget: cloud models have large context windows; use them fully.
  // Local large-context mode (no chunking): allow up to 50k chars.
  // Local small-context: conservative limit.
  const maxContextChars = localLargeContext ? 50000 : isLocal ? 5000 : 40000;

  // Build context block
  let contextBlock: string;
  let referenceContext = context; // used for suggestion position lookup
  if (attachedSources && attachedSources.length > 0) {
    const perSourceBudget = Math.floor(maxContextChars / attachedSources.length);
    contextBlock = attachedSources.map(src =>
      `=== ${src.name} ===\n${truncateText(src.text, perSourceBudget)}`
    ).join('\n\n');
    if (attachedSources.length === 1) referenceContext = attachedSources[0].text;
  } else {
    contextBlock = truncateText(context, maxContextChars);
  }

  const intent = detectChatIntent(message);

  let taskInstruction: string;
  if (intent === 'command') {
    taskInstruction = `The researcher issued a direct command: execute it. Produce the requested text directly. Do NOT explain or critique — just do what was asked. If you produce a replacement for existing manuscript text, include it as a suggestion so the researcher can accept it.`;
  } else if (intent === 'analysis_request') {
    taskInstruction = `The researcher is requesting analysis or improvements. Read the FULL manuscript context provided, identify the relevant section(s), and:
1. Give a concise, specific answer focused on the section/aspect they asked about.
2. Back up your assessment with concrete examples from the text.
3. ALWAYS include specific text suggestions (originalText → suggestedText) for every problem you identify — do not describe problems without proposing fixes.
4. Aim for 3–8 targeted suggestions from the relevant section.`;
  } else {
    // info_question
    taskInstruction = `The researcher is asking an informational question. Answer clearly and concisely. No suggestions needed unless specific text edits would directly answer the question.`;
  }

  const prompt = `${taskInstruction}

Researcher: "${message}"

Manuscript / Context:
"""
${contextBlock}
"""

${intent !== 'info_question' ? `After your response, append any text edit suggestions in this exact format:
[SUGGESTIONS_START]
[
  {"originalText": "exact verbatim quote from the text above", "suggestedText": "improved replacement", "explanation": "specific reason", "severity": "critical|major|minor|style", "category": "grammar|clarity|flow|structure|research"}
]
[SUGGESTIONS_END]` : 'Reply in plain text only — no suggestions block needed.'}`;

  let textResponse = await callLLM(prompt, settings, activePrompt);
  if (!textResponse) textResponse = '';

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
          agent,
          startIndex: referenceContext.indexOf(s.originalText),
          endIndex: referenceContext.indexOf(s.originalText) + (s.originalText?.length || 0),
          severity: s.severity || 'minor',
          category: s.category || 'clarity',
        }))
        .filter((s: any) => s.startIndex !== -1);
      cleanText = textResponse.replace(/\[SUGGESTIONS_START\][\s\S]*?\[SUGGESTIONS_END\]/, '').trim();
    } catch (e) {
      console.error('Failed to parse chat suggestions:', e);
    }
  }

  return { text: cleanText, suggestions };
}

export async function chatWithManuscript(
  message: string,
  context: string,
  settings: AISettings,
  attachedSources?: Array<{ name: string; text: string }>
): Promise<{ text: string }> {
  const isLocal = settings.provider === 'local';
  const localLargeContext = isLocal && settings.localChunkSize === 0;
  const maxContextChars = localLargeContext ? 50000 : isLocal ? 6000 : 40000;

  let contextBlock: string;
  if (attachedSources && attachedSources.length > 0) {
    const perSourceBudget = Math.floor(maxContextChars / attachedSources.length);
    contextBlock = attachedSources.map(src =>
      `=== ${src.name} ===\n${truncateText(src.text, perSourceBudget)}`
    ).join('\n\n');
  } else {
    contextBlock = truncateText(context, maxContextChars);
  }

  const prompt = `Manuscript / Context:
"""
${contextBlock}
"""

Researcher: "${message}"

Respond as a knowledgeable academic peer. Be specific, critical, and grounded in the text above.`;

  const text = await callLLM(prompt, settings, MANUSCRIPT_AI_SYSTEM_PROMPT);
  return { text: text || 'No response generated.' };
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

export async function getThesaurus(word: string, settings: AISettings): Promise<string[]> {
  // Use Datamuse API for fast, free synonym lookup without token cost
  try {
    const response = await fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&max=10`);
    if (response.ok) {
      const data = await response.json();
      if (data.length > 0) return data.map((d: any) => d.word);
    }
  } catch (_) {}

  // Fallback to LLM
  const prompt = `List 8 synonyms for the word "${word}" as used in academic writing. Return ONLY a JSON array of strings, e.g. ["word1","word2"]. No explanation.`;
  try {
    const response = await callLLM(prompt, settings, 'You are a thesaurus. Return only JSON arrays.', true);
    const parsed = parseJSONRobust(response);
    if (Array.isArray(parsed)) return parsed.slice(0, 8);
  } catch (_) {}
  return [];
}

export async function digestSourceForManuscript(sourceText: string, sourceName: string, manuscriptText: string, settings: AISettings): Promise<string> {
  const isLocal = settings.provider === 'local';
  const truncatedSource = truncateText(sourceText, isLocal ? 3000 : 8000);
  const truncatedManuscript = truncateText(manuscriptText, isLocal ? 1000 : 2000);

  const systemPrompt = `You are a research assistant helping to digest reference materials for a manuscript author.
Given a source document and the current manuscript, extract and summarize the most relevant information from the source.
Focus on: key findings, methods, data, or arguments that relate to the manuscript's topic.
Be concise (max 300 words). Use bullet points for key facts.`;

  const prompt = `Manuscript (for context):
"""
${truncatedManuscript}
"""

Source document "${sourceName}":
"""
${truncatedSource}
"""

Summarize what in this source is most relevant to the manuscript above. Focus on facts, findings, and methods the author could cite or build upon.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || sourceText.substring(0, 500) + '...';
  } catch (_) {
    return sourceText.substring(0, 500) + '...';
  }
}

export async function rewriteSection(sectionText: string, manuscriptContext: string, settings: AISettings): Promise<string> {
  const truncatedContext = truncateText(manuscriptContext, settings.provider === 'local' ? 800 : 2000);

  const systemPrompt = `You are an expert academic editor specializing in NIH-style scientific manuscripts. Rewrite the provided section to maximize clarity and scientific rigor while preserving all findings and meaning.

Writing requirements:
- Use simple, clear, professional scientific English appropriate for peer-reviewed journals and NIH applications.
- Do NOT use em dashes (—) or en dashes (–). Use commas, semicolons, or rewrite affected sentences.
- Do NOT use rhetorical questions, exclamations, or filler phrases ("Indeed,", "Notably,", "Of note,", "It is worth mentioning that").
- Use a natural mix of active and passive voice: active in Methods and Results where the agent is clear; passive is acceptable when the subject is unknown or unimportant.
- Keep sentences under 35 words. One idea per sentence.
- Avoid vague intensifiers ("very", "quite", "extremely"). Use precise, field-standard terminology.
- Do not start sentences with conjunctions ("But", "And", "So") in formal scientific prose.
Return ONLY the rewritten text, no commentary.`;

  const prompt = `Manuscript context (surrounding text):
"""
${truncatedContext}
"""

Section to rewrite:
"""
${sectionText}
"""

Provide a complete rewrite of the section above.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || sectionText;
  } catch (_) {
    return sectionText;
  }
}

export async function transformWithInstruction(
  selectedText: string,
  instruction: string,
  manuscriptContext: string,
  settings: AISettings
): Promise<string> {
  const truncatedContext = truncateText(manuscriptContext, settings.provider === 'local' ? 600 : 1500);

  const systemPrompt = `You are an expert academic writing assistant specializing in scientific manuscripts. Transform the provided text according to the instruction. Preserve all key scientific information and claims.

Writing requirements for the output:
- Simple, clear, professional scientific English. NIH-compliant style.
- Do NOT use em dashes (—) or en dashes (–).
- Do NOT use rhetorical questions, exclamations, or conversational filler ("Indeed,", "Notably,", "Of note,").
- Mix of active and passive voice appropriate to the section context.
- Sentences under 35 words. Precise, field-standard terminology.
Return ONLY the transformed text, no commentary, no quotation marks around the output.`;

  const prompt = `Instruction: ${instruction}

Manuscript context (for reference only):
"""
${truncatedContext}
"""

Text to transform:
"""
${selectedText}
"""

Apply the instruction to the text above. Return ONLY the transformed text.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    // Strip any quotes or markdown the LLM might add
    return response.trim().replace(/^["'`]+|["'`]+$/g, '').trim() || selectedText;
  } catch (_) {
    return selectedText;
  }
}

export async function analyzeSourceAgainstManuscript(
  sourceText: string,
  sourceName: string,
  manuscriptText: string,
  settings: AISettings
): Promise<string> {
  const isLocal = settings.provider === 'local';
  const truncatedSource = truncateText(sourceText, isLocal ? 4000 : 12000);
  const truncatedManuscript = truncateText(manuscriptText, isLocal ? 3000 : 8000);

  const systemPrompt = DEFAULT_AGENT_PROMPTS['literature-reviewer'];

  const prompt = `## Your manuscript (work-in-progress):
"""
${truncatedManuscript}
"""

## Reference paper "${sourceName}":
"""
${truncatedSource}
"""

Analyze the scientific relationship between these two manuscripts. Focus on how the reference paper can inform, support, complement, or nuance the current manuscript. Identify methodological connections, supporting evidence, differing findings (and why they might differ), and how the author should engage with this reference.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No analysis generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Literature analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function generatePostDraftingContent(text: string, type: 'cover_letter' | 'rebuttal', settings: AISettings): Promise<string> {
  const systemPrompt = type === 'cover_letter' ? POST_DRAFTING_PROMPTS.COVER_LETTER_AGENT : POST_DRAFTING_PROMPTS.REBUTTAL_AGENT;

  const prompt = `Here is the manuscript text:\n\n"""\n${text}\n"""\n\nPlease generate the requested document based on your instructions.`;

  try {
    const response = await callLLM(prompt, settings, systemPrompt, false);
    return response || 'No content generated. Check your LLM connection.';
  } catch (error) {
    throw new Error(`Failed to generate content: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export const POST_DRAFTING_PROMPTS = {
  COVER_LETTER_AGENT: `You are an expert academic editor drafting a journal cover letter.
Write a formal, persuasive cover letter to the Editor-in-Chief.
1. State the manuscript title and target journal (use placeholders like [Journal Name] if unknown).
2. Briefly summarize the core research question and methodology.
3. Highlight the most significant findings and their broader impact.
4. Explain why this paper is a perfect fit for the journal's readership.
5. Include standard declarations (not under consideration elsewhere, all authors agree).
Make it professional, confident, and concise (under 400 words).`,

  REBUTTAL_AGENT: `You are an expert academic editor drafting a response to reviewers.
Based on the provided manuscript, draft a template for a rebuttal letter.
Include:
1. A polite, appreciative opening to the Editor and Reviewers.
2. A bulleted summary of the major changes made to the manuscript.
3. A structured "Point-by-Point Response" section with placeholder examples showing how to respectfully agree with, or push back on, reviewer comments using evidence from the text.`
};
