# Contributing

## Setup

    npm ci

Node.js 22 or later (see `engines` in package.json; CI runs 22.x and 24.x).

## Build

    npm run build

Runs `tsc`, compiling `src/**/*.ts` and `test/**/*.ts` (see tsconfig.json)
to `dist/`.

## Test

    npm test

Runs `npm run build` and then `node --test "dist/test/**/*.test.js"` — the
compiled tests, via Node's own test runner. There is no separate lint or
format command; `tsc --strict` is what catches type errors.

## What CI checks

`.github/workflows/ci.yml` runs on every push to `main` and on every pull
request, on a Node.js 22.x / 24.x matrix:

    npm ci
    npm run build
    node --test "dist/test/**/*.test.js"

A pull request has to pass on both Node versions.

## Adding a new check

A check is a `Finding` pushed inside `checkProfile()` in `src/checks.ts` —
an `id`, a `level` (`blocker` / `warning` / `info`), a `title`, a `detail`,
and an optional `fix`. Add the failing case to `test/unit.test.ts` first: a
profile that should trigger the new finding, and an assertion on its `id`
and `level`. Then make it pass.

## Commit messages

One line, sentence case, no trailing period, says what the commit does for
the tool rather than how it does it — for example, from this repo's own
history:

    Ask the specification site which release is current
    Audit a list of shops in one run
    Ship the code and its types, not dangling source maps
    Test count, as the suite now runs it

## Scope

`dist/` is build output, not source — don't edit it or include it in a diff.
