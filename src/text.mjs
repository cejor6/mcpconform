// Safe text for messages built from artifact values. A JSON value can be an
// object whose `toString` is not callable (`{"toString": 1}`), and String() or
// `${...}` on it throws; JSON.stringify never calls toString. Strings pass through.
export function show(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? typeof v;
  } catch {
    return Array.isArray(v) ? "[array]" : `[${typeof v}]`; // e.g. too deep to serialize
  }
}
