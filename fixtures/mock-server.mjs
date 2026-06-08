// Minimal MCP stdio server for testing `mcpconform inspect`. Newline-delimited
// JSON-RPC: answers initialize and tools/list; exposes one bad + one good tool.
// NOTE: kept OUTSIDE test/ so `node --test` does not execute it as a test file
// (it listens on stdin forever, which would hang the runner).
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

process.stdin.on("data", (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0.0.0" } },
      });
    else if (msg.method === "tools/list") {
      const tools = [
        { name: "bad.tool", inputSchema: { type: "object" } },
        { name: "good_tool", description: "A perfectly fine tool.", inputSchema: { type: "object" } },
      ];
      // Proves env passthrough: only present when the parent supplied MCPCONFORM_TEST.
      if (process.env.MCPCONFORM_TEST)
        tools.push({ name: `env_${process.env.MCPCONFORM_TEST}`, description: "env-derived", inputSchema: { type: "object" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    }
  }
});
