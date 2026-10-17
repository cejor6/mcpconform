#!/usr/bin/env node
// mcpconform — provider- and language-agnostic static linter for MCP setup.
// Phase-1 engine: dependency-free. Lints a tools/list dump (or bare array) of
// MCP Tool objects against the core spec rules + targeted provider profiles.
// (server.json / client-config linters and ajv-backed schema rules land next.)

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runCoreRules, runProviderRules } from "./rules.mjs";
import { runSchemaValidity } from "./schema.mjs";
import { runServerJsonRules } from "./server-json.mjs";
import { runClientConfigRules } from "./client-config.mjs";
import { inspectStdio } from "./inspect.mjs";
import { loadAllProfiles, portableProfileIds } from "./profiles.mjs";
import { renderHuman, renderSarif, escapeControl } from "./report.mjs";

// Exit codes: 0 = clean, 1 = error-tier findings, 2 = usage error or internal
// failure (bad flag/config, server failed to start, a crash while linting).
// Anything that escapes the handling below is an internal error, never a
// "findings" exit 1 that CI could mistake for a normal lint failure.
const crash = (e) => {
  const text = String(e?.stack ?? e).split("\n").map(escapeControl).join("\n");
  console.error(`mcpconform: internal error: ${text}`);
  process.exit(2);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Strip a UTF-8 BOM (common from Windows editors) — JSON.parse rejects it.
const readText = (p) => readFileSync(p, "utf8").replace(/^\uFEFF/, "");
const loadJSON = (p) => JSON.parse(readText(p));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const q = (v) => escapeControl(JSON.stringify(v) ?? String(v));

function usageError(msg) {
  console.error(`mcpconform: ${msg}`);
  console.error("Run `mcpconform --help` for usage.");
  process.exit(2);
}

// Comma lists tolerate spaces: "a, b" -> ["a", "b"].
const splitList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const BOOL_FLAGS = { "--expand": "expand", "--portable": "portable", "--help": "help", "-h": "help", "--version": "version", "-v": "version" };
const VALUE_FLAGS = {
  "--target": "target", "--format": "format", "--mode": "mode", "--min-severity": "minSeverity",
  "--min-tools": "minTools", "--type": "type", "--out": "out", "--env-file": "envFile",
  "--env": "envKv", "--dump": "dump", "--config": "config",
};

// Every value flag accepts both `--flag value` and `--flag=value`. Unknown flags
// and value flags with no value are usage errors (exit 2) rather than silently
// ignored — a typo'd flag must never turn into a quiet "No findings".
function parseArgs(argv) {
  const out = { _: [], rest: [], target: [], format: "human", portable: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a === "-" || !a.startsWith("-")) { out._.push(a); continue; }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (Object.hasOwn(BOOL_FLAGS, flag)) {
      if (eq > 0) usageError(`option ${flag} does not take a value`);
      out[BOOL_FLAGS[flag]] = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, flag)) {
      const hint = out._[0] === "inspect" ? " (put the server command after `--`)" : "";
      usageError(`unknown option ${q(flag)}${hint}`);
    }
    let v;
    if (eq > 0) v = a.slice(eq + 1);
    else {
      v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) usageError(`option ${flag} requires a value`);
      i++;
    }
    const key = VALUE_FLAGS[flag];
    if (key === "target") out.target = splitList(v);
    else if (key === "envKv") (out.envKv ||= []).push(v);
    else out[key] = v;
  }
  return out;
}

function checkEnum(label, value, allowed) {
  if (!allowed.includes(value)) usageError(`${label} must be ${allowed.join("|")} (got ${q(value)})`);
}

// "server" followed (anywhere later) by "schema", case-insensitive. Equivalent
// to /server.*schema/i, which is quadratic on a long "serverserver..." $schema.
function isServerSchemaUri(s) {
  if (typeof s !== "string") return false;
  const l = s.toLowerCase();
  const i = l.indexOf("server");
  return i >= 0 && l.includes("schema", i + 6);
}

