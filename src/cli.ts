/**
 * ucp-audit - is your shop actually reachable by shopping agents?
 */

import { readFileSync, writeFileSync } from "node:fs";

import { checkProfile, countByLevel, type Finding } from "./checks.js";
import { parseProfile, profileUrl, urlsIn, type Profile } from "./profile.js";
import { fetchProfile, httpFetcher, probeUrls, type Fetcher, type UrlResult } from "./probe.js";
import { renderConsole, renderJson, type Context } from "./report.js";

/** The newest published UCP release this build knows about. */
export const KNOWN_SPEC_VERSION = "2026-08-25";

const USAGE = `ucp-audit - check whether a shop is actually reachable by shopping agents.

  ucp-audit allbirds.com
  ucp-audit yourshop.com --probe --json report.json
  ucp-audit --file saved-profile.json

Reads the Universal Commerce Protocol profile a business publishes at
/.well-known/ucp and reports what would make an agent skip the shop - silently,
because nothing anywhere reports it.

  --probe           also check that every URL the profile declares resolves
  --file PATH       audit a saved profile instead of fetching one
  --json FILE       write the findings as JSON
  --spec-version V  compare against this published version (default ${KNOWN_SPEC_VERSION})
  --timeout MS      per request, default 15000
  --quiet           write files, print nothing

Exit codes: 0 no blockers, 1 at least one blocker, 2 no profile or unreadable.
`;

interface Args {
  target?: string;
  flags: Map<string, string>;
  bools: Set<string>;
}

function parse(argv: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  let target: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      target ??= token;
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) bools.add(name);
    else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { target, flags, bools };
}

export async function run(
  argv: string[],
  fetcher?: Fetcher,
  out: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const args = parse(argv);
  const file = args.flags.get("file");

  if ((!args.target && !file) || args.bools.has("help")) {
    out(USAGE);
    return args.target || file ? 0 : 2;
  }

  const specVersion = args.flags.get("spec-version") ?? KNOWN_SPEC_VERSION;
  const timeout = Number(args.flags.get("timeout") ?? 15_000);
  const http = fetcher ?? httpFetcher(timeout);
  const quiet = args.bools.has("quiet");

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
