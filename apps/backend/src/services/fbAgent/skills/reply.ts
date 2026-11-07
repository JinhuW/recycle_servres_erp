import type { AgentLlm } from '../types';
import type { LlmRequest } from '../prompt';

// Shared by the skills. Usage is collected by the runtime's wrapper around llm.
export async function replyText(llm: AgentLlm, req: LlmRequest): Promise<string> {
  const { json } = await llm(req);
  const reply = json.reply;
  if (typeof reply !== 'string') throw new Error('the reply model answered without a reply');
  return reply;
}
