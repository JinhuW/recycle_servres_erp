-- Canonical customer that MCP-created sell-order drafts are attributed to by
-- default. Fixed UUID so prod (where it already exists) and fresh/test DBs
-- converge on the same row. The default is also recorded as a workspace
-- setting so it is reconfigurable without a code change (create_sell_order_draft
-- reads mcp.sellOrderCustomerId, falling back to this id).
INSERT INTO customers (id, name, active)
VALUES ('f30f98bc-09c7-4108-b083-c7d69cc9968c', 'MCP', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_settings (key, value) VALUES
  ('mcp.sellOrderCustomerId', '"f30f98bc-09c7-4108-b083-c7d69cc9968c"'::jsonb)
ON CONFLICT (key) DO NOTHING;
