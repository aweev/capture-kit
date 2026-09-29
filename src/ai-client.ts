import { resolveSecret, redactSecrets } from './auth.ts';
import type { AiConfig } from './ai-config.ts';

/**
 * Minimal OpenAI-compatible chat client (M4 transport).
 *
 * One `fetch` call, no SDK dependency. Text and vision (image_url data URLs)
 * both ride `/chat/completions`. All failures surface as Errors with redacted
 * messages — callers decide whether to warn-and-skip (run post-pass) or abort
 * (explicit `ai` command).
 */

export type ChatPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = { role: 'system' | 'user'; content: string | ChatPart[] };

export function resolveApiKey(config: AiConfig): string {
  if (!config.apiKey) {
    throw new Error('No AI API key. Set `ai.apiKey` (or `$ENV:NAME`) in config, or pass --ai-key.');
  }
  return resolveSecret(config.apiKey);
}

export async function chatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  options: { maxTokens?: number; json?: boolean; fetchFn?: typeof fetch } = {},
): Promise<string> {
  const key = resolveApiKey(config);
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`AI request failed: ${redactSecrets((err as Error).message)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response
      .text()
      .catch(() => '')
      .then((t) => t.slice(0, 300));
    throw new Error(`AI request failed (HTTP ${response.status}): ${redactSecrets(detail)}`);
  }
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI request returned no content.');
  return content;
}
