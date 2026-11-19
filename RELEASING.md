# Releasing @charchy/send

## Once: settings the publish workflow relies on

`.github/workflows/publish.yml` publishes from a `v*` tag. Set these before the first CI release.

1. **GitHub environment `npm`** — Settings → Environments → New environment `npm`:
   - **Required reviewers:** at least one owner. The staging job waits for that approval.
   - **Deployment branches and tags:** *Selected branches and tags* → add the tag pattern `v*`.
   - No secrets: publishing uses OIDC.
2. **Tag ruleset** — Settings → Rules → Rulesets → New tag ruleset:
   - Target: tags matching `v*`; enforcement **Active**.
   - Rules: **Restrict creations**, **Restrict updates**, **Restrict deletions**, **Block force pushes**.
   - Bypass list: repository admins only.
3. **npm Trusted Publisher** — on npmjs.com, package `@charchy/send` → Settings → Trusted publishing → GitHub Actions:
   - Organization or user `charchyy` · Repository `charchy-send` · Workflow filename `publish.yml` · Environment name `npm`
   - Allowed actions: leave **Allow `npm publish`** and **Allow `npm dist-tag`** unticked. CI only stages (`npm stage publish` is always allowed); a maintainer approves each version with 2FA.
   - npm sets this up on an existing package, so the first version is published by hand (below). A new trusted-publisher configuration expires unless it is used within 2 days, and its fields cannot be edited: create it just before the first tagged release (delete and recreate it if it expired).
   - Settings → Publishing access → *Require two-factor authentication and disallow bypass 2fa tokens*. CI keeps working (OIDC is not a token).
4. **Actions may open pull requests** — Settings → Actions → General → *Allow GitHub Actions to create and approve pull requests*, for `sync-openapi.yml`.

## The first publish (by hand)

As an npm account in the `charchy` org, from a clean checkout of `main`:

```bash
pnpm install --frozen-lockfile
pnpm run generate:check && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run lint:package
npm login                                        # with 2FA
npm publish --access public --provenance=false   # provenance is only possible from CI
```

`--provenance=false` overrides `publishConfig.provenance` for this one publish; every later version is published by CI, with provenance.

## Every release after that

1. Bump `version` in `package.json` **and** `src/version.ts` (a test keeps them equal), and add a `CHANGELOG.md` entry.
2. Merge to `main` (the workflow refuses a tag whose commit is not on `main`).
3. Tag that commit and push the tag:
   ```bash
   git tag v0.1.1 <commit on main>
   git push origin v0.1.1
   ```
4. Approve the `npm` environment deployment in the Actions run. The job **stages** the version.
5. Approve the staged version with 2FA: npmjs.com → `@charchy/send` → **Staged Packages** → **Approve** (or `npm stage list @charchy/send`, then `npm stage approve <id>`). Only then is it on the registry. Reject it there if anything looks wrong.

## Before tagging

- `pnpm build`, then `CHARCHY_SEND_BASE_URL=… CHARCHY_SEND_KEY=chy_test_… pnpm smoke` — a live check against a deployment, with a test key.
- `npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`.

## The contract

`openapi/openapi.yaml` is a copy of https://charchy.krd/docs/openapi.yaml. `sync-openapi.yml` checks it daily and opens a pull request when it changes; `pnpm generate` regenerates `src/generated/openapi.ts`, and `test/contract.types.ts` fails until the hand-shaped types in `src/types.ts` match.
