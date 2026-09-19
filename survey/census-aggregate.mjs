/**
 * Turns a merged census CSV into the small file a page is built from.
 *
 * The census asks the web at large - not a population of shops - so its
 * aggregate is simpler than the Shopify one: how many answered, how many
 * published a profile, and how many could not be reached at all. No shop
 * names, small enough to read in a pull request.
 *
 *     node survey/census-aggregate.mjs 2026-09-18-top2k.csv 2026-09-18-top2k-aggregate.json
 */

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write("usage: node survey/census-aggregate.mjs <merged.csv> <out.json>\n");
  process.exit(2);
}

const lines = readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean);
const rows = lines.slice(1).map((line) => line.split(","));

const byOutcome = {};
const versions = {};
for (const [, outcome, , version] of rows) {
  byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  if (outcome === "checked" && version) versions[version] = (versions[version] ?? 0) + 1;
}

const total = rows.length;
const checked = byOutcome.checked ?? 0;
// Everything we could not read either way, kept apart from "has no profile".
const unverified =
  (byOutcome.blocked ?? 0) + (byOutcome.unreachable ?? 0) + (byOutcome["not-json"] ?? 0) + (byOutcome.invalid ?? 0);

const aggregate = {
  kind: "census",
  checkedAt: new Date().toISOString(),
  population: {
    source: "Tranco top 2000 sites, as they are - no commerce classifier",
    list: "survey/domains-top2k.txt",
    note: "Publishing /.well-known/ucp is itself the signal; a site that does not publish one needs no classification.",
  },
  method: {
    request: "one HTTPS GET of /.well-known/ucp per domain",
    concurrency: 4,
    timeouts: "2.5s on the first pass; every domain that timed out was asked again with 6s",
  },
  summary: { total, checked, unverified, byOutcome, versions },
};

writeFileSync(output, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
process.stdout.write(`${output}\n`);
process.stdout.write(`  ${total} domain(s)\n`);
for (const [outcome, count] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${outcome.padEnd(14)} ${String(count).padStart(5)}  (${pct(count)})\n`);
}
