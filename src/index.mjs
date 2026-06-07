#!/usr/bin/env node
// mcplint — provider- and language-agnostic static linter for MCP setup.
// Phase-1 engine: dependency-free. Lints a tools/list dump (or bare array) of
// MCP Tool objects against the core spec rules + targeted provider profiles.
// (server.json / client-config linters and ajv-backed schema rules land next.)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runCoreRules, runProviderRules } from "./rules.mjs";
import { runSchemaValidity } from "./schema.mjs";
import { renderHuman, renderSarif } from "./report.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loadJSON = (p) => JSON.parse(readFileSync(p, "utf8"));

function parseArgs(argv) {
  const out = { _: [], target: [], format: "human", mode: "default", portable: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--portable") out.portable = true;
    else if (a === "--config") out.config = argv[++i];
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

const args = parseArgs(process.argv.slice(2));
if (!args._.length) {
  console.error(
    "usage: mcplint <tools.json> [--target a,b] [--portable] [--mode strict] [--format human|sarif]"
  );
  process.exit(2);
}

const ruleMeta = Object.fromEntries(loadJSON(join(ROOT, "rules.json")).rules.map((r) => [r.id, r]));
const allProfiles = loadProfiles(join(ROOT, "profiles"));

let config = {};
const cfgPath = args.config ? resolve(args.config) : join(ROOT, "mcplint.config.json");
if (existsSync(cfgPath)) {
  try {
    config = loadJSON(cfgPath);
  } catch {
    /* ignore bad config */
  }
}
const sevOverrides = config.rules || {};

let targetIds = args.target.length ? args.target : config.targets || [];
if (args.portable || config.portable)
  targetIds = Object.values(allProfiles)
    .filter((p) => p.kind !== "spec-baseline" && p.kind !== "synthetic")
    .map((p) => p.id);
const missing = targetIds.filter((id) => !allProfiles[id]);
const activeProfiles = targetIds.map((id) => allProfiles[id]).filter(Boolean);

const artifact = loadJSON(resolve(args._[0]));
const tools = Array.isArray(artifact) ? artifact : artifact.tools || [];

const findings = [];
const severityFor = (id) => sevOverrides[id] || ruleMeta[id]?.tier || "warn";
function emit(id, tool, message, profile = null) {
  const tier = severityFor(id);
  if (tier === "off") return;
  findings.push({ id, tier, tool: tool ?? null, message, profile });
}

const mode = args.mode || config.mode || "default";
runCoreRules(tools, emit);
runSchemaValidity(tools, emit);
if (activeProfiles.length) runProviderRules(tools, activeProfiles, emit, mode);

for (const p of activeProfiles)
  if (p.verified === false && findings.some((f) => f.profile === p.id))
    emit(
      "meta/profile-unverified",
      null,
      `Findings used profile "${p.id}" (verified:false) — confirm its numbers against the vendor docs.`,
      p.id
    );

const meta = { file: args._[0], toolCount: tools.length, targets: targetIds, missing };
console.log(
  args.format === "sarif"
    ? renderSarif(findings, ruleMeta, meta)
    : renderHuman(findings, ruleMeta, meta)
);

process.exit(findings.some((f) => f.tier === "error") ? 1 : 0);
