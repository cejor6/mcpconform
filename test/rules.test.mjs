import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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

test("client-config: malformed ref in an env value is flagged", () => {
  const ids = cc({ mcpServers: { x: { command: "node", args: ["s.js"], env: { TOKEN: "${API_TOKEN" } } } });
  assert.ok(ids.includes("client-config/env-refs-declared"));
});

test("client-config: inputs key (Claude Code / VS Code) not flagged as unknown", () => {
  const ids = cc({ mcpServers: { x: { command: "npx", args: ["s"], inputs: [{ type: "promptString", id: "k" }] } } });
  assert.ok(!ids.includes("client-config/known-keys"));
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

// --- --min-severity (display floor) ---
test("cli: --min-severity error shows only error-tier findings, still exits 1", () => {
  const r = cli(["examples/tools.bad.json", "--target", "anthropic", "--min-severity", "error"]);
  assert.equal(r.code, 1); // errors survive any floor
  assert.match(r.out, /ERROR /);
  assert.doesNotMatch(r.out, /WARN /); // warn finding labels dropped
  assert.doesNotMatch(r.out, /INFO /); // info finding labels dropped
});

test("cli: --min-severity warn drops info but keeps warn and error", () => {
  const r = cli(["examples/tools.bad.json", "--target", "anthropic", "--min-severity", "warn"]);
  assert.match(r.out, /WARN /);
  assert.match(r.out, /ERROR /);
  assert.doesNotMatch(r.out, /INFO /);
});

test("cli: invalid --min-severity exits 2 with a usage message", () => {
  const r = cli(["examples/tools.good.json", "--min-severity", "loud"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /min-severity/);
});

// --- --min-tools (inspect live-surface floor) ---
const mock = join(ROOT, "fixtures/mock-server.mjs");

test("cli inspect: --min-tools above the surfaced count fails the guard (exit 2)", () => {
  const r = cli(["inspect", "--min-tools", "5", "--", process.execPath, mock]);
  assert.equal(r.code, 2); // mock surfaces 2 tools; floor of 5 not met
  assert.match(r.out, /min-tools/);
});

test("cli inspect: --min-tools exactly at the surfaced count passes the guard", () => {
  // mock surfaces 2 tools (warn/info only, no errors), so floor of 2 -> guard
  // passes and the lint itself exits 0. Assert the guard did NOT fire.
  const r = cli(["inspect", "--min-tools", "2", "--", process.execPath, mock]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /min-tools/);
});

test("cli: invalid --min-tools exits 2 with a usage message", () => {
  const r = cli(["examples/tools.good.json", "--min-tools", "abc"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /min-tools/);
});

// flag passed as the last token (no value) must error, not silently no-op
test("cli: --min-severity with no value exits 2", () => {
  const r = cli(["examples/tools.good.json", "--min-severity"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /min-severity/);
});

test("cli: --min-tools with no value exits 2", () => {
  const r = cli(["examples/tools.good.json", "--min-tools"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /min-tools/);
});

// the floor is display-only: a warn/info-only surface filtered to error shows
// nothing and exits 0 (proving exit code is independent of the floor).
test("cli inspect: --min-severity error on a warn/info-only surface shows nothing, exits 0", () => {
  const r = cli(["inspect", "--min-severity", "error", "--", process.execPath, mock]);
  assert.equal(r.code, 0);
  assert.match(r.out, /No findings/);
});

test("cli: --format sarif respects --min-severity (only error-level results emitted)", () => {
  const r = cli(["examples/tools.bad.json", "--target", "anthropic", "--format", "sarif", "--min-severity", "error"]);
  const sarif = JSON.parse(r.out);
  const results = sarif.runs[0].results;
  assert.ok(results.length > 0);
  assert.ok(results.every((x) => x.level === "error"), "every SARIF result is error-level after the floor");
});

test("cli: config.minSeverity is honored from the config file", () => {
  const cfg = join(tmpdir(), "mcpconform-cfg-minseverity.json");
  writeFileSync(cfg, JSON.stringify({ targets: ["anthropic"], minSeverity: "error" }));
  const r = cli(["examples/tools.bad.json", "--config", cfg]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /WARN /);
  assert.doesNotMatch(r.out, /INFO /);
});

// --- aggregation of repeated framework-injected info findings ---
function tmpTools(tools) {
  const f = join(tmpdir(), `mcpconform-agg-${tools.length}-${tools[0]?.name ?? "x"}.json`);
  writeFileSync(f, JSON.stringify({ tools }));
  return f;
}
// n clean tools that each carry the same non-reverse-DNS _meta key (the FastMCP
// injection pattern) -> tool/meta-namespacing (info) fires identically on each.
const injected = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `t_${i}`,
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string", description: "x" } }, required: ["a"] },
    annotations: { readOnlyHint: true },
    _meta: { fastmcp: { v: "1" } },
  }));

test("cli: an info finding repeated on 3+ tools collapses to one aggregated line", () => {
  const r = cli([tmpTools(injected(4))]);
  assert.match(r.out, /tool\/meta-namespacing/);
  assert.match(r.out, /on all 4 tools/);
  assert.match(r.out, /framework-injected/); // hint comes from the rule's own message
  assert.match(r.out, /0 error, 0 warn, 1 info/); // 4 identical infos -> 1 line
});

test("cli: aggregation collapses at exactly AGG_MIN (3) tools", () => {
  const r = cli([tmpTools(injected(3))]);
  assert.match(r.out, /on all 3 tools/);
  assert.match(r.out, /0 error, 0 warn, 1 info/);
});

// Only rules flagged `aggregate:true` collapse. A per-tool-actionable info rule
// (tool/no-params-shape) firing identically on every tool must STAY itemized with
// its tool names, and must NOT get the aggregated "on all N tools" wording.
test("cli: a non-aggregatable info rule is never collapsed, keeps tool names", () => {
  const file = tmpTools(Array.from({ length: 3 }, (_, i) => ({ name: `np_${i}`, description: "d", inputSchema: { type: "object" } })));
  const r = cli([file]);
  assert.match(r.out, /tool\/no-params-shape/);
  assert.match(r.out, /0 error, 0 warn, 3 info/); // itemized, not collapsed
  assert.match(r.out, /\[np_0\]/);
  assert.match(r.out, /\[np_2\]/); // per-tool names preserved
  assert.doesNotMatch(r.out, /on all 3 tools/);
});

test("cli: --expand itemizes the repeated finding instead of collapsing", () => {
  const r = cli([tmpTools(injected(4)), "--expand"]);
  assert.match(r.out, /0 error, 0 warn, 4 info/);
  assert.match(r.out, /\[t_0\]/);
  assert.match(r.out, /\[t_3\]/); // every occurrence keeps its tool name
});

test("cli: config.expand disables aggregation", () => {
  const cfg = join(tmpdir(), "mcpconform-expand-cfg.json");
  writeFileSync(cfg, JSON.stringify({ expand: true }));
  const r = cli([tmpTools(injected(4)), "--config", cfg]);
  assert.match(r.out, /0 error, 0 warn, 4 info/);
});

test("cli: aggregation collapses the SARIF results too (one result, not N)", () => {
  const sarif = JSON.parse(cli([tmpTools(injected(4)), "--format", "sarif"]).out);
  const meta = sarif.runs[0].results.filter((x) => x.ruleId === "tool/meta-namespacing");
  assert.equal(meta.length, 1);
  assert.match(meta[0].message.text, /on all 4 tools/);
});

test("cli: below the threshold (2 repeats) stays itemized", () => {
  const r = cli([tmpTools(injected(2))]);
  assert.match(r.out, /0 error, 0 warn, 2 info/);
  assert.doesNotMatch(r.out, /on all 2 tools/);
});

test("cli: error-tier repeats are never aggregated", () => {
  // 3 tools each missing inputSchema -> tool/input-schema-required (error) x3
  const file = tmpTools(Array.from({ length: 3 }, (_, i) => ({ name: `e_${i}`, description: "d" })));
  const r = cli([file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /3 error/);
  assert.doesNotMatch(r.out, /on all 3 tools/);
});

test("cli: SARIF driver.version tracks package.json (no drift)", () => {
  const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const sarif = JSON.parse(cli(["examples/tools.good.json", "--format", "sarif"]).out);
  assert.equal(sarif.runs[0].tool.driver.version, pkgVersion);
});

// ===== CLI robustness: exit codes, argument parsing, malformed input, ReDoS,
// output escaping. Kept in this file on purpose: with --test-force-exit,
// `node --test` over several files can drop the tail of one file's tests when
// another file finishes first.
import { mkdtempSync } from "node:fs";
import { loadAllProfiles } from "../src/profiles.mjs";
const RTMP = mkdtempSync(join(tmpdir(), "mcpconform-robust-"));
function rrun(a, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, join(ROOT, "src/index.mjs"), ...a], {
    encoding: "utf8",
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
}
let rseq = 0;
function rfile(content, raw = false) {
  const f = join(RTMP, `a${rseq++}.json`);
  writeFileSync(f, raw ? content : JSON.stringify(content));
  return f;
}
const noStack = (r) => assert.doesNotMatch(r.out, /\n\s+at .*\(node:|Unhandled|Node\.js v\d/, "no raw Node crash output");

// --- exit codes + argument parsing ---
test("cli: unknown flag exits 2 instead of being silently ignored", () => {
  const r = rrun(["examples/tools.good.json", "--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown option "--bogus"/);
});

test("cli: --flag=value works for value flags (was a silent 'No findings')", () => {
  const r = rrun(["examples/tools.bad.json", "--target=anthropic"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /provider\/name-pattern/);
  const s = rrun(["examples/tools.bad.json", "--target=anthropic", "--format=sarif", "--min-severity=error"]);
  assert.ok(JSON.parse(s.stdout).runs[0].results.every((x) => x.level === "error"));
});

test("cli: bad enum values for --format/--mode/--type exit 2 with a message", () => {
  for (const [flag, val] of [["--format", "xml"], ["--mode", "loud"], ["--type", "yaml"]]) {
    const r = rrun(["examples/tools.good.json", flag, val]);
    assert.equal(r.code, 2, `${flag} ${val}`);
    assert.match(r.out, new RegExp(`${flag} must be`));
  }
});

test("cli: a value flag with no value (or followed by another flag) exits 2", () => {
  assert.equal(rrun(["examples/tools.good.json", "--format"]).code, 2);
  const r = rrun(["examples/tools.good.json", "--target", "--format", "sarif"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /--target requires a value/);
});

test("cli: a boolean flag given a value exits 2", () => {
  assert.equal(rrun(["examples/tools.good.json", "--expand=yes"]).code, 2);
});

test("cli: files after `--` are linted, not dropped", () => {
  const r = rrun(["--target", "anthropic", "--", "examples/tools.bad.json"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /provider\/name-pattern/);
});

test("cli inspect: a server flag without `--` is a usage error with a hint", () => {
  const r = rrun(["inspect", process.execPath, mock, "--port", "3"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /after `--`/);
});

test("cli: an I/O failure (unwritable --out) exits 2, not 1", () => {
  const r = rrun(["examples/tools.good.json", "--out", join(RTMP, "no/such/dir/out.txt")]);
  assert.equal(r.code, 2);
  assert.match(r.out, /internal error/);
});

// --- targets ---
test("cli: an unknown target exits 2 and lists the known profiles", () => {
  const r = rrun(["examples/tools.good.json", "--target", "anthropc"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown target profile\(s\): "anthropc"/);
  assert.match(r.out, /known: .*anthropic/);
});

test("cli: target list entries are trimmed ('anthropic, openai' keeps openai)", () => {
  const r = rrun(["examples/tools.good.json", "--target", "anthropic, openai"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /targets: anthropic, openai\)/);
});

test("cli: prototype keys are not profiles or severities", () => {
  assert.equal(rrun(["examples/tools.bad.json", "--target", "constructor"]).code, 2);
  const r = rrun(["examples/tools.bad.json", "--min-severity", "constructor"]);
  assert.equal(r.code, 2); // used to hide every finding and exit 0
  assert.match(r.out, /min-severity/);
});

// --- config validation ---
test("cli: config severity overrides must be error|warn|info|off", () => {
  for (const v of ["ERROR", "high"]) {
    const cfg = rfile({ rules: { "tool/name-unique": v } });
    const r = rrun(["examples/tools.bad.json", "--config", cfg]);
    assert.equal(r.code, 2, v);
    assert.match(r.out, /tool\/name-unique.*must be error\|warn\|info\|off/);
  }
});

test("cli: a missing or malformed --config exits 2", () => {
  assert.equal(rrun(["examples/tools.good.json", "--config", join(RTMP, "nope.json")]).code, 2);
  assert.equal(rrun(["examples/tools.good.json", "--config", rfile("{bad", true)]).code, 2);
  assert.equal(rrun(["examples/tools.good.json", "--config", rfile({ targets: "anthropic" })]).code, 2);
});

test("cli: config.mode is honored (was always overridden by the flag default)", () => {
  const cfg = rfile({ targets: ["openai"], mode: "strict" });
  const r = rrun(["examples/tools.bad.json", "--config", cfg]);
  assert.match(r.out, /provider\/schema-additional-properties|provider\/schema-all-required/);
});

// --- artifact type detection ---
test("cli: an unrecognized shape is a meta error, not a clean 0-tool lint", () => {
  for (const doc of [{ mcpServer: { a: { command: "x" } } }, { name: "io.github.a/b", version: "1.0.0" }, null, 42]) {
    const r = rrun([rfile(doc)]);
    assert.equal(r.code, 1, JSON.stringify(doc));
    assert.match(r.out, /meta\/unrecognized-artifact/);
    assert.match(r.out, /--type/);
  }
});

test("cli: an unrecognized shape names a likely fix", () => {
  let r = rrun([rfile({ mcpServer: { a: { command: "x" } } })]);
  assert.match(r.out, /Found "mcpServer" — did you mean "mcpServers"\?/);
  r = rrun([rfile({ name: "io.github.a/b", version: "1.0.0", description: "d" })]);
  assert.match(r.out, /Looks like a server\.json with no packages\[\], remotes\[\] or \$schema/);
});

test("cli: zero tools / zero servers is a meta/empty-artifact warning, not an error", () => {
  for (const doc of [{ tools: [] }, [], { mcpServers: {} }]) {
    const r = rrun([rfile(doc)]);
    assert.equal(r.code, 0, JSON.stringify(doc)); // prompt/resource-only servers are legitimate
    assert.match(r.out, /WARN  meta\/empty-artifact/);
    assert.doesNotMatch(r.out, /unrecognized-artifact/);
  }
  // and it can be raised to a fail-gate (or turned off) on its own
  const cfg = rfile({ rules: { "meta/empty-artifact": "error" } });
  assert.equal(rrun([rfile({ tools: [] }), "--config", cfg]).code, 1);
});

test("cli: inspect --dump of a zero-tool server lints clean-with-warning, not as an error", () => {
  const srv = join(RTMP, "notools.mjs");
  writeFileSync(srv, `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list" ? { tools: [] } : {} }) + "\\n");
  }
});`);
  const dump = join(RTMP, "notools-dump.json");
  assert.equal(rrun(["inspect", "--dump", dump, "--", process.execPath, srv]).code, 0);
  assert.equal(rrun([dump]).code, 0);
});

test("cli: a VS Code settings.json is linted through its mcp.servers block", () => {
  const r = rrun([rfile({ "editor.fontSize": 12, mcp: { servers: { a: { command: "x", url: "https://e" } } } })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /\[client-config\]  \(1 server\(s\)\)/);
  assert.match(r.out, /client-config\/one-transport/);
});

test("cli: --type still requires the matching JSON shape", () => {
  let r = rrun([rfile(null), "--type", "server-json"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /server-json artifact must be a JSON object/);
  r = rrun([rfile({ mcpServer: {} }), "--type", "tools"]);
  assert.match(r.out, /meta\/unrecognized-artifact/);
  r = rrun([rfile({ servers: { a: { command: "x" } } }), "--type", "client-config"]);
  assert.equal(r.code, 0);
});

test("cli: object-valued names/versions ({toString: 1}) are findings, in both formats", () => {
  const evil = { toString: 1 };
  const files = [
    rfile({ tools: [{ name: evil, description: evil, inputSchema: { type: "object", properties: { a: { description: evil } }, required: [evil] } }] }),
    rfile({ name: evil, version: evil, packages: [{ registryType: evil, version: evil, transport: { type: evil } }], remotes: [{ type: evil }] }),
  ];
  for (const fmt of ["human", "sarif"]) {
    const r = rrun([...files, "--format", fmt, "--target", "anthropic"]);
    noStack(r);
    assert.equal(r.code, 1, r.out);
    assert.doesNotMatch(r.out, /internal-error|internal error/);
    assert.match(r.out, /\{\\?"toString\\?":1\}/);
  }
});

test("cli: a crash while rendering still exits 2 with meta/internal-error", () => {
  const hook =
    "data:text/javascript,const o=String.prototype.localeCompare;" +
    "String.prototype.localeCompare=function(...a){if(String(this).includes('render_crash'))throw new Error('render boom');return o.apply(this,a)}";
  const f = join(RTMP, "render_crash.json");
  writeFileSync(f, JSON.stringify({ tools: [{ name: "a" }, { name: "b" }] }));
  const r = rrun([f, "examples/tools.bad.json"], ["--import", hook]);
  noStack(r);
  assert.equal(r.code, 2);
  assert.match(r.out, /meta\/internal-error[\s\S]*rendering the report: render boom/);
});

test("rules: deterministic fuzz with hostile values never throws", async () => {
  const { loadAllProfiles: load } = await import("../src/profiles.mjs");
  const { renderHuman, renderSarif } = await import("../src/report.mjs");
  const { show } = await import("../src/text.mjs");
  const profs = Object.values(load().profiles);
  let seed = 1;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  const atoms = [null, 0, 1.5, true, "", "x", "delete_user", "API_KEY", "${", "eyJ", { toString: 1 }, { valueOf: 1, toString: 1 }, [], [null], {}, "object"];
  const keys = ["name", "description", "inputSchema", "outputSchema", "annotations", "title", "execution", "_meta", "icons", "type",
    "properties", "required", "items", "anyOf", "$ref", "$defs", "additionalProperties", "format", "taskSupport", "readOnlyHint",
    "packages", "remotes", "version", "registryType", "transport", "url", "environmentVariables", "packageArguments", "mcpServers",
    "servers", "command", "args", "env", "headers", "mimeType", "src", "toString", "constructor", "$schema", "enum", "pattern"];
  const val = (d) => {
    const r = rnd(10);
    if (d > 4 || r < 4) return atoms[rnd(atoms.length)];
    if (r < 6) return Array.from({ length: rnd(4) }, () => val(d + 1));
    const o = {};
    for (let i = rnd(6); i > 0; i--) o[keys[rnd(keys.length)]] = val(d + 1);
    return o;
  };
  for (let i = 0; i < 1500; i++) {
    const doc = val(0);
    const tools = Array.isArray(doc) ? doc : [doc, val(1)];
    const f = [];
    const emit = (id, tool, message, profile = null) =>
      f.push({ id, tier: "warn", tool: tool == null ? null : show(tool), message: show(message), profile, file: "x" });
    assert.doesNotThrow(() => {
      runCoreRules(tools, emit);
      for (const m of ["default", "strict"]) runProviderRules(tools, profs, emit, m);
      runServerJsonRules(doc, emit, { packageVersion: "1.0.0" });
      runClientConfigRules(doc, emit);
      runClientConfigRules({ mcpServers: doc }, emit);
      renderHuman(f, {}, { summaries: ["s"] });
      renderSarif(f, {}, { summaries: [] });
    }, show(doc));
  }
});

// --- malformed input: findings, never crashes ---
test("cli: malformed shapes produce findings and the remaining files are still linted", () => {
  const bad = [null, { tools: "x" }, { tools: {} }, { packages: [null] }, { remotes: [null] }, { mcpServers: "abc" }].map((d) => rfile(d));
  const r = rrun([...bad, "examples/tools.bad.json", "--target", "anthropic"]);
  noStack(r);
  assert.equal(r.code, 1);
  assert.match(r.out, /`tools` must be an array of Tool objects \(got string\)/);
  assert.match(r.out, /`tools` must be an array of Tool objects \(got object\)/);
  assert.match(r.out, /packages\[0\] must be an object/);
  assert.match(r.out, /remotes\[0\] must be an object/);
  assert.match(r.out, /provider\/name-pattern/); // the good file after them still ran
});

test("cli: a crash inside one artifact becomes meta/internal-error, exits 2, and the rest still run", () => {
  // Preload a hook that throws for one specific tool name, simulating an engine bug.
  const hook =
    "data:text/javascript,const a=Set.prototype.add;" +
    "Set.prototype.add=function(v){if(v==='__crash__')throw new Error('boom');return a.call(this,v)}";
  const crashing = rfile({ tools: [{ name: "__crash__", description: "d", inputSchema: { type: "object" } }] });
  const r = rrun([crashing, "examples/tools.bad.json", "--target", "anthropic"], ["--import", hook]);
  assert.equal(r.code, 2);
  assert.match(r.out, /meta\/internal-error/);
  assert.match(r.out, /boom/);
  assert.match(r.out, /provider\/name-pattern/);
});

test("cli: a UTF-8 BOM is stripped before parsing", () => {
  const r = rrun([rfile("﻿" + JSON.stringify({ tools: [{ name: "ok_tool", description: "d", inputSchema: { type: "object", additionalProperties: false } }] }), true)]);
  assert.doesNotMatch(r.out, /parse-error/);
  assert.equal(r.code, 0);
});

test("core: required names that are Object.prototype keys are still checked", () => {
  const f = [];
  runCoreRules([{ name: "x", description: "d", inputSchema: { type: "object", properties: {}, required: ["constructor", "toString"] } }],
    (id, tool, message) => f.push({ id, message }));
  assert.equal(f.filter((x) => x.id === "tool/required-references-properties").length, 2);
});

test("core: a non-array tools value is ignored, not a crash", () => {
  assert.doesNotThrow(() => runCoreRules("x", () => {}));
  assert.doesNotThrow(() => runCoreRules({}, () => {}));
});

// A bad toolName.pattern is rejected once, at profile load (profiles.mjs:
// ProfileError -> exit 2); there is no separate runtime rule for it.
test("cli: a profilesDir profile with an uncompilable toolName.pattern exits 2 at load", () => {
  const dir = mkdtempSync(join(RTMP, "prof-"));
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "badpat", kind: "llm-provider", verified: false, toolName: { pattern: "(" } }));
  const cfg = rfile({ profilesDir: dir });
  const r = rrun(["examples/tools.good.json", "--config", cfg, "--target", "badpat"]);
  noStack(r);
  assert.equal(r.code, 2);
  assert.match(r.out, /toolName\/pattern is not a valid regular expression/);
});

test("profiles: an id that is an Object.prototype key is an ordinary profile", () => {
  const dir = mkdtempSync(join(RTMP, "prof-"));
  writeFileSync(join(dir, "ctor.json"), JSON.stringify({ id: "constructor", kind: "llm-provider", verified: false, toolName: { maxLength: 3 } }));
  // Used to fail as a false "duplicate profile id" (inherited Object.prototype.constructor).
  const { profiles } = loadAllProfiles(dir);
  assert.ok(Object.hasOwn(profiles, "constructor"));
  assert.equal(profiles.constructor.toolName.maxLength, 3);
  assert.ok(!Object.hasOwn(profiles, "toString"));
  const cfg = rfile({ profilesDir: dir });
  const r = rrun(["examples/tools.good.json", "--config", cfg, "--target", "constructor"]);
  assert.equal(r.code, 1); // the profile is applied like any other
  assert.match(r.out, /provider\/name-length <constructor>/);
  // and "__proto__" can never be an id (schema pattern), so it is a usage error
  const r2 = rrun(["examples/tools.good.json", "--target", "__proto__"]);
  assert.equal(r2.code, 2);
  assert.match(r2.out, /unknown target profile/);
});

test("schema: a 3000-deep inputSchema is walked without a stack overflow", () => {
  let s = { type: "string" };
  for (let i = 0; i < 3000; i++) s = { type: "object", properties: { a: s } };
  const f = [];
  const prof = { id: "p", inputSchema: { maxNestingDepth: 5 } };
  assert.doesNotThrow(() => checkProviderSchema("deep", s, prof, "default", (id, t, m) => f.push(m)));
  assert.ok(f.some((m) => /nests 3000 deep/.test(m)));
});

test("cli: a deeply nested schema file is linted, not crashed", () => {
  const depth = 3000;
  const schema = '{"type":"object","properties":{"a":'.repeat(depth) + '{"type":"string"}' + "}}".repeat(depth);
  const f = join(RTMP, "deep.json");
  writeFileSync(f, `{"tools":[{"name":"deep","description":"d","inputSchema":${schema}}]}`);
  const r = rrun([f, "--target", "openai", "--mode", "strict"]);
  noStack(r);
  assert.equal(r.code, 1);
  assert.match(r.out, /provider\/schema-max-depth/);
  // Ajv's stack overflow is reported as "unchecked", never as an invalid schema.
  assert.match(r.out, /tool\/input-schema-unchecked/);
  assert.doesNotMatch(r.out, /tool\/input-schema-valid|Maximum call stack/);
});

// --- inspect robustness ---
test("cli inspect: a server that writes `null`/non-objects is handled (exit 2, no crash)", () => {
  const srv = join(RTMP, "nullsrv.mjs");
  writeFileSync(srv, `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    process.stdout.write('null\\n5\\n"x"\\n');
    if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
    if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { message: "nope\\u001b[2J" } }) + "\\n");
  }
});`);
  const r = rrun(["inspect", "--", process.execPath, srv]);
  noStack(r);
  assert.equal(r.code, 2);
  assert.match(r.out, /tools\/list failed: nope\\u001b\[2J/); // server text is escaped too
  assert.doesNotMatch(r.out, /\x1b/);
});

test("cli inspect: a server that closes its stdin fails cleanly (no unhandled EPIPE)", () => {
  // Closes stdin, then answers initialize: our follow-up writes hit a closed pipe.
  const srv = 'require("fs").closeSync(0);console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{}}));setTimeout(()=>{},5000)';
  const r = rrun(["inspect", "--", process.execPath, "-e", srv]);
  noStack(r);
  assert.equal(r.code, 2);
});

test("cli inspect: the report never echoes the spawned command's arguments", () => {
  // Assembled at runtime so secret scanners don't flag this deliberately fake key.
  const secret = ["sk", "live", "0123456789abcdef" + "SECRET"].join("-");
  const human = rrun(["inspect", "--", process.execPath, mock, `--api-key=${secret}`]);
  assert.equal(human.code, 0);
  assert.doesNotMatch(human.out, /SECRET/);
  assert.match(human.out, /inspect\/node(\.exe)? \(\+2 args\)/);
  const sarif = rrun(["inspect", "--format", "sarif", "--", process.execPath, mock, `--api-key=${secret}`]);
  assert.doesNotMatch(sarif.out, /SECRET/);
  const uris = JSON.parse(sarif.stdout).runs[0].results.map((x) => x.locations[0].physicalLocation.artifactLocation.uri);
  assert.ok(uris.length && uris.every((u) => /^inspect\/[A-Za-z0-9._-]+$/.test(u)), uris.join(","));
});

// --- ReDoS: 300KB adversarial inputs stay linear ---
const fast = (fn, ms) => {
  const t = process.hrtime.bigint();
  fn();
  const took = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(took < ms, `took ${took.toFixed(0)}ms (budget ${ms}ms)`);
};

test("redos: malformed ${...} check is linear on 300KB of unterminated refs", () => {
  const f = [];
  fast(() => runClientConfigRules({ mcpServers: { a: { command: "x", args: ["${a:-".repeat(60000)] } } }, (id) => f.push(id)), 1000);
  assert.ok(f.includes("client-config/env-refs-declared"));
});

test("redos: JWT secret check is linear on 300KB of '-eyJ' runs", () => {
  fast(() => runClientConfigRules({ mcpServers: { a: { command: "x", env: { K: "eyJ-".repeat(75000) } } } }, () => {}), 1000);
});

test("redos: a 300KB server-ish $schema is detected in linear time", () => {
  const f = rfile({ $schema: "server".repeat(50000) });
  // includes process start-up; the quadratic regex took ~20s here
  fast(() => assert.match(rrun([f]).out, /meta\/unrecognized-artifact/), 5000);
  const ok = rrun([rfile({ $schema: "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json" })]);
  assert.match(ok.out, /\[server\.json\]/);
});

// The rewrites must not change what is flagged.
test("client-config: ${...} and JWT detection semantics are unchanged", () => {
  const flagged = (v, where = "args") => {
    const f = [];
    const cfg = where === "args" ? { command: "x", args: [v] } : { command: "x", env: { K: v } };
    runClientConfigRules({ mcpServers: { a: cfg } }, (id) => f.push(id));
    return f;
  };
  assert.ok(!flagged("${A:-$HOME}").includes("client-config/env-refs-declared"));
  assert.ok(!flagged("${A:-${B}}").includes("client-config/env-refs-declared"));
  assert.ok(flagged("${A} then ${").includes("client-config/env-refs-declared"));
  assert.ok(flagged("${} x }").includes("client-config/env-refs-declared"));

  // Differential check of the JWT detector against the original regex.
  const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  const alphabet = ["eyJ", "-", ".", "a", "b", "_", " ", "=", "e", "y", "J", "aaaaaaaaaa"];
  let seed = 7;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  for (let i = 0; i < 3000; i++) {
    let v = "";
    for (let j = rnd(40); j > 0; j--) v += alphabet[rnd(alphabet.length)];
    const got = flagged(v, "env").includes("client-config/no-hardcoded-secrets");
    assert.equal(got, JWT.test(v), JSON.stringify(v));
  }
  assert.ok(flagged("x-eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f", "env").includes("client-config/no-hardcoded-secrets"));
});

// --- output escaping ---
test("cli: control characters from the input are escaped in the human report", () => {
  const f = rfile({ tools: [{ name: "a\u001b[31mRED\u0007\rX\u009b2J‮", description: "d", inputSchema: { type: "object" } }] });
  const r = rrun([f]);
  assert.doesNotMatch(r.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/); // only the report's own \n
  assert.match(r.stdout, /a\\u001b\[31mRED\\u0007\\rX\\u009b2J\\u202e/);
});

test("cli: SARIF carries no raw control characters and round-trips the original text", () => {
  const name = "a\u001b[31m\u009b‮b";
  const r = rrun([rfile({ tools: [{ name, description: "d", inputSchema: { type: "object" } }] }), "--format", "sarif"]);
  assert.doesNotMatch(r.stdout, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/);
  const res = JSON.parse(r.stdout).runs[0].results;
  assert.ok(res.some((x) => x.message.text.startsWith(`${name}: `)));
});

test("cli: SARIF run properties carry the targets and per-artifact summaries", () => {
  const r = rrun(["examples/tools.good.json", "examples/server.bad.json", "--target", "anthropic", "--format", "sarif"]);
  const props = JSON.parse(r.stdout).runs[0].properties;
  assert.deepEqual(props.targets, ["anthropic"]);
  assert.equal(props.summaries.length, 2);
  assert.match(props.summaries[1], /\[server\.json\]/);
});

test("cli: a report larger than the 64KB pipe buffer is not truncated", () => {
  const tools = Array.from({ length: 400 }, (_, i) => ({ name: `t_${i}` })); // 2 findings each, no ajv work
  const r = rrun([rfile({ tools }), "--format", "sarif"]);
  assert.ok(r.stdout.length > 65536, `only ${r.stdout.length} bytes`);
  assert.equal(JSON.parse(r.stdout).runs[0].results.length, 800);
});

test("redos: name splitting (secret names, mutating verbs) is linear on a 300KB capitals run", async () => {
  const { nameWords } = await import("../src/names.mjs");
  fast(() => nameWords("A".repeat(300000)), 1000);
  // Differential check against the original quadratic regex.
  const orig = (s) =>
    String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
  const alphabet = ["A", "B", "a", "b", "_", "1", "HTTP", "Get", "x"];
  let seed = 11;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  for (let i = 0; i < 3000; i++) {
    let v = "";
    for (let j = rnd(20); j > 0; j--) v += alphabet[rnd(alphabet.length)];
    assert.deepEqual(nameWords(v), orig(v), JSON.stringify(v));
  }
});

test("detect: isServerSchemaUri is exactly /server.*schema/i (randomized, incl. line terminators)", async () => {
  const { isServerSchemaUri } = await import("../src/detect.mjs");
  const RE = /server.*schema/i;
  const alphabet = ["server", "schema", "SERVER", "Schema", "serv", "er", "sch", "ema", "\n", "\r", "\u2028", "\u2029", "/", ".", "x", "ſ", "K", "İ"];
  let seed = 5;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  for (let i = 0; i < 5000; i++) {
    let v = "";
    for (let j = rnd(12); j > 0; j--) v += alphabet[rnd(alphabet.length)];
    assert.equal(isServerSchemaUri(v), RE.test(v), JSON.stringify(v));
  }
  fast(() => isServerSchemaUri("server".repeat(50000)), 1000);
});

test("client-config: the linear ${...} check matches the original regex (randomized)", () => {
  const VAR_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-+?][^}]*)?\}/g;
  const orig = (v) => v.replace(VAR_REF, "").includes("${");
  const alphabet = ["${", "}", "$", "{", "A", "_", "1", ":-", ":+", ":?", ":", "-", " ", "${A}", "${A:-"];
  let seed = 9;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % k);
  for (let i = 0; i < 5000; i++) {
    let v = "";
    for (let j = rnd(12); j > 0; j--) v += alphabet[rnd(alphabet.length)];
    const f = [];
    runClientConfigRules({ mcpServers: { a: { command: "x", args: [v] } } }, (id) => f.push(id));
    assert.equal(f.includes("client-config/env-refs-declared"), orig(v), JSON.stringify(v));
  }
});

test("cli: a bad config minSeverity names the config key, not the flag", () => {
  const r = rrun(["examples/tools.good.json", "--config", rfile({ minSeverity: "loud" })]);
  assert.equal(r.code, 2);
  assert.match(r.out, /config `minSeverity` must be error\|warn\|info/);
});
