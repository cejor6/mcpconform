// Secret-name heuristics shared by the server.json and client-config rules.
//
// Names are split into words on _ - . and camelCase boundaries. A name looks
// secret when a word
//   - IS a secret word (TOKEN, SECRET, PASSWORD, AUTH, PAT, ...), or
//   - ENDS with one, for run-together names (ACCESSTOKEN, CLIENTSECRET,
//     APIKEY, PRIVATEKEY), or
//   - is KEY qualified by a secret-ish word (API_KEY, PRIVATE_KEY,
//     SIGNING_KEY, ...). A bare KEY is too often a data key (SORT_KEY).
// Whole-word matching keeps AUTHOR, KEYBOARD, MONKEY and the plural count
// TOKENS (MAX_TOKENS) out. A name is cleared by a quantity/limit word (MAX,
// LIMIT, COUNT, ...), a data-key word (PARTITION, SORT, CACHE, PRIMARY,
// PUBLISHABLE, ...), or a final word that names/locates a secret rather than
// holding it (_ID, _PATH, _FILE, ...).

import { nameWords } from "./names.mjs";

const SECRET_WORDS = new Set([
  "token", "secret", "password", "passwd", "passphrase", "pwd", "credential", "credentials", "pem",
  "auth", "authorization", "pat", "apikey", "privatekey", "secretkey", "accesskey",
]);
// Run-together forms: a word ending in one of these (ACCESSTOKEN, CLIENTSECRET).
const SECRET_ENDINGS = ["token", "secret", "password", "passwd", "apikey", "privatekey", "secretkey", "accesskey"];
const ENDING_EXCEPTIONS = new Set(["nonsecret", "nopassword"]);
// KEY is a secret only next to one of these.
const KEY_QUALIFIERS = new Set([
  "api", "private", "secret", "access", "signing", "auth", "client", "encryption", "master", "hmac",
  "ssh", "service", "session", "webhook", "app", "license", "account", "jwt", "gpg", "pgp",
]);
// Anywhere in the name: a size/limit/count, a public half, or a data key.
const NON_SECRET_WORDS = new Set([
  "max", "min", "limit", "limits", "count", "length", "len", "size", "ttl", "timeout", "expiry",
  "expires", "expiration", "public", "publishable", "partition", "sort", "cache", "primary",
  "routing", "idempotency", "foreign",
]);
// As the final word: an identifier/path/flag that names or locates a secret.
const NON_SECRET_LAST = new Set([
  "id", "path", "name", "user", "username", "enabled", "url", "uri", "host", "port", "region", "env",
  "file", "dir", "type", "mode", "method", "scheme", "header", "prefix", "column",
]);

const isSecretWord = (x) =>
  SECRET_WORDS.has(x) || (!ENDING_EXCEPTIONS.has(x) && SECRET_ENDINGS.some((e) => x.length > e.length && x.endsWith(e)));

/** True when an env-var / header name looks like it holds a secret value. */
export function isSecretName(name) {
  const w = nameWords(name);
  if (!w.length) return false;
  if (w.some((x) => NON_SECRET_WORDS.has(x)) || NON_SECRET_LAST.has(w[w.length - 1])) return false;
  return w.some((x) => isSecretWord(x)) || (w.includes("key") && w.some((x) => KEY_QUALIFIERS.has(x)));
}

// A long run of hex is only treated as a secret when the NAME also looks
// secret-ish — a bare hex value is as likely a commit SHA, digest, or id.
// The value must be entirely hex (optionally behind a Bearer/token scheme).
const LONG_HEX = /^(?:(?:bearer|token)\s+)?[0-9a-f]{32,}$/i;
export const looksHexSecret = (name, value) => typeof value === "string" && LONG_HEX.test(value.trim()) && isSecretName(name);
