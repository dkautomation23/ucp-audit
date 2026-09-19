/**
 * ucp-audit - is your shop actually reachable by shopping agents?
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { checkProfile, countByLevel, type Finding } from "./checks.js";
import { parseProfile, profileUrl, urlsIn, type Profile } from "./profile.js";
import { fetchProfile, httpFetcher, probeUrls, type Fetcher, type UrlResult } from "./probe.js";
import { renderConsole, renderJson, type Context } from "./report.js";
import {
  auditMany,
  CSV_HEADER,
  domainsIn,
  parseDomainList,
  renderSummary,
  summarise,
  toCsvRow,
  type DomainResult,
} from "./batch.js";
import { currentSpecVersion, KNOWN_SPEC_VERSION } from "./spec.js";

export { KNOWN_SPEC_VERSION };

const USAGE = `ucp-audit - check whether a shop is actually reachable by shopping agents.

  ucp-audit allbirds.com
  ucp-audit yourshop.com --probe --json report.json
  ucp-audit --batch shops.txt --csv survey.csv
  ucp-audit --file saved-profile.json

Reads the Universal Commerce Protocol profile a business publishes at
/.well-known/ucp and reports what would make an agent skip the shop - silently,
because nothing anywhere reports it.

  --batch FILE      audit a list of domains, one per line, and print the totals
  --csv FILE        write the batch result as CSV, one row per domain
  --probe           also check that every URL the profile declares resolves
  --file PATH       audit a saved profile instead of fetching one
  --json FILE       write the findings as JSON
  --spec-version V  compare against this version instead of asking ucp.dev
  --offline         do not ask ucp.dev; use the built-in ${KNOWN_SPEC_VERSION}
  --timeout MS      per request, default 15000
  --quiet           write files, print nothing

Exit codes: 0 no blockers, 1 at least one blocker, 2 no profile or unreadable.
`;

interface Args {
  target?: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

/**
 * Flags that take no value.
 *
 * Without this list, `ucp-audit --probe yourshop.com` reads the shop name as
 * the value of --probe and then complains that no shop was named.
 */
const SWITCHES = new Set(["probe", "quiet", "help", "offline"]);

