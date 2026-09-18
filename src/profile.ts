/**
 * Reading a business's UCP profile.
 *
 * Every business that speaks the Universal Commerce Protocol publishes a
 * machine-readable profile at `/.well-known/ucp` declaring which services and
 * capabilities it supports. The protocol calls this permissionless onboarding:
 * any platform with a discoverable profile can transact with any business
 * without prior registration. The same property is what lets a merchant - or
 * anyone else - check from the outside whether that profile actually says what
 * the merchant thinks it says.
 *
 * Parsing here is deliberately tolerant. Real profiles in the wild disagree with
 * each other on small things (one merchant writes `extends` as a string where
 * another writes an array), and a checker that throws on the first surprise
 * cannot report the surprise.
 */

export interface ServiceBinding {
  version?: string;
  spec?: string;
  transport?: string;
  endpoint?: string;
  schema?: string;
}

export interface Capability {
  version?: string;
  spec?: string;
  schema?: string;
  extends: string[];
  requiresProtocolMin?: string;
}

export interface Profile {
  /** Protocol version the business declares it is speaking. */
  version?: string;
  supportedVersions: Record<string, string>;
  services: Record<string, ServiceBinding[]>;
  capabilities: Record<string, Capability[]>;
  /** Anything under `ucp` we did not model, kept so nothing is silently lost. */
  raw: Record<string, unknown>;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

/**
 * Keys that must never be copied out of a downloaded document.
 *
 * The profile is JSON from a third party, and every record built from it is
 * built with a plain object literal - but a key called `__proto__` arriving in
 * a `for...of Object.entries` loop is still worth dropping on the floor rather
 * than reasoning about.
 */
const FORBIDDEN_KEY = /^(__proto__|constructor|prototype)$/;

function safeEntries(value: unknown): [string, unknown][] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).filter(([key]) => !FORBIDDEN_KEY.test(key));
}

export function parseProfile(document: unknown): Profile {
  const root = (document as { ucp?: Record<string, unknown> })?.ucp;
  if (!root || typeof root !== "object") {
    throw new Error("not a UCP profile: no `ucp` object at the top level");
  }

  const services: Record<string, ServiceBinding[]> = {};
  for (const [name, value] of safeEntries(root.services)) {
    const entries = Array.isArray(value) ? value : [value];
    services[name] = entries.map((entry) => {
      const binding = (entry ?? {}) as Record<string, unknown>;
      return {
        version: typeof binding.version === "string" ? binding.version : undefined,
        spec: typeof binding.spec === "string" ? binding.spec : undefined,
        transport: typeof binding.transport === "string" ? binding.transport : undefined,
        endpoint: typeof binding.endpoint === "string" ? binding.endpoint : undefined,
        schema: typeof binding.schema === "string" ? binding.schema : undefined,
      };
    });
  }

  const capabilities: Record<string, Capability[]> = {};
  for (const [name, value] of safeEntries(root.capabilities)) {
    const entries = Array.isArray(value) ? value : [value];
    capabilities[name] = entries.map((entry) => {
      const capability = (entry ?? {}) as Record<string, unknown>;
      const requires = capability.requires as { protocol?: { min?: unknown } } | undefined;
      return {
        version: typeof capability.version === "string" ? capability.version : undefined,
        spec: typeof capability.spec === "string" ? capability.spec : undefined,
        schema: typeof capability.schema === "string" ? capability.schema : undefined,
        extends: asArray(capability.extends),
        requiresProtocolMin:
          typeof requires?.protocol?.min === "string" ? requires.protocol.min : undefined,
      };
    });
  }

  const supportedVersions: Record<string, string> = {};
  for (const [version, url] of safeEntries(root.supported_versions)) {
    if (typeof url === "string") supportedVersions[version] = url;
  }

  return {
    version: typeof root.version === "string" ? root.version : undefined,
    supportedVersions,
    services,
    capabilities,
    raw: root,
  };
}

/** Every URL the profile points at, with the field it came from. */
export function urlsIn(profile: Profile): { where: string; url: string }[] {
  const found: { where: string; url: string }[] = [];
  for (const [version, url] of Object.entries(profile.supportedVersions)) {
    found.push({ where: `supported_versions.${version}`, url });
  }
  for (const [name, bindings] of Object.entries(profile.services)) {
    for (const binding of bindings) {
      if (binding.endpoint) found.push({ where: `services.${name}.endpoint`, url: binding.endpoint });
      if (binding.schema) found.push({ where: `services.${name}.schema`, url: binding.schema });
      if (binding.spec) found.push({ where: `services.${name}.spec`, url: binding.spec });
    }
  }
  for (const [name, entries] of Object.entries(profile.capabilities)) {
    for (const entry of entries) {
      if (entry.schema) found.push({ where: `capabilities.${name}.schema`, url: entry.schema });
      if (entry.spec) found.push({ where: `capabilities.${name}.spec`, url: entry.spec });
    }
  }
  return found;
}

/**
 * UCP versions are dates, which makes comparison a string compare - but only
 * for strings that really are dates. Anything else sorts as "unknown" rather
 * than silently comparing wrong.
 */
const DATE_VERSION = /^\d{4}-\d{2}-\d{2}$/;

export function isDateVersion(value: string | undefined): value is string {
  return typeof value === "string" && DATE_VERSION.test(value);
}

/** -1, 0, 1, or null when either side is not a date-shaped version. */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  if (!isDateVersion(a) || !isDateVersion(b)) return null;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function profileUrl(domain: string): string {
  const base = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
  const url = new URL(base);
  // A profile lives at the root of the origin, whatever path was pasted in.
  return `${url.origin}/.well-known/ucp`;
}
