// Schema-aware rules backed by ajv (the one dependency). Two jobs:
//   1. validateInputSchema() — is the tool's inputSchema itself a VALID JSON Schema?
//      This is the part you don't hand-roll; ajv implements the whole spec.
//   2. checkProviderSchema() — does the schema fit a targeted profile's JSON-Schema
//      SUBSET (supported/unsupported keywords, strict additionalProperties / all-required,
//      nesting depth, $ref/anyOf)? This walk is necessarily custom — ajv validates
//      schemas, it cannot tell you "Gemini does not accept anyOf".

import Ajv2020 from "ajv/dist/2020.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const firstLine = (s) => String(s || "").split("\n")[0].slice(0, 200);

function ajvFor(schema) {
  const is2020 = !schema || !schema.$schema || /2020-12/.test(schema.$schema);
  const ajv = is2020
    ? new Ajv2020({ strict: false, validateFormats: false, allErrors: false })
    : new Ajv({ strict: false, validateFormats: false, allErrors: false });
  addFormats(ajv);
  return ajv;
}

export function validateInputSchema(schema) {
  try {
    ajvFor(schema).compile(schema);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Core rule: tool/input-schema-valid
export function runSchemaValidity(tools, emit) {
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const s = t.inputSchema;
    if (!s || typeof s !== "object" || Array.isArray(s)) continue; // tool/input-schema-required covers this
    const { ok, error } = validateInputSchema(s);
    if (!ok)
      emit("tool/input-schema-valid", t.name ?? null, `inputSchema is not a valid JSON Schema: ${firstLine(error)}`);
  }
}

// Collect every subschema with its object-nesting depth (root = 0).
function collect(schema, depth, acc) {
  if (!schema || typeof schema !== "object") return acc;
  acc.push({ schema, depth });
  const into = (s, d) => collect(s, d, acc);
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
  return acc;
}

const META_OK = new Set(["$schema", "$id"]);

// Provider subset checks for one tool's inputSchema against one profile.
export function checkProviderSchema(toolName, schema, profile, mode, emit) {
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

  for (const kw of keywords) {
    if (META_OK.has(kw)) continue;
    const allowlistMiss = !!supported && !supported.has(kw);
    const cosmetic = ignored.has(kw) || unenforced.has(kw);

    if (denied.has(kw) || (allowlistMiss && !cosmetic)) {
      emit("provider/schema-unsupported-keyword", toolName, `inputSchema uses "${kw}" which ${pid} does not support`, pid);
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
}
