/**
 * What can go wrong with a published UCP profile, and how it shows up.
 *
 * Every check answers one question a merchant would ask if they knew to ask it.
 * The severity is judged by the consequence for the merchant, not by how
 * unusual the finding is: anything that makes an agent quietly skip the shop is
 * a blocker, because nothing anywhere will report it. There is no error page
 * when an agent decides your catalogue is not searchable - there is just no
 * traffic.
 */

import { compareVersions, isDateVersion, type Profile } from "./profile.js";

export type Level = "blocker" | "warning" | "info";

export interface Finding {
  id: string;
  level: Level;
  title: string;
  detail: string;
  /** What to do about it, in the merchant's terms. */
  fix?: string;
}

/**
 * Capabilities that decide whether an agent can find anything to buy.
 *
 * Checkout without a catalogue is a shop an agent can pay at but not browse:
 * the agent has to already know the product, which defeats the point of
 * discovery-led shopping.
 */
export const DISCOVERY_CAPABILITIES = [
  "dev.ucp.shopping.catalog.search",
  "dev.ucp.shopping.catalog.lookup",
];

export const CART_CAPABILITY = "dev.ucp.shopping.cart";
export const CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";

export interface CheckOptions {
  /** The newest published spec version to compare against. */
  specVersion?: string;
  /** Storefront host the profile was fetched from, for the host-mismatch note. */
  host?: string;
}

