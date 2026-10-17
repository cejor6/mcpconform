// Artifact-type detection by JSON shape (no filesystem access).

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// "server" followed later on the same line by "schema", case-insensitive —
// exactly /server.*schema/i (whose `.` stops at \n, \r, U+2028, U+2029), but
// linear: the regex is quadratic on a long "serverserver..." value.
export function isServerSchemaUri(s) {
  if (typeof s !== "string") return false;
  return s
    .toLowerCase()
    .split(/[\n\r\u2028\u2029]/)
    .some((line) => {
      const i = line.indexOf("server");
      return i >= 0 && line.includes("schema", i + 6);
    });
}

// VS Code keeps MCP servers under "mcp" in settings.json: {"mcp": {"servers": {...}}}.
export const vscodeMcpBlock = (doc) =>
  isObj(doc) && !doc.mcpServers && !doc.servers && isObj(doc.mcp) && doc.mcp.servers ? doc.mcp : null;

// Returns "tools" | "server-json" | "client-config", or null when the shape
// matches no known artifact (the CLI reports that; it never guesses "tools").
export function detectType(doc) {
  if (Array.isArray(doc)) return "tools";
  if (!isObj(doc)) return null;
  if (doc.mcpServers || doc.servers || vscodeMcpBlock(doc)) return "client-config";
  if (doc.packages || doc.remotes || isServerSchemaUri(doc.$schema)) return "server-json";
  if (Object.hasOwn(doc, "tools")) return "tools";
  return null;
}

// Near-miss top-level keys ("mcpServer", "MCP_SERVERS", "tool") -> the key meant.
const KEY_FIXES = {
  mcpservers: "mcpServers", mcpserver: "mcpServers", servers: "servers", server: "servers",
  tools: "tools", tool: "tools", packages: "packages", package: "packages", remotes: "remotes", remote: "remotes",
};

/** A one-line, actionable reason an object was not recognized. */
export function unrecognizedHint(doc) {
  if (!isObj(doc)) return null;
  for (const k of Object.keys(doc)) {
    const want = KEY_FIXES[k.toLowerCase().replace(/[^a-z]/g, "")];
    if (want && want !== k) return `Found "${k}" — did you mean "${want}"?`;
  }
  if (isObj(doc.mcp))
    return 'Found an "mcp" block without "servers"; VS Code settings keep MCP servers under "mcp": {"servers": {...}}.';
  if (typeof doc.name === "string" && doc.name.includes("/") && (Object.hasOwn(doc, "version") || Object.hasOwn(doc, "description")))
    return "Looks like a server.json with no packages[], remotes[] or $schema: the registry requires at least one of " +
      "packages[]/remotes[] (add one, plus the registry $schema), or pass --type server-json to lint it as is.";
  return null;
}
