import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCoreRules, runProviderRules } from "../src/rules.mjs";
import { validateInputSchema, checkProviderSchema } from "../src/schema.mjs";
import { runServerJsonRules } from "../src/server-json.mjs";
import { runClientConfigRules } from "../src/client-config.mjs";
import { inspectStdio } from "../src/inspect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = (id) => JSON.parse(readFileSync(join(ROOT, "profiles", `${id}.json`), "utf8"));

function core(tools) {
  const f = [];
  runCoreRules(tools, (id, tool, message) => f.push({ id, tool, message }));
  return f;
}
function provider(tools, profiles) {
  const f = [];
  runProviderRules(tools, profiles, (id, tool, message, pid) => f.push({ id, tool, pid }));
  return f;
}
const ids = (f) => f.map((x) => x.id);

const okTool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: {
    type: "object",
    properties: { location: { type: "string", description: "City" } },
    required: ["location"],
  },
  annotations: { readOnlyHint: true },
};

test("clean tool yields no core findings", () => {
  assert.deepEqual(core([okTool]), []);
});

test("missing inputSchema -> input-schema-required", () => {
  assert.ok(ids(core([{ name: "x", description: "d" }])).includes("tool/input-schema-required"));
});

test("root type array -> input-schema-root-object", () => {
  assert.ok(
    ids(core([{ name: "x", description: "d", inputSchema: { type: "array" } }])).includes(
      "tool/input-schema-root-object"
    )
  );
});

test("duplicate names -> name-unique", () => {
  const t = { name: "dup", description: "d", inputSchema: { type: "object" } };
  assert.ok(ids(core([t, { ...t }])).includes("tool/name-unique"));
});

test("required references a missing property", () => {
  const f = core([
    {
      name: "x",
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["nope"] },
    },
  ]);
  assert.ok(ids(f).includes("tool/required-references-properties"));
});

test("space in name -> name-charset", () => {
  assert.ok(
    ids(core([{ name: "get weather", description: "d", inputSchema: { type: "object" } }])).includes(
      "tool/name-charset"
    )
  );
});

test("mutating verb without annotation warns; readOnly/destructive hint clears it", () => {
  const bare = { name: "delete_thing", description: "d", inputSchema: { type: "object" } };
  assert.ok(ids(core([bare])).includes("tool/destructive-needs-annotation"));
  const annotated = { ...bare, annotations: { destructiveHint: true } };
  assert.ok(!ids(core([annotated])).includes("tool/destructive-needs-annotation"));
});

test("flagship: dotted name rejected by anthropic AND openai (legal per MCP)", () => {
  const t = { name: "admin.tools.list", description: "d", inputSchema: { type: "object" } };
  const hits = provider([t], [profile("anthropic"), profile("openai")])
    .filter((x) => x.id === "provider/name-pattern")
    .map((x) => x.pid)
    .sort();
  assert.deepEqual(hits, ["anthropic", "openai"]);
});

test("provider name-length fires past the profile max", () => {
  const t = { name: "a".repeat(65), description: "d", inputSchema: { type: "object" } };
  assert.ok(provider([t], [profile("anthropic")]).some((x) => x.id === "provider/name-length"));
});

test("provider description-length fires past openai 1024", () => {
  const t = { name: "ok_name", description: "x".repeat(1100), inputSchema: { type: "object" } };
  assert.ok(provider([t], [profile("openai")]).some((x) => x.id === "provider/description-length"));
});

test("clean tool passes anthropic + openai + gemini provider checks", () => {
  assert.deepEqual(provider([okTool], [profile("anthropic"), profile("openai"), profile("gemini")]), []);
});

function pschema(schema, id, mode = "default") {
  const f = [];
  checkProviderSchema("t", schema, profile(id), mode, (rid, tool, msg, pid) => f.push({ id: rid, pid }));
  return f;
}

test("ajv: valid inputSchema passes, invalid type fails", () => {
  assert.equal(validateInputSchema({ type: "object", properties: { a: { type: "string" } } }).ok, true);
  assert.equal(validateInputSchema({ type: "object", properties: { a: { type: "frobnicate" } } }).ok, false);
});

