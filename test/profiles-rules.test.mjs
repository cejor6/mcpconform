// Profile loading/validation, --portable selection, schema dialects/caching,
// and the rule-accuracy fixes (secret names, mutating verbs, no-params shape,
// annotations, recursion, maxProperties, string formats, case collisions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runCoreRules, runProviderRules, isMutatingName } from "../src/rules.mjs";
import { validateInputSchema, runSchemaValidity, checkProviderSchema } from "../src/schema.mjs";
import { runServerJsonRules } from "../src/server-json.mjs";
import { runClientConfigRules } from "../src/client-config.mjs";
import { isSecretName, looksHexSecret } from "../src/secrets.mjs";
import { loadProfileDir, loadAllProfiles, validateProfile, portableProfileIds, SHIPPED_PROFILES_DIR } from "../src/profiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = (id) => JSON.parse(readFileSync(join(ROOT, "profiles", `${id}.json`), "utf8"));
const collectInto = (f) => (id, tool, message, pid = null) => f.push({ id, tool, message, pid });
const core = (tools) => { const f = []; runCoreRules(tools, collectInto(f)); return f; };
const provider = (tools, profiles, mode = "default") => { const f = []; runProviderRules(tools, profiles, collectInto(f), mode); return f; };
const ids = (f) => f.map((x) => x.id);
function cli(a, opts = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "src/index.mjs"), ...a], { encoding: "utf8", cwd: ROOT, ...opts });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
}
const ruleIds = new Set(JSON.parse(readFileSync(join(ROOT, "rules.json"), "utf8")).rules.map((r) => r.id));

// --- profiles: validation + loading ------------------------------------------

test("profiles: every shipped profile validates against profile.schema.json", () => {
  const loaded = loadProfileDir(SHIPPED_PROFILES_DIR);
  assert.ok(Object.keys(loaded).length >= 5);
  for (const [id, { profile: p }] of Object.entries(loaded)) assert.deepEqual(validateProfile(p), [], id);
});

test("profiles: verified:true without source/lastVerified, unknown fields, and bad regex are rejected", () => {
  assert.ok(validateProfile({ id: "x", kind: "llm-provider", verified: true }).length);
  assert.ok(validateProfile({ id: "x", kind: "llm-provider", verified: false, inputSchema: { maxDepth: 3 } }).some((m) => /maxDepth/.test(m)));
  assert.ok(validateProfile({ id: "x", kind: "llm-provider", verified: false, toolName: { pattern: "([" } }).some((m) => /regular expression/.test(m)));
  assert.deepEqual(validateProfile({ id: "x", kind: "llm-provider", verified: false }), []);
});

function withProfilesDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcpconform-prof-"));
  try {
    mkdirSync(join(dir, "profiles"));
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, "profiles", name), typeof body === "string" ? body : JSON.stringify(body));
    const cfg = join(dir, "mcpconform.config.json");
    writeFileSync(cfg, JSON.stringify({ profilesDir: "./profiles" }));
    return fn(cfg, join(dir, "profiles"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cli: an invalid profilesDir profile is a usage error (exit 2) naming the file", () => {
  withProfilesDir({ "bad.json": { id: "bad", kind: "llm-provider", verified: false, toolName: { patern: "^x$" } } }, (cfg) => {
    const r = cli(["examples/tools.good.json", "--config", cfg, "--target", "bad"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid profile .*bad\.json/);
    assert.match(r.stderr, /patern/);
  });
});

test("cli: an unparsable profilesDir profile is a usage error, not silently skipped", () => {
  withProfilesDir({ "broken.json": "{ nope" }, (cfg) => {
    const r = cli(["examples/tools.good.json", "--config", cfg]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /broken\.json: cannot parse JSON/);
  });
});

test("profiles: a profilesDir profile overriding a shipped id warns (and wins)", () => {
  const custom = { ...profile("anthropic"), toolName: { pattern: "^[a-z]+$", maxLength: 64 } };
  withProfilesDir({ "mine.json": custom }, (cfg, dir) => {
    const { profiles, warnings } = loadAllProfiles(dir);
    assert.equal(profiles.anthropic.toolName.pattern, "^[a-z]+$");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"anthropic" .* overrides the shipped profile/);
    const r = cli(["examples/tools.good.json", "--config", cfg, "--target", "anthropic"]);
    assert.match(r.stderr, /warning: profile "anthropic"/);
    assert.equal(r.code, 1); // get_weather fails the custom ^[a-z]+$ pattern
  });
});

