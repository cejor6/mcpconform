#!/usr/bin/env node
// mcpconform — provider- and language-agnostic static linter for MCP setup.
// Phase-1 engine: dependency-free. Lints a tools/list dump (or bare array) of
// MCP Tool objects against the core spec rules + targeted provider profiles.
// (server.json / client-config linters and ajv-backed schema rules land next.)

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runCoreRules, runProviderRules } from "./rules.mjs";
import { runSchemaValidity } from "./schema.mjs";
import { runServerJsonRules } from "./server-json.mjs";
import { runClientConfigRules } from "./client-config.mjs";
import { inspectStdio } from "./inspect.mjs";
import { renderHuman, renderSarif } from "./report.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loadJSON = (p) => JSON.parse(readFileSync(p, "utf8"));

function parseArgs(argv) {
  const out = { _: [], rest: [], target: [], format: "human", mode: "default", portable: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    else if (a === "--target") out.target = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--min-severity") out.minSeverity = argv[++i] ?? "";
    else if (a === "--min-tools") out.minTools = argv[++i] ?? "";
    else if (a === "--expand") out.expand = true;
    else if (a === "--portable") out.portable = true;
    else if (a === "--type") out.type = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--env-file") out.envFile = argv[++i];
    else if (a === "--env") (out.envKv = out.envKv || []).push(argv[++i]);
    else if (a === "--dump") out.dump = argv[++i];
    else if (a === "--config") out.config = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (!a.startsWith("--")) out._.push(a);
  }
  return out;
}

function loadProfiles(dir) {
  const out = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "profile.schema.json") continue;
    try {
      const p = loadJSON(join(dir, f));
      if (p.id) out[p.id] = p;
    } catch {
      /* skip malformed profile */
    }
  }
  return out;
}

function detectType(doc) {
  if (Array.isArray(doc)) return "tools";
  if (doc && (doc.mcpServers || doc.servers)) return "client-config";
  if (doc && (doc.packages || doc.remotes || (typeof doc.$schema === "string" && /server.*schema/i.test(doc.$schema))))
    return "server-json";
  return "tools";
}

