// Split an identifier into lowercase words on _ - . (any non-alphanumeric) and
// camelCase / acronym boundaries: "deleteUser" -> [delete, user],
// "HTTPDelete" -> [http, delete], "MAX_TOKENS" -> [max, tokens].
export const nameWords = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
