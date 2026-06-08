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
import { spawnSync } from "node:child_process";

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

test("gemini: anyOf errors exactly once (no schema-no-refs dup); additionalProperties/default are info", () => {
  const s = {
    type: "object",
    additionalProperties: false,
    properties: { x: { anyOf: [{ type: "string" }, { type: "number" }], default: "a" } },
  };
  const f = [];
  checkProviderSchema("t", s, profile("gemini"), "default", (rid, tool, msg) => f.push({ id: rid, msg }));
  const anyofErr = f.filter((x) => x.id === "provider/schema-unsupported-keyword" && /anyOf/.test(x.msg));
  assert.equal(anyofErr.length, 1); // not double-reported
  assert.ok(!f.some((x) => x.id === "provider/schema-no-refs")); // dedup: no second anyOf finding
  assert.ok(f.some((x) => x.id === "provider/schema-unenforced-keyword" && /additionalProperties/.test(x.msg)));
  assert.ok(f.some((x) => x.id === "provider/schema-unenforced-keyword" && /default/.test(x.msg)));
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

// regression: dogfooding kalshi-mcp-server surfaced two false positives
test("server.json: registryBaseUrl optional; *_ID not treated as a secret", () => {
  const ids = sj({
    name: "io.github.you/srv",
    version: "1.0.0",
    packages: [
      {
        registryType: "pypi",
        identifier: "srv",
        version: "1.0.0",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "FOO_API_KEY_ID", isSecret: false },
          { name: "FOO_API_TOKEN", isSecret: false },
        ],
      },
    ],
  });
  assert.ok(!ids.includes("server-json/registry-base-url"), "registryBaseUrl must be optional");
  assert.equal(ids.filter((x) => x === "server-json/env-secret-flag").length, 1); // only FOO_API_TOKEN
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

test("client-config: unknown server-entry key -> known-keys", () => {
  const ids = cc({ mcpServers: { x: { command: "node", arg: ["s.js"] } } });
  assert.ok(ids.includes("client-config/known-keys"));
});

test("client-config: known keys (envFile, timeout, disabled) not flagged", () => {
  const ids = cc({ mcpServers: { x: { command: "node", args: ["s.js"], envFile: ".env", timeout: "30", disabled: "false" } } });
  assert.ok(!ids.includes("client-config/known-keys"));
});

test("client-config: malformed ${...} -> env-refs-declared", () => {
  const ids = cc({ mcpServers: { x: { command: "node", args: ["--key=${API_KEY"] } } });
  assert.ok(ids.includes("client-config/env-refs-declared"));
});

test("client-config: well-formed ${VAR} and ${VAR:-default} not flagged", () => {
  const ids = cc({ mcpServers: { x: { command: "node", args: ["--k=${API_KEY}", "--p=${PORT:-3000}"], env: { T: "${T}" } } } });
  assert.ok(!ids.includes("client-config/env-refs-declared"));
});

test("provider: total-size fires when serialized set exceeds maxTotalBytes", () => {
  const f = provider([okTool], [{ id: "tiny", tools: { maxTotalBytes: 50 } }]);
  assert.ok(ids(f).includes("provider/total-size"));
});

test("provider: total-size dormant when profile budget is null", () => {
  const f = provider([okTool], [profile("anthropic")]);
  assert.ok(!ids(f).includes("provider/total-size"));
});

// --- inspect (live MCP stdio handshake) ---
test("inspect: handshake returns tools from a live stdio server", async () => {
  const tools = await inspectStdio("node", [join(ROOT, "fixtures/mock-server.mjs")], { timeoutMs: 10000 });
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "bad.tool");
  assert.equal(tools[1].name, "good_tool");
});

test("inspect: passes env vars through to the spawned server", async () => {
  const tools = await inspectStdio("node", [join(ROOT, "fixtures/mock-server.mjs")], {
    env: { MCPCONFORM_TEST: "xyz" },
    timeoutMs: 10000,
  });
  assert.ok(tools.some((t) => t.name === "env_xyz"));
});

// --- newly implemented core rules ---
test("core: output-schema/title/taskSupport/_meta/property-desc rules fire", () => {
  const found = ids(
    core([
      {
        name: "x",
        title: "x",
        description: "d",
        inputSchema: { type: "object", properties: { a: { type: "string" } } },
        outputSchema: { type: "array" },
        execution: { taskSupport: "maybe" },
        _meta: { foo: 1 },
      },
    ])
  );
  for (const id of [
    "tool/output-schema-root-object",
    "tool/title-redundant",
    "tool/execution-tasksupport-enum",
    "tool/meta-namespacing",
    "tool/property-descriptions",
  ])
    assert.ok(found.includes(id), id);
});

test("core: annotations-consistency fires on readOnly+destructive", () => {
  const found = ids(core([{ name: "y", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } }]));
  assert.ok(found.includes("tool/annotations-consistency"));
});

// --- CLI end-to-end (spawns the real binary) ---
function cli(a) {
  const r = spawnSync(process.execPath, [join(ROOT, "src/index.mjs"), ...a], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("cli: good fixture exits 0", () => {
  assert.equal(cli(["examples/tools.good.json", "--target", "anthropic,openai"]).code, 0);
});

test("cli: bad fixture exits 1 and reports provider/name-pattern", () => {
  const r = cli(["examples/tools.bad.json", "--target", "anthropic"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /provider\/name-pattern/);
});

test("cli: server.json + client-config auto-detected and flagged", () => {
  const r = cli(["examples/server.bad.json", "examples/client-config.bad.json"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /server-json\//);
  assert.match(r.out, /client-config\//);
});

test("cli: --help exits 0 with usage; --version prints semver", () => {
  const h = cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /USAGE/);
  const v = cli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+/);
});