test("profiles: _comment keys are allowed; non-profile JSON in profilesDir is skipped with a warning", () => {
  const custom = { _comment: "mine", id: "my-host", kind: "mcp-host", verified: false, toolName: { _why: "doc", pattern: "^[a-z_]+$" } };
  withProfilesDir({ "my-host.json": custom, "package.json": { name: "x", version: "1.0.0" } }, (cfg, dir) => {
    const { profiles, warnings } = loadAllProfiles(dir);
    assert.ok(profiles["my-host"]);
    assert.ok(warnings.some((w) => /package\.json: not a profile/.test(w)));
    const r = cli(["examples/tools.good.json", "--config", cfg, "--target", "my-host"]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /skipping .*package\.json/);
  });
});

test("profiles: still rejects a profile missing kind/verified (documented as breaking)", () => {
  withProfilesDir({ "half.json": { id: "half" } }, (cfg) => {
    assert.equal(cli(["examples/tools.good.json", "--config", cfg]).code, 2);
  });
});

test("profiles: overriding a verified shipped id with verified:false warns it leaves --portable", () => {
  const custom = { ...profile("openai"), verified: false };
  withProfilesDir({ "openai.json": custom }, (cfg, dir) => {
    const { profiles, warnings } = loadAllProfiles(dir);
    assert.ok(warnings.some((w) => /"openai" .*excluded from --portable/.test(w)));
    assert.ok(!portableProfileIds(profiles).includes("openai"));
  });
});

test("profiles: pointing profilesDir at the shipped directory is not an override", () => {
  assert.deepEqual(loadAllProfiles(SHIPPED_PROFILES_DIR).warnings, []);
});

// --- generic-strict + --portable -----------------------------------------------

test("generic-strict: examples/tools.good.json passes in default and strict mode", () => {
  const { tools } = JSON.parse(readFileSync(join(ROOT, "examples/tools.good.json"), "utf8"));
  for (const mode of ["default", "strict"]) assert.deepEqual(provider(tools, [profile("generic-strict")], mode), [], mode);
  for (const mode of ["default", "strict"])
    assert.equal(cli(["examples/tools.good.json", "--target", "generic-strict", "--mode", mode]).code, 0, mode);
});

