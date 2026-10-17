// Secret-name heuristics shared by the server.json and client-config rules.
//
// Names are split into words on _ - . and camelCase boundaries, and a secret
// word must be a WHOLE word: AUTHOR is not AUTH, KEYBOARD is not KEY, and the
// plural TOKENS (MAX_TOKENS) is a count, not a credential. Words that make the
// name describe a quantity/limit or a pointer to a secret (MAX, LIMIT, COUNT,
// _ID, _PATH, PUBLIC, ...) clear it.

import { nameWords } from "./names.mjs";

const SECRET_WORDS = new Set([
  "key", "apikey", "token", "secret", "password", "passwd", "passphrase", "pwd", "credential",
  "credentials", "pem", "auth", "authorization", "pat",
]);
// Anywhere in the name: a size/limit/count or a public half, never the secret.
const NON_SECRET_WORDS = new Set([
  "max", "min", "limit", "limits", "count", "length", "len", "size", "ttl", "timeout", "expiry",
  "expires", "expiration", "public",
]);
// As the final word: an identifier/path/flag that names or locates a secret.
const NON_SECRET_LAST = new Set([
  "id", "path", "name", "user", "username", "enabled", "url", "uri", "host", "port", "region", "env",
  "file", "dir", "type", "mode", "method", "scheme", "header", "prefix",
]);

/** True when an env-var / header name looks like it holds a secret value. */
export function isSecretName(name) {
  const w = nameWords(name);
  if (!w.length || !w.some((x) => SECRET_WORDS.has(x))) return false;
  if (w.some((x) => NON_SECRET_WORDS.has(x))) return false;
  return !NON_SECRET_LAST.has(w[w.length - 1]);
}
