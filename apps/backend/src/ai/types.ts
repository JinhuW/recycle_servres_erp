// src/ai/types.ts
import type { LineCategory } from '../types';

export type OcrProvider = 'stub' | 'workers-ai' | 'openrouter';

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: OcrProvider;
};

// Below this overall confidence we do NOT autofill the form — the user
// enters the line manually. Keep in sync with the frontend gate.
export const CONFIDENCE_FLOOR = 0.6;
