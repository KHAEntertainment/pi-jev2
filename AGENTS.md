# AGENTS.md

Maintainer rules for this repository.

## Layout

- This repository (`KHAEntertainment/pi-jev2`) is the canonical source for the `@khaentertainment/pi-jev2` package, a fork of `y0usaf/pi-jev`.
- `docs/SESSION-NOTES.md` is the running handoff log: decisions, what is verified, what is not. Read it before resuming work and append to it when you stop.

## Code

- Runtime dependencies stay at zero. Classification goes through the host's `ctx.modelRegistry.classify` (pi 0.99 or later); escalation transports use `fetch` or `pi.exec`. Do not add a client library.
- Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) belong in `peerDependencies` with a `"*"` range and must not be bundled. The same packages may be pinned in `devDependencies` for typechecking and tests.
- The gate fails open by design. Do not change an error path to block a tool call.
- Escalation fails open too: an orchestrator that does not answer (unreachable, timeout, cancel, unparseable reply) falls back to the `enforce` rule. It never resolves to a deny of its own.
- Shadow mode is the default. Any change that makes enforcement or escalation implicit needs justifying in the README.
- A threshold change belongs with a measurement in the `## Calibration` table, not with a guess. That applies per classifier: thresholds measured on Jev do not transfer to another model without its own rows (`npm run calibrate`).
- Before pushing: `npm run typecheck`, `npm run lint`, `npm test`.

## Publishing

- A GitHub release publishes from `.github/workflows/publish.yml` using trusted publishing (OIDC), so the repo holds no npm token and no OTP is involved.
- One-time setup (TODO, owner only):
  1. Create the `@khaentertainment` scope on npm.
  2. Bootstrap the package with one authenticated publish. npm cannot attach a trusted publisher to a package that does not exist yet.
  3. On npmjs.com, open the package settings and add a Trusted Publisher: user `KHAEntertainment`, repository `pi-jev2`, workflow `publish.yml`, environment empty.

  See `PUBLISHING.md`.
- The package name is scoped (`@khaentertainment/pi-jev2`) so it can sit next to the upstream `@y0usaf/pi-jev` without a name clash.
