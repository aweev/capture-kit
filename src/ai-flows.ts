import { chatCompletion } from './ai-client.ts';
import type { AiConfig } from './ai-config.ts';
import { flowSchema, type Flow } from './flows.ts';

/**
 * Flow synthesis (FR-40).
 *
 * Given a URL and a plain-English goal ("show signup and dashboard"), a model
 * drafts a reviewable flow config. The output is validated against the flow
 * schema and written to `flows.suggested.json` — it is never applied
 * automatically. Selectors are best-effort guesses (roles, labels, test ids);
 * the user reviews and fixes them before running.
 */

export async function suggestFlows(
  config: AiConfig,
  options: {
    url: string;
    goal: string;
    pages?: string[];
    fetchFn?: typeof fetch;
  },
): Promise<Flow[]> {
  const pageList = options.pages?.length ? options.pages.join(', ') : '(unknown — propose goto steps)';
  const raw = await chatCompletion(
    config,
    [
      {
        role: 'system',
        content:
          'You write capturekit flow configs as JSON: {"flows": [{"name": "...", "steps": [...]}]}. Step shapes: {"goto": "/path"}, {"click": "selector"}, {"fill": "selector", "text": "..."}, {"hover": "selector"}, {"press": "selector", "key": "Enter"}, {"waitFor": "selector"}, {"scroll": "bottom"}. Prefer role/label selectors like "text=Sign up" or "[data-testid=...]". At most 3 flows, at most 8 steps each. select `goto` paths only from the known pages list.',
      },
      {
        role: 'user',
        content: `Site: ${options.url}\nKnown pages: ${pageList}\nGoal: ${options.goal}`,
      },
    ],
    { json: true, fetchFn: options.fetchFn },
  );
  let parsed: { flows?: unknown };
  try {
    parsed = JSON.parse(raw) as { flows?: unknown };
  } catch {
    throw new Error('AI returned non-JSON flows; nothing to review.');
  }
  if (!Array.isArray(parsed.flows) || parsed.flows.length === 0) {
    throw new Error('AI returned no flows; nothing to review.');
  }
  return parsed.flows.slice(0, 3).map((flow, index) => {
    const result = flowSchema.safeParse(flow);
    if (!result.success) {
      throw new Error(`Suggested flow ${index + 1} is invalid: ${result.error.issues.map((i) => i.message).join('; ')}`);
    }
    return result.data;
  });
}