// Returns null when the shape matches no known artifact; the caller reports
// that as meta/unrecognized-artifact instead of guessing "tools" (which used
// to lint 0 tools and pass a typo'd or empty file clean).
function detectType(doc) {
  if (Array.isArray(doc)) return "tools";
  if (!isObj(doc)) return null;
  if (doc.mcpServers || doc.servers) return "client-config";
  if (doc.packages || doc.remotes || isServerSchemaUri(doc.$schema)) return "server-json";
  if (Object.hasOwn(doc, "tools")) return "tools";
  return null;
}

function parseEnvFile(p) {
  const env = {};
  if (!p || !existsSync(p)) return env;
  for (const raw of readText(p).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, eq).trim().replace(/^export\s+/, "")] = v;
  }
  return env;
}

function siblingPackageVersion(filePath) {
  const dir = dirname(filePath);
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      return loadJSON(pkg).version || null;
    } catch {
      /* ignore */
    }
  }
  const py = join(dir, "pyproject.toml");
  if (existsSync(py)) {
    const m = readText(py).match(/^[ \t]*version\s*=\s*["']([^"']+)["']/m);
    if (m) return m[1];
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const pkg = loadJSON(join(ROOT, "package.json"));

const HELP = `mcpconform ${pkg.version} - static linter for MCP tool defs, server.json, and client config

USAGE
  mcpconform <file...> [options]              lint files (type auto-detected by shape)
  mcpconform inspect [options] -- <cmd...>    start a live MCP server and lint its tools/list

OPTIONS
  --target <a,b>     provider profiles to check against (e.g. anthropic,openai); empty = MCP-spec only
  --portable         check against every verified profile (incl. the synthetic
                     strictest-common-denominator one); unverified stubs are skipped
  --mode <m>         default | strict (applies each profile's strict{} rules)
  --type <t>         force artifact type: tools | server-json | client-config
  --format <f>       human (default) | sarif
  --min-severity <s> report only findings at or above this tier: error | warn | info
                     (display filter; exit code is unaffected. default: info = all)
  --expand           list every finding; by default an info finding repeated on 3+
                     tools (framework-injected noise) is collapsed to one line
  --out <file>       write the report to a file instead of stdout
  --config <file>    config file (default: ./mcpconform.config.json)
  --env-file <.env>  (inspect) load env vars for the spawned server
  --env KEY=VAL      (inspect) set an env var for the spawned server (repeatable)
  --min-tools <n>    (inspect) fail (exit 2) if the live server surfaces fewer than n tools
  --dump <file>      (inspect) also write the captured tools/list to a file
  -h, --help         show this help
  -v, --version      print version

  Value options also accept --opt=value. Unknown options are an error.

EXIT CODES
  0  no error-tier findings
  1  error-tier findings (including unparseable / unrecognized artifacts)
  2  usage error (bad option, config, or target) or internal failure

EXAMPLES
  mcpconform server.json .mcp.json
  mcpconform tools.json --target anthropic,openai
  mcpconform inspect --env-file .env -- python server.py`;

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.help || (!args._.length && !args.rest.length)) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}
checkEnum("--format", args.format, ["human", "sarif"]);
if (args.type !== undefined) checkEnum("--type", args.type, ["tools", "server-json", "client-config"]);

const ruleMeta = Object.fromEntries(loadJSON(join(ROOT, "rules.json")).rules.map((r) => [r.id, r]));

// A config that is named but missing, unparseable, or of the wrong shape is a
// usage error (exit 2): silently ignoring it would drop every override in it.
let config = {};
const cfgPath = args.config ? resolve(args.config) : join(process.cwd(), "mcpconform.config.json");
if (args.config && !existsSync(cfgPath)) usageError(`config file not found: ${q(args.config)}`);
if (existsSync(cfgPath)) {
  try {
    config = loadJSON(cfgPath);
  } catch (e) {
    usageError(`cannot parse config ${q(cfgPath)}: ${escapeControl(e.message)}`);
  }
  if (!isObj(config)) usageError(`config ${q(cfgPath)} must be a JSON object`);
}

