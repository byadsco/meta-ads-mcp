# Contributing to Meta Ads MCP

Thanks for considering a contribution. This guide covers how to set up the project, the checks your change must pass, and the conventions we follow. If anything here is unclear, open an issue and we'll fix the docs.

## Code of conduct

Be kind, assume good intent, focus on the technical issue. Disrespectful behavior, harassment, or sustained derailing will get you disinvited.

## Project setup

```bash
git clone https://github.com/byadsco/meta-ads-mcp.git
cd meta-ads-mcp
npm install
cp .env.example .env   # fill in only what you need for the mode you'll test
```

You need **Node.js 22.13+**, the same major the Docker image runs on (Import Attributes syntax is used for JSON imports).

For multi-tenant HTTP testing locally:

```bash
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085
npm run dev
```

For single-tenant stdio testing (no Firestore, no Meta App):

```bash
META_ACCESS_TOKEN=EAA... npm run dev:stdio
```

## Required checks before opening a PR

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs all of these. Run them locally first — it's faster than waiting for CI:

```bash
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc, must produce a clean dist/
```

A separate CI job runs [gitleaks](https://github.com/gitleaks/gitleaks) against the diff using [.gitleaks.toml](.gitleaks.toml). If it flags your change, the credential pattern is real — do not whitelist; rotate and remove.

## Repository conventions

- **No code comments unless the *why* is non-obvious.** Names should explain the *what*. Don't add doc-block boilerplate.
- **No `--no-verify` on git commits.** If a hook fails, fix the cause.
- **Don't commit `.env*`** (except `.env.example`). They are gitignored; never `git add -f` them.
- **Tests live under [tests/](tests/)** mirroring the `src/` paths.
- **TypeScript strict mode.** No `any` unless you can justify it in review.
- **Zod schemas** for every tool input. The MCP SDK relies on them for both validation and the JSON Schema served to clients.
- **Pino structured logs.** Use `event=...` keys for anything an operator might grep for; never log a Meta token in plaintext (`maskToken()` exists for this).
- **ffmpeg for the keyframe tests.** [tests/media/ffmpeg.integration.test.ts](tests/media/ffmpeg.integration.test.ts) runs the real binary on a synthetic clip and skips itself when `ffmpeg` is not on your PATH. CI installs it and sets `FFMPEG_REQUIRED=1`, which turns that skip into a failure, so a missing binary is caught there, not on your machine.

## Adding a new tool

If you want to expose a Meta Marketing API endpoint that the 142 built-in tools don't cover, see the full walkthrough in [docs/adding-a-tool.md](docs/adding-a-tool.md). Quick summary:

- New file under [src/tools/](src/tools/) (or extend an existing category) exporting a `register*Tools(server)` function that calls `server.registerTool(name, { description, inputSchema, annotations }, handler)`.
- Use the `ads_*` naming convention (no `meta_` prefix) and the modern `registerTool` API. The legacy `server.tool(...)` form is deprecated upstream and removed from this repo in v3.0.0.
- Spread the right ToolAnnotations from [src/tools/_register.ts](src/tools/_register.ts) (`READ` / `CREATE` / `UPDATE` / `DELETE` / `TOGGLE` / `UPLOAD` / `TOKEN`) and prefix write-tool descriptions with `WRITE_WARNING`.
- The handler **must** route every Graph API call through `metaApiClient` ([src/meta/client.ts](src/meta/client.ts)) — never `fetch` directly. The shared client is what gives you bucketed rate-limiting, the circuit breaker, write pacing, and Meta-error → `McpError` classification.
- Register the new module in [src/tools/index.ts](src/tools/index.ts) and bump the count in [tests/tools/registration.test.ts](tests/tools/registration.test.ts). Mirror the source path under `tests/tools/` with a vitest using the shared mocks in [tests/setup.ts](tests/setup.ts) — `createMockMcpServer()` records both `server.tool` and `server.registerTool` calls.

## Auth surface — extra scrutiny

Changes under [src/auth/](src/auth/) and [src/transport/security-config.ts](src/transport/security-config.ts) carry higher risk. Even small changes here:

- Need a passing test that exercises the affected flow.
- Should explain in the PR description what the threat model assumption is and why your change preserves it.
- Will get reviewed by a maintainer before merge — please be patient if it takes a couple of days.

If your change touches the encryption layer, the OAuth provider, the session cookie shape, or the Firestore document layout, **mention it explicitly in the PR title** (e.g. `auth: rotate session cookie format`).

## Commit messages

Follow conventional-commits-ish prefixes:

- `feat:` new functionality
- `fix:` bug fix
- `chore:` deps, tooling, non-product changes
- `refactor:` no behavior change
- `docs:` README / SECURITY.md / inline docs
- `test:` test-only changes
- `ci:` GitHub Actions changes

Keep the subject under 70 characters and let the body explain *why*. The recent log on `main` is a good reference for tone.

## Pull requests

- **One topic per PR.** If you find adjacent issues, file separate PRs or issues.
- **Describe the change** — what, why, how to verify.
- **Reference the issue number** if any.
- **Self-review the diff** before requesting a review. Things you should catch yourself: leftover `console.log`, debug branches, hardcoded test values, commented-out code.
- **Update docs in the same PR** when you change behavior. README and SECURITY.md count.

## Reporting bugs

For regular bugs: open a GitHub Issue with a clear repro and the version (`git rev-parse HEAD`).

For **security** bugs: do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Releasing

Two automated paths run independently:

- **Deploy to Cloud Run** — every push to `main` triggers [.github/workflows/deploy.yml](.github/workflows/deploy.yml). Production updates immediately; there is no manual step.
- **Publish to GitHub Packages** — every published GitHub Release triggers [.github/workflows/publish.yml](.github/workflows/publish.yml). Pushes the npm package to `npm.pkg.github.com` (`@byadsco/meta-ads-mcp`) and the container image to `ghcr.io/byadsco/meta-ads-mcp` tagged with the release semver.

### Cutting a new release

1. **Open a PR that bumps the version.** It touches three files and nothing else: the `version` field in [package.json](package.json), the two `version` fields at the top of [package-lock.json](package-lock.json) (the root entry and `packages[""]`), and [CHANGELOG.md](CHANGELOG.md), where you leave `## [Unreleased]` in place with an empty body and insert `## [X.Y.Z] — YYYY-MM-DD` right below it so the existing body becomes the release's. Use semver: a patch for fixes only, a minor for new features, a major for anything that breaks an installer or a client, which includes raising `engines.node` and changing the published tool schemas. Edit the fields by hand. **Do not run `npm version` locally**: it creates a tag at the same time, which collides with the tag the release job makes on the squash-merge commit and leaves the repo half-bumped.
2. **Merge the PR.** Branch protection requires a CODEOWNERS review; since you can't review your own PR, admin bypass is fine for a version-only change.
3. **Let [deploy.yml](.github/workflows/deploy.yml) do the rest.** On the push to `main` it deploys, then its `release` job reads the version from `package.json` and, if no GitHub Release exists for `vX.Y.Z`, creates one at the deployed commit with `--generate-notes` (the body lists the merged PRs since the previous tag). Its `publish` job then runs [publish.yml](.github/workflows/publish.yml), which pushes the npm package to `npm.pkg.github.com` and the image to `ghcr.io/byadsco/meta-ads-mcp` tagged `X.Y.Z`, `X.Y`, `X` and `latest`. On a push that does not change the version the `release` job still runs but finds the release already exists and creates nothing, and the `publish` job is skipped. If the repository has a `CONTEXT7_API_KEY` secret, the same job also asks Context7 to re-index the documentation; without the secret that step is skipped.
4. **Watch it and verify the artifacts:**

    ```bash
    gh run list --workflow="Deploy to Cloud Run" --limit 1
    gh release view vX.Y.Z
    docker pull ghcr.io/byadsco/meta-ads-mcp:X.Y.Z
    npm view @byadsco/meta-ads-mcp@X.Y.Z --registry=https://npm.pkg.github.com
    ```

If the automation fails, which step failed decides the recovery. If the deploy went through but no release was created, create it by hand at the exact commit that was deployed, not at `main`, which may have moved: `gh release create vX.Y.Z --target <deployed sha> --generate-notes`, adding `--prerelease` when the version carries a pre-release identifier, since without it `publish.yml` would tag the package and the image as `latest`; `publish.yml` then runs on the `release: published` event. If the release exists but `publish.yml` failed, re-run that workflow run from the Actions tab rather than creating anything; `gh release create` on an existing tag errors with HTTP 422, which is the collision check you want. Do **not** add `--verify-tag`; that flag aborts when the tag does *not* exist remotely, the opposite of what you want.

For a **prerelease**, put the pre-release identifier in the version itself (`4.1.0-rc.1`). The release job detects the hyphen and marks the GitHub Release as a prerelease; `publish.yml` then publishes the npm package under the `next` dist-tag instead of `latest`, and the image gets only the full `X.Y.Z-rc.1` tag: no `X.Y`, `X` or `latest`, since those would point a stable-looking tag at a prerelease.

## Questions

Open a discussion or an issue. We try to respond within a few business days.
