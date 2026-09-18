/**
 * Auditing a list of shops instead of one.
 *
 * Two reasons this exists. An agency running twenty client stores needs one
 * command, not twenty. And a survey of what the protocol looks like in the wild
 * needs hundreds - which is only defensible if the crawler is polite, so the
 * politeness is built into this file rather than left to the caller.
 *
 * The outcome of each domain is a *status*, not a boolean. "We could not check
 * this shop" and "this shop is broken" are different facts, and merging them is
 * how a survey ends up publishing a number that is not true.
 */

import { checkProfile, countByLevel, type Finding } from "./checks.js";
import { parseProfile, profileUrl, type Profile } from "./profile.js";
import { fetchProfile, type Fetcher } from "./probe.js";

export type Outcome =
  | "checked"        // profile read and audited
  | "no-profile"     // 404: agents cannot discover this shop at all
  | "blocked"        // 403/429: the shop refused us, which says nothing about the shop
  | "not-json"       // something answered 200 that is not a profile
  | "invalid"        // JSON, but not a UCP profile
  | "unreachable";   // no answer

export interface DomainResult {
  domain: string;
  outcome: Outcome;
  httpStatus?: number;
  protocolVersion?: string;
  capabilities?: string[];
  /** Can an agent find products here at all? */
  catalogueSearchable?: boolean;
  findings?: Finding[];
  blockers?: number;
  topBlocker?: string;
  error?: string;
}

const CATALOGUE_SEARCH = "dev.ucp.shopping.catalog.search";
const CATALOGUE_LOOKUP = "dev.ucp.shopping.catalog.lookup";

export async function auditDomain(
  fetcher: Fetcher,
  domain: string,
  specVersion: string,
): Promise<DomainResult> {
  const url = profileUrl(domain);
  let fetched;
  try {
    fetched = await fetchProfile(fetcher, url);
  } catch (error) {
    return { domain, outcome: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }

  if (fetched.status === 404) return { domain, outcome: "no-profile", httpStatus: 404 };
  if (fetched.status === 403 || fetched.status === 429) {
    return { domain, outcome: "blocked", httpStatus: fetched.status };
  }
  if (fetched.status !== 200) {
    return { domain, outcome: "unreachable", httpStatus: fetched.status };
  }
  if (!fetched.contentType.includes("json")) {
    return { domain, outcome: "not-json", httpStatus: 200 };
  }

  let profile: Profile;
  try {
    profile = parseProfile(JSON.parse(fetched.body));
  } catch (error) {
    return {
      domain,
      outcome: "invalid",
      httpStatus: 200,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const findings = checkProfile(profile, { specVersion, host: new URL(url).host });
  const capabilities = Object.keys(profile.capabilities).sort();
  const blockers = findings.filter((finding) => finding.level === "blocker");

  return {
    domain,
    outcome: "checked",
    httpStatus: 200,
    protocolVersion: profile.version,
    capabilities,
    catalogueSearchable: capabilities.includes(CATALOGUE_SEARCH) || capabilities.includes(CATALOGUE_LOOKUP),
    findings,
    blockers: countByLevel(findings).blocker,
    topBlocker: blockers[0]?.title,
  };
}

export interface BatchOptions {
  specVersion: string;
  /** Requests in flight. Four is polite and still finishes 200 domains quickly. */
  concurrency?: number;
  /** Pause between domains taken by one worker. */
  delayMs?: number;
  onResult?: (result: DomainResult, done: number, total: number) => void;
}

export async function auditMany(
  fetcher: Fetcher,
  domains: string[],
  options: BatchOptions,
): Promise<DomainResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 4));
  const delayMs = options.delayMs ?? 250;

  const results: DomainResult[] = new Array(domains.length);
  let next = 0;
  let done = 0;

  // One worker per slot, each taking the next domain when it finishes its own.
  // Keeps exactly `concurrency` requests in flight without a queue library.
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= domains.length) return;
      results[index] = await auditDomain(fetcher, domains[index]!, options.specVersion);
      done += 1;
      options.onResult?.(results[index]!, done, domains.length);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return results;
}