export function checkProfile(profile: Profile, options: CheckOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const capabilityNames = new Set(Object.keys(profile.capabilities));

  // --- the profile itself -------------------------------------------------
  if (!profile.version) {
    findings.push({
      id: "version-missing",
      level: "blocker",
      title: "The profile declares no protocol version",
      detail: "`ucp.version` is absent, so a platform cannot negotiate a version with you.",
      fix: "Publish `ucp.version` as the dated protocol version your implementation speaks.",
    });
  } else if (!isDateVersion(profile.version)) {
    findings.push({
      id: "version-malformed",
      level: "blocker",
      title: `Protocol version "${profile.version}" is not a dated version`,
      detail: "UCP versions are dates, for example 2026-08-25. Anything else cannot be compared.",
    });
  } else if (options.specVersion) {
    const behind = compareVersions(profile.version, options.specVersion);
    if (behind === -1) {
      findings.push({
        id: "version-behind",
        level: "warning",
        title: `Protocol version ${profile.version} is behind the published ${options.specVersion}`,
        detail:
          "Capabilities added after your version do not exist as far as an agent is concerned, " +
          "and each release has added shopping capabilities.",
        fix: "Plan the upgrade, or confirm with your platform which version it publishes for you.",
      });
    }
  }

  if (Object.keys(profile.services).length === 0) {
    findings.push({
      id: "no-services",
      level: "blocker",
      title: "No services declared",
      detail: "A profile with no services tells an agent there is nothing here to talk to.",
    });
  }

  // --- can an agent actually find the products? ---------------------------
  const missingDiscovery = DISCOVERY_CAPABILITIES.filter((name) => !capabilityNames.has(name));
  if (capabilityNames.has(CHECKOUT_CAPABILITY) && missingDiscovery.length === DISCOVERY_CAPABILITIES.length) {
    findings.push({
      id: "checkout-without-catalogue",
      level: "blocker",
      title: "Checkout is offered, but the catalogue cannot be searched or looked up",
      detail:
        "An agent can pay for something it already knows about, and cannot discover anything. " +
        `Neither ${DISCOVERY_CAPABILITIES.join(" nor ")} is declared.`,
      fix: "Declare the catalogue capabilities so agents can find your products at all.",
    });
  } else if (missingDiscovery.length > 0) {
    findings.push({
      id: "discovery-incomplete",
      level: "warning",
      title: "Part of the catalogue interface is missing",
      detail: `Not declared: ${missingDiscovery.join(", ")}.`,
      fix: "Search finds candidates, lookup resolves a known product. Agents use both.",
    });
  }

  if (!capabilityNames.has(CART_CAPABILITY) && capabilityNames.has(CHECKOUT_CAPABILITY)) {
    findings.push({
      id: "no-cart",
      level: "warning",
      title: "Checkout without a cart capability",
      detail: "Multi-item purchases and cart-level discounts have nowhere to happen.",
    });
  }

  // --- internal consistency ----------------------------------------------
  for (const [name, entries] of Object.entries(profile.capabilities)) {
    for (const entry of entries) {
      if (entry.requiresProtocolMin) {
        const short = compareVersions(profile.version, entry.requiresProtocolMin);
        if (short === -1) {
          findings.push({
            id: "requires-unmet",
            level: "blocker",
            title: `${name} requires protocol ${entry.requiresProtocolMin}, profile declares ${profile.version}`,
            detail:
              "A platform reading this profile sees a capability it must not use. " +
              "It will skip the capability without telling anyone.",
            fix: "Raise the declared protocol version, or stop declaring the capability.",
          });
        }
      }

      for (const target of entry.extends) {
        if (!capabilityNames.has(target)) {
          findings.push({
            id: "extends-missing",
            level: "blocker",
            title: `${name} extends ${target}, which is not declared`,
            detail: "An extension of a capability that is not offered cannot be used.",
            fix: `Declare ${target}, or remove it from the \`extends\` of ${name}.`,
          });
        }
      }

      if (entry.version && profile.version && compareVersions(entry.version, profile.version) === 1) {
        findings.push({
          id: "capability-ahead",
          level: "warning",
          title: `${name} is at ${entry.version}, ahead of the declared protocol ${profile.version}`,
          detail: "The profile contradicts itself about which release it is on.",
        });
      }
    }
  }

  if (profile.version && Object.keys(profile.supportedVersions).length > 0) {
    const listed = Object.keys(profile.supportedVersions);
    const newest = listed.filter(isDateVersion).sort().at(-1);
    if (newest && compareVersions(newest, profile.version) === 1) {
      findings.push({
        id: "supported-newer-than-declared",
        level: "warning",
        title: `supported_versions lists ${newest}, newer than the declared ${profile.version}`,
        detail: "Which of the two an agent believes is undefined.",
      });
    }
  }

  // --- transport hygiene --------------------------------------------------
  for (const [name, bindings] of Object.entries(profile.services)) {
    for (const binding of bindings) {
      if (binding.endpoint && binding.endpoint.startsWith("http://")) {
        findings.push({
          id: "endpoint-insecure",
          level: "blocker",
          title: `${name} publishes a plaintext endpoint`,
          detail: `${binding.endpoint} is http, so payment and customer data would travel unencrypted.`,
          fix: "Serve the endpoint over HTTPS.",
        });
      }

      const needsEndpoint = binding.transport && binding.transport !== "embedded";
      if (needsEndpoint && !binding.endpoint) {
        findings.push({
          id: "endpoint-missing",
          level: "blocker",
          title: `${name} declares transport "${binding.transport}" with no endpoint`,
          detail: "An agent has nowhere to send the request.",
        });
      }

      if (binding.endpoint && options.host) {
        try {
          const endpointHost = new URL(binding.endpoint).host;
          if (endpointHost !== options.host) {
            findings.push({
              id: "endpoint-other-host",
              level: "info",
              title: `${name} is served from ${endpointHost}, not ${options.host}`,
              detail:
                "Normal when a platform hosts the protocol for you. Worth knowing, because that " +
                "host's availability is now part of your storefront.",
            });
          }
        } catch {
          findings.push({
            id: "endpoint-malformed",
            level: "blocker",
            title: `${name} has an endpoint that is not a URL`,
            detail: binding.endpoint,
          });
        }
      }
    }
  }

  return findings;
}

export function worstLevel(findings: Finding[]): Level | null {
  if (findings.some((finding) => finding.level === "blocker")) return "blocker";
  if (findings.some((finding) => finding.level === "warning")) return "warning";
  return findings.length > 0 ? "info" : null;
}

export function countByLevel(findings: Finding[]): Record<Level, number> {
  return {
    blocker: findings.filter((finding) => finding.level === "blocker").length,
    warning: findings.filter((finding) => finding.level === "warning").length,
    info: findings.filter((finding) => finding.level === "info").length,
  };
}
