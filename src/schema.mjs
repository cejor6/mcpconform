// Schema-aware rules backed by ajv (the one dependency). Two jobs:
//   1. validateInputSchema() — is the tool's inputSchema itself a VALID JSON Schema?
//      This is the part you don't hand-roll; ajv implements the whole spec.
//   2. checkProviderSchema() — does the schema fit a targeted profile's JSON-Schema
//      SUBSET (supported/unsupported keywords, strict additionalProperties / all-required,
//      nesting depth, $ref/anyOf)? This walk is necessarily custom — ajv validates
//      schemas, it cannot tell you "Gemini does not accept anyOf".

import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const firstLine = (s) => String(s || "").split("\n")[0].slice(0, 200);

// $schema dialects ajv (as installed) can validate, keyed by the canonical
// meta-schema URI each one registers. The match is lenient on http/https and a
// trailing "#", since both spellings appear in the wild. draft-04/03 need a
// separate package (ajv-draft-04) we deliberately don't depend on; those, and
// any custom meta-schema URI, are reported as "unchecked", never as invalid.
const KNOWN_DIALECT = /^https?:\/\/json-schema\.org\/(draft\/2020-12|draft\/2019-09|draft-07|draft-06|draft-04|draft-03)\/schema#?$/i;
const DIALECTS = {
  "draft/2020-12": { uri: "https://json-schema.org/draft/2020-12/schema", engine: "2020" },
  "draft/2019-09": { uri: "https://json-schema.org/draft/2019-09/schema", engine: "2019" },
  "draft-07": { uri: "http://json-schema.org/draft-07/schema#", engine: "07" },
  "draft-06": { uri: "http://json-schema.org/draft-06/schema#", engine: "07" }, // ajv's draft-07 class + the draft-06 meta-schema
};

// One ajv instance per engine, created lazily and reused for every tool: a new
// Ajv + addFormats per tool made a 2000-tool server take ~30s. Compiled schemas
// are removed again after each compile (see compileOnce) so the cache doesn't
// grow with the tool count and one tool's $id can't collide with another's.
const engines = new Map();
function engine(kind) {
  let ajv = engines.get(kind);
  if (!ajv) {
    const opts = { strict: false, validateFormats: false, allErrors: false };
    ajv = kind === "2020" ? new Ajv2020(opts) : kind === "2019" ? new Ajv2019(opts) : new Ajv(opts);
    if (kind === "07") ajv.addMetaSchema(require("ajv/dist/refs/json-schema-draft-06.json"));
    addFormats(ajv);
    engines.set(kind, ajv);
  }
  return ajv;
}

// Compile, then drop everything the compile registered (the root schema's cache
// entry plus any root/nested $id refs), leaving the shared instance as it was.
function compileOnce(kind, schema) {
  const ajv = engine(kind);
  const before = { schemas: new Set(Object.keys(ajv.schemas)), refs: new Set(Object.keys(ajv.refs)) };
  try {
    ajv.compile(schema);
  } finally {
    ajv.removeSchema(schema);
    for (const k of Object.keys(ajv.schemas)) if (!before.schemas.has(k)) delete ajv.schemas[k];
    for (const k of Object.keys(ajv.refs)) if (!before.refs.has(k)) delete ajv.refs[k];
  }
}

// Returns { ok: true } | { ok: false, error } | { ok: true, unchecked: reason }.
// `unchecked` means validity could not be determined (unsupported dialect, or a
// schema too deep to compile) — distinct from invalid, so it is never an error.
export function validateInputSchema(schema) {
  let kind = "2020";
  let target = schema;
  const declared = schema && typeof schema === "object" ? schema.$schema : undefined;
  if (typeof declared === "string" && declared !== "") {
    const m = declared.match(KNOWN_DIALECT);
    const d = m && DIALECTS[m[1].toLowerCase()];
    if (!d)
      return {
        ok: true,
        unchecked: m
          ? `declares ${m[1]} ($schema "${declared}"), which mcpconform cannot validate; use draft 2020-12 (the MCP default) or draft-07`
          : `declares an unrecognized $schema "${declared}"; validity not checked`,
      };
    kind = d.engine;
    if (declared !== d.uri) target = { ...schema, $schema: d.uri };
  }
  try {
    compileOnce(kind, target);
    return { ok: true };
  } catch (e) {
    if (e instanceof RangeError) {
      engines.delete(kind); // don't reuse an instance a stack overflow interrupted mid-compile
      return { ok: true, unchecked: "is nested too deeply to validate (stack overflow while compiling)" };
    }
    return { ok: false, error: e.message };
  }
}

