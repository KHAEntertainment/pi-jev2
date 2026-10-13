# Publishing

> **Fork note (0.4.0).** This repository now publishes `@khaentertainment/pi-jev2`
> from `KHAEntertainment/pi-jev2`. None of the steps below has been done for
> the new name yet. They go in this order:
>
> 1. **Create the `@khaentertainment` scope** on npmjs.com, as a user or an organization.
> 2. **Bootstrap the package with one authenticated publish.** npm can configure a
>    trusted publisher only for a package that already exists. From the owner's
>    machine, logged in with 2FA (a passkey or security key), run
>    `npm publish --access public` on the release commit. Do not use a bypass
>    token: as the history below explains, npm restricts them for direct
>    publishing.
> 3. **Configure the trusted publisher** on the package's settings page: user
>    `KHAEntertainment`, repository `pi-jev2`, workflow `publish.yml`, environment
>    empty. Then set publishing access to "Require two-factor authentication and
>    disallow tokens".
> 4. **Later releases publish from the GitHub release workflow** with no secret.
>
> The history below is upstream's, kept for the method. When following it, read
> `@y0usaf/pi-jev` as `@khaentertainment/pi-jev2` and `y0usaf`/`pi-jev` as
> `KHAEntertainment`/`pi-jev2`.

npm has one durable route left for this package: trusted publishing (OIDC) from
`.github/workflows/publish.yml`. Classic tokens were revoked in November 2025,
TOTP 2FA is retired, and tokens that bypass 2FA are now restricted for direct
publishing — so "publish locally with a bypass token" is not a fallback, it is a
dead end. (The token still in `~/.npmrc` answers `401 Unauthorized`.)

## State, verified 2026-09-19

- **The trusted publisher is not configured.** A hand-run OIDC exchange for
  `@y0usaf/pi-jev` returns `OIDC token exchange error - package not found`, and
  `npm publish` from the workflow falls back to token lookup and fails with:

  ```
  npm error code ENEEDAUTH
  npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
  ```

- npm cannot explain itself here: every trusted-publishing failure — missing
  config, mismatched workflow filename, too-old CLI — collapses into that same
  message (npm/cli#9088). The `Preflight - OIDC trusted-publishing check` step in
  the workflow does the exchange by hand instead and prints the registry's own
  answer. Keep it.
- The workflow itself is correct: GitHub-hosted runner, `id-token: write`, Node 24
  (npm 11.19), no `registry-url` and no `NODE_AUTH_TOKEN`, so nothing shadows the
  OIDC token. `package.json`'s `repository.url` matches the GitHub repo.
- Versions 0.1.0 and 0.2.0 were published by hand and carry no provenance
  attestation — visible in the registry as two signature entries and no
  `dist.attestations`. The 0.2.0 release run failed with `E404`; the workflow was
  rewritten the next day but has only ever been exercised as a dry run.

## The one-time setup, and who can do it

npmjs.com -> package `@y0usaf/pi-jev` -> Settings -> Trusted Publisher -> GitHub
Actions:

| Field | Value |
|---|---|
| Organization or user | `y0usaf` |
| Repository | `pi-jev` |
| Workflow filename | `publish.yml` |
| Environment | (empty) |
| Allowed actions | allow `npm publish` (not stage-only) |

Adding it requires an interactive 2FA challenge on npmjs.com
(`POST /-/package/{package}/trust`), so it needs a **passkey or hardware key** on
the account. It cannot be done by a token, a script, or a CI job — this is the one
step a human has to take. While you are there, set Publishing access to
"Require two-factor authentication and disallow tokens"; the trusted publisher is
then the only way in.

After that, a GitHub release publishes with provenance and no stored secret, and
nothing expires.
