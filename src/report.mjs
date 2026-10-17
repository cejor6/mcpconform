// Output formatters: human-readable (default) and SARIF 2.1.0 (for GitHub code scanning).

import { show } from "./text.mjs";

const ORDER = { error: 0, warn: 1, info: 2 };
const LABEL = { error: "ERROR", warn: "WARN ", info: "INFO " };

// Input-derived text (tool names, server keys, file names, messages quoting the
// artifact) must not reach a terminal raw: an ESC/BEL/CR in a tool name could
// rewrite or hide report lines. Escape C0 controls (incl. ESC, BEL, CR, LF, TAB),
// DEL, C1 controls (e.g. the 8-bit CSI \u009b), and the Unicode bidi/line-
// separator controls that can visually reorder a line. Backslashes are left
// alone so Windows paths in summaries read normally.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const NAMED = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
const uEscape = (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
export const escapeControl = (s) => show(s).replace(CONTROL, (c) => NAMED[c] ?? uEscape(c));

export function renderHuman(findings, ruleMeta, meta) {
  const esc = escapeControl;
  const lines = [];
  for (const s of meta.summaries || []) lines.push(`mcpconform  ${esc(s)}`);
  lines.push("");

  if (!findings.length) {
    lines.push("  No findings.");
    return lines.join("\n");
  }

  const multi = new Set(findings.map((f) => f.file)).size > 1;
  const sorted = [...findings].sort(
    (a, b) =>
      ORDER[a.tier] - ORDER[b.tier] ||
      (a.file || "").localeCompare(b.file || "") ||
      a.id.localeCompare(b.id)
  );
  for (const f of sorted) {
    const prof = f.profile ? ` <${esc(f.profile)}>` : "";
    const ftag = multi && f.file ? ` ${esc(f.file)}` : "";
    const loc = f.tool ? ` [${esc(f.tool)}]` : "";
    lines.push(`  ${LABEL[f.tier]} ${esc(f.id)}${prof}${ftag}${loc}`);
    lines.push(`        ${esc(f.message)}`);
  }

  const c = findings.reduce((m, f) => ((m[f.tier] = (m[f.tier] || 0) + 1), m), {});
  lines.push("");
  lines.push(`  ${c.error || 0} error, ${c.warn || 0} warn, ${c.info || 0} info`);
  return lines.join("\n");
}

// JSON.stringify already escapes C0 controls (ESC -> \u001b) but emits DEL, C1
// and bidi controls raw. They can only occur inside string literals, so
// re-escaping them as \uXXXX is lossless: the parsed SARIF is identical.
const JSON_UNSAFE = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function renderSarif(findings, ruleMeta, meta) {
  const level = (t) => (t === "error" ? "error" : t === "warn" ? "warning" : "note");
  const ids = [...new Set(findings.map((f) => f.id))];
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "mcpconform",
              version: meta.version || "0.0.0",
              informationUri: "https://github.com/cejor6/mcpconform",
              rules: ids.map((id) => ({
                id,
                shortDescription: { text: ruleMeta[id]?.message ?? id },
              })),
            },
          },
          results: findings.map((f) => ({
            ruleId: f.id,
            level: level(f.tier),
            message: {
              text:
                (f.profile ? `[${f.profile}] ` : "") +
                (f.tool ? `${f.tool}: ` : "") +
                f.message,
            },
            locations: [
              { physicalLocation: { artifactLocation: { uri: f.file ?? "input" } } },
            ],
          })),
          // Run context the human report prints in its header: which provider
          // profiles were checked and a one-line summary per linted artifact.
          properties: { targets: meta.targets || [], summaries: meta.summaries || [] },
        },
      ],
    },
    null,
    2
  ).replace(JSON_UNSAFE, uEscape);
}
