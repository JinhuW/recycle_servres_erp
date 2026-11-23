import OpenAI from 'openai';
import type { Env } from '../../types';
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

function client(env: Env): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
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
  keyName: 'OPENAI_API_KEY',
  configured: (env) => !!env.OPENAI_API_KEY,

  async complete(env, req) {
    let res: OpenAI.Responses.Response;
    try {
      res = await client(env).responses.create(
        {
          model: req.model,
          input: toInput(req.turns),
          max_output_tokens: req.maxTokens,
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
    const text = res.output_text;
    if (!text?.trim()) throw new EmptyAnswerError('OpenAI');
    const [inPerM, outPerM] = req.price ?? UNKNOWN_PRICE;
    const searches = res.output.filter((o) => o.type === 'web_search_call').length;
    const promptTokens = res.usage?.input_tokens ?? 0;
    const completionTokens = res.usage?.output_tokens ?? 0;
    return {
      text,
      usage: {
        promptTokens,
        completionTokens,
        costUsd: (promptTokens * inPerM + completionTokens * outPerM) / 1e6 + searches * WEB_SEARCH_USD,
      },
    };
  },

  async listModels(env) {
    const out: AiModel[] = [];
    for await (const m of client(env).models.list()) {
      if (!CHAT_MODEL.test(m.id) || NOT_CHAT.test(m.id)) continue;
      out.push({
        id: `openai:${m.id}`,
        provider: 'openai',
        name: m.id,
        contextLength: null,
        promptPerM: null,
        completionPerM: null,
        structuredOutputs: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      });
    }
    return out;
  },
};
