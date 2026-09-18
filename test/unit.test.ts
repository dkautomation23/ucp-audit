import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { compareVersions, parseProfile, profileUrl, urlsIn, type Profile } from "../src/profile.js";
import { checkProfile, countByLevel, worstLevel, type Finding } from "../src/checks.js";
import { isPublicUrl, probeUrls, type Fetcher } from "../src/probe.js";
import { renderConsole, renderJson } from "../src/report.js";
import { run } from "../src/cli.js";
import {
  auditDomain,
  auditMany,
  parseDomainList,
  summarise as summariseBatch,
  toCsv,
  type DomainResult,
} from "../src/batch.js";

const work = mkdtempSync(join(tmpdir(), "ucp-audit-"));
after(() => rmSync(work, { recursive: true, force: true }));
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}
function has(findings: Finding[], id: string): Finding | undefined {
  return findings.find((finding) => finding.id === id);
}

/** A profile that passes everything, to vary one thing at a time from. */
function goodProfile(): unknown {
  return {
    ucp: {
      version: "2026-08-25",
      supported_versions: { "2026-04-08": "https://shop.example/.well-known/ucp/2026-04-08" },
      services: {
        "dev.ucp.shopping": [
          { version: "2026-08-25", transport: "mcp", endpoint: "https://shop.example/api/ucp/mcp" },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }],
        "dev.ucp.shopping.cart": [{ version: "2026-08-25" }],
        "dev.ucp.shopping.catalog.search": [{ version: "2026-08-25" }],
        "dev.ucp.shopping.catalog.lookup": [{ version: "2026-08-25" }],
      },
    },
  };
}

describe("reading a profile", () => {
  it("reads a real merchant profile recorded from the wild", () => {
    const profile = parseProfile(fixture("allbirds"));
    assert.equal(profile.version, "2026-08-25");
    assert.equal(Object.keys(profile.capabilities).length, 8);
    assert.deepEqual(Object.keys(profile.services), ["dev.ucp.shopping"]);
    assert.equal(profile.services["dev.ucp.shopping"]![0]!.transport, "mcp");
  });

  it("accepts `extends` as a string, because merchants write it both ways", () => {
    // chewy writes a bare string where allbirds writes an array; both are real.
    const chewy = parseProfile(fixture("chewy"));
    assert.deepEqual(chewy.capabilities["dev.ucp.shopping.fulfillment"]![0]!.extends, [
      "dev.ucp.shopping.checkout",
    ]);
    const allbirds = parseProfile(fixture("allbirds"));
    assert.equal(allbirds.capabilities["dev.ucp.shopping.fulfillment"]![0]!.extends.length, 2);
  });

  it("refuses a document that is not a profile", () => {
    assert.throws(() => parseProfile({ hello: "world" }), /not a UCP profile/);
    assert.throws(() => parseProfile(null), /not a UCP profile/);
  });

  it("builds the profile URL from anything a person might paste", () => {
    for (const input of ["allbirds.com", "https://allbirds.com", "https://allbirds.com/collections/shoes"]) {
      assert.equal(profileUrl(input), "https://allbirds.com/.well-known/ucp");
    }
  });

  it("compares dated versions, and refuses to compare anything else", () => {
    assert.equal(compareVersions("2026-01-23", "2026-08-25"), -1);
    assert.equal(compareVersions("2026-08-25", "2026-08-25"), 0);
    assert.equal(compareVersions("2026-09-01", "2026-08-25"), 1);
    assert.equal(compareVersions("v2", "2026-08-25"), null);
    assert.equal(compareVersions(undefined, "2026-08-25"), null);
  });

  it("collects every URL the profile points at", () => {
    const urls = urlsIn(parseProfile(fixture("allbirds")));
    assert.ok(urls.some((entry) => entry.where === "services.dev.ucp.shopping.endpoint"));
    assert.ok(urls.some((entry) => entry.where.startsWith("supported_versions.")));
    assert.ok(urls.length > 5);
  });
});

