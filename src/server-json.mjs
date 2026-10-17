// Rules for the MCP registry manifest (server.json). Pure data-in/findings-out;
// the optional sibling-manifest version cross-check is passed in via opts so this
// module stays free of filesystem access (the CLI reads the sibling file).

import { isSecretName } from "./secrets.mjs";
import { show } from "./text.mjs";

const REGISTRY_TYPES = ["npm", "pypi", "cargo", "nuget", "oci", "mcpb"];
const TRANSPORT_TYPES = ["stdio", "streamable-http", "sse"];
const REMOTE_TYPES = ["streamable-http", "sse"];
const SEMVER = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
const REVDNS = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\/[A-Za-z0-9._-]+$/;

export function runServerJsonRules(doc, emit, opts = {}) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;

  if (typeof doc.name !== "string" || !REVDNS.test(doc.name))
    emit("server-json/name-reverse-dns", null,
      `name "${show(doc.name ?? "")}" should be reverse-DNS, e.g. io.github.you/server.`);

  if (typeof doc.version !== "string" || !SEMVER.test(doc.version))
    emit("server-json/version-semver", null, `version "${show(doc.version ?? "")}" should be semver (e.g. 1.2.0).`);

  const pkgs = Array.isArray(doc.packages) ? doc.packages : [];
  const remotes = Array.isArray(doc.remotes) ? doc.remotes : [];
  if (!pkgs.length && !remotes.length)
    emit("server-json/packages-or-remotes", null, "At least one of packages[] or remotes[] is required.");

  pkgs.forEach((p, i) => {
    const at = `packages[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      emit("server-json/packages-or-remotes", at, `${at} must be an object.`);
      return;
    }
    if (!REGISTRY_TYPES.includes(p.registryType))
      emit("server-json/registry-type-enum", at,
        `registryType "${show(p.registryType)}" must be one of ${REGISTRY_TYPES.join("|")}.`);
    if (p.registryType === "mcpb" && !p.fileSha256)
      emit("server-json/mcpb-sha", at, "fileSha256 is required for mcpb packages.");

    const tr = p.transport || {};
    if (tr.type && !TRANSPORT_TYPES.includes(tr.type))
      emit("server-json/transport-type-enum", at,
        `transport.type "${show(tr.type)}" must be one of ${TRANSPORT_TYPES.join("|")}.`);
    if ((tr.type === "streamable-http" || tr.type === "sse") && !tr.url)
      emit("server-json/transport-url", at, `transport.url is required for ${show(tr.type)}.`);
    if (typeof tr.url === "string" && /^http:\/\//i.test(tr.url))
      emit("server-json/url-https", at, "transport.url should use https.");

    if (p.version && doc.version && p.version !== doc.version)
      emit("server-json/version-matches-package", at,
        `package version ${show(p.version)} != root version ${show(doc.version)}.`);

    for (const key of ["packageArguments", "runtimeArguments"])
      if (Array.isArray(p[key]))
        p[key].forEach((a, j) => {
          if (a && a.type === "named" && !a.name)
            emit("server-json/arg-named-requires-name", `${at}.${key}[${j}]`, "named argument requires a `name`.");
        });

    if (Array.isArray(p.environmentVariables))
      p.environmentVariables.forEach((e) => {
        if (e && typeof e.name === "string" && isSecretName(e.name) && e.isSecret !== true)
          emit("server-json/env-secret-flag", `${at}.env.${e.name}`, "Secret-looking env var should set isSecret:true.");
      });
  });

  remotes.forEach((r, i) => {
    const at = `remotes[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      emit("server-json/packages-or-remotes", at, `${at} must be an object.`);
      return;
    }
    if (!REMOTE_TYPES.includes(r.type))
      emit("server-json/transport-type-enum", at, `remote type "${show(r.type)}" must be one of ${REMOTE_TYPES.join("|")}.`);
    if (!r.url) emit("server-json/transport-url", at, "remote url is required.");
    if (typeof r.url === "string" && /^http:\/\//i.test(r.url))
      emit("server-json/url-https", at, "remote url should use https.");
  });

  if (opts.packageVersion && doc.version && opts.packageVersion !== doc.version)
    emit("server-json/version-matches-package", null,
      `root version ${show(doc.version)} != sibling package manifest version ${opts.packageVersion}.`);
}