// Core rules: tool/input-schema-valid, tool/input-schema-unchecked
export function runSchemaValidity(tools, emit) {
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const s = t.inputSchema;
    if (!s || typeof s !== "object" || Array.isArray(s)) continue; // tool/input-schema-required covers this
    const { ok, error, unchecked } = validateInputSchema(s);
    if (!ok)
      emit("tool/input-schema-valid", t.name ?? null, `inputSchema is not a valid JSON Schema: ${firstLine(error)}`);
    else if (unchecked)
      emit("tool/input-schema-unchecked", t.name ?? null, `inputSchema ${unchecked}.`);
  }
}

// Collect every subschema with its object-nesting depth (root = 0), in pre-order.
// Iterative (explicit stack), so a deeply nested schema cannot overflow the call stack.
function collect(root, rootDepth, acc) {
  const stack = [[root, rootDepth]];
  while (stack.length) {
    const [schema, depth] = stack.pop();
    if (!schema || typeof schema !== "object") continue;
    acc.push({ schema, depth });
    const kids = [];
    const into = (s, d) => kids.push([s, d]);
    if (schema.properties && typeof schema.properties === "object")
      for (const k of Object.keys(schema.properties)) into(schema.properties[k], depth + 1);
    if (Array.isArray(schema.items)) schema.items.forEach((s) => into(s, depth + 1));
    else if (schema.items) into(schema.items, depth + 1);
    if (Array.isArray(schema.prefixItems)) schema.prefixItems.forEach((s) => into(s, depth + 1));
    if (schema.additionalProperties && typeof schema.additionalProperties === "object")
      into(schema.additionalProperties, depth + 1);
    for (const c of ["anyOf", "oneOf", "allOf"])
      if (Array.isArray(schema[c])) schema[c].forEach((s) => into(s, depth)); // combinators: same nesting level
    for (const d of ["$defs", "definitions"])
      if (schema[d] && typeof schema[d] === "object")
        for (const k of Object.keys(schema[d])) into(schema[d][k], depth + 1);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]); // reversed: pop in original order
  }
  return acc;
}

const META_OK = new Set(["$schema", "$id"]);

// Provider subset checks for one tool's inputSchema against one profile.
// A pathologically deep schema can overflow the recursive walk; report it as
// unchecked (a warning) for this profile instead of crashing the whole run.
export function checkProviderSchema(toolName, schema, profile, mode, emit) {
  try {
    checkProviderSchemaUnguarded(toolName, schema, profile, mode, emit);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    emit("tool/input-schema-unchecked", toolName,
      `inputSchema is nested too deeply to check against ${profile.id} (stack overflow while walking it).`, profile.id);
  }
}