test("--portable: includes generic-strict, excludes the unverified stub", () => {
  const picked = portableProfileIds(loadAllProfiles().profiles);
  assert.ok(picked.includes("generic-strict"));
  assert.ok(!picked.includes("mistral"));
  assert.ok(picked.includes("anthropic") && picked.includes("openai") && picked.includes("gemini"));
  const r = cli(["examples/tools.good.json", "--portable"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /targets: .*generic-strict/);
  assert.doesNotMatch(r.out, /mistral/);
});

// --- schema dialects, depth, caching --------------------------------------------

test("schema: 2019-09, draft-07 and draft-06 $schema validate (no 'no schema with key or ref')", () => {
  const body = { type: "object", properties: { a: { type: "string" } } };
  for (const d of [
    "https://json-schema.org/draft/2019-09/schema",
    "http://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-06/schema#",
    "https://json-schema.org/draft/2020-12/schema",
    "http://json-schema.org/draft/2020-12/schema", // http spelling of the 2020-12 URI
  ]) {
    const r = validateInputSchema({ $schema: d, ...body });
    assert.deepEqual(r, { ok: true }, d);
  }
  // still catches genuinely invalid schemas in the non-default dialects
  assert.equal(validateInputSchema({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "frobnicate" }).ok, false);
  assert.equal(validateInputSchema({ $schema: "http://json-schema.org/draft-06/schema#", type: "object", properties: "nope" }).ok, false);
});

test("schema: draft-04 / unknown $schema -> input-schema-unchecked warning, not invalid", () => {
  for (const d of ["http://json-schema.org/draft-04/schema#", "https://example.com/my-meta"]) {
    const f = [];
    runSchemaValidity([{ name: "t", inputSchema: { $schema: d, type: "object" } }], collectInto(f));
    assert.deepEqual(ids(f), ["tool/input-schema-unchecked"], d);
  }
});

test("schema: a ~1500-deep schema is 'unchecked', not invalid (no stack-overflow false positive)", () => {
  let deep = { type: "string" };
  for (let i = 0; i < 1500; i++) deep = { type: "object", properties: { a: deep } };
  const f = [];
  runSchemaValidity([{ name: "deep", inputSchema: deep }], collectInto(f));
  assert.deepEqual(ids(f), ["tool/input-schema-unchecked"]);
  assert.match(f[0].message, /nested too deeply/);
  // the engine still works afterwards
  assert.deepEqual(validateInputSchema({ type: "object" }), { ok: true });
});

test("cli: a 3000-deep schema with a provider target warns instead of crashing", () => {
  const n = 3000;
  const schema = '{"type":"object","properties":{"a":'.repeat(n) + '{"type":"string"}' + "}}".repeat(n);
  const dir = mkdtempSync(join(tmpdir(), "mcpconform-deep-"));
  try {
    const file = join(dir, "deep.json");
    writeFileSync(file, `{"tools":[{"name":"deep","description":"d","inputSchema":${schema}}]}`);
    const r = cli([file, "--target", "openai"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /tool\/input-schema-unchecked <openai> \[deep\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema: shared ajv instance does not leak $ids between tools", () => {
  const s = () => ({ $id: "https://example.com/s", type: "object", properties: { a: { $id: "https://example.com/n", type: "string" } } });
  for (let i = 0; i < 3; i++) assert.deepEqual(validateInputSchema(s()), { ok: true });
});

test("schema: 2000 tools validate quickly (one cached ajv per dialect)", () => {
  const tools = Array.from({ length: 2000 }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: "object", properties: { a: { type: "string", format: "email" }, b: { $ref: "#/$defs/x" } }, $defs: { x: { type: "integer" } } },
  }));
  const t0 = Date.now();
  const f = [];
  runSchemaValidity(tools, collectInto(f));
  const ms = Date.now() - t0;
  assert.deepEqual(f, []);
  assert.ok(ms < 10000, `took ${ms}ms`); // ~2s locally; was ~30s with an Ajv per tool. Generous bound for slow CI.
});

// --- false positives / negatives -----------------------------------------------------

test("secret names: whole-word match; MAX_TOKENS/TOKEN_LIMIT/AUTHOR are not secrets", () => {
  for (const n of ["MAX_TOKENS", "TOKEN_LIMIT", "AUTHOR", "AUTHOR_NAME", "KEYBOARD_LAYOUT", "MONKEY", "TOKENIZER", "API_KEY_ID", "SECRET_PATH", "PUBLIC_KEY", "PASSWORD_MIN_LENGTH", "KEY"])
    assert.equal(isSecretName(n), false, n);
  for (const n of ["API_KEY", "GITHUB_TOKEN", "apiKey", "DB_PASSWORD", "CLIENT_SECRET", "BASIC_AUTH", "PRIVATE_KEY", "APIKEY", "Authorization", "X-Api-Key", "STRIPE_SECRET_KEY"])
    assert.equal(isSecretName(n), true, n);
});

test("secret names: run-together forms still match (main caught them as substrings)", () => {
  for (const n of ["ACCESSTOKEN", "AUTHTOKEN", "APITOKEN", "SECRETKEY", "CLIENTSECRET", "PRIVATEKEY"])
    assert.equal(isSecretName(n), true, n);
});

test("secret names: data keys are not secrets (KEY needs a secret-ish qualifier)", () => {
  for (const n of ["PARTITION_KEY", "SORT_KEY", "CACHE_KEY", "PRIMARY_KEY_COLUMN", "STRIPE_PUBLISHABLE_KEY", "ROUTING_KEY", "IDEMPOTENCY_KEY", "FOREIGN_KEY"])
    assert.equal(isSecretName(n), false, n);
});

test("server.json: env-secret-flag no longer fires on MAX_TOKENS / TOKEN_LIMIT / AUTHOR", () => {
  const doc = {
    name: "io.github.x/y",
    version: "1.0.0",
    packages: [{
      registryType: "npm", identifier: "y", version: "1.0.0", transport: { type: "stdio" },
      environmentVariables: [{ name: "MAX_TOKENS" }, { name: "TOKEN_LIMIT" }, { name: "AUTHOR" }, { name: "API_TOKEN" }],
    }],
  };
  const f = [];
  runServerJsonRules(doc, collectInto(f));
  assert.deepEqual(f.filter((x) => x.id === "server-json/env-secret-flag").map((x) => x.tool), ["packages[0].env.API_TOKEN"]);
});

test("mutating verbs: camelCase, suffixed and bare verbs; not 'updated_at'-style words or read-verb names", () => {
  for (const n of ["delete", "deleteUser", "user_delete", "delete_account", "HTTPDelete", "bulk-delete", "createIssue", "set_value"])
    assert.equal(isMutatingName(n), true, n);
  for (const n of ["updated_at", "get_updates", "check_for_update", "data_set", "market_place", "settings_get", "list_deleted"])
    assert.equal(isMutatingName(n), false, n);
  // compound nouns, read-verb + trailing verb, and verb + field suffix are not actions
  for (const n of ["price_drop", "suggest_move", "evaluate_move", "status_update", "auto_update", "reset_at", "update_by", "delete_id"])
    assert.equal(isMutatingName(n), false, n);
  assert.equal(isMutatingName("delete_by_id"), true);
  assert.ok(ids(core([{ name: "deleteUser", description: "d", inputSchema: { type: "object", additionalProperties: false } }])).includes("tool/destructive-needs-annotation"));
});

test("no-params-shape: properties:{} without additionalProperties:false is flagged; with it, not", () => {
  const t = (s) => ({ name: "ping", description: "d", inputSchema: s });
  assert.ok(ids(core([t({ type: "object", properties: {} })])).includes("tool/no-params-shape"));
  assert.ok(!ids(core([t({ type: "object", properties: {}, additionalProperties: false })])).includes("tool/no-params-shape"));
  assert.ok(!ids(core([t({ type: "object", properties: { a: { type: "string", description: "a" } } })])).includes("tool/no-params-shape"));
});

test("no-params-shape: map-style tools (additionalProperties schema / patternProperties) are exempt", () => {
  const t = (s) => ({ name: "set_labels", description: "d", inputSchema: s, annotations: { destructiveHint: false } });
  assert.ok(!ids(core([t({ type: "object", additionalProperties: { type: "string" } })])).includes("tool/no-params-shape"));
  assert.ok(!ids(core([t({ type: "object", properties: {}, patternProperties: { "^x-": { type: "string" } } })])).includes("tool/no-params-shape"));
});

// --- rule claims now implemented ---------------------------------------------------

const syntheticProfile = (extra) => ({ id: "test-consumer", kind: "synthetic", verified: false, ...extra });
const pschema = (schema, p, mode = "default") => {
  const f = [];
  checkProviderSchema("t", schema, p, mode, collectInto(f));
  return f;
};

test("provider: allowsRecursion:false flags $ref '#' and $defs cycles, not acyclic refs", () => {
  const p = syntheticProfile({ inputSchema: { allowsRefs: true, allowsRecursion: false } });
  const selfRef = { type: "object", properties: { child: { $ref: "#" } } };
  const cycle = {
    type: "object",
    properties: { n: { $ref: "#/$defs/node" } },
    $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
  };
  const acyclic = { type: "object", properties: { n: { $ref: "#/$defs/leaf" } }, $defs: { leaf: { type: "string" } } };
  assert.deepEqual(ids(pschema(selfRef, p)), ["provider/schema-no-refs"]);
  assert.deepEqual(ids(pschema(cycle, p)), ["provider/schema-no-refs"]);
  assert.deepEqual(pschema(acyclic, p), []);
  // allowsRecursion:true (or unset) -> inert
  assert.deepEqual(pschema(cycle, syntheticProfile({ inputSchema: { allowsRefs: true } })), []);
});

test("provider: strict.maxProperties counts properties across nested objects", () => {
  const props = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }]));
  const schema = { type: "object", properties: { ...props(60), nested: { type: "object", properties: props(50) } } };
  const p = syntheticProfile({ strict: { maxProperties: 100 } });
  assert.deepEqual(ids(pschema(schema, p, "strict")), ["provider/schema-max-properties"]);
  assert.deepEqual(pschema(schema, p, "default"), []); // strict-only cap
  assert.deepEqual(ids(pschema(schema, syntheticProfile({ inputSchema: { maxProperties: 100 } }))), ["provider/schema-max-properties"]);
});

