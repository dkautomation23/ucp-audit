/**
 * Which release of the specification to judge a profile against.
 *
 * A version baked into the build goes stale the day the spec moves, and a tool
 * that under-reports how far behind a shop is, is worse than one that says it
 * does not know. So the current release is read from the specification site,
 * which publishes its released versions as JSON, and the built-in constant is
 * the fallback rather than the answer.
 *
 * The fallback is not a failure path to be ashamed of: it is what runs in CI
 * with no network, and it is why this module never throws. A version lookup
 * that cannot answer must not stop an audit.
 */

import type { Fetcher } from "./probe.js";

/** Published releases, newest first, as of this build. */
export const KNOWN_SPEC_VERSION = "2026-08-25";

export const VERSIONS_URL = "https://ucp.dev/versions.json";

/** A release is a date, and anything else is not one. */
const DATED = /^\d{4}-\d{2}-\d{2}$/;

export interface SpecVersion {
  version: string;
  /** Where the number came from, so the report can say so honestly. */
  source: "network" | "built-in" | "given";
}

/**
 * The newest published release, or the built-in constant if the site cannot be
 * read, answers with something unexpected, or is simply not reachable.
 */
export async function currentSpecVersion(fetcher: Fetcher): Promise<SpecVersion> {
  try {
    const response = await fetcher.get(VERSIONS_URL);
    if (response.status !== 200) return { version: KNOWN_SPEC_VERSION, source: "built-in" };

    const parsed: unknown = JSON.parse(response.body);
    if (!Array.isArray(parsed)) return { version: KNOWN_SPEC_VERSION, source: "built-in" };

    const dated = parsed
      .filter((entry): entry is { version: string; aliases?: unknown } =>
        typeof (entry as { version?: unknown })?.version === "string",
      )
      .filter((entry) => DATED.test(entry.version));

    // "latest" is the site's own answer to this question; the newest date is
    // the fallback for the day that alias is missing.
    const latest = dated.find(
      (entry) => Array.isArray(entry.aliases) && entry.aliases.includes("latest"),
    );
    const newest = dated.map((entry) => entry.version).sort().at(-1);
    const version = latest?.version ?? newest;
    if (!version) return { version: KNOWN_SPEC_VERSION, source: "built-in" };

    // A site that somehow lists an older release than this build knows about
    // must not drag the tool backwards.
    if (version < KNOWN_SPEC_VERSION) return { version: KNOWN_SPEC_VERSION, source: "built-in" };
    return { version, source: "network" };
  } catch {
    return { version: KNOWN_SPEC_VERSION, source: "built-in" };
  }
}