function checkProviderSchemaUnguarded(toolName, schema, profile, mode, emit) {
  if (!schema || typeof schema !== "object") return;
  const is = profile.inputSchema || {};
  const sp = profile.strict || {};
  const strict = mode === "strict";
  const pid = profile.id;

  const subs = collect(schema, 0, []);
  const keywords = new Set();
  for (const { schema: s } of subs) for (const k of Object.keys(s)) keywords.add(k);

  // One verdict per keyword (deduplicated):
  //   - hard-unsupported (denylist, or an allowlist miss that isn't merely cosmetic) -> error
  //   - accepted-but-no-effect (declared ignored, or an unenforced constraint)        -> info
  //     (promoted to error only under a strict mode that rejects unenforced keywords)
  const supported = is.supportedKeywords ? new Set(is.supportedKeywords) : null;
  const denied = new Set(is.unsupportedKeywords || []);
  const ignored = new Set(is.ignoredKeywords || []);
  const unenforced = new Set(is.unenforcedKeywords || []);

  // supportedStringFormats: the `format` values the consumer honors under strict
  // mode. A strict mode that rejects unenforced keywords still accepts `format`
  // when its value is one of these; any other value is rejected.
  const formats = Array.isArray(is.supportedStringFormats) ? new Set(is.supportedStringFormats) : null;
  const strictRejects = strict && sp.rejectsUnenforcedKeywords;

  for (const kw of keywords) {
    if (META_OK.has(kw)) continue;
    const allowlistMiss = !!supported && !supported.has(kw);
    const cosmetic = ignored.has(kw) || unenforced.has(kw);

    if (denied.has(kw) || (allowlistMiss && !cosmetic)) {
      emit("provider/schema-unsupported-keyword", toolName, `inputSchema uses "${kw}" which ${pid} does not support`, pid);
    } else if (kw === "format" && formats && strictRejects) {
      const bad = new Set(subs.map((x) => x.schema.format).filter((v) => typeof v === "string" && !formats.has(v)));
      for (const v of bad)
        emit("provider/schema-unsupported-keyword", toolName,
          `inputSchema uses format "${v}" which ${pid} rejects in strict mode (supported: ${[...formats].join(", ")})`, pid);
    } else if (cosmetic) {
      if (strict && sp.rejectsUnenforcedKeywords && unenforced.has(kw))
        emit("provider/schema-unsupported-keyword", toolName, `inputSchema uses "${kw}" which ${pid} rejects in strict mode`, pid);
      else emit("provider/schema-unenforced-keyword", toolName, `"${kw}" is accepted but has no effect on ${pid}`, pid);
    }
  }

  // Structural forbids ($ref/anyOf) — only for profiles WITHOUT an allowlist.
  // With an allowlist the keyword loop already covers these; running both double-reports.
  if (!supported) {
    if (is.allowsRefs === false && keywords.has("$ref"))
      emit("provider/schema-no-refs", toolName, `${pid} does not support $ref; inline the definition`, pid);
    if (is.allowsAnyOf === false && keywords.has("anyOf"))
      emit("provider/schema-no-refs", toolName, `${pid} does not support anyOf`, pid);
    // Recursion is only reachable through $ref, so it's checked only when $ref
    // itself is allowed (otherwise the $ref finding above already covers it).
    if (is.allowsRecursion === false && is.allowsRefs !== false && isRecursive(schema, subs))
      emit("provider/schema-no-refs", toolName, `${pid} does not support recursive schemas; bound the nesting explicitly`, pid);
  }

  // strict-mode structural requirements
  if (strict) {
    if (sp.requiresAdditionalPropertiesFalse)
      for (const { schema: s } of subs)
        if (s.type === "object" && s.properties && s.additionalProperties !== false)
          emit("provider/schema-additional-properties", toolName, `${pid} strict mode requires additionalProperties:false on every object`, pid);
    if (sp.requiresAllPropertiesRequired)
      for (const { schema: s } of subs)
        if (s.type === "object" && s.properties) {
          const req = new Set(Array.isArray(s.required) ? s.required : []);
          const missing = Object.keys(s.properties).filter((k) => !req.has(k));
          if (missing.length)
            emit("provider/schema-all-required", toolName, `${pid} strict mode requires every property in required; missing: ${missing.join(", ")}`, pid);
        }
  }

  // max nesting depth
  const maxDepth = (strict && sp.maxNestingDepth) || is.maxNestingDepth;
  if (maxDepth) {
    const deepest = subs.reduce((m, x) => Math.max(m, x.depth), 0);
    if (deepest > maxDepth)
      emit("provider/schema-max-depth", toolName, `inputSchema nests ${deepest} deep; ${pid} max is ${maxDepth}`, pid);
  }

  // max total object properties (summed over every object in the schema)
  const maxProps = (strict && sp.maxProperties) || is.maxProperties;
  if (maxProps) {
    let total = 0;
    for (const { schema: s } of subs)
      if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) total += Object.keys(s.properties).length;
    if (total > maxProps)
      emit("provider/schema-max-properties", toolName, `inputSchema declares ${total} object properties in total; ${pid} max is ${maxProps}`, pid);
  }
}

// True when the schema can recurse: a $ref to the root ("#"), a
// $recursiveRef/$dynamicRef, or a cycle among the root's $defs/definitions.
// Best-effort over local refs only; external refs are not resolved.
function isRecursive(root, subs) {
  for (const { schema: s } of subs)
    if (s.$ref === "#" || s.$recursiveRef !== undefined || s.$dynamicRef !== undefined) return true;
  const defs = new Map();
  for (const d of ["$defs", "definitions"])
    if (root[d] && typeof root[d] === "object" && !Array.isArray(root[d]))
      for (const [k, v] of Object.entries(root[d])) defs.set(`${d}/${k}`, v);
  if (!defs.size) return false;
  const target = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
    let key;
    try {
      key = decodeURIComponent(ref.slice(2)).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return null;
    }
    return defs.has(key) ? key : null;
  };
  const edges = new Map();
  for (const [k, v] of defs)
    edges.set(k, collect(v, 0, []).map((x) => target(x.schema.$ref)).filter(Boolean));
  const state = new Map(); // 1 = on the DFS stack, 2 = done
  const cyclic = (k) => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const n of edges.get(k)) if (cyclic(n)) return true;
    state.set(k, 2);
    return false;
  };
  for (const k of defs.keys()) if (cyclic(k)) return true;
  return false;
}