test("provider: supportedStringFormats — strict mode accepts listed formats, rejects others", () => {
  const a = profile("anthropic");
  const fmt = (f) => ({ type: "object", properties: { x: { type: "string", format: f } }, additionalProperties: false });
  assert.deepEqual(pschema(fmt("email"), a, "strict"), []);
  const bad = pschema(fmt("credit-card"), a, "strict");
  assert.deepEqual(ids(bad), ["provider/schema-unsupported-keyword"]);
  assert.match(bad[0].message, /credit-card/);
  // default mode unchanged: format is an unenforced hint
  assert.deepEqual(ids(pschema(fmt("email"), a)), ["provider/schema-unenforced-keyword"]);
});

test("provider: caseSensitive:false flags names that differ only by case", () => {
  const t = (name) => ({ name, description: "d", inputSchema: { type: "object" } });
  const p = syntheticProfile({ toolName: { caseSensitive: false } });
  assert.deepEqual(ids(provider([t("Search"), t("search"), t("other")], [p])), ["provider/name-case-collision"]);
  assert.deepEqual(provider([t("Search"), t("search")], [syntheticProfile({ toolName: { caseSensitive: true } })]), []);
});

test("annotations-consistency: readOnly + idempotentHint:false flags; readOnly + idempotentHint:true does not", () => {
  const t = (a) => ({ name: "get_x", description: "d", inputSchema: { type: "object", additionalProperties: false }, annotations: a });
  assert.ok(ids(core([t({ readOnlyHint: true, idempotentHint: false })])).includes("tool/annotations-consistency"));
  assert.ok(!ids(core([t({ readOnlyHint: true, idempotentHint: true })])).includes("tool/annotations-consistency"));
  assert.ok(!ids(core([t({ readOnlyHint: false, idempotentHint: false })])).includes("tool/annotations-consistency"));
});

