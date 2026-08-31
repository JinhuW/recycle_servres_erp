# MCP tool errors returned as JSON-RPC errors read as "the tool is disabled"

**Date:** 2026-08-05
**Symptom:** ChatGPT reported that writing market prices was impossible —
"Market MCP 写入工具已被系统禁用" / "MCP 写入接口在重新连接后持续返回
Resource not found". Reads (`list_market_values`, `get_market_value`) worked
in the same conversation. Nothing was wrong with the token, the scopes, or
the deployment.

## What was actually happening

`tools/call` reported *every* tool failure as a JSON-RPC error:

```ts
catch (e) { return c.json(rpcErr(req.id, -32602, e.message)); }
```

So `set_market_price` with a part number that doesn't match any `ref_prices`
row answered `-32602 not_found`. Reproduced from ChatGPT with a deliberately
nonexistent part number; what the model received was:

```json
{"type": "json_rpc_error", "code": -32602, "message": "not_found", "is_error": true}
```

ChatGPT surfaces a JSON-RPC error as a *transport* failure, not as a tool
result. The model can't read it as "your argument was wrong", so it concluded
the endpoint was down, then that the tool had been disabled by the system, and
stopped writing for the rest of the session — including for part numbers that
would have matched. One mistyped part number disabled the whole feature.

The MCP spec is explicit about this split (Tools → Error handling): protocol
errors are for unknown tools and malformed requests; anything that happens
*inside* a tool is reported in the result with `isError: true`, precisely so
the model can see it and recover.

## Fix

- `tools/call` returns tool failures as `{ content: [...], isError: true }`
  results. Protocol errors stay JSON-RPC: unknown tool (-32601),
  `insufficient_scope` (-32001), parse/batch errors.
- `not_found` now names the part number back, so "I mistyped it" is
  distinguishable from "the endpoint is down".
- Tool descriptions tell the client that failures arrive as `isError` results
  and to retry rather than assume the tool is unavailable.

## Second finding, same investigation

ChatGPT's connector panel labelled all five tools **PUBLIC WRITE / Open world
/ Destructive**, read-only ones included. Cause: we shipped no `annotations`,
and the MCP defaults for an absent annotation are `readOnlyHint: false`,
`destructiveHint: true`, `openWorldHint: true`. Every tool now carries
explicit annotations.

## Tripwire

Do not reach for `rpcErr` in a `tools/call` catch block. If the tool ran, its
failure belongs in the result. `tests/mcp-server.test.ts` asserts both halves
of the split, and that every tool advertises annotations.
