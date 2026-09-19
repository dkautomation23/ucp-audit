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

/** How many hops a shop may send us on before we stop. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects ourselves, checking every hop.
 *
 * `redirect: "follow"` hands the decision to whoever answers: a shop's own
 * address passes the public-address check, and its 302 to `http://127.0.0.1` or
 * to a cloud metadata service is then followed without anyone asking. Checking
 * the URL we were given and letting the answer take us anywhere is not a check.
 *
 * The first URL is the operator's choice and is not second-guessed here; every
 * address a stranger sends us to afterwards is.
 */
async function followed(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_STATUS.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;

    const next = new URL(location, current).toString();
    if (!isPublicUrl(next)) {
      throw new Error(
        `${current} redirects to ${next}, which is not a public address; refusing to follow it`,
      );
    }
    current = next;
  }

  throw new Error(`${url} sent more than ${MAX_REDIRECTS} redirects; giving up`);
}

/**
 * Reads at most `limit` bytes and stops.
 *
 * `response.text()` reads whatever is sent before anyone can object, so a size
 * check that runs afterwards protects nothing: the memory is already spent.
 */
async function readCapped(response: Response, limit: number, url: string): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let text = "";
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error(`${url} returned more than ${limit} bytes; that is not a profile`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
}

export function httpFetcher(timeoutMs: number): Fetcher {
  return {
    async get(url) {
      const response = await followed(
        url,
        { headers: { accept: "application/json", "user-agent": USER_AGENT } },
        timeoutMs,
      );
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: await readCapped(response, MAX_PROFILE_BYTES, url),
      };
    },
    async head(url) {
      try {
        const response = await followed(
          url,
          { method: "HEAD", headers: { "user-agent": USER_AGENT } },
          timeoutMs,
        );
        // Many servers answer 405 to HEAD while serving GET perfectly well, so
        // that is not evidence of a missing endpoint.
        if (response.status === 405 || response.status === 501) {
          const fallback = await followed(
            url,
            { method: "GET", headers: { "user-agent": USER_AGENT } },
            timeoutMs,
          );
          await fallback.body?.cancel();
          return fallback.status;
        }
        await response.body?.cancel();
        return response.status;
      } catch {
        return 0; // unreachable, or a redirect we refused to follow
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
