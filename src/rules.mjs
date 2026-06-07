// Rule implementations for mcplint.
//
// Core rules are provider-agnostic (pure MCP-spec / JSON-Schema correctness).
// provider/* rules are a single PARAMETERIZED family: they read whatever
// profile(s) the run targets. No vendor is referenced by name in here.
//
// Each rule calls emit(ruleId, toolNameOrNull, message, profileIdOrNull).
// Severity is resolved by the caller from rules.json + config overrides.

import { checkProviderSchema } from "./schema.mjs";

const MUTATING =
  /^(delete|remove|drop|destroy|cancel|purge|reset|revoke|send|place|create|update|set|write|edit|move|rename)[_-]/i;

// --- core (agnostic) -------------------------------------------------------
export function runCoreRules(tools, emit) {
  const seen = new Set();
  tools.forEach((t, i) => {
    const where = t && typeof t === "object" ? (t.name ?? `#${i}`) : `#${i}`;
    if (!t || typeof t !== "object") {
      emit("tool/name-required", where, "Tool entry is not an object.");
      return;
    }

    if (!t.name || typeof t.name !== "string") {
      emit("tool/name-required", where, "Tool `name` must be a non-empty string.");
    } else {
      if (!/^[A-Za-z0-9_.-]+$/.test(t.name))
        emit("tool/name-charset", t.name, "Name should use only A-Z a-z 0-9 _ - . (MCP spec).");
      if (t.name.length > 128)
        emit("tool/name-length", t.name, `Name is ${t.name.length} chars; MCP recommends <= 128.`);
      if (seen.has(t.name))
        emit("tool/name-unique", t.name, "Duplicate tool name within the server.");
      seen.add(t.name);
    }

    if (!t.description || !String(t.description).trim())
      emit("tool/description-present", where, "No description; agents select tools from descriptions.");

    const s = t.inputSchema;
    if (s === undefined || s === null) {
      emit("tool/input-schema-required", where, "`inputSchema` is required and must not be null.");
    } else if (typeof s !== "object" || Array.isArray(s)) {
      emit("tool/input-schema-required", where, "`inputSchema` must be a JSON Schema object.");
    } else {
      if (s.type !== "object")
        emit("tool/input-schema-root-object", where,
          `inputSchema root type must be "object" (got ${JSON.stringify(s.type)}).`);
      if (Array.isArray(s.required) && s.properties && typeof s.properties === "object") {
        for (const r of s.required)
          if (!(r in s.properties))
            emit("tool/required-references-properties", where,
              `required lists "${r}" but it is not in properties.`);
      }
    }

    if (typeof t.name === "string" && MUTATING.test(t.name)) {
      const a = t.annotations;
      const ok = a && (typeof a.destructiveHint === "boolean" || a.readOnlyHint === true);
      if (!ok)
        emit("tool/destructive-needs-annotation", t.name,
          "Mutating-verb tool lacks annotations (destructiveHint defaults to TRUE).");
    }
  });
}

// --- provider (parameterized by profile) -----------------------------------
export function runProviderRules(tools, profiles, emit, mode = "default") {
  for (const p of profiles) {
    const tn = p.toolName ?? {};
    const td = p.toolDescription ?? {};
    const re = tn.pattern ? new RegExp(tn.pattern) : null;

    for (const t of tools) {
      if (!t || typeof t.name !== "string") continue;
      if (re && !re.test(t.name))
        emit("provider/name-pattern", t.name, `name fails ${p.id} pattern ${tn.pattern}`, p.id);
      if (tn.maxLength && t.name.length > tn.maxLength)
        emit("provider/name-length", t.name, `name is ${t.name.length} chars; ${p.id} max is ${tn.maxLength}`, p.id);
      if (td.maxLength && typeof t.description === "string" && t.description.length > td.maxLength)
        emit("provider/description-length", t.name,
          `description is ${t.description.length} chars; ${p.id} max is ${td.maxLength}`, p.id);
    }

    for (const t of tools) {
      if (t && typeof t === "object" && t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema))
        checkProviderSchema(typeof t.name === "string" ? t.name : null, t.inputSchema, p, mode, emit);
    }

    if (p.tools && p.tools.maxCount && tools.length > p.tools.maxCount)
      emit("provider/tool-count", null, `${tools.length} tools exceed ${p.id} max of ${p.tools.maxCount}`, p.id);
  }
}
