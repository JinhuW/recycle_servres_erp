import OpenAI from 'openai';
import { EmptyAnswerError, toBase64, type AiModel, type LlmProvider, type Turn } from './types';

// The Responses API, not Chat Completions: it takes images, JSON mode and the
// web_search tool on one endpoint, so the PO review's lookup needs no second
// transport.

// Charged when the catalogue has no price for the model, so the PO review's
// cost cap errs towards stopping early.
const UNKNOWN_PRICE: [number, number] = [10, 40];
const WEB_SEARCH_USD = 0.01;

// /v1/models lists embeddings, audio, image and moderation models too, and
// says nothing about which can chat.
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|moderation|search-preview|instruct)/;
const LIST_TIMEOUT_MS = 10_000;

/**
 * The lowest reasoning effort `model` takes, as the OpenRouter path sends for
 * the same models; null for models that reject the parameter (gpt-4o, the
 * -chat aliases). These are transcriptions: thinking only costs time.
 */
export function minimalReasoning(model: string): 'minimal' | 'low' | null {
  if (/^gpt-([5-9]|\d{2})/.test(model) && !model.includes('-chat')) return 'minimal';
  if (/^o\d/.test(model)) return 'low';
  return null;
}

function client(apiKey: string | undefined): OpenAI {
  return new OpenAI({
    apiKey,
    maxRetries: 0,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  });
}

function toInput(turns: Turn[]): OpenAI.Responses.ResponseInput {
  return turns.map((t): OpenAI.Responses.ResponseInputItem => {
    if (t.role === 'assistant') return { role: 'assistant', content: t.text };
    return {
      role: 'user',
      content: [
        { type: 'input_text', text: t.text },
        ...(t.images ?? []).map((img): OpenAI.Responses.ResponseInputImage => {
          const { mime, data } = toBase64(img);
          // Downscaled, label text reads as 8GB/DDR3.
          return { type: 'input_image', image_url: `data:${mime};base64,${data}`, detail: 'high' };
        }),
      ],
    };
  });
}

export const openAiProvider: LlmProvider = {
  id: 'openai',

  async complete(apiKey, req) {
    // A web search needs more than minimal reasoning, so it keeps the default.
    const effort = req.webSearch ? null : minimalReasoning(req.model);
    let res: OpenAI.Responses.Response;
    try {
      res = await client(apiKey).responses.create(
        {
          model: req.model,
          input: toInput(req.turns),
          max_output_tokens: req.maxTokens,
          ...(effort ? { reasoning: { effort } } : {}),
          // Every prompt sent here asks for one JSON object. JSON mode can't
          // be combined with web search, which cites as it writes.
          ...(req.webSearch
            ? { tools: [{ type: 'web_search' }] }
            : { text: { format: { type: 'json_object' } } }),
        },
        { signal: req.signal },
      );
    } catch (e) {
      if (req.signal.aborted) throw req.signal.reason;
      if (e instanceof OpenAI.APIError) throw new Error(`OpenAI ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    const [inPerM, outPerM] = req.price ?? UNKNOWN_PRICE;
    const searches = res.output.filter((o) => o.type === 'web_search_call').length;
    const promptTokens = res.usage?.input_tokens ?? 0;
    const completionTokens = res.usage?.output_tokens ?? 0;
    const usage = {
      promptTokens,
      completionTokens,
      costUsd: (promptTokens * inPerM + completionTokens * outPerM) / 1e6 + searches * WEB_SEARCH_USD,
    };
    const text = res.output_text;
    if (!text?.trim()) throw new EmptyAnswerError('OpenAI', usage);
    return { text, usage };
  },

  async listModels(apiKey) {
    const out: AiModel[] = [];
    for await (const m of client(apiKey).models.list({ timeout: LIST_TIMEOUT_MS })) {
      if (!CHAT_MODEL.test(m.id) || NOT_CHAT.test(m.id)) continue;
      out.push({
        id: `openai:${m.id}`,
        provider: 'openai',
        name: m.id,
        contextLength: null,
        promptPerM: null,
        completionPerM: null,
        // /v1/models says nothing about capabilities. The catalogue fills them
        // from OpenRouter's openai/<id> entry; one it can't match is assumed
        // text-only without strict schemas, so no image or evaluator picker
        // offers it (o3-mini, gpt-3.5-turbo and gpt-4 are both).
        structuredOutputs: false,
        inputModalities: ['text'],
        outputModalities: ['text'],
      });
    }
    return out;
  },
};
