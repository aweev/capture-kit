import { z } from 'zod';

/**
 * AI layer config (M4, FR-40..FR-43).
 *
 * Optional, off by default, bring-your-own-key: nothing calls a model unless
 * `ai.enabled` is true *and* an API key resolves. The default provider speaks
 * the OpenAI-compatible `/chat/completions` API, so OpenAI, Azure OpenAI,
 * Ollama, LM Studio, and OpenRouter-style gateways all work via `baseUrl`.
 * AI features emit reviewable files (`alt.json`, `client-summary.md`,
 * `flows.suggested.json`) and the tool functions fully without them.
 */
export const aiSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai-compatible']).default('openai-compatible'),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    model: z.string().min(1).default('gpt-4o-mini'),
    /** Literal key or `$ENV:NAME` ref. Never written to output or logs. */
    apiKey: z.string().min(1).optional(),
    /** Per-request ceiling. */
    timeoutMs: z.number().int().min(1000).max(300000).default(60000),
    /** Skip images larger than this (bytes) for vision calls. */
    maxImageBytes: z.number().int().min(1024).max(20_000_000).default(2_000_000),
    /** Max assets to describe per run (cheapest first: smallest files). */
    maxAltAssets: z.number().int().min(1).max(200).default(20),
  })
  .strict();

export type AiConfig = z.infer<typeof aiSchema>;
