import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runCoreRules, runProviderRules } from "../src/rules.mjs";
import { validateInputSchema, checkProviderSchema } from "../src/schema.mjs";

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
