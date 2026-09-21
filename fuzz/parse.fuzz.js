/**
 * `parseProfile` is handed a JSON document fetched from a shop nobody here
 * controls, and everything downstream - the checks, the CSV, the survey totals
 * - assumes it came back well formed. An exception at shop forty of five
 * thousand ends the census, so the property worth checking is that any bytes
 * at all produce a profile rather than a stack trace.
 */
import { parseDomainList, toCsvRow } from "../dist/src/batch.js";
import { isDateVersion, parseProfile, urlsIn } from "../dist/src/profile.js";
import { isPublicUrl } from "../dist/src/probe.js";

export function fuzz(data) {
  const text = data.toString("utf8");

  const domains = parseDomainList(text);
  if (!Array.isArray(domains)) {
    throw new Error("parseDomainList must always return an array");
  }
  for (const domain of domains) {
    if (typeof domain !== "string" || domain === "") {
      throw new Error("parseDomainList produced an empty domain");
    }
  }

  isPublicUrl(text.slice(0, 300));
  isDateVersion(text.slice(0, 40));

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return;
  }

  // Refusing a document that is not a UCP profile is the contract, not a bug:
  // the caller reports that shop as not speaking the protocol. What must never
  // happen is an error about this code's own internals - a TypeError reading a
  // property of undefined ends a census of five thousand shops and names no
  // cause a reader can act on.
  let profile;
  try {
    profile = parseProfile(document);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("not a UCP profile")) return;
    throw error;
  }
  if (profile === null || typeof profile !== "object") {
    throw new Error("parseProfile must always return a profile object");
  }

  const urls = urlsIn(profile);
  if (!Array.isArray(urls)) {
    throw new Error("urlsIn must always return an array");
  }
  for (const entry of urls) {
    if (typeof entry.where !== "string" || typeof entry.url !== "string") {
      throw new Error("urlsIn produced an entry that is not {where, url}");
    }
  }

  toCsvRow({ domain: "x.example", outcome: "checked", profile, blockers: 0, warnings: 0 });
}