/** One domain per line; blanks and `#` comments ignored, scheme and path stripped. */
export function parseDomainList(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    try {
      seen.add(new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`).host.toLowerCase());
    } catch {
      // A line that is not a host is skipped rather than fetched blindly.
    }
  }
  return [...seen];
}

const CSV_COLUMNS = [
  "domain",
  "outcome",
  "http_status",
  "protocol_version",
  "capabilities",
  "catalogue_searchable",
  "blockers",
  "top_blocker",
] as const;

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(results: DomainResult[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const result of results) {
    rows.push(
      [
        result.domain,
        result.outcome,
        result.httpStatus ?? "",
        result.protocolVersion ?? "",
        result.capabilities?.length ?? "",
        result.outcome === "checked" ? (result.catalogueSearchable ? "yes" : "no") : "",
        result.blockers ?? "",
        result.topBlocker ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

export interface Summary {
  total: number;
  byOutcome: Record<Outcome, number>;
  /** Of those actually checked. */
  checked: number;
  withoutCatalogue: number;
  withBlockers: number;
  versions: Record<string, number>;
  behindSpec: number;
  blockerCounts: Record<string, number>;
}

export function summarise(results: DomainResult[], specVersion: string): Summary {
  const byOutcome = {
    checked: 0, "no-profile": 0, blocked: 0, "not-json": 0, invalid: 0, unreachable: 0,
  } as Record<Outcome, number>;
  const versions: Record<string, number> = {};
  const blockerCounts: Record<string, number> = {};
  let withoutCatalogue = 0;
  let withBlockers = 0;
  let behindSpec = 0;

  for (const result of results) {
    byOutcome[result.outcome] += 1;
    if (result.outcome !== "checked") continue;

    const version = result.protocolVersion ?? "unstated";
    versions[version] = (versions[version] ?? 0) + 1;
    if (version !== "unstated" && version < specVersion) behindSpec += 1;
    if (result.catalogueSearchable === false) withoutCatalogue += 1;
    if ((result.blockers ?? 0) > 0) withBlockers += 1;
    for (const finding of result.findings ?? []) {
      if (finding.level !== "blocker") continue;
      blockerCounts[finding.id] = (blockerCounts[finding.id] ?? 0) + 1;
    }
  }

  return {
    total: results.length,
    byOutcome,
    checked: byOutcome.checked,
    withoutCatalogue,
    withBlockers,
    versions,
    behindSpec,
    blockerCounts,
  };
}

export function renderSummary(summary: Summary, specVersion: string): string {
  const percent = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`);
  const lines: string[] = [];

  lines.push(`${summary.total} domain(s)`);
  lines.push("");
  lines.push(`  profile read and audited   ${summary.byOutcome.checked}  (${percent(summary.byOutcome.checked, summary.total)})`);
  lines.push(`  no profile published       ${summary.byOutcome["no-profile"]}  (${percent(summary.byOutcome["no-profile"], summary.total)})`);
  lines.push(`  refused the check          ${summary.byOutcome.blocked}`);
  lines.push(`  answered something else    ${summary.byOutcome["not-json"] + summary.byOutcome.invalid}`);
  lines.push(`  no answer                  ${summary.byOutcome.unreachable}`);
  lines.push("");

  if (summary.checked === 0) return lines.join("\n");

  lines.push(`Of the ${summary.checked} audited:`);
  lines.push(`  agents cannot search the catalogue   ${summary.withoutCatalogue}  (${percent(summary.withoutCatalogue, summary.checked)})`);
  lines.push(`  at least one blocker                 ${summary.withBlockers}  (${percent(summary.withBlockers, summary.checked)})`);
  lines.push(`  behind the published ${specVersion}       ${summary.behindSpec}  (${percent(summary.behindSpec, summary.checked)})`);
  lines.push("");

  const versions = Object.entries(summary.versions).sort((a, b) => b[1] - a[1]);
  if (versions.length > 0) {
    lines.push("Protocol versions:");
    for (const [version, count] of versions) lines.push(`  ${version}  ${count}`);
    lines.push("");
  }

  const blockers = Object.entries(summary.blockerCounts).sort((a, b) => b[1] - a[1]);
  if (blockers.length > 0) {
    lines.push("Blockers by kind:");
    for (const [id, count] of blockers) lines.push(`  ${id}  ${count}`);
  }
  return lines.join("\n");
}
