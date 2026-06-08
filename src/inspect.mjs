// Language-agnostic acquisition: spawn an MCP stdio server, perform the
// initialize -> notifications/initialized -> tools/list handshake over
// newline-delimited JSON-RPC, and return its tool definitions. Works for a
// server written in ANY language because it speaks the protocol, not the source.

import { spawn } from "node:child_process";

export function inspectStdio(command, args = [], { timeoutMs = 20000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });
    const tools = [];
    let buf = "";
    let nextId = 1;
    let initId;
    let listId;
    let done = false;

    const timer = setTimeout(
      () => finish(new Error(`timed out after ${timeoutMs}ms waiting for the MCP server`)),
      timeoutMs
    );

    function finish(err, val) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      child.unref?.();
      err ? reject(err) : resolve(val);
    }

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const request = (method, params) => {
      const id = nextId++;
      send({ jsonrpc: "2.0", id, method, params });
      return id;
    };

    child.on("error", (e) => finish(e));
    child.stderr.on("data", () => {}); // server logs belong on stderr; ignore
    child.on("exit", (code) => {
      if (!done) finish(new Error(`server exited (code ${code}) before tools/list completed`));
    });

    function handle(msg) {
      if (msg.id === initId && (msg.result || msg.error)) {
        if (msg.error) return finish(new Error(`initialize failed: ${msg.error.message}`));
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        listId = request("tools/list", {});
        return;
      }
      if (msg.id === listId && (msg.result || msg.error)) {
        if (msg.error) return finish(new Error(`tools/list failed: ${msg.error.message}`));
        const r = msg.result || {};
        if (Array.isArray(r.tools)) tools.push(...r.tools);
        if (r.nextCursor) {
          listId = request("tools/list", { cursor: r.nextCursor });
          return;
        }
        return finish(null, tools);
      }
    }

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // skip non-JSON-RPC lines
        }
        handle(msg);
      }
    });

    initId = request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcpconform", version: "0.1.0" },
    });
  });
}