// Per-rule severity overrides. An invalid value ("ERROR", "high") used to
// silently drop the rule from both the report and the exit code; reject it.
const SEVERITIES = ["error", "warn", "info", "off"];
const sevOverrides = config.rules ?? {};
if (!isObj(sevOverrides)) usageError("config `rules` must be an object of rule id -> error|warn|info|off");
for (const [id, v] of Object.entries(sevOverrides))
  if (!SEVERITIES.includes(v)) usageError(`config rules[${q(id)}] must be ${SEVERITIES.join("|")} (got ${q(v)})`);

let configTargets = config.targets ?? [];
if (!Array.isArray(configTargets) || configTargets.some((t) => typeof t !== "string"))
  usageError("config `targets` must be an array of profile ids");
configTargets = configTargets.map((t) => t.trim()).filter(Boolean);

// Every profile (shipped + config.profilesDir) is schema-validated at load; an
// invalid one is a usage error (exit 2), never a silent skip.
let allProfiles;
try {
  const profilesDir = config.profilesDir ? resolve(dirname(cfgPath), config.profilesDir) : null;
  if (profilesDir && !existsSync(profilesDir))
    console.error(`mcpconform: warning: profilesDir ${profilesDir} does not exist; using shipped profiles only`);
  const loaded = loadAllProfiles(profilesDir && existsSync(profilesDir) ? profilesDir : null);
  allProfiles = loaded.profiles;
  for (const w of loaded.warnings) console.error(`mcpconform: warning: ${w}`);
} catch (e) {
  if (e.name !== "ProfileError") throw e;
  console.error(`mcpconform: ${e.message}`);
  process.exit(2);
}

let targetIds = args.target.length ? args.target : configTargets;
// --portable: every verified profile, including the synthetic
// strictest-common-denominator one; unverified stubs are excluded.
if (args.portable || config.portable) targetIds = portableProfileIds(allProfiles);
// Own-property lookups only: "constructor" / "toString" are not profiles. An
// unknown or typo'd target is a usage error, not a warning line that SARIF
// consumers never see.
const missing = targetIds.filter((id) => !Object.hasOwn(allProfiles, id));
if (missing.length)
  usageError(`unknown target profile(s): ${missing.map(q).join(", ")} (known: ${Object.keys(allProfiles).sort().join(", ")})`);
const activeProfiles = targetIds.map((id) => allProfiles[id]);

const severityFor = (id) =>
  (Object.hasOwn(sevOverrides, id) && sevOverrides[id]) || (Object.hasOwn(ruleMeta, id) && ruleMeta[id].tier) || "warn";
const mode = args.mode ?? config.mode ?? "default";
checkEnum(args.mode !== undefined ? "--mode" : "config `mode`", mode, ["default", "strict"]);

// Reporting floor: drop findings below the requested tier from the output.
// This NEVER changes the exit code — error-tier findings are rank 0, so they
// clear every floor and always survive the filter; exit stays "1 iff an
// error-tier finding exists". CLI flag wins over config.minSeverity; default
// "info" keeps every finding. An empty value (flag passed with no argument)
// is "" and fails the enum check below, rather than silently no-opping.
const TIER_RANK = { error: 0, warn: 1, info: 2 };
const minSeverity = args.minSeverity !== undefined ? args.minSeverity : config.minSeverity ?? "info";
if (typeof minSeverity !== "string" || !Object.hasOwn(TIER_RANK, minSeverity)) {
  console.error(`mcpconform: --min-severity must be error|warn|info (got ${q(minSeverity)})`);
  process.exit(2);
}
const atOrAboveFloor = (f) => TIER_RANK[f.tier] <= TIER_RANK[minSeverity];

