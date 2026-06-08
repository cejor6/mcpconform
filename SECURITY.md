# Security policy

mcpconform is a static linter distributed as an npm package. It reads
untrusted input (MCP tool definitions, `server.json`, client configs) and,
in `inspect` mode, spawns a user-specified MCP server. Threat model: "a
developer runs mcpconform over input they don't fully control, or installs
it from npm."

## Reporting a vulnerability

**Please do not file public issues for vulnerabilities.** Open a private
GitHub security advisory:
https://github.com/cejor6/mcpconform/security/advisories/new

Include the affected version, reproduction steps, and impact. Target
response: 7 days.

## In scope

- Crashes or unbounded resource use triggered by malicious input JSON.
- `inspect` spawning behavior (command/argument handling, env passthrough).
- Supply-chain risk in the published package (malicious dependency or build
  artifact).

## Out of scope

- Vulnerabilities in upstream dependencies — report upstream; we'll bump.
- The behavior of whatever MCP server you point `inspect` at.

## Notes

- `inspect` runs the server command you give it — treat it like any "run
  this binary" tool; don't point it at untrusted commands.
- The linter does no network I/O of its own; `inspect` only performs the
  local stdio MCP handshake with the process it spawns.