describe("what makes an agent skip a shop", () => {
  it("a complete, current profile has nothing to fix", () => {
    const findings = checkProfile(parseProfile(goodProfile()), { specVersion: "2026-08-25" });
    assert.deepEqual(findings, [], `unexpected: ${JSON.stringify(findings)}`);
    assert.equal(worstLevel(findings), null);
  });

  it("checkout without a catalogue is a blocker - the real chewy.com case", () => {
    const findings = checkProfile(parseProfile(fixture("chewy")), { specVersion: "2026-08-25" });
    const blocker = has(findings, "checkout-without-catalogue");
    assert.equal(blocker?.level, "blocker");
    assert.match(blocker!.detail, /cannot discover anything/);
  });

  it("a version behind the published spec is a warning, not a blocker", () => {
    const findings = checkProfile(parseProfile(fixture("chewy")), { specVersion: "2026-08-25" });
    assert.equal(has(findings, "version-behind")?.level, "warning");
  });

  it("the same profile against its own version raises no version warning", () => {
    const findings = checkProfile(parseProfile(fixture("chewy")), { specVersion: "2026-01-23" });
    assert.equal(has(findings, "version-behind"), undefined);
  });

  it("a capability requiring a newer protocol than declared is a blocker", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    (document.ucp.capabilities as Record<string, unknown>)["dev.ucp.shopping.discount"] = [
      { version: "2026-08-25", requires: { protocol: { min: "2026-12-01" } } },
    ];
    const finding = has(checkProfile(parseProfile(document)), "requires-unmet");
    assert.equal(finding?.level, "blocker");
    assert.match(finding!.title, /2026-12-01/);
  });

  it("extending a capability that is not declared is a blocker", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    (document.ucp.capabilities as Record<string, unknown>)["dev.ucp.shopping.discount"] = [
      { version: "2026-08-25", extends: ["dev.ucp.shopping.nonexistent"] },
    ];
    assert.equal(has(checkProfile(parseProfile(document)), "extends-missing")?.level, "blocker");
  });

  it("a plaintext endpoint is a blocker", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    (document.ucp.services as Record<string, unknown[]>)["dev.ucp.shopping"] = [
      { version: "2026-08-25", transport: "rest", endpoint: "http://shop.example/api" },
    ];
    const finding = has(checkProfile(parseProfile(document)), "endpoint-insecure");
    assert.equal(finding?.level, "blocker");
    assert.match(finding!.detail, /unencrypted/);
  });

  it("a transport with no endpoint has nowhere to send a request", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    (document.ucp.services as Record<string, unknown[]>)["dev.ucp.shopping"] = [
      { version: "2026-08-25", transport: "rest" },
    ];
    assert.equal(has(checkProfile(parseProfile(document)), "endpoint-missing")?.level, "blocker");
  });

  it("an embedded transport needs no endpoint and is not flagged", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    (document.ucp.services as Record<string, unknown[]>)["dev.ucp.shopping"] = [
      { version: "2026-08-25", transport: "embedded" },
    ];
    assert.equal(has(checkProfile(parseProfile(document)), "endpoint-missing"), undefined);
  });

  it("a missing version is a blocker, a malformed one too", () => {
    const empty = parseProfile({ ucp: { capabilities: {}, services: { s: [{}] } } });
    assert.equal(has(checkProfile(empty), "version-missing")?.level, "blocker");

    const odd = parseProfile({ ucp: { version: "v2", services: { s: [{}] }, capabilities: {} } });
    assert.equal(has(checkProfile(odd), "version-malformed")?.level, "blocker");
  });

  it("a profile with no services says there is nothing to talk to", () => {
    const bare = parseProfile({ ucp: { version: "2026-08-25", services: {}, capabilities: {} } });
    assert.equal(has(checkProfile(bare), "no-services")?.level, "blocker");
  });

  it("an endpoint on another host is a note, not a fault", () => {
    const findings = checkProfile(parseProfile(fixture("allbirds")), { host: "allbirds.com" });
    const note = has(findings, "endpoint-other-host");
    assert.equal(note?.level, "info");
    assert.match(note!.title, /myshopify\.com/);
    assert.equal(countByLevel(findings).blocker, 0, "a hosted endpoint must not fail the audit");
  });

  it("half a catalogue interface is a warning", () => {
    const document = goodProfile() as { ucp: Record<string, unknown> };
    delete (document.ucp.capabilities as Record<string, unknown>)["dev.ucp.shopping.catalog.lookup"];
    const finding = has(checkProfile(parseProfile(document)), "discovery-incomplete");
    assert.equal(finding?.level, "warning");
    assert.match(finding!.detail, /catalog\.lookup/);
  });
});

