// Profile loading + validation. Every consumer profile — shipped or from a
// user's profilesDir — is validated against profiles/profile.schema.json at
// load time, so a typo'd or malformed profile fails loudly (ProfileError,
// surfaced by the CLI as a usage error, exit 2) instead of being silently
// skipped or crashing a rule mid-run. Vendor-agnostic: nothing here knows
// any profile id.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SHIPPED_PROFILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "profiles");
const SCHEMA_FILE = "profile.schema.json";

/** Thrown for any profile that cannot be loaded or fails validation. */
export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileError";
  }
}

let validator = null;
function profileValidator() {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = ajv.compile(JSON.parse(readFileSync(join(SHIPPED_PROFILES_DIR, SCHEMA_FILE), "utf8")));
  }
  return validator;
}

/** Returns a list of human-readable problems with a parsed profile ([] = valid). */
export function validateProfile(profile) {
  const validate = profileValidator();
  const problems = [];
  if (!validate(profile))
    for (const e of validate.errors) {
      const extra = e.params?.additionalProperty ? ` ("${e.params.additionalProperty}")` : "";
      problems.push(`${e.instancePath || "/"} ${e.message}${extra}`);
    }
  // Semantics JSON Schema can't express: the name pattern must compile.
  const pat = profile?.toolName?.pattern;
  if (typeof pat === "string")
    try {
      new RegExp(pat);
    } catch (e) {
      problems.push(`/toolName/pattern is not a valid regular expression: ${e.message}`);
    }
  return problems;
}

/**
 * Load + validate every *.json profile in a directory (profile.schema.json is
 * skipped). A JSON file that isn't a profile at all (not an object, or no
 * `id` — e.g. a package.json kept alongside) is skipped with a warning pushed
 * onto `warnings`. Throws ProfileError on unparsable JSON, a schema violation
 * in anything that is a profile, or two files in one directory declaring the
 * same id. Returns { [id]: { profile, file } }.
 */
export function loadProfileDir(dir, warnings = []) {
  const out = {};
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch (e) {
    throw new ProfileError(`cannot read profiles directory ${dir}: ${e.message}`);
  }
  for (const f of entries) {
    if (!f.endsWith(".json") || f === SCHEMA_FILE) continue;
    const file = join(dir, f);
    let profile;
    try {
      profile = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new ProfileError(`invalid profile ${file}: cannot parse JSON: ${e.message}`);
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.id === undefined) {
      warnings.push(`skipping ${file}: not a profile (no "id")`);
      continue;
    }
    const problems = validateProfile(profile);
    if (problems.length)
      throw new ProfileError(`invalid profile ${file}:\n  - ${problems.join("\n  - ")}`);
    if (out[profile.id])
      throw new ProfileError(`duplicate profile id "${profile.id}" in ${out[profile.id].file} and ${file}`);
    out[profile.id] = { profile, file };
  }
  return out;
}

/**
 * Shipped profiles, overlaid by an optional user profilesDir. A user profile
 * that replaces a shipped id is allowed (that's how you pin or patch one) but
 * produces a warning so it is never silent.
 * Returns { profiles: { [id]: profile }, warnings: string[] }.
 */
export function loadAllProfiles(extraDir = null, shippedDir = SHIPPED_PROFILES_DIR) {
  const warnings = [];
  const shipped = loadProfileDir(shippedDir, warnings);
  const profiles = Object.fromEntries(Object.entries(shipped).map(([id, x]) => [id, x.profile]));
  if (extraDir)
    for (const [id, { profile, file }] of Object.entries(loadProfileDir(extraDir, warnings))) {
      if (shipped[id] && shipped[id].file !== file) {
        warnings.push(`profile "${id}" from ${file} overrides the shipped profile of the same id`);
        if (profile.verified !== true && shipped[id].profile.verified === true)
          warnings.push(`profile "${id}" from ${file} is verified:false, so it is excluded from --portable`);
      }
      profiles[id] = profile;
    }
  return { profiles, warnings };
}

/**
 * Profiles selected by --portable: every VERIFIED consumer profile, including
 * the synthetic strictest-common-denominator one. Unverified stubs are left
 * out (a guessed constraint must not fail a portability gate), as are
 * spec-baseline profiles (the core rules already cover the spec).
 */
export function portableProfileIds(profiles) {
  return Object.values(profiles)
    .filter((p) => p.verified === true && p.kind !== "spec-baseline")
    .map((p) => p.id);
}