test("client-config: 32+ hex under a secret-named key is flagged; hashes under other keys are not", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  assert.equal(looksHexSecret("API_KEY", hex), true);
  assert.equal(looksHexSecret("Authorization", `Bearer ${hex}`), true);
  assert.equal(looksHexSecret("COMMIT_SHA", hex + "01234567"), false);
  assert.equal(looksHexSecret("API_KEY", "0123abcd"), false); // too short
  const f = [];
  runClientConfigRules({ mcpServers: { s: { command: "node", env: { API_KEY: hex, GIT_SHA: hex }, } } }, collectInto(f));
  assert.deepEqual(f.filter((x) => x.id === "client-config/no-hardcoded-secrets").map((x) => x.tool), ["s.env.API_KEY"]);
});

test("rules.json: provider/schema-max-properties is warn-tier (profile limits pending re-verification)", () => {
  const r = JSON.parse(readFileSync(join(ROOT, "rules.json"), "utf8")).rules.find((x) => x.id === "provider/schema-max-properties");
  assert.equal(r.tier, "warn");
});

test("rules.json: every rule id these tests emit is catalogued; dead client-config/valid-json is gone", () => {
  for (const id of ["tool/input-schema-unchecked", "provider/schema-max-properties", "provider/name-case-collision"])
    assert.ok(ruleIds.has(id), id);
  assert.ok(!ruleIds.has("client-config/valid-json"));
});
