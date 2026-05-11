// Label OCR. Two providers behind one interface:
//
//   stub:        deterministic canned extraction (matches the prototype, fine
//                for dev and demos when no AI binding is configured)
//   workersAI:   Cloudflare Workers AI vision (Llama 3.2 11B vision-instruct)
//
// Picked at runtime based on env.STUB_OCR.

import type { Env, LineCategory } from './types';

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: 'stub' | 'workers-ai';
};

const STUB_BY_CATEGORY: Record<LineCategory, Omit<ScanResult, 'provider'>> = {
  RAM: {
    category: 'RAM',
    confidence: 0.94,
    fields: {
      brand: 'Samsung',
      capacity: '32GB',
      type: 'DDR4',
      classification: 'RDIMM',
      rank: '2Rx4',
      speed: '3200',
      partNumber: 'M393A4K40DB3-CWE',
    },
  },
  SSD: {
    category: 'SSD',
    confidence: 0.91,
    fields: {
      brand: 'Samsung',
      capacity: '1.92TB',
      interface: 'NVMe',
      formFactor: 'M.2 22110',
      partNumber: 'MZ1L21T9HCLS-00A07',
    },
  },
  Other: {
    category: 'Other',
    confidence: 0.88,
    fields: {
      description: 'Intel Xeon Gold 6248',
      partNumber: 'SRF90',
    },
  },
};

function isStub(env: Env): boolean {
  // Default to stub unless STUB_OCR is explicitly false AND env.AI is bound.
  if (!env.AI) return true;
  return (env.STUB_OCR ?? 'true').toLowerCase() !== 'false';
}

const PROMPT_BY_CATEGORY: Record<LineCategory, string> = {
  RAM: `You are reading a server RAM module label. Extract these fields and respond as compact JSON only:
{"brand":"…","capacity":"… GB","type":"DDR3|DDR4|DDR5","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx4|1Rx8|2Rx4|2Rx8|4Rx4","speed":"MHz number","partNumber":"…"}
If a field is not visible, omit it. No prose.`,
  SSD: `You are reading an enterprise SSD label. Respond as compact JSON only:
{"brand":"…","capacity":"… GB or TB","interface":"SATA|SAS|NVMe|U.2","formFactor":"2.5\\"|M.2 2280|M.2 22110|U.2|AIC","partNumber":"…"}
Omit unknown fields. No prose.`,
  Other: `You are reading a server-component label (CPU, NIC, PSU, GPU, etc). Respond as compact JSON only:
{"description":"human-readable name","partNumber":"…"}
No prose.`,
};

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  if (isStub(env)) {
    return { ...STUB_BY_CATEGORY[category], provider: 'stub' };
  }

  // Workers AI llava vision call. We pass the raw image bytes (max ~4MB).
  const ai = env.AI!;
  const prompt = PROMPT_BY_CATEGORY[category];
  const response = (await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: Array.from(new Uint8Array(imageBytes)),
    prompt,
    max_tokens: 256,
  })) as { response?: string; description?: string };

  const text = (response.response ?? response.description ?? '').trim();
  const json = parseJsonLoose(text);

  return {
    category,
    confidence: json ? 0.85 : 0.4,
    fields: (json ?? {}) as Record<string, string>,
    provider: 'workers-ai',
  };
}

// LLMs sometimes wrap JSON in code fences or add stray prose. Pull the first
// {…} block and try to parse it.
function parseJsonLoose(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
