// Output formatters: human-readable (default) and SARIF 2.1.0 (for GitHub code scanning).

const ORDER = { error: 0, warn: 1, info: 2 };
const LABEL = { error: "ERROR", warn: "WARN ", info: "INFO " };

export function renderHuman(findings, ruleMeta, meta) {
  const lines = [];
  for (const s of meta.summaries || []) lines.push(`mcpconform  ${s}`);
  if (meta.missing?.length) lines.push(`  ! unknown target profile(s) ignored: ${meta.missing.join(", ")}`);
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
    const prof = f.profile ? ` <${f.profile}>` : "";
    const ftag = multi && f.file ? ` ${f.file}` : "";
    const loc = f.tool ? ` [${f.tool}]` : "";
    lines.push(`  ${LABEL[f.tier]} ${f.id}${prof}${ftag}${loc}`);
    lines.push(`        ${f.message}`);
  }

  const c = findings.reduce((m, f) => ((m[f.tier] = (m[f.tier] || 0) + 1), m), {});
  lines.push("");
  lines.push(`  ${c.error || 0} error, ${c.warn || 0} warn, ${c.info || 0} info`);
  return lines.join("\n");
}

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
              version: "0.1.0",
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
        },
      ],
    },
    null,
    2
  );
}