function parse(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  let target: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    // -h is what people try when --help is too much typing.
    if (token === "-h") {
      bools.add("help");
      continue;
    }
    if (!token.startsWith("--")) {
      target ??= token;
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (SWITCHES.has(name)) bools.add(name);
    else if (next === undefined || next.startsWith("--")) bools.add(name);
    else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { target, flags, bools };
}

/** Reads back the rows a previous run appended, enough to summarise them. */
function parseCsvResults(csv: string): DomainResult[] {
  const results: DomainResult[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [domain, outcome, status, version, capabilities, searchable, blockers] = line.split(",");
    if (!domain || !outcome) continue;
    if (outcome !== "checked") {
      results.push({ domain, outcome: outcome as DomainResult["outcome"], httpStatus: status ? Number(status) : undefined });
      continue;
    }
    results.push({
      domain,
      outcome: "checked",
      httpStatus: status ? Number(status) : undefined,
      protocolVersion: version || undefined,
      // Only the count survives a CSV round trip; the names are in the JSON.
      capabilities: new Array(Number(capabilities || 0)).fill(""),
      catalogueSearchable: searchable === "yes",
      findings: [],
      blockers: Number(blockers || 0),
    });
  }
  return results;
}

export async function run(
  argv: string[],
  fetcher?: Fetcher,
  out: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const args = parse(argv);
  const file = args.flags.get("file");
  const batch = args.flags.get("batch");

  // Asking for help is not a mistake; naming nothing to audit is.
  const askedForHelp = args.bools.has("help");
  if (!args.target && !file && !batch) {
    out(USAGE);
    return askedForHelp ? 0 : 2;
  }
  if (askedForHelp) {
    out(USAGE);
    return 0;
  }

  // The published release is read from the specification site, because a
  // version baked into a build starts lying the day the spec moves. Asking is
  // one request and never fatal: no answer means the built-in constant.
  const given = args.flags.get("spec-version");
  const spec = given
    ? { version: given, source: "given" as const }
    : args.bools.has("offline")
      ? { version: KNOWN_SPEC_VERSION, source: "built-in" as const }
      : await currentSpecVersion(fetcher ?? httpFetcher(Number(args.flags.get("timeout") ?? 15_000)));
  const specVersion = spec.version;
  const timeout = Number(args.flags.get("timeout") ?? 15_000);
  const http = fetcher ?? httpFetcher(timeout);
  const quiet = args.bools.has("quiet");

  const batchPath = args.flags.get("batch");
  if (batchPath) {
    const domains = parseDomainList(readFileSync(batchPath, "utf8"));
    if (domains.length === 0) {
      out(`${batchPath}: no domains found\n`);
      return 2;
    }

    // Rows land as they arrive, and a run that finds its CSV already there
    // picks up where the last one stopped: a survey of thousands of shops is
    // an hour of polite crawling, and starting over costs that hour twice.
    const csvPath = args.flags.get("csv");
    let alreadyDone: DomainResult[] = [];
    let pending = domains;
    if (csvPath && existsSync(csvPath)) {
      const existing = readFileSync(csvPath, "utf8");
      const done = domainsIn(existing);
      pending = domains.filter((domain) => !done.has(domain));
      alreadyDone = parseCsvResults(existing);
      if (!quiet && pending.length < domains.length) {
        out(`resuming: ${domains.length - pending.length} domain(s) already in ${csvPath}\n`);
      }
    } else if (csvPath) {
      writeFileSync(csvPath, `${CSV_HEADER}\n`, "utf8");
    }

    if (!quiet) {
      out(`auditing ${pending.length} domain(s), 4 at a time`);
      out(spec.source === "network" ? ` against ${specVersion}, read from ucp.dev\n\n` : ` against ${specVersion}\n\n`);
    }
    const fresh = await auditMany(http, pending, {
      specVersion,
      onResult: (result, done, total) => {
        if (csvPath) appendFileSync(csvPath, `${toCsvRow(result)}\n`, "utf8");
        if (quiet) return;
        const detail =
          result.outcome === "checked"
            ? `${result.capabilities?.length} cap(s), ${result.blockers} blocker(s)${result.catalogueSearchable ? "" : ", catalogue not searchable"}`
            : result.outcome;
        out(`  ${String(done).padStart(4)}/${total}  ${result.domain.padEnd(34)} ${detail}\n`);
      },
    });

    const results = [...alreadyDone, ...fresh];
    const totals = summarise(results, specVersion);
    if (!quiet) out(`\n${renderSummary(totals, specVersion)}\n`);
    if (csvPath && !quiet) out(`\n${results.length} row(s) in ${csvPath}\n`);
    const jsonPath = args.flags.get("json");
    if (jsonPath) {
      writeFileSync(jsonPath, `${JSON.stringify({ specVersion, checkedAt: new Date().toISOString(), summary: totals, results }, null, 2)}\n`, "utf8");
      if (!quiet) out(`findings written to ${jsonPath}\n`);
    }

    // A survey is not a gate: a shop failing its own audit is not this run
    // failing. Only being unable to check anything at all is.
    return totals.checked === 0 ? 2 : 0;
  }

  let body: string;
  let url: string;
  let bytes: number;
  let host: string | undefined;

  if (file) {
    body = readFileSync(file, "utf8");
    url = file;
    bytes = Buffer.byteLength(body, "utf8");
  } else {
    url = profileUrl(args.target!);
    host = new URL(url).host;
    const fetched = await fetchProfile(http, url);
    if (fetched.status !== 200) {
      out(
        `${url} answered ${fetched.status}.\n` +
          (fetched.status === 404
            ? "No UCP profile is published here, so shopping agents cannot discover this shop at all.\n"
            : "The profile could not be read.\n"),
      );
      return 2;
    }
    if (!fetched.contentType.includes("json")) {
      out(`${url} is served as "${fetched.contentType}" rather than JSON.\n`);
      return 2;
    }
    body = fetched.body;
    bytes = fetched.bytes;
  }

  let profile: Profile;
  try {
    profile = parseProfile(JSON.parse(body));
  } catch (error) {
    out(`${url}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const findings: Finding[] = checkProfile(profile, { specVersion, host });

  let probed: UrlResult[] | undefined;
  if (args.bools.has("probe")) {
    probed = await probeUrls(http, urlsIn(profile));
    for (const result of probed) {
      if (result.status === -1) {
        findings.push({
          id: "url-not-public",
          level: "blocker",
          title: `${result.where} points at an address that is not on the public internet`,
          detail: `${result.url} was not requested. A shopping agent could not reach it either.`,
          fix: "Publish a public HTTPS URL, or remove the entry from the profile.",
        });
        continue;
      }
      if (result.status === 0 || result.status >= 400) {
        findings.push({
          id: "url-unreachable",
          level: result.where.endsWith("endpoint") ? "blocker" : "warning",
          title: `${result.where} does not resolve`,
          detail: `${result.url} answered ${result.status === 0 ? "nothing" : result.status}.`,
          fix: "A URL in the profile that does not answer is a promise an agent cannot keep.",
        });
      }
    }
  }

  const context: Context = { target: args.target ?? file!, profileUrl: url, bytes, specVersion, probed };

  if (!quiet) out(`${renderConsole(profile, findings, context)}\n`);

  const jsonPath = args.flags.get("json");
  if (jsonPath) {
    writeFileSync(jsonPath, renderJson(profile, findings, context), "utf8");
    if (!quiet) out(`\nfindings written to ${jsonPath}\n`);
  }

  return countByLevel(findings).blocker > 0 ? 1 : 0;
}
