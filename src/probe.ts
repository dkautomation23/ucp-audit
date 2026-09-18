/**
 * Fetching the profile, and optionally checking that what it points at exists.
 *
 * The two are separate on purpose. Reading the profile is one request and can be
 * done politely against anyone. Probing every URL it declares is a dozen more,
 * so it only happens when asked for with `--probe`, and never against a
 * merchant you do not own without a reason.
 */

export interface Fetcher {
  get(url: string): Promise<{ status: number; contentType: string; body: string }>;
  head(url: string): Promise<number>;
}

export const USER_AGENT = "ucp-audit (+https://github.com/dkautomation23/ucp-audit)";

/**
 * Hosts this tool refuses to request, whatever a profile says.
 *
 * `--probe` follows URLs written by someone else. Run from inside a company
 * network, that is a request forgery primitive: a profile pointing at
 * `http://169.254.169.254/` or `http://localhost:8080/admin` would have the
 * operator's own machine fetch it. A readiness checker has no business reaching
 * anything that is not on the public internet, so it does not.
 */
const PRIVATE_HOST =
  /^(localhost|.*\.localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|\[::1\]|fc00:|fe80:|172\.(1[6-9]|2\d|3[01])\.)/i;

export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) return false;
  // A bare name with no dot cannot be a public host, and may be an internal one.
  if (!host.includes(".") && !host.includes(":")) return false;
  return true;
}

/** 5 MB. A profile is a few kilobytes; anything larger is not a profile. */
export const MAX_PROFILE_BYTES = 5 * 1024 * 1024;

export function httpFetcher(timeoutMs: number): Fetcher {
  return {
    async get(url) {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_PROFILE_BYTES) {
        throw new Error(`${url} returned more than ${MAX_PROFILE_BYTES} bytes; that is not a profile`);
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body,
      };
    },
    async head(url) {
      try {
        const response = await fetch(url, {
          method: "HEAD",
          headers: { "user-agent": USER_AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Many servers answer 405 to HEAD while serving GET perfectly well, so
        // that is not evidence of a missing endpoint.
        if (response.status === 405 || response.status === 501) {
          const fallback = await fetch(url, {
            method: "GET",
            headers: { "user-agent": USER_AGENT },
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
          });
          return fallback.status;
        }
        return response.status;
      } catch {
        return 0; // unreachable
      }
    },
  };
}

export interface FetchedProfile {
  status: number;
  contentType: string;
  body: string;
  bytes: number;
}

export async function fetchProfile(fetcher: Fetcher, url: string): Promise<FetchedProfile> {
  const response = await fetcher.get(url);
  return { ...response, bytes: Buffer.byteLength(response.body, "utf8") };
}

export interface UrlResult {
  where: string;
  url: string;
  status: number;
}

/**
 * Sequential, with a pause between requests.
 *
 * A readiness checker that hits a shop with twenty parallel requests is
 * indistinguishable from something worth blocking, and being blocked is a worse
 * outcome than being slow.
 */
export async function probeUrls(
  fetcher: Fetcher,
  urls: { where: string; url: string }[],
  delayMs = 200,
): Promise<UrlResult[]> {
  const results: UrlResult[] = [];
  const seen = new Map<string, number>();

  for (const entry of urls) {
    if (!isPublicUrl(entry.url)) {
      // -1 reads as "refused by us", which is a different fact from "dead".
      results.push({ ...entry, status: -1 });
      continue;
    }
    if (seen.has(entry.url)) {
      results.push({ ...entry, status: seen.get(entry.url)! });
      continue;
    }
    const status = await fetcher.head(entry.url);
    seen.set(entry.url, status);
    results.push({ ...entry, status });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
}
