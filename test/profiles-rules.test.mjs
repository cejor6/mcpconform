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
import { runCoreRules, runProviderRules } from "../src/rules.mjs";
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
