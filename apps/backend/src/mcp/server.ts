// MCP HTTP adapter. We speak JSON-RPC 2.0 directly over a single POST endpoint
// instead of pulling in the SDK's Streamable HTTP transport, since the tools
// don't emit server-initiated messages (no SSE upgrade needed).

import type { Context } from 'hono';
import { getDb } from '../db';
import { readPackageVersion } from '../lib/version';
import { TOOL_DEFS, callListMarketValues, callGetMarketValue, callSetMarketPrice } from './tools/market';
import {
  SELL_ORDER_TOOL_DEFS, callSearchSellableInventory, callCreateSellOrderDraft,
} from './tools/sellOrders';
import type { OAuthCtx, OAuthScope, Env } from '../types';
import { mcpToolCallsTotal } from '../metrics';

type JsonRpcReq = { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> };

const SERVER_INFO = { name: 'recycle-erp-mcp', version: readPackageVersion() };
const CAPABILITIES = { tools: { listChanged: false } };

const ALL_TOOLS = [...TOOL_DEFS, ...SELL_ORDER_TOOL_DEFS];

// Single source of truth for which scope each tool requires. Drives both
// tools/list visibility and the tools/call gate, so a token only ever sees and
// invokes the tools its scopes permit.
const TOOL_SCOPES: Record<string, OAuthScope> = {
  list_market_values: 'market:read',
  get_market_value: 'market:read',
  set_market_price: 'market:write',
  search_sellable_inventory: 'sellorder:read',
  create_sell_order_draft: 'sellorder:write',
};

function rpcOk(id: number | string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: number | string | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function handleMcp(c: Context<{ Bindings: Env; Variables: any }>): Promise<Response> {
  let req: JsonRpcReq;
  try { req = await c.req.json() as JsonRpcReq; }
  catch { return c.json(rpcErr(null, -32700, 'parse error')); }

  const sql = getDb(c.env);
  const ctx = c.get('oauthCtx') as OAuthCtx | undefined;
  const granted = new Set(ctx?.scopes ?? []);

  switch (req.method) {
    case 'initialize':
      return c.json(rpcOk(req.id, {
        protocolVersion: (req.params as any)?.protocolVersion ?? '2024-11-05',
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      }));
    case 'tools/list':
      return c.json(rpcOk(req.id, {
        tools: ALL_TOOLS.filter(t => granted.has(TOOL_SCOPES[t.name])),
      }));
    case 'tools/call': {
      const { name, arguments: args = {} } = (req.params ?? {}) as { name?: string; arguments?: any };
      const toolLabel = name ?? 'unknown';
      try {
        const required = name ? TOOL_SCOPES[name] : undefined;
        if (!name || !required) {
          mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
          return c.json(rpcErr(req.id, -32601, `unknown tool: ${name}`));
        }
        if (!granted.has(required)) {
          mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
          return c.json(rpcErr(req.id, -32001, `insufficient_scope: ${required} required`));
        }
        let payload: unknown;
        if (name === 'list_market_values') payload = await callListMarketValues(sql, args);
        else if (name === 'get_market_value') payload = await callGetMarketValue(sql, args);
        else if (name === 'set_market_price') {
          payload = await callSetMarketPrice(sql, args, {
            source: `mcp:${ctx!.clientId}`, actorUserId: ctx!.userId,
          });
        }
        else if (name === 'search_sellable_inventory') payload = await callSearchSellableInventory(sql, args);
        else if (name === 'create_sell_order_draft') {
          payload = await callCreateSellOrderDraft(sql, args, {
            source: `mcp:${ctx!.clientId}`, actorUserId: ctx!.userId,
          });
        }
        mcpToolCallsTotal.inc({ tool: toolLabel, status: 'ok' });
        return c.json(rpcOk(req.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        }));
      } catch (e) {
        mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
        return c.json(rpcErr(req.id, -32602, e instanceof Error ? e.message : 'invalid params'));
      }
    }
    default:
      return c.json(rpcErr(req.id, -32601, `unknown method: ${req.method}`));
  }
}
