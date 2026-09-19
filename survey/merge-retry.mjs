/**
 * Merges a second, patient pass over the domains that did not answer.
 *
 * A short timeout keeps a census finishable in an evening, but it turns a slow
 * site into "could not verify". Asking those again with a long timeout and
 * keeping the better answer is the difference between an honest unverified
 * share and a lazy one.
 *
 *     node survey/merge-retry.mjs first.csv retry.csv merged.csv
 */

import { readFileSync, writeFileSync } from "node:fs";

const [first, retry, out] = process.argv.slice(2);
if (!first || !retry || !out) {
  process.stderr.write("usage: node survey/merge-retry.mjs <first.csv> <retry.csv> <merged.csv>\n");
  process.exit(2);
}

/** Splits a CSV line, respecting quoted commas. */
function cells(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else current += char;
  }
  values.push(current);
  return values;
}

function read(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0];
  const rows = new Map();
  for (const line of lines.slice(1)) rows.set(cells(line)[0], line);
  return { header, rows };
}

const a = read(first);
const b = read(retry);

let replaced = 0;
for (const [domain, line] of b.rows) {
  const before = a.rows.get(domain);
  if (!before) continue;
  const wasUnreachable = cells(before)[1] === "unreachable";
  const nowAnswers = cells(line)[1] !== "unreachable";
  // Only ever replace a non-answer with an answer; never the other way round.
  if (wasUnreachable && nowAnswers) {
    a.rows.set(domain, line);
    replaced += 1;
  }
}

writeFileSync(out, `${a.header}\n${[...a.rows.values()].join("\n")}\n`, "utf8");

const counts = {};
for (const line of a.rows.values()) {
  const outcome = cells(line)[1];
  counts[outcome] = (counts[outcome] ?? 0) + 1;
}

process.stdout.write(`${a.rows.size} domain(s); ${replaced} answered on the second, patient pass\n`);
for (const [outcome, count] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
  process.stdout.write(`  ${outcome.padEnd(14)} ${count}  (${((count / a.rows.size) * 100).toFixed(1)}%)\n`);
}
