// MCP HTTP adapter. We speak JSON-RPC 2.0 directly over a single POST endpoint
// instead of pulling in the SDK's Streamable HTTP transport, since the two read
// tools don't emit server-initiated messages (no SSE upgrade needed in v1).

import type { Context } from 'hono';
import { getDb } from '../db';
import { readPackageVersion } from '../lib/version';
import { TOOL_DEFS, callListMarketValues, callGetMarketValue } from './tools/market';
import type { Env } from '../types';

type JsonRpcReq = { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> };

const SERVER_INFO = { name: 'recycle-erp-market', version: readPackageVersion() };
const CAPABILITIES = { tools: { listChanged: false } };

function rpcOk(id: number | string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: number | string, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// `c` is typed loosely (any Variables shape) because the mount site in
// index.ts carries the app-wide `{ user, requestId }` Variables map and Hono's
// Context type is invariant in its env shape.
export async function handleMcp(c: Context<{ Bindings: Env; Variables: any }>): Promise<Response> {
  let req: JsonRpcReq;
  try { req = await c.req.json() as JsonRpcReq; }
  catch { return c.json(rpcErr(0, -32700, 'parse error'), 400); }

  const sql = getDb(c.env);

  switch (req.method) {
    case 'initialize':
      return c.json(rpcOk(req.id, {
        protocolVersion: (req.params as any)?.protocolVersion ?? '2024-11-05',
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      }));
    case 'tools/list':
      return c.json(rpcOk(req.id, { tools: TOOL_DEFS }));
    case 'tools/call': {
      const { name, arguments: args = {} } = (req.params ?? {}) as { name?: string; arguments?: any };
      try {
        let payload: unknown;
        if (name === 'list_market_values') payload = await callListMarketValues(sql, args);
        else if (name === 'get_market_value') payload = await callGetMarketValue(sql, args);
        else return c.json(rpcErr(req.id, -32601, `unknown tool: ${name}`));
        return c.json(rpcOk(req.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        }));
      } catch (e) {
        return c.json(rpcErr(req.id, -32602, e instanceof Error ? e.message : 'invalid params'));
      }
    }
    default:
      return c.json(rpcErr(req.id, -32601, `unknown method: ${req.method}`));
  }
}