// inspect-only floor on the live tool count: a server that boots but registers
// zero (or too few) tools would otherwise lint nothing and pass green. CLI flag
// wins over config.minTools; default 0 disables the guard. "" (flag passed with
// no argument) is rejected — Number("") is 0, which would silently disable it.
const minToolsRaw = args.minTools !== undefined ? args.minTools : config.minTools;
let minTools = 0;
if (minToolsRaw !== undefined && minToolsRaw !== null) {
  minTools = minToolsRaw === "" ? NaN : Number(minToolsRaw);
  if (!Number.isInteger(minTools) || minTools < 0) {
    console.error(`mcpconform: --min-tools must be a non-negative integer (got "${minToolsRaw}")`);
    process.exit(2);
  }
}

const expand = args.expand || config.expand || false;

// Collapse repeated framework-injected noise. Some info rules fire identically on
// every tool when a framework stamps the same thing on all of them - e.g.
// tool/meta-namespacing on FastMCP's non-reverse-DNS `_meta` key, or
// provider/schema-unenforced-keyword on a codebase that puts minimum/maximum on
// every tool. There, N identical lines are pure noise: when such a finding
// (grouped by file + rule + identical message) repeats on AGG_MIN+ tools within
// one artifact, report it once with a count.
//
// Which rules collapse is OPT-IN per rule (`aggregate: true` in rules.json), NOT
// inferred from the message - most info rules (no-params-shape, title-redundant,
// property-descriptions, ...) are per-tool actionable and must stay itemized with
// their tool names. The message is still part of the group key so different causes
// (different `_meta` keys / keywords) stay separate. Display-only: the exit code is
// computed before this runs. Vendor-agnostic: the opt-in lives in data, never a
// name in the engine. toolCounts maps an artifact to its tool count, only to say
// "all N tools" vs "N tools". One order-preserving pass: the collapsed line takes
// the slot of the first occurrence; later ones are dropped.
const AGG_MIN = 3;
function aggregate(findings, toolCounts) {
  const aggregatable = (f) => ruleMeta[f.id]?.aggregate && f.tool != null;
  const keyOf = (f) => JSON.stringify([f.file, f.id, f.message]);
  const sizes = new Map();
  for (const f of findings) {
    if (!aggregatable(f)) continue;
    const k = keyOf(f);
    sizes.set(k, (sizes.get(k) || 0) + 1);
  }
  const done = new Set();
  const out = [];
  for (const f of findings) {
    const n = aggregatable(f) ? sizes.get(keyOf(f)) : 0;
    if (n < AGG_MIN) { out.push(f); continue; } // itemize: not aggregatable, or below threshold
    const k = keyOf(f);
    if (done.has(k)) continue; // a later occurrence of an already-collapsed group
    done.add(k);
    const everyTool = toolCounts[f.file] != null && n === toolCounts[f.file];
    out.push({ ...f, tool: null, message: f.message + (everyTool ? ` (on all ${n} tools)` : ` (on ${n} tools)`) });
  }
  return out;
}

// Single place that applies the reporting floor + aggregation, writes/prints,
// and returns the exit code (1 iff an error-tier finding survived). Shared by the
// inspect path and the file-lint path so render + exit logic lives in one spot.
// The exit code is taken from the floored-but-unaggregated set, so neither the
// floor nor aggregation (both display-only) can ever change it.
function emitReport(findings, meta, toolCounts = {}) {
  const shown = findings.filter(atOrAboveFloor);
  const reported = expand ? shown : aggregate(shown, toolCounts);
  const output = args.format === "sarif" ? renderSarif(reported, ruleMeta, meta) : renderHuman(reported, ruleMeta, meta);
  if (args.out) writeFileSync(resolve(args.out), output + "\n");
  else console.log(output);
  // A crash while linting an artifact is reported as a meta/internal-error
  // finding (so the other artifacts still get linted) but exits 2, not 1.
  if (findings.some((f) => f.id === "meta/internal-error")) return 2;
  return shown.some((f) => f.tier === "error") ? 1 : 0;
}

