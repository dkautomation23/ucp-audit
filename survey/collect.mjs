/**
 * Builds the domain list the survey runs against.
 *
 * The population has to be defensible, so it is defined by two public facts
 * rather than by taste:
 *
 *   1. the domain is in the Tranco top N, a ranked list built from several
 *      traffic sources and published daily with a citable id;
 *   2. its DNS points at Shopify's storefront address, 23.227.38.0/24 - the
 *      A record Shopify documents for merchants using their own domain - or at
 *      a `*.myshopify.com` name.
 *
 * Shopify is not the whole of commerce, and the survey says so. But UCP is a
 * Google and Shopify specification, so Shopify storefronts are the shops it
 * reaches first, and "did the shops it reaches first adopt it" is the question
 * worth measuring.
 *
 * Discovery is DNS only: it asks a public resolver, never the shop. The shops
 * themselves are contacted exactly once each, later, by the audit.
 *
 * Usage:
 *   node survey/collect.mjs --scan 200000
 */

import dns from "node:dns/promises";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".cache");

/** Shopify's documented storefront A record for merchant-owned domains. */
const SHOPIFY_PREFIX = "23.227.38.";
const SHOPIFY_CNAME = /\.myshopify\.com\.?$/i;

// Public resolvers, because the machine running this may have a local one that
// refuses anything but a plain lookup. Queries go to them, not to any shop.
const RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const CONCURRENCY = 60;
const TIMEOUT_MS = 4000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function tranco(scan) {
  mkdirSync(CACHE, { recursive: true });
  const id = (await (await fetch("https://tranco-list.eu/top-1m-id")).text()).trim();
  const path = join(CACHE, `tranco-${id}-${scan}.csv`);
  if (!existsSync(path)) {
    const response = await fetch(`https://tranco-list.eu/download/${id}/${scan}`);
    if (!response.ok) throw new Error(`tranco: HTTP ${response.status}`);
    writeFileSync(path, await response.text(), "utf8");
  }
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return { id, domains: rows.map((row) => row.split(",")[1]).filter(Boolean) };
}

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), TIMEOUT_MS)),
  ]);
}

/** "yes" it is a Shopify storefront, "no" it is not, "unknown" we could not tell. */
async function isStorefront(resolver, domain) {
  try {
    const addresses = await withTimeout(resolver.resolve4(domain));
    if (addresses.some((address) => address.startsWith(SHOPIFY_PREFIX))) return "yes";
    return "no";
  } catch (error) {
    // No A record often means a CNAME chain; Shopify's own is worth following.
    if (error?.code === "ENODATA" || error?.code === "ENOTFOUND") {
      try {
        const names = await withTimeout(resolver.resolveCname(domain));
        return names.some((name) => SHOPIFY_CNAME.test(name)) ? "yes" : "no";
      } catch {
        return error?.code === "ENOTFOUND" ? "no" : "unknown";
      }
    }
    return "unknown";
  }
}

async function main() {
  const scan = Number(arg("scan", 200000));
  const { id, domains } = await tranco(scan);

  const probePath = join(CACHE, `dns-${id}-${scan}.csv`);
  const known = new Map();
  if (existsSync(probePath)) {
    for (const row of readFileSync(probePath, "utf8").split(/\r?\n/)) {
      const [domain, verdict] = row.split(",");
      if (domain && verdict) known.set(domain, verdict);
    }
    process.stderr.write(`resuming: ${known.size} domain(s) already resolved\n`);
  }

  const ranked = new Map(domains.map((domain, index) => [domain, index + 1]));
  const shops = [...known].filter(([, verdict]) => verdict === "yes").map(([domain]) => domain);

  let next = 0;
  let scanned = known.size;
  let unknown = [...known.values()].filter((verdict) => verdict === "unknown").length;
  const started = Date.now();

  async function worker(slot) {
    const resolver = new dns.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    resolver.setServers([RESOLVERS[slot % RESOLVERS.length]]);
    // A second resolver for the domains the first one did not answer about, so
    // one slow nameserver does not turn a shop into an unknown.
    const backup = new dns.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    backup.setServers([RESOLVERS[(slot + 1) % RESOLVERS.length]]);

    for (;;) {
      const index = next++;
      if (index >= domains.length) return;
      const domain = domains[index];
      if (known.has(domain)) continue;

      let verdict = await isStorefront(resolver, domain);
      if (verdict === "unknown") verdict = await isStorefront(backup, domain);
      appendFileSync(probePath, `${domain},${verdict}\n`, "utf8");
      known.set(domain, verdict);
      scanned += 1;
      if (verdict === "yes") shops.push(domain);
      if (verdict === "unknown") unknown += 1;
      if (scanned % 5000 === 0) {
        const rate = Math.round(scanned / ((Date.now() - started) / 1000));
        process.stderr.write(`  ${scanned} resolved, ${shops.length} storefront(s), ${rate}/s\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, slot) => worker(slot)));

  shops.sort((a, b) => (ranked.get(a) ?? 1e9) - (ranked.get(b) ?? 1e9));

  const header = [
    "# Live Shopify storefronts - the population of the UCP survey.",
    "#",
    `# Ranking:   Tranco list ${id} (https://tranco-list.eu/list/${id}), top ${scan}.`,
    "# Selection: DNS A record inside 23.227.38.0/24, the address Shopify",
    "#            documents for merchant-owned domains, or a CNAME to",
    "#            *.myshopify.com. Discovery asked a resolver, never the shop.",
    `# Collected: ${new Date().toISOString().slice(0, 10)} by survey/collect.mjs.`,
    `# Result:    ${shops.length} storefront(s) out of ${scanned} ranked domain(s);`,
    `#            ${unknown} domain(s) could not be resolved either way.`,
    "# Order:     by Tranco rank, most visited first.",
    "#",
    "# These are shop names, not a verdict about any of them. The survey",
    "# publishes totals only.",
    "",
  ].join("\n");

  const outPath = join(HERE, "domains.txt");
  writeFileSync(outPath, `${header}${shops.join("\n")}\n`, "utf8");
  process.stderr.write(`\n${shops.length} storefront(s) from ${scanned} resolved -> ${outPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