function parseEnvFile(p) {
  const env = {};
  if (!p || !existsSync(p)) return env;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
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
    const m = readFileSync(py, "utf8").match(/^\s*version\s*=\s*["']([^"']+)["']/m);
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
  --portable         check against every shipped provider profile
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

const ruleMeta = Object.fromEntries(loadJSON(join(ROOT, "rules.json")).rules.map((r) => [r.id, r]));

let config = {};
const cfgPath = args.config ? resolve(args.config) : join(process.cwd(), "mcpconform.config.json");
if (existsSync(cfgPath)) {
  try {
    config = loadJSON(cfgPath);
  } catch {
    /* ignore bad config */
  }
}
const sevOverrides = config.rules || {};

const allProfiles = loadProfiles(join(ROOT, "profiles"));
if (config.profilesDir) {
  const dir = resolve(dirname(cfgPath), config.profilesDir);
  if (existsSync(dir)) Object.assign(allProfiles, loadProfiles(dir));
}

let targetIds = args.target.length ? args.target : config.targets || [];
if (args.portable || config.portable)
  targetIds = Object.values(allProfiles)
    .filter((p) => p.kind !== "spec-baseline" && p.kind !== "synthetic")
    .map((p) => p.id);
const missing = targetIds.filter((id) => !allProfiles[id]);
const activeProfiles = targetIds.map((id) => allProfiles[id]).filter(Boolean);

const severityFor = (id) => sevOverrides[id] || ruleMeta[id]?.tier || "warn";
const mode = args.mode || config.mode || "default";

// Reporting floor: drop findings below the requested tier from the output.
// This NEVER changes the exit code — error-tier findings are rank 0, so they
// clear every floor and always survive the filter; exit stays "1 iff an
// error-tier finding exists". CLI flag wins over config.minSeverity; default
// "info" keeps every finding. An empty value (flag passed with no argument)
// is "" and fails the enum check below, rather than silently no-opping.
const TIER_RANK = { error: 0, warn: 1, info: 2 };
const minSeverity = args.minSeverity !== undefined ? args.minSeverity : config.minSeverity ?? "info";
if (!(minSeverity in TIER_RANK)) {
  console.error(`mcpconform: --min-severity must be error|warn|info (got "${minSeverity}")`);
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
  return shown.some((f) => f.tier === "error") ? 1 : 0;
}

if (args._[0] === "inspect") {
  const cmd = args.rest.length ? args.rest : args._.slice(1);
  if (!cmd.length) {
    console.error("usage: mcpconform inspect [--target a,b] -- <command> [args...]");
    process.exit(2);
  }
  const env = { ...parseEnvFile(args.envFile) };
  for (const kv of args.envKv || []) {
    const eq = kv.indexOf("=");
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  let tools;
  try {
    tools = await inspectStdio(cmd[0], cmd.slice(1), { env });
  } catch (e) {
    console.error(`mcpconform inspect: ${e.message}`);
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
  const label = `inspect:${cmd.join(" ")}`;
  const findings = [];
  const emit = (id, tool, message, profile = null) => {
    const tier = severityFor(id);
    if (tier === "off") return;
    findings.push({ id, tier, tool: tool ?? null, message, profile, file: label });
  };
  runCoreRules(tools, emit);
  runSchemaValidity(tools, emit);
  if (activeProfiles.length) runProviderRules(tools, activeProfiles, emit, mode);
  for (const p of activeProfiles)
    if (p.verified === false && findings.some((f) => f.profile === p.id))
      emit("meta/profile-unverified", null,
        `Findings used profile "${p.id}" (verified:false) — confirm its numbers against the vendor docs.`, p.id);
  const tgt = targetIds.length ? `targets: ${targetIds.join(", ")}` : "no provider target";
  const meta = { summaries: [`${label}  [tools]  (${tools.length} tools, ${tgt})`], targets: targetIds, missing };
  process.exit(emitReport(findings, meta, { [label]: tools.length }));
}

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

  const type = args.type || detectType(artifact);
  if (type === "tools") {
    const tools = Array.isArray(artifact) ? artifact : artifact.tools || [];
    runCoreRules(tools, emit);
    runSchemaValidity(tools, emit);
    if (activeProfiles.length) runProviderRules(tools, activeProfiles, emit, mode);
    for (const p of activeProfiles)
      if (p.verified === false && findings.some((f) => f.profile === p.id))
        emit("meta/profile-unverified", null,
          `Findings used profile "${p.id}" (verified:false) — confirm its numbers against the vendor docs.`, p.id);
    const tgt = targetIds.length ? `targets: ${targetIds.join(", ")}` : "no provider target";
    return { findings, summary: `${fileArg}  [tools]  (${tools.length} tools, ${tgt})`, toolCount: tools.length };
  }
  if (type === "server-json") {
    runServerJsonRules(artifact, emit, { packageVersion: siblingPackageVersion(apath) });
    return { findings, summary: `${fileArg}  [server.json]  (${(artifact.packages || []).length} package(s), ${(artifact.remotes || []).length} remote(s))` };
  }
  if (type === "client-config") {
    runClientConfigRules(artifact, emit);
    const n = Object.keys(artifact.mcpServers || artifact.servers || {}).length;
    return { findings, summary: `${fileArg}  [client-config]  (${n} server(s))` };
  }
  return { findings, summary: `${fileArg}  [unknown]` };
}

const allFindings = [];
const summaries = [];
const toolCounts = {};
for (const fileArg of args._) {
  const { findings, summary, toolCount } = lintOne(fileArg);
  allFindings.push(...findings);
  summaries.push(summary);
  if (toolCount != null) toolCounts[fileArg] = toolCount;
}

const meta = { summaries, targets: targetIds, missing };
process.exit(emitReport(allFindings, meta, toolCounts));