// process.exit() right after console.log() drops whatever stdout has not yet
// flushed when it is a pipe, truncating large reports (at 64KB on Linux). Exit
// from the callback of a final write instead, which runs once stdout drains.
function exitAfterFlush(code) {
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}
// The reader went away (`mcpconform ... | head`): not an internal error.
process.stdout.on("error", (e) => (e.code === "EPIPE" ? process.exit(process.exitCode ?? 0) : crash(e)));

const internalError = (file, e) => ({
  id: "meta/internal-error", tier: "error", tool: null, profile: null, file,
  message: `mcpconform crashed while linting this artifact: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`,
});

// Lint one tools array (static dump or live tools/list) against core + profiles.
function lintTools(tools, emit, findings) {
  runCoreRules(tools, emit);
  runSchemaValidity(tools, emit);
  if (activeProfiles.length) runProviderRules(tools, activeProfiles, emit, mode);
  for (const p of activeProfiles)
    if (p.verified === false && findings.some((f) => f.profile === p.id))
      emit("meta/profile-unverified", null,
        `Findings used profile "${p.id}" (verified:false) — confirm its numbers against the vendor docs.`, p.id);
}
const targetNote = () => (targetIds.length ? `targets: ${targetIds.join(", ")}` : "no provider target");

if (args._[0] === "inspect") {
  const cmd = args.rest.length ? args.rest : args._.slice(1);
  if (!cmd.length) {
    console.error("usage: mcpconform inspect [--target a,b] -- <command> [args...]");
    process.exit(2);
  }
  if (args.envFile && !existsSync(args.envFile)) usageError(`--env-file not found: ${q(args.envFile)}`);
  const env = { ...parseEnvFile(args.envFile) };
  for (const kv of args.envKv || []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) usageError(`--env expects KEY=VAL (got ${q(kv)})`);
    env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  let tools;
  try {
    tools = await inspectStdio(cmd[0], cmd.slice(1), { env });
  } catch (e) {
    // The message can carry server-supplied text (a JSON-RPC error.message).
    console.error(`mcpconform inspect: ${escapeControl(e?.message ?? e)}`);
    console.error(
      "hint: if the server needs env vars to start, pass --env-file <.env> or --env KEY=VAL " +
        "(tool listing rarely hits the network, so placeholder values are usually enough), " +
        "or lint a static tools/list dump / server.json instead."
    );
    process.exit(2);
  }
  if (args.dump) writeFileSync(resolve(args.dump), JSON.stringify({ tools }, null, 2) + "\n");
  if (tools.length < minTools) {
    console.error(
      `mcpconform inspect: server surfaced ${tools.length} tool(s); --min-tools requires at least ${minTools}. ` +
        "The server booted but registered too few tools — likely a broken tool import or registration."
    );
    process.exit(2);
  }
  // Label the run by the command's basename only. The full command line often
  // carries secrets (`--api-key=sk-live-...`) and would otherwise be echoed into
  // the report and the SARIF artifact uri. Sanitized to a relative-path-ish uri.
  let base = cmd[0].split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || /^\.+$/.test(base)) base = "server";
  const label = `inspect/${base}`;
  const nArgs = cmd.length - 1;
  const argNote = nArgs ? ` (+${nArgs} arg${nArgs === 1 ? "" : "s"})` : "";
  let findings = [];
  const emit = (id, tool, message, profile = null) => {
    const tier = severityFor(id);
    if (tier === "off") return;
    findings.push({ id, tier, tool: tool ?? null, message, profile, file: label });
  };
  try {
    lintTools(tools, emit, findings);
  } catch (e) {
    findings = [internalError(label, e)];
  }
  const meta = { summaries: [`${label}${argNote}  [tools]  (${tools.length} tools, ${targetNote()})`], targets: targetIds, version: pkg.version };
  exitAfterFlush(emitReport(findings, meta, { [label]: tools.length }));
}

