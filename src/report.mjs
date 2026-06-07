// Output formatters: human-readable (default) and SARIF 2.1.0 (for GitHub code scanning).

const ORDER = { error: 0, warn: 1, info: 2 };
const LABEL = { error: "ERROR", warn: "WARN ", info: "INFO " };

export function renderHuman(findings, ruleMeta, meta) {
  const lines = [];
  const tgt = meta.targets.length ? `targets: ${meta.targets.join(", ")}` : "no provider target";
  lines.push(`mcplint  ${meta.file}  (${meta.toolCount} tools, ${tgt})`);
  if (meta.missing?.length) lines.push(`  ! unknown target profile(s) ignored: ${meta.missing.join(", ")}`);
  lines.push("");

  if (!findings.length) {
    lines.push("  No findings.");
    return lines.join("\n");
  }

  const sorted = [...findings].sort(
    (a, b) => ORDER[a.tier] - ORDER[b.tier] || a.id.localeCompare(b.id)
  );
  for (const f of sorted) {
    const prof = f.profile ? ` <${f.profile}>` : "";
    const loc = f.tool ? ` [${f.tool}]` : "";
    lines.push(`  ${LABEL[f.tier]} ${f.id}${prof}${loc}`);
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
              name: "mcplint",
              version: "0.1.0",
              informationUri: "https://github.com/cejor6/mcplint",
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
              { physicalLocation: { artifactLocation: { uri: meta.file } } },
            ],
          })),
        },
      ],
    },
    null,
    2
  );
}
