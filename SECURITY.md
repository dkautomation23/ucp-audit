# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

- GitHub: use "Report a vulnerability" under this repository's Security tab
  (Private vulnerability reporting) —
  https://github.com/dkautomation23/ucp-audit/security/advisories/new
- Email: hello@dkautomation.dev

Include what you ran, what you expected, what happened instead, and the
smallest profile or command that reproduces it.

We aim to send a first response within 3 business days.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (latest release) | yes |
| anything older | no |

ucp-audit has not reached 1.0. Only the latest published release is
supported — update before reporting.

## Scope

ucp-audit reads a JSON profile from a domain you name (or from a file you
give it with `--file`), and — only with `--probe` — requests every URL that
profile declares. That profile is written by whoever runs the shop, not by
you, so what matters here is what a hostile profile can make the tool do.

In scope:

- A profile (or a redirect from a URL it declares) that makes `--probe` send
  a request to a non-public address — loopback, link-local, or a private
  range — despite the `isPublicUrl` check in `src/probe.ts` that exists to
  refuse exactly that.
- A profile response that defeats the 5 MB cap on what `httpFetcher.get`
  will read (`MAX_PROFILE_BYTES` in `src/probe.ts`) and causes unbounded
  memory use.
- A profile whose JSON reaches the prototype chain of an object ucp-audit
  builds from it. `src/profile.ts` strips `__proto__`, `constructor`, and
  `prototype` keys from a downloaded document for this reason; a way around
  that filter is in scope.
- `--batch` processing a domain list in a way that ignores its own
  concurrency limit (4 at a time, `src/batch.ts`) and sends an unbounded
  burst at a target.

Out of scope:

- A shop's UCP profile being reported as broken when it is, in fact,
  broken — that is the tool working. Open a normal issue if you think a
  specific finding is wrong.
- The security of a shop being audited, or of ucp.dev.
- `--file` reading whatever local path you give it, or `--json` / `--csv`
  writing to whatever local path you give it. That is your own machine and
  your own command line, not an attacker's input.