describe("safety of the tool itself", () => {
  it("refuses to request anything that is not on the public internet", () => {
    for (const url of [
      "http://localhost:8080/admin",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://[::1]/",
      "http://intranet/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      assert.equal(isPublicUrl(url), false, `${url} must be refused`);
    }
  });

  it("still allows ordinary public URLs", () => {
    for (const url of ["https://allbirds.com/api", "http://example.com/x", "https://ucp.dev/schema.json"]) {
      assert.equal(isPublicUrl(url), true, `${url} must be allowed`);
    }
  });

  it("a profile pointing inside the network is reported, not fetched", async () => {
    let requested = 0;
    const fetcher: Fetcher = {
      async get() {
        throw new Error("should not be called");
      },
      async head() {
        requested += 1;
        return 200;
      },
    };
    const results = await probeUrls(
      fetcher,
      [
        { where: "services.x.endpoint", url: "http://169.254.169.254/latest/meta-data/" },
        { where: "services.y.endpoint", url: "https://example.com/ok" },
      ],
      0,
    );
    assert.equal(requested, 1, "only the public URL may be requested");
    assert.equal(results[0]!.status, -1, "the internal address is refused, not called");
    assert.equal(results[1]!.status, 200);
  });

  it("does not let a downloaded document touch the prototype chain", () => {
    const hostile = JSON.parse(
      `{"ucp":{"version":"2026-08-25","capabilities":{"__proto__":[{"version":"x"}],"constructor":[{}]},"services":{"__proto__":[{}]}}}`,
    );
    const profile = parseProfile(hostile);
    assert.equal(Object.keys(profile.capabilities).length, 0);
    assert.equal(Object.keys(profile.services).length, 0);
    assert.equal(({} as Record<string, unknown>).version, undefined, "Object.prototype untouched");
  });

  it("asks for each URL once, however many times the profile repeats it", async () => {
    let calls = 0;
    const fetcher: Fetcher = {
      async get() {
        throw new Error("unused");
      },
      async head() {
        calls += 1;
        return 200;
      },
    };
    const same = { where: "a", url: "https://example.com/one" };
    await probeUrls(fetcher, [same, { ...same, where: "b" }, { ...same, where: "c" }], 0);
    assert.equal(calls, 1);
  });
});

describe("the whole run, against recorded profiles", () => {
  function replay(name: string, status = 200, contentType = "application/json"): Fetcher {
    return {
      async get() {
        return { status, contentType, body: readFileSync(join(FIXTURES, `${name}.json`), "utf8") };
      },
      async head() {
        return 200;
      },
    };
  }

  it("exits 1 and names the blocker for a shop agents cannot browse", async () => {
    let printed = "";
    const code = await run(["chewy.com"], replay("chewy"), (text) => {
      printed += text;
    });
    assert.equal(code, 1);
    assert.match(printed, /BLOCK.*catalogue cannot be searched/s);
    assert.match(printed, /2026-01-23/);
  });

  it("exits 0 for a complete, current shop", async () => {
    const code = await run(["allbirds.com", "--quiet"], replay("allbirds"), () => {});
    assert.equal(code, 0);
  });

  it("exits 2 and says plainly when no profile is published", async () => {
    let printed = "";
    const code = await run(["nothing.example"], replay("allbirds", 404), (text) => {
      printed += text;
    });
    assert.equal(code, 2);
    assert.match(printed, /cannot discover this shop at all/);
  });

  it("exits 2 when the profile is served as something other than JSON", async () => {
    const code = await run(["x.example", "--quiet"], replay("allbirds", 200, "text/html"), () => {});
    assert.equal(code, 2);
  });

  it("writes a JSON report a script can read", async () => {
    const path = join(work, "report.json");
    await run(["chewy.com", "--quiet", "--json", path], replay("chewy"), () => {});
    const report = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(report.protocolVersion, "2026-01-23");
    assert.equal(report.summary.blocker, 1);
    assert.ok(report.capabilities.includes("dev.ucp.shopping.checkout"));
    assert.ok(report.findings.some((finding: { id: string }) => finding.id === "checkout-without-catalogue"));
  });

  it("audits a saved profile with no network at all", async () => {
    const path = join(work, "saved.json");
    writeFileSync(path, JSON.stringify(goodProfile()), "utf8");
    const code = await run(["--file", path, "--quiet"], undefined, () => {});
    assert.equal(code, 0);
  });
});

describe("the report", () => {
  const profile: Profile = parseProfile(fixture("chewy"));
  const findings = checkProfile(profile, { specVersion: "2026-08-25" });
  const context = { target: "chewy.com", profileUrl: "https://chewy.com/.well-known/ucp", bytes: 3217, specVersion: "2026-08-25" };

  it("leads with what the shop can and cannot do", () => {
    const text = renderConsole(profile, findings, context);
    assert.match(text, /protocol\s+2026-01-23/);
    assert.match(text, /caps\s+3:/);
    assert.match(text, /1 blocker\(s\)/);
  });

  it("says so plainly when there is nothing to fix", () => {
    const clean = parseProfile(goodProfile());
    const text = renderConsole(clean, [], { ...context, target: "shop.example" });
    assert.match(text, /Nothing to fix/);
  });

  it("machine-readable output carries the findings and the summary", () => {
    const report = JSON.parse(renderJson(profile, findings, context));
    assert.equal(report.target, "chewy.com");
    assert.equal(report.summary.blocker, 1);
    assert.ok(Array.isArray(report.capabilities));
  });
});

describe("auditing a list of shops", () => {
  /** Answers each domain from a table, so nothing here reaches the network. */
  function catalogue(byHost: Record<string, { status: number; body?: unknown; type?: string }>): Fetcher {
    return {
      async get(url) {
        const host = new URL(url).host;
        const entry = byHost[host];
        if (!entry) throw new Error(`no fixture for ${host}`);
        return {
          status: entry.status,
          contentType: entry.type ?? "application/json",
          body: entry.body === undefined ? "" : JSON.stringify(entry.body),
        };
      },
      async head() {
        return 200;
      },
    };
  }

  it("reads a domain list the way a person writes one", () => {
    const domains = parseDomainList(
      "allbirds.com\n" +
        "# a comment\n" +
        "\n" +
        "https://glossier.com/collections/all\n" +
        "  gymshark.com  \n" +
        "allbirds.com\n" +
        "not a host at all\n"
    );
    assert.deepEqual(domains, ["allbirds.com", "glossier.com", "gymshark.com"]);
  });

  it("tells apart the six things that can happen to a domain", async () => {
    const fetcher = catalogue({
      "good.example": { status: 200, body: fixture("allbirds") },
      "none.example": { status: 404 },
      "rude.example": { status: 403 },
      "busy.example": { status: 429 },
      "html.example": { status: 200, body: {}, type: "text/html" },
      "odd.example": { status: 200, body: { hello: "world" } },
    });

    const outcomes: Record<string, string> = {};
    for (const host of ["good", "none", "rude", "busy", "html", "odd"]) {
      const result = await auditDomain(fetcher, `${host}.example`, "2026-08-25");
      outcomes[host] = result.outcome;
    }

    assert.equal(outcomes.good, "checked");
    assert.equal(outcomes.none, "no-profile");
    assert.equal(outcomes.rude, "blocked", "403 is the shop refusing us, not the shop being broken");
    assert.equal(outcomes.busy, "blocked");
    assert.equal(outcomes.html, "not-json");
    assert.equal(outcomes.odd, "invalid");
  });

  it("records whether an agent could find anything to buy", async () => {
    const fetcher = catalogue({
      "full.example": { status: 200, body: fixture("allbirds") },
      "thin.example": { status: 200, body: fixture("chewy") },
    });
    const full = await auditDomain(fetcher, "full.example", "2026-08-25");
    const thin = await auditDomain(fetcher, "thin.example", "2026-08-25");

    assert.equal(full.catalogueSearchable, true);
    assert.equal(thin.catalogueSearchable, false);
    assert.equal(thin.blockers, 1);
    assert.match(thin.topBlocker!, /catalogue cannot be searched/);
  });

  it("keeps the order of the list however the answers arrive", async () => {
    const domains = Array.from({ length: 12 }, (_, i) => `shop${i}.example`);
    const fetcher: Fetcher = {
      async get(url) {
        const index = Number(/shop(\d+)/.exec(url)![1]);
        // Later domains answer sooner, so order cannot come from timing.
        await new Promise((resolve) => setTimeout(resolve, (12 - index) * 2));
        return { status: 404, contentType: "application/json", body: "" };
      },
      async head() {
        return 200;
      },
    };
    const results = await auditMany(fetcher, domains, { specVersion: "2026-08-25", delayMs: 0 });
    assert.deepEqual(results.map((r) => r.domain), domains);
  });

  it("never runs more than four requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher: Fetcher = {
      async get() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: 404, contentType: "application/json", body: "" };
      },
      async head() {
        return 200;
      },
    };
    await auditMany(fetcher, Array.from({ length: 20 }, (_, i) => `s${i}.example`), {
      specVersion: "2026-08-25",
      concurrency: 99,          // asking for more must not grant it
      delayMs: 0,
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
  });

  it("a refused domain never counts as a broken one", () => {
    const results: DomainResult[] = [
      { domain: "a", outcome: "checked", catalogueSearchable: false, blockers: 1, protocolVersion: "2026-08-25", findings: [] },
      { domain: "b", outcome: "blocked", httpStatus: 403 },
      { domain: "c", outcome: "no-profile", httpStatus: 404 },
      { domain: "d", outcome: "unreachable" },
    ];
    const totals = summariseBatch(results, "2026-08-25");
    assert.equal(totals.total, 4);
    assert.equal(totals.checked, 1, "only the audited domain is a denominator");
    assert.equal(totals.withoutCatalogue, 1);
    assert.equal(totals.byOutcome.blocked, 1);
    assert.equal(totals.byOutcome["no-profile"], 1);
    assert.equal(totals.byOutcome.unreachable, 1);
  });

  it("counts how far behind the published version the audited shops are", () => {
    const results: DomainResult[] = [
      { domain: "a", outcome: "checked", protocolVersion: "2026-01-23", findings: [], blockers: 0 },
      { domain: "b", outcome: "checked", protocolVersion: "2026-08-25", findings: [], blockers: 0 },
    ];
    const totals = summariseBatch(results, "2026-08-25");
    assert.equal(totals.behindSpec, 1);
    assert.deepEqual(totals.versions, { "2026-01-23": 1, "2026-08-25": 1 });
  });

  it("writes CSV a spreadsheet can open, commas and all", () => {
    const csv = toCsv([
      {
        domain: "thin.example",
        outcome: "checked",
        httpStatus: 200,
        protocolVersion: "2026-01-23",
        capabilities: ["a", "b", "c"],
        catalogueSearchable: false,
        blockers: 1,
        topBlocker: 'Checkout is offered, but the catalogue cannot be searched',
      },
      { domain: "none.example", outcome: "no-profile", httpStatus: 404 },
    ]);
    const rows = csv.trimEnd().split("\n");
    assert.equal(rows[0], "domain,outcome,http_status,protocol_version,capabilities,catalogue_searchable,blockers,top_blocker");
    assert.match(rows[1]!, /^thin\.example,checked,200,2026-01-23,3,no,1,"Checkout is offered, but/);
    assert.equal(rows[2], "none.example,no-profile,404,,,,,");
  });

  it("the whole batch run writes its CSV and does not fail on a broken shop", async () => {
    const list = join(work, "shops.txt");
    const csv = join(work, "survey.csv");
    writeFileSync(list, "good.example\nthin.example\nnone.example\n", "utf8");

    const fetcher = catalogue({
      "good.example": { status: 200, body: fixture("allbirds") },
      "thin.example": { status: 200, body: fixture("chewy") },
      "none.example": { status: 404 },
    });

    let printed = "";
    const code = await run(["--batch", list, "--csv", csv], fetcher, (text) => {
      printed += text;
    });

    assert.equal(code, 0, "a survey is not a gate: a broken shop is not a failed run");
    assert.match(printed, /3 domain\(s\)/);
    assert.match(printed, /agents cannot search the catalogue\s+1/);
    const written = readFileSync(csv, "utf8");
    assert.equal(written.trimEnd().split("\n").length, 4, "header plus three rows");
  });

  it("exits 2 when not one domain could be checked", async () => {
    const list = join(work, "all-dead.txt");
    writeFileSync(list, "rude.example\nbusy.example\n", "utf8");
    const fetcher = catalogue({ "rude.example": { status: 403 }, "busy.example": { status: 429 } });
    const code = await run(["--batch", list, "--quiet"], fetcher, () => {});
    assert.equal(code, 2, "a run that verified nothing must not look like a clean run");
  });
});
