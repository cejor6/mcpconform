// Rules for client config files (.mcp.json / claude_desktop_config.json / mcpServers).
// No MCP spec governs this shape, so these encode the cross-client conventions.

const SECRET = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];
const looksSecret = (v) => typeof v === "string" && SECRET.some((re) => re.test(v));

// Union of server-entry keys recognized across the major clients (Claude
// Desktop, Claude Code .mcp.json, VS Code, Cursor, Cline/Roo). Keys outside
// this set in a server entry are almost always typos (`arg`, `enviroment`).
// We only check inside server entries — never top-level, since a file like
// claude_desktop_config.json carries unrelated app keys at the root.
const KNOWN_SERVER_KEYS = new Set([
  "command", "args", "env", "envFile", "cwd", // stdio
  "type", "url", "headers", // remote (http/sse)
  "timeout", "disabled", "autoApprove", "alwaysAllow", "transportType", // client extras
]);

// True when a string carries a malformed ${...} interpolation: an unterminated
// `${`, an empty `${}`, or an invalid variable name. Well-formed `${NAME}` and
// `${NAME:-default}` are left alone (they may resolve from the host env, which
// we can't see statically).
const VAR_REF = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::[-+?][^}]*)?\}/g;
const hasMalformedRef = (v) => typeof v === "string" && v.replace(VAR_REF, "").includes("${");

export function runClientConfigRules(doc, emit) {
  const servers = (doc && (doc.mcpServers || doc.servers)) || null;
  if (!servers || typeof servers !== "object") {
    emit("client-config/one-transport", null, "No `mcpServers` (or `servers`) object found.");
    return;
  }

  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") {
      emit("client-config/one-transport", name, "Server entry must be an object.");
      continue;
    }

    const hasCmd = typeof cfg.command === "string" && cfg.command.length > 0;
    const hasUrl = typeof cfg.url === "string" && cfg.url.length > 0;
    const httpType = cfg.type === "http" || cfg.type === "sse" || cfg.type === "streamable-http";

    if (hasCmd && hasUrl)
      emit("client-config/one-transport", name, "Has both `command` (stdio) and `url` (http) — use exactly one.");
    else if (!hasCmd && !hasUrl)
      emit("client-config/one-transport", name, "Needs a transport: `command` (stdio) or `url` (http/sse).");

    if ((httpType || (!hasCmd && cfg.url !== undefined)) && !hasUrl)
      emit("client-config/http-url-required", name, "http/sse server entry needs a `url`.");

    if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string")))
      emit("client-config/args-array", name, "`args` must be an array of strings.");

    for (const key of Object.keys(cfg))
      if (!KNOWN_SERVER_KEYS.has(key))
        emit("client-config/known-keys", `${name}.${key}`, `unknown server-entry key "${key}" — typo? (recognized: ${[...KNOWN_SERVER_KEYS].join(", ")})`);

    const refStrings = [cfg.command, cfg.url, ...(Array.isArray(cfg.args) ? cfg.args : [])]
      .concat(cfg.env && typeof cfg.env === "object" ? Object.values(cfg.env) : [])
      .concat(cfg.headers && typeof cfg.headers === "object" ? Object.values(cfg.headers) : []);
    if (refStrings.some(hasMalformedRef))
      emit("client-config/env-refs-declared", name, "malformed ${...} variable interpolation (empty, unterminated, or invalid name).");

    if (cfg.env && typeof cfg.env === "object")
      for (const [k, v] of Object.entries(cfg.env)) {
        if (typeof v !== "string")
          emit("client-config/env-values-strings", `${name}.env.${k}`, `env value must be a string (got ${typeof v}).`);
        if (looksSecret(v))
          emit("client-config/no-hardcoded-secrets", `${name}.env.${k}`, "Looks like a hardcoded secret; reference an env var instead.");
      }

    if (cfg.headers && typeof cfg.headers === "object")
      for (const [k, v] of Object.entries(cfg.headers))
        if (looksSecret(v))
          emit("client-config/no-hardcoded-secrets", `${name}.headers.${k}`, "Looks like a hardcoded secret in headers; use an env var reference.");

    if (hasUrl && /^http:\/\//i.test(cfg.url))
      emit("client-config/url-https", name, "Remote server url should use https.");
  }
}