test("gemini rejects anyOf (outside its OpenAPI subset)", () => {
  const s = { type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "number" }] } } };
  assert.ok(pschema(s, "gemini").some((x) => x.id === "provider/schema-unsupported-keyword"));
});

test("openai strict: object without additionalProperties:false flags", () => {
  const s = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.ok(pschema(s, "openai", "strict").some((x) => x.id === "provider/schema-additional-properties"));
});

test("openai strict: property missing from required flags", () => {
  const s = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: false };
  assert.ok(pschema(s, "openai", "strict").some((x) => x.id === "provider/schema-all-required"));
});

test("clean object schema passes gemini subset", () => {
  const s = { type: "object", properties: { location: { type: "string", description: "City" } }, required: ["location"] };
  assert.deepEqual(pschema(s, "gemini"), []);
});

// --- server.json ---
function sj(doc, opts) {
  const f = [];
  runServerJsonRules(doc, (id) => f.push(id), opts);
  return f;
}

test("server.json: bad name/version/registry/transport flagged", () => {
  const ids = sj({ name: "my-server", version: "v1", packages: [{ registryType: "pip", transport: { type: "http" } }] });
  for (const id of [
    "server-json/name-reverse-dns",
    "server-json/version-semver",
    "server-json/registry-type-enum",
    "server-json/transport-type-enum",
  ])
    assert.ok(ids.includes(id), id);
});

test("server.json: clean doc passes", () => {
  const ids = sj({
    name: "io.github.you/srv",
    version: "1.0.0",
    packages: [{ registryType: "pypi", registryBaseUrl: "https://pypi.org", identifier: "srv", version: "1.0.0", transport: { type: "stdio" } }],
  });
  assert.deepEqual(ids, []);
});

test("server.json: root version mismatch vs sibling manifest", () => {
  const ids = sj({ name: "io.github.you/srv", version: "1.0.0", remotes: [{ type: "sse", url: "https://x/mcp" }] }, { packageVersion: "0.9.0" });
  assert.ok(ids.includes("server-json/version-matches-package"));
});

// --- client config ---
function cc(doc) {
  const f = [];
  runClientConfigRules(doc, (id) => f.push(id));
  return f;
}

test("client-config: both transports + non-array args flagged", () => {
  const ids = cc({ mcpServers: { x: { command: "python", url: "https://y", args: "a.py" } } });
  assert.ok(ids.includes("client-config/one-transport"));
  assert.ok(ids.includes("client-config/args-array"));
});

test("client-config: hardcoded secret + non-string env flagged", () => {
  const ids = cc({ mcpServers: { x: { command: "node", args: ["s.js"], env: { API_KEY: "sk-live-abcdefghij1234567890", PORT: 3000 } } } });
  assert.ok(ids.includes("client-config/no-hardcoded-secrets"));
  assert.ok(ids.includes("client-config/env-values-strings"));
});

test("client-config: clean stdio + clean http pass", () => {
  const ids = cc({
    mcpServers: {
      a: { command: "node", args: ["s.js"], env: { TOKEN: "${TOKEN}" } },
      b: { type: "http", url: "https://x/mcp" },
    },
  });
  assert.deepEqual(ids, []);
});

// --- inspect (live MCP stdio handshake) ---
test("inspect: handshake returns tools from a live stdio server", async () => {
  const tools = await inspectStdio("node", [join(ROOT, "test/fixtures/mock-server.mjs")], { timeoutMs: 10000 });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "bad.tool");
  assert.equal(tools[1].name, "good_tool");
});

test("inspect: passes env vars through to the spawned server", async () => {
  const tools = await inspectStdio("node", [join(ROOT, "test/fixtures/mock-server.mjs")], {
    env: { MCPLINT_TEST: "xyz" },
    timeoutMs: 10000,
  });
  assert.ok(tools.some((t) => t.name === "env_xyz"));
});