const UNRECOGNIZED =
  'Cannot determine the artifact type. Expected a tools/list result ({"tools": [...]}) or a bare array of Tool objects, ' +
  "a server.json (packages / remotes / registry $schema), or a client config (mcpServers / servers). Pass --type to force one.";
const typeName = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function lintOne(fileArg) {
  const findings = [];
  const emit = (id, tool, message, profile = null) => {
    const tier = severityFor(id);
    if (tier === "off") return;
    findings.push({ id, tier, tool: tool ?? null, message, profile, file: fileArg });
  };

  const apath = resolve(fileArg);
  let artifact;
  try {
    artifact = loadJSON(apath);
  } catch (e) {
    findings.push({ id: "meta/parse-error", tier: "error", tool: null, message: `Cannot parse JSON: ${e.message}`, profile: null, file: fileArg });
    return { findings, summary: `${fileArg}  [parse-error]` };
  }

  // --type forces the artifact type; it still has to be the right JSON shape.
  const type = args.type || detectType(artifact);
  if (type === "tools") {
    const tools = Array.isArray(artifact) ? artifact : isObj(artifact) ? artifact.tools : undefined;
    if (!Array.isArray(tools)) {
      const why = isObj(artifact) && Object.hasOwn(artifact, "tools")
        ? `\`tools\` must be an array of Tool objects (got ${typeName(artifact.tools)}).`
        : `Expected a tools/list result ({"tools": [...]}) or a bare array of Tool objects (got ${typeName(artifact)}).`;
      emit("meta/unrecognized-artifact", null, why);
      return { findings, summary: `${fileArg}  [tools]  (no tools array)` };
    }
    if (!tools.length) emit("meta/unrecognized-artifact", null, "The tools artifact contains zero tools, so nothing was linted.");
    lintTools(tools, emit, findings);
    return { findings, summary: `${fileArg}  [tools]  (${tools.length} tools, ${targetNote()})`, toolCount: tools.length };
  }
  if ((type === "server-json" || type === "client-config") && !isObj(artifact)) {
    emit("meta/unrecognized-artifact", null, `A ${type} artifact must be a JSON object (got ${typeName(artifact)}).`);
    return { findings, summary: `${fileArg}  [${type === "server-json" ? "server.json" : type}]` };
  }
  if (type === "server-json") {
    runServerJsonRules(artifact, emit, { packageVersion: siblingPackageVersion(apath) });
    const count = (k) => (Array.isArray(artifact[k]) ? artifact[k].length : 0);
    return { findings, summary: `${fileArg}  [server.json]  (${count("packages")} package(s), ${count("remotes")} remote(s))` };
  }
  if (type === "client-config") {
    runClientConfigRules(artifact, emit);
    const servers = artifact.mcpServers || artifact.servers;
    const n = servers && typeof servers === "object" ? Object.keys(servers).length : 0;
    return { findings, summary: `${fileArg}  [client-config]  (${n} server(s))` };
  }
  emit("meta/unrecognized-artifact", null, UNRECOGNIZED);
  return { findings, summary: `${fileArg}  [unknown]` };
}

function lintFiles() {
  // Files after `--` are files too (`--` only ends option parsing).
  const files = [...args._, ...args.rest];
  const allFindings = [];
  const summaries = [];
  const toolCounts = Object.create(null);
  for (const fileArg of files) {
    // One bad artifact must not abort the rest: a crash becomes a finding.
    let res;
    try {
      res = lintOne(fileArg);
    } catch (e) {
      res = { findings: [internalError(fileArg, e)], summary: `${fileArg}  [internal-error]` };
    }
    for (const f of res.findings) allFindings.push(f); // no spread: 100k+ findings overflow it
    summaries.push(res.summary);
    if (res.toolCount != null) toolCounts[fileArg] = res.toolCount;
  }
  const meta = { summaries, targets: targetIds, version: pkg.version };
  return emitReport(allFindings, meta, toolCounts);
}

if (args._[0] !== "inspect") exitAfterFlush(lintFiles());
