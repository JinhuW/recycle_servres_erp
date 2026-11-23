import Anthropic from '@anthropic-ai/sdk';
import { EmptyAnswerError, toBase64, type AiModel, type AiUsage, type LlmProvider } from './types';

// USD per million tokens (input, output). Anthropic's API reports tokens, not
// dollars, and the PO review's per-PO cost cap needs dollars. A model not
// listed is charged at the dearest rate, so a new one can't slip past the cap.
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-2': [8, 40],
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};
const UNKNOWN_PRICE: [number, number] = [10, 50];
const WEB_SEARCH_USD = 0.01;

function priceOf(model: string): [number, number] {
  return PRICES[model] ?? UNKNOWN_PRICE;
}

function client(apiKey: string | undefined): Anthropic {
  return new Anthropic({
    apiKey,
    // Retries and the deadline belong to ai/llm.ts, which runs them the same
    // way for every provider.
    maxRetries: 0,
    // Resolved per call so a test's stubbed fetch is the one used.
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  });
}

function toParams(turns: Parameters<LlmProvider['complete']>[1]['turns']): Anthropic.MessageParam[] {
  return turns.map((t) => {
    if (t.role === 'assistant') return { role: 'assistant', content: t.text };
    return {
      role: 'user',
      content: [
        // Images first: Claude reads an image better when it comes before the ask.
        ...(t.images ?? []).map((img): Anthropic.ImageBlockParam => {
          const { mime, data } = toBase64(img);
          return { type: 'image', source: { type: 'base64', media_type: mime, data } };
        }),
        { type: 'text', text: t.text },
      ],
    };
  });
}

export const anthropicProvider: LlmProvider = {
  id: 'anthropic',

  async complete(apiKey, req) {
    const messages = toParams(req.turns);
    const usage: AiUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
    const [inPerM, outPerM] = priceOf(req.model);
    let text = '';
    // A web-search turn can pause mid-way (`pause_turn`); sending its content
    // back lets the model carry on from where it stopped.
    for (let leg = 0; leg < 3; leg++) {
      let msg: Anthropic.Message;
      try {
        msg = await client(apiKey).messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            // These are transcription and lookup jobs: low effort keeps them
            // quick and cheap, and current models refuse `temperature`.
            output_config: { effort: 'low' },
            messages,
            ...(req.webSearch
              ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] }
              : {}),
          },
          { signal: req.signal },
        );
      } catch (e) {
        // Surface our own deadline as the timeout ai/llm.ts retries on.
        if (req.signal.aborted) throw req.signal.reason;
        if (e instanceof Anthropic.APIError) throw new Error(`Anthropic ${e.status ?? ''}: ${e.message}`);
        throw e;
      }
      usage.promptTokens += msg.usage.input_tokens;
      usage.completionTokens += msg.usage.output_tokens;
      usage.costUsd += (msg.usage.input_tokens * inPerM + msg.usage.output_tokens * outPerM) / 1e6
        + (msg.usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
      if (msg.stop_reason === 'refusal') throw new Error('Anthropic: the model declined this request');
      text += msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (msg.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: msg.content });
    }
    if (!text.trim()) throw new EmptyAnswerError('Anthropic');
    return { text, usage };
  },

  async listModels(apiKey) {
    const out: AiModel[] = [];
    for await (const m of client(apiKey).models.list({ limit: 100 })) {
      if (m.lifecycle === 'retired') continue;
      const price = PRICES[m.id];
      out.push({
        id: `anthropic:${m.id}`,
        provider: 'anthropic',
        name: m.display_name,
        contextLength: m.max_input_tokens,
        promptPerM: price?.[0] ?? null,
        completionPerM: price?.[1] ?? null,
        structuredOutputs: m.capabilities?.structured_outputs.supported ?? true,
        inputModalities: m.capabilities?.image_input.supported === false ? ['text'] : ['text', 'image'],
        outputModalities: ['text'],
      });
    }
    return out;
  },
};
