/**
 * Printing the result so the first line is the one that matters.
 */

import { countByLevel, type Finding, type Level } from "./checks.js";
import type { Profile } from "./profile.js";
import type { UrlResult } from "./probe.js";

const MARK: Record<Level, string> = { blocker: "BLOCK", warning: "warn ", info: "note " };
const BAR = "-".repeat(72);

export interface Context {
  target: string;
  profileUrl: string;
  bytes: number;
  specVersion?: string;
  probed?: UrlResult[];
}

export function renderConsole(profile: Profile, findings: Finding[], context: Context): string {
  const counts = countByLevel(findings);
  const lines: string[] = [];

  lines.push(BAR);
  lines.push(`UCP AUDIT - ${context.target}`);
  lines.push(BAR);
  lines.push(`profile   ${context.profileUrl}  (${context.bytes} bytes)`);
  lines.push(
    `protocol  ${profile.version ?? "not declared"}` +
      (context.specVersion ? `   published spec: ${context.specVersion}` : ""),
  );

  const services = Object.entries(profile.services)
    .map(([name, bindings]) => `${name} [${bindings.map((b) => b.transport ?? "?").join(", ")}]`)
    .join("; ");
  lines.push(`services  ${services || "none"}`);
  lines.push(`caps      ${Object.keys(profile.capabilities).length}: ${Object.keys(profile.capabilities).sort().join(", ") || "none"}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("Nothing to fix. The profile is internally consistent and offers a complete");
    lines.push("shopping surface.");
  } else {
    for (const level of ["blocker", "warning", "info"] as Level[]) {
      for (const finding of findings.filter((item) => item.level === level)) {
        lines.push(`  ${MARK[level]}  ${finding.title}`);
        lines.push(`         ${finding.detail}`);
        if (finding.fix) lines.push(`         -> ${finding.fix}`);
        lines.push("");
      }
    }
  }

  if (context.probed && context.probed.length > 0) {
    const refused = context.probed.filter((result) => result.status === -1);
    const dead = context.probed.filter((result) => result.status === 0 || result.status >= 400);
    lines.push(
      `${context.probed.length} declared URL(s) checked, ${dead.length} unreachable` +
        (refused.length > 0 ? `, ${refused.length} not requested` : ""),
    );
    for (const result of dead) {
      lines.push(`  ${result.status === 0 ? "dead" : result.status}  ${result.where}  ${result.url}`);
    }
    for (const result of refused) {
      lines.push(`  skip  ${result.where}  ${result.url}  (not a public address - refused)`);
    }
    if (dead.length > 0) lines.push("");
  }

  lines.push(`${counts.blocker} blocker(s), ${counts.warning} warning(s), ${counts.info} note(s)`);
  return lines.join("\n");
}

export function renderJson(profile: Profile, findings: Finding[], context: Context): string {
  return `${JSON.stringify(
    {
      target: context.target,
      profileUrl: context.profileUrl,
      checkedAt: new Date().toISOString(),
      protocolVersion: profile.version ?? null,
      publishedSpecVersion: context.specVersion ?? null,
      services: Object.fromEntries(
        Object.entries(profile.services).map(([name, bindings]) => [
          name,
          bindings.map((binding) => ({ version: binding.version, transport: binding.transport })),
        ]),
      ),
      capabilities: Object.keys(profile.capabilities).sort(),
      findings,
      summary: countByLevel(findings),
      unreachableUrls: (context.probed ?? []).filter((r) => r.status === 0 || r.status >= 400),
    },
    null,
    2,
  )}\n`;
}
