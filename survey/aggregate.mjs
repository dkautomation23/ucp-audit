/**
 * Reduces one audit run to the file the published page is built from.
 *
 * The full `--json` output of a five-thousand-shop run is megabytes of
 * per-domain findings. What gets published is this: totals, version counts,
 * blocker counts and how often each capability appears - no shop names, small
 * enough to read in a pull request, and enough to rebuild every number on the
 * page.
 *
 *     node survey/aggregate.mjs survey/2026-09-18-summary.json
 */

import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  process.stderr.write("usage: node survey/aggregate.mjs <run.json>\n");
  process.exit(2);
}

const run = JSON.parse(readFileSync(source, "utf8"));

const capabilities = {};
let capabilityCountHistogram = {};
for (const result of run.results) {
  if (result.outcome !== "checked") continue;
  for (const capability of result.capabilities ?? []) {
    capabilities[capability] = (capabilities[capability] ?? 0) + 1;
  }
  const size = (result.capabilities ?? []).length;
  capabilityCountHistogram[size] = (capabilityCountHistogram[size] ?? 0) + 1;
}

const aggregate = {
  specVersion: run.specVersion,
  checkedAt: run.checkedAt,
  population: {
    source: "Tranco top 300000, DNS pointing at Shopify (23.227.38.0/24 or *.myshopify.com)",
    script: "survey/collect.mjs",
    list: "survey/domains.txt",
  },
  method: {
    request: "one HTTPS GET of /.well-known/ucp per domain",
    concurrency: 4,
    note: "Domains that refused, timed out or answered something else are counted separately and never as broken.",
  },
  summary: run.summary,
  capabilities: Object.fromEntries(
    Object.entries(capabilities).sort((a, b) => b[1] - a[1]),
  ),
  capabilityCountHistogram,
};

const out = source.replace(/-summary\.json$/, "-aggregate.json");
writeFileSync(out, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
process.stdout.write(`${out}\n`);
