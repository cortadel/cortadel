# Releasing the `integrations/` packages

Maintainer runbook for the twelve framework integration packages under `integrations/`. Everything
here is either a **one-time registry setup step a human must perform** (a workflow file cannot create
a trusted publisher or mint a token) or the **per-release procedure** once that setup is done.

The SDKs in `sdk/` release separately, on their own `sdk-ts-v*` / `sdk-py-v*` / `sdk-dotnet-v*` tags —
see `CONTRIBUTING.md#releasing`. Nothing in this file changes how they work.

> **Read this before your first release.** As of this writing **none of the twelve is published.**
> `.github/workflows/integrations.yml` has the publish jobs, but two of the three registries still
> need a human to configure something first. A release tag pushed before then runs all the gates,
> passes them, and then fails at the registry call.

---

## What must exist before the first tag

The whole checklist, in one place. Two rows need work; one does not.

| Registry | What the workflow needs | Status | Do this |
| --- | --- | --- | --- |
| **npm** (8 packages) | the **`NPM_TOKEN_INTEGRATIONS`** repository secret, minted *All Packages / Read and write* | **Missing — you must create it.** `gh secret list` on `cortadel/cortadel` shows `NPM_TOKEN` and `PYPI_TOKEN` but **no** `NPM_TOKEN_INTEGRATIONS`. `NPM_TOKEN` is the SDK's narrower secret and is **not** a substitute. | [§1.2](#12-phase-1--mint-the-bootstrap-token--one-time-per-registry) |
| **PyPI** (3 packages) | the **`PYPI_TOKEN`** repository secret, **account-scoped** | **Already configured — nothing to do.** The secret exists, and `publish-pypi` uses it exactly as `python.yml` does for the `cortadel` SDK. No trusted publisher is registered on pypi.org and none is wanted. | [§2](#2-pypi--nothing-to-configure) |
| **NuGet** (1 package) | a nuget.org **trusted-publishing policy** whose *Workflow file* is `integrations.yml` | **Missing — you must create it.** `dotnet.yml`'s existing policy names a different workflow file and can never match this one. | [§3.1](#31-create-the-policy--one-time-per-registry) |

Nothing else is a prerequisite. Everything else in this file is either the per-release procedure, or
optional hardening explicitly labelled as such.

The one thing on the PyPI row that is **not** verifiable from CI: that `PYPI_TOKEN`'s scope really is
*Entire account* rather than *Project: cortadel*. See [§2.1](#21-pre-flight--optional-one-time) — it
costs one page load and the failure mode if the assumption is wrong is a spent version number.

---

## 0. The tag scheme

```
integration-<directory-slug>-v<version>
```

The slug is the **directory name under `integrations/`**, never the registry package name. They are
not always the same:

| Tag | Directory | Publishes as | Registry |
| --- | --- | --- | --- |
| `integration-claude-agent-sdk-v0.1.0` | `claude-agent-sdk` | `@cortadel/claude-agent-sdk` | npm |
| `integration-deepagents-v0.1.0` | `deepagents` | `@cortadel/deepagents` | npm |
| `integration-langgraph-v0.1.0` | `langgraph` | `@cortadel/langgraph` | npm |
| `integration-mastra-v0.1.0` | `mastra` | `@cortadel/mastra` | npm |
| `integration-n8n-nodes-cortadel-v0.1.0` | `n8n-nodes-cortadel` | `n8n-nodes-cortadel` (**unscoped** — n8n's community-node naming rule requires it) | npm |
| `integration-openai-agents-v0.1.0` | `openai-agents` | `@cortadel/openai-agents` | npm |
| `integration-openclaw-v0.1.0` | `openclaw` | `@cortadel/openclaw` | npm |
| `integration-vercel-ai-sdk-v0.1.0` | `vercel-ai-sdk` | **`@cortadel/vercel-ai-provider`** | npm |
| `integration-crewai-v0.1.0` | `crewai` | `cortadel-crewai` | PyPI |
| `integration-google-adk-v0.1.0` | `google-adk` | `cortadel-google-adk` | PyPI |
| `integration-pydantic-ai-v0.1.0` | `pydantic-ai` | `cortadel-pydantic-ai` | PyPI |
| `integration-microsoft-agent-framework-v0.1.0` | `microsoft-agent-framework` | `Cortadel.AgentFramework` | NuGet |

`vercel-ai-sdk` → `@cortadel/vercel-ai-provider` is the row to remember: the directory and the
package name disagree, which is why the tag keys on the directory and the workflow reads the package
name out of the manifest.

The tag's version must equal the version in that package's manifest exactly. `release-plan` fails the
run on any mismatch, before any registry is contacted — see `CONTRIBUTING.md#releasing`.

---

## 1. npm — one-time setup for the eight npm packages

npm is the awkward one, and it is worth understanding why before starting: **npm trusted publishing
cannot create a package that does not already exist.** "Package must exist" is a documented
prerequisite, the website settings page a trusted publisher is configured on does not exist for a
package with no versions, and npm has no PyPI-style pre-registration (npm/cli#8544 is open). So the
first publish of each package *must* be token-authenticated, and OIDC can only take over afterwards.

This is a four-phase migration. Phases 1–2 are what unblock the first release; phases 3–4 remove the
token and should follow promptly — npm caps write-permission granular tokens at **90 days**, so a
setup left at phase 2 has a built-in expiry that will break a release without warning.

> **Classic/automation tokens no longer exist.** Creation was disabled 2025-11-05 and every classic
> token was permanently revoked 2025-11-19. Granular access tokens are the only kind. Any older
> runbook mentioning an "automation token" is stale.

### 1.1 Pre-flight — one-time, per registry

- [ ] Confirm you are logged in to npmjs.com as the account that owns the `@cortadel` scope. That is
      the account that published `@cortadel/sdk@1.0.0` (maintainer `serhii-seletskyi`,
      `admin@cortadel.com`). The scope is already ours — `@cortadel/sdk` exists — so there is no
      squatting risk, but the bootstrap token has to come from this account.
- [ ] Determine whether `@cortadel` is a **user scope** or an npm **Organization**. If it is an Org,
      open Organization settings and check whether *Require two-factor authentication* is enforced.
      If it is, a Bypass-2FA token will be **rejected**, and phase 1 must instead be done
      interactively from a laptop with an OTP rather than from CI.
- [ ] Confirm for yourself that the secret really is absent before minting anything —
      `gh secret list --repo cortadel/cortadel`. At the time of writing it lists `NPM_TOKEN` and
      `PYPI_TOKEN` but **no `NPM_TOKEN_INTEGRATIONS`**, which is the whole reason phases 1–2 below
      exist. `NPM_TOKEN` is the SDK's own narrower secret and is **not** a substitute: `publish-npm`
      reads `NPM_TOKEN_INTEGRATIONS` by name, and an unset secret expands to the empty string rather
      than failing, so the first symptom of skipping this is a `publish` step that authenticates as
      nobody.
- [ ] Note for later: `@cortadel/sdk@1.0.0` has **no provenance attestation**
      (`https://registry.npmjs.org/-/npm/v1/attestations/@cortadel/sdk@1.0.0` returns 404), and its
      recorded `_nodeVersion`/`_npmVersion` do not match `typescript.yml`'s pin. That release was
      almost certainly published by hand, which means **the SDK's own CI npm publish path is
      unproven**. Do not assume `secrets.NPM_TOKEN` works. This is tracked separately from the
      integrations release; the integrations workflow asserts provenance on every publish so the same
      thing cannot happen again silently.

### 1.2 Phase 1 — mint the bootstrap token — one-time, per registry

- [ ] npmjs.com → profile picture (upper right) → **Access Tokens** → **Generate New Token**.
- [ ] Name it something disposable and dated: `cortadel-integrations-bootstrap-2026-08`.
- [ ] Tick **Bypass 2FA**. Required for any CI publish while account 2FA is set to "auth and writes".
      Do **not** tick it if a package or the organization enforces 2FA fully — npm rejects the token
      and you must publish interactively instead.
- [ ] Leave **Allowed IP Ranges** empty. GitHub-hosted runner egress IPs are not stable.
- [ ] Under *Packages and scopes*: Permissions = **Read and write**, Select Packages =
      **All Packages**.

      Not "Only select packages and scopes". Two independent reasons: the package picker enumerates
      *existing* packages, and none of the eight exists yet; and a `@cortadel`-scoped token cannot
      publish the unscoped `n8n-nodes-cortadel` at all. npm's documentation also never states whether
      selecting a scope covers packages created in that scope *in future* — it is genuinely ambiguous
      in the docs — so "All Packages" is chosen as the option that unambiguously works.

      > **Blast radius, stated as plainly as NuGet's in §3.** *All Packages / Read and write* means
      > exactly that: while this token exists it can publish **`@cortadel/sdk`** too — the package
      > `typescript.yml` releases under a different and narrower secret — and anything else the
      > account owns. And it is not only yours to use: anyone with write access to `cortadel/cortadel`
      > can reach it by pushing any `integration-*-v*` tag, or by dispatching `integrations.yml`
      > against one. Nothing about the token is scoped to the eight packages it was minted for.
      >
      > This is inherent to npm's bootstrap problem, not a misconfiguration — but it is the reason
      > phase 4 (§1.5) is a deadline rather than housekeeping. The over-scoping is bounded by nothing
      > except the expiry you set below and the deletion at phase 4.
- [ ] Leave the **Organizations** section at *No access*. Org access manages settings and teams; per
      npm's docs it "does not give the token the right to publish packages managed by the
      organization".
- [ ] Set **Expiration** to the shortest workable window — 7 days is plenty; 90 days is the hard
      maximum for a write token. This token is deleted at phase 4.
- [ ] **Generate Token**, copy it.
- [ ] Store it as the repository secret **`NPM_TOKEN_INTEGRATIONS`** in `cortadel/cortadel`
      (Settings → Secrets and variables → Actions).

      **Not `NPM_TOKEN`.** That name belongs to `typescript.yml`'s SDK release and is narrower than
      what this needs. Keeping them separate means phase 4 can delete this secret without touching the
      SDK's release path.

### 1.3 Phase 2 — the first publish — one-time, **per package** (×8)

- [ ] Cut one tag and let it run end to end before doing the rest. Suggested first:
      `integration-langgraph-v0.1.0`.
- [ ] Confirm the run's `publish-npm` job reached *Verify the published version actually carries
      provenance* and that it passed. If provenance is missing the job fails deliberately — the
      package is published and cannot be unpublished cleanly, but a provenance-less release must not
      report green. Investigate before tagging the other seven.
- [ ] Then tag the remaining seven, one at a time or together:
      `integration-claude-agent-sdk-v0.1.0`, `integration-deepagents-v0.1.0`,
      `integration-mastra-v0.1.0`, `integration-n8n-nodes-cortadel-v0.1.0`,
      `integration-openai-agents-v0.1.0`, `integration-openclaw-v0.1.0`,
      `integration-vercel-ai-sdk-v0.1.0`.
- [ ] Confirm all eight appear on the registry at `0.1.0`.

### 1.4 Phase 3 — attach a trusted publisher — one-time, **per package** (×8)

This is interactive and **cannot be done from CI**: npm explicitly refuses Bypass-2FA granular tokens
for `npm trust`, and requires an account-level 2FA challenge.

- [ ] On your laptop: `npm install -g npm@^11.15.0`, then `npm login`. Account-level 2FA must be
      enabled, and you must not be authenticated with the Bypass-2FA token from phase 1.
- [ ] For each of the eight packages:

      ```bash
      npm trust github <package> --allow-publish \
        --repository cortadel/cortadel \
        --file integrations.yml \
        --yes
      sleep 2
      ```

      The `sleep 2` is npm's own recommendation for configuring packages in bulk — it is there to
      avoid rate limiting, and two seconds is the interval that fits roughly 80 packages inside the
      five-minute 2FA window below. Eight is nowhere near that ceiling, but the sleep costs sixteen
      seconds in total and removes the failure mode outright.

      On the **first** invocation, complete the 2FA challenge and take the npm website's option to
      *skip two-factor authentication for the next 5 minutes* — the remaining seven then run
      unprompted. `--yes` suppresses the *"Do you want to proceed?"* confirmation, not the 2FA
      challenge; the first call still prompts for that.
- [ ] **The flag is `--file`, not `--workflow`.** There is no `--workflow` option and there never
      was. npm's usage line for this subcommand is

      ```
      npm trust github [package] --file [--repo|--repository] [--env|--environment]
                                 [--allow-publish] [--allow-stage-publish] [-y|--yes]
      ```

      and `file` is the one option declared `required: true`, so `--workflow integrations.yml` does
      not merely get ignored — npm parses it as an unknown config, finds no `--file`, and aborts
      with *"GitHub Actions Workflow must be specified with the file option"*. Every other flag in
      the command above was checked against the same source (`lib/commands/trust/github.js` and
      `lib/trust-cmd.js`): `--repository` is real and takes `--repo` as an alias, `--allow-publish`
      is real and *some* permission flag is mandatory (omitting both fails with *"At least one
      permission flag is required"*), and `--yes` is real with the alias `-y`.
- [ ] Verify with `npm trust list <package>` for each of the eight. That subcommand takes only the
      package name — no flags are needed and none of the ones above apply to it.

      Be precise about what npm checks and when, because the two are easy to conflate. The CLI
      validates the *shape* of what you pass, locally, before any request: `--file` must end in
      `.yml` or `.yaml` and must be a bare filename (passing a path fails with *"GitHub Actions
      workflow must be just a file not a path"*), and `--repository` must have exactly two
      `owner/repo` segments. Nothing validates that the repository or the workflow it names actually
      **exists**, or that it is the right one — a configuration pointing at a plausible-looking file
      that is not this workflow saves cleanly and surfaces only as an `ENEEDAUTH` at the next
      publish. So `integrations.yml` is what to pass: not `integrations`, not
      `.github/workflows/integrations.yml`, and case-sensitively that exact filename.
- [ ] Leave **Environment name** blank, matching the workflow (which sets no `environment:`) — that
      is done by simply omitting `--env`, not by passing it empty.
- [ ] Note: only **one** trusted publisher per package. Changing it later requires
      `npm trust revoke <package> --id <id>` first. Pass the package name explicitly: the positional
      is optional only because npm falls back to the `package.json` in the current directory, and run
      from anywhere else it fails with *"Package name must be specified either as an argument or in
      the package.json file"*. Get the `<id>` from `npm trust list <package>`.

### 1.5 Phase 4 — remove the token — one-time, per registry

- [ ] Edit `.github/workflows/integrations.yml`'s `publish-npm` job — the exact edit is spelled out in
      a comment on the *Publish to npm* step:
      1. delete the `env:` block (`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN_INTEGRATIONS }}`);
      2. delete ` --provenance` from the command — with trusted publishing the CLI generates and
         publishes the attestation itself.

      Keep `registry-url` on `actions/setup-node`; npm's own recipe keeps it and simply omits the
      token.

      **Keep `node-version: '24.x'` — it is load-bearing, and it is the line most likely to be
      "simplified" back into a broken state.** An earlier draft of this file asserted the opposite:
      that the job "publishes with **pnpm** and never invokes npm at all, so npm's version is
      irrelevant to it". That is backwards. On pnpm 10, `pnpm publish` packs a tarball and then
      shells out to the npm CLI on `PATH` — literally
      `runNpm(opts.npmPath, ["publish", …])`, with `runNpm` resolving to `npmPath ?? "npm"`
      (read out of pnpm 10.30.0's own `dist/pnpm.cjs`). pnpm's bundle contains no OIDC code at all,
      so **the trusted-publishing exchange is npm's**. pnpm's maintainers say so themselves in the
      fix for pnpm/pnpm#11513: *"This worked in v10 because `pnpm publish` shelled out to
      `npm publish`, whose own OIDC flow handled the case."*

      So npm's documented floor binds: **npm ≥ 11.5.1 and Node ≥ 22.14.0**
      ([docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)). Measured
      across the whole of `nodejs.org/dist/index.json` on 2026-08-14, **no Node 22 release ships
      npm 11** — the entire 22 line is npm 10.5.1 … 10.9.8, newest `v22.23.2 → npm 10.9.8` — so the
      `'22.x'` this file used to mandate could never have met the floor it was later claimed to be
      unrelated to. `'24.x'` resolves to `v24.19.0 → npm 11.17.0`, and Node 24 is the current LTS.

      This was never a risk to phases 1–3: those are token-authenticated, and a token publish with
      `--provenance` works fine on npm 10.9.x. It bites **here**, at phase 4, as a bare 404 — which
      looks exactly like "package does not exist" and misdiagnoses badly.

      The pnpm pin is a *separate* real constraint and it stays: `pnpm/action-setup` holds
      `version: 10`. Avoid pnpm 11 precisely **because it stopped delegating** — that is what took
      npm's OIDC flow out of the path and produced the 404 in pnpm/pnpm#11513. (The placeholder half
      of that bug was fixed in #11526, but that fix moves OIDC into pnpm rather than npm, so
      adopting pnpm 11 would be its own migration needing its own rehearsal — not a version bump.)
- [ ] Bump **one** package to `0.1.1` and tag it, to prove the OIDC path end to end. **This step is
      mandatory, and it is the one that actually de-risks the migration** — no version pin in the
      workflow proves the OIDC path, only a publish that used it does. Do it before the next step,
      while the token is still there to fall back on.

      **Rehearse on the least consequential of the eight, not a flagship.** A failed rehearsal is
      not free: the version number is burned either way, and npm never lets a version be reused, so
      a botched attempt leaves a permanent stray `0.1.1` on whatever package you chose. Pick the one
      whose consumers you would least mind seeing that on, and decide it deliberately rather than
      reaching for whichever package is nearest to hand.

      Note this is the **opposite** criterion to §1.3's suggested first publish. There you want a
      representative canary, because you are proving the path for seven more packages that have not
      shipped yet. Here the path is already proven for token publishes and the only open question is
      the auth swap, so you want the smallest blast radius instead.
- [ ] Only after that proof: delete the `NPM_TOKEN_INTEGRATIONS` repository secret, and revoke the
      token itself (npmjs.com → Access Tokens → Delete).
- [ ] Update `CONTRIBUTING.md#releasing`, which will then be describing the wrong mechanism for npm.
- [ ] Optional hardening, **per package**: package Settings → *Require two-factor authentication and
      disallow tokens*. Per npm's docs that setting "only affects traditional token authentication.
      Your trusted publishers will continue to work normally."

---

## 2. PyPI — nothing to configure

**There is no registry-side setup for PyPI.** No pending publisher to register, no trusted publisher
to create, nothing to click on pypi.org before the first tag. This section exists to say so, and to
record the two things that are worth checking anyway.

`publish-pypi` authenticates with the **`PYPI_TOKEN` repository secret** — the same secret, the same
pinned action and the same `user: __token__` / `password:` inputs `python.yml` already uses to publish
the `cortadel` SDK. That is the repository owner's decision, and it is also what makes creating three
brand-new projects possible:

- The token is **account-scoped**, so it can create projects that do not exist yet — and all three of
  `cortadel-crewai`, `cortadel-google-adk` and `cortadel-pydantic-ai` are brand new.
- A **project-scoped** token could not, and this is the detail to remember if the secret is ever
  re-minted narrower: Warehouse's `ProjectName`/`ProjectID` caveat verifiers reject any context
  outside the projects the token enumerates. Worse, Warehouse checks the macaroon's permission *after*
  `create_project` runs, so a project-scoped attempt can leave an empty `cortadel-crewai` project
  squatting the name with zero releases.

Possible follow-up, not scheduled and deliberately not implemented: once the three projects exist,
migrating them to PyPI trusted publishing would remove the stored token from this path and turn on
PEP 740 attestations.

> **An earlier revision of this section said the opposite — ignore any copy of it you still have.** It
> told you to register three *pending publishers* at `https://pypi.org/manage/account/publishing/` and
> warned you off `secrets.PYPI_TOKEN` entirely. That is not how this repository publishes. A pending
> publisher registered by mistake is inert rather than harmful — it can never match a job that sends a
> password — but delete it rather than leaving a misleading entry on the account page.

### 2.1 Pre-flight — optional, one-time

Neither of these blocks a release. Both are cheap, and the first one checks the single assumption the
whole PyPI path rests on.

- [ ] Open `https://pypi.org/manage/account/token/` and confirm `PYPI_TOKEN`'s scope reads **"Entire
      account (all projects)"** and not *Scope: Project: cortadel*. **This is not discoverable from
      CI** — the workflow cannot tell you, and the failure mode if the assumption is wrong is an
      upload rejected with the thoroughly confusing *"Non-user identities cannot create new
      projects"*, after the version number is already spent. If it turns out to be project-scoped, the
      fix is to mint a new account-scoped token on that same page and replace the repository secret —
      not to switch mechanisms.
- [ ] Confirm the account has a **verified primary email** and 2FA (PyPI has required 2FA for uploads
      since 2023). An API token cannot be created without them, so if `PYPI_TOKEN` exists this is
      already true; check it only if you are re-minting.

### 2.2 First release — **per package** (×3)

- [ ] **Release the three on separate tags, not together.** PyPI rate-limits project *creation*
      (`TooManyProjectsCreated` → HTTP 429); three brand-new projects from one burst is close to what
      that guard exists for. Suggested first: `integration-pydantic-ai-v0.1.0`.
- [ ] Before tagging, check each project name character-for-character against the `name =` field in
      the matching `pyproject.toml` (`integrations/crewai` → `cortadel-crewai`,
      `integrations/google-adk` → `cortadel-google-adk`, `integrations/pydantic-ai` →
      `cortadel-pydantic-ai`). The name that gets created is whatever the manifest says; a typo
      permanently creates the wrong project, and PyPI will not let the name or the version be reused.
- [ ] Do **not** expect PEP 740 attestations on the project page. The token path cannot produce them:
      `pypa/gh-action-pypi-publish` force-disables attestations whenever a `password` is supplied,
      because attestations currently require trusted publishing. Their absence is the configuration
      working, not a fault — and it is the one thing the follow-up above would buy.
- [ ] Confirm each project appears at `0.1.0` on pypi.org, and that its *Publishing* settings page
      lists **no** publishers. That is expected here.

**TestPyPI is deliberately skipped.** It needs a separate account and a separate token, a second
trigger path, and validates almost nothing that matters here — its names do not reserve production
names, and a TestPyPI token's scope tells you nothing about the production one's. If you want a
rehearsal anyway, wire it as a manually-dispatched job, not as part of the tag path.

---

## 3. NuGet — one-time setup for `Cortadel.AgentFramework`

A **new trusted-publishing policy is required**, and the reason is the **workflow filename**, not the
new package ID. A nuget.org policy is a tuple of *(package owner, repository owner, repository,
workflow file, environment)* and never names a package — "the policy will apply to all packages owned
by the selected owner". So nothing needs pre-registering for `Cortadel.AgentFramework` itself (an
owner-wide key creates new IDs on first push), but `dotnet.yml`'s existing policy does not match
`integrations.yml` and never will.

> **Blast radius, stated up front.** This policy lets `integrations.yml` mint a key that can push
> **any** package owned by the `cortadel` nuget.org account, `Cortadel.Sdk` included. Per-package
> scoping does not exist (NuGetGallery issue #10587, open). Anyone who can land a change to
> `integrations.yml` on a release tag can publish those packages. This is inherent to nuget.org's
> design, not a misconfiguration — but treat `integrations.yml` as release-security-sensitive from
> now on.

### 3.1 Create the policy — one-time, per registry

- [ ] Sign in to `https://www.nuget.org` as the account behind **`cortadel-admin`** — the username
      `dotnet.yml` already passes to `NuGet/login`, and the same one `integrations.yml` passes.
- [ ] Go to **`https://www.nuget.org/account/trustedpublishing`** (or: username menu → *Trusted
      Publishing*).
- [ ] Open the existing policy that publishes `Cortadel.Sdk` and **write down its *Package owner*
      value verbatim** before creating anything. Expected: `cortadel` (the owner of `Cortadel.Sdk`).

      This is the single irreversible decision in this file. The new package ID becomes owned by
      whichever *Package owner* the policy names, on first push, and because the `Cortadel.` prefix is
      unreserved nothing will warn you if you pick wrong.
- [ ] Add a new policy with exactly:

      | Field | Value |
      | --- | --- |
      | Package owner | `cortadel` *(the value you just copied)* |
      | Repository owner | `cortadel` |
      | Repository | `cortadel` |
      | Workflow file | `integrations.yml` *(filename only — not the `.github/workflows/` path)* |
      | Environment | *(leave empty)* |

- [ ] Save, then re-read the policy's status. A newly created policy can show as *temporarily active
      for 7 days*, going permanently active only after the first successful OIDC exchange (nuget.org
      needs the immutable GitHub repo/owner IDs). Microsoft's docs say this "usually happens with
      private GitHub repos" and `cortadel/cortadel` is public, so it probably will not appear — but if
      it does, the first tagged release clears it, and the 7-day clock can be restarted from the UI at
      any time.

### 3.2 Optional, and unrelated to publishing — reserve the ID prefix

- [ ] `Cortadel.` is **not** currently a reserved prefix (`Cortadel.Sdk` shows `"verified": false` in
      the nuget.org search API). Nothing blocks the new ID — rejection only happens when a *different*
      owner holds the prefix — but nothing protects it either: any third party can push
      `Cortadel.Anything` today. This is the only genuinely unmitigated risk in the whole picture.
- [ ] To claim it, email `account@nuget.org` with owner display name `cortadel` and requested prefix
      `Cortadel.*`. Not a prerequisite for publishing.

### 3.3 Ownership

- [ ] If `Cortadel.AgentFramework` should be co-owned by a second nuget.org account, that must be done
      **after** the first push, from the package's *Manage owners* page. It cannot be set at push time.

---

## 4. Cutting a release

Once the prerequisites are in place — npm's secret (§1) and NuGet's policy (§3); PyPI needs nothing
(§2) — a release is one tag.

```bash
git checkout main && git pull
# The tag's version MUST equal the version in the package's own manifest —
#   TypeScript: integrations/<slug>/package.json  -> version
#   Python:     integrations/<slug>/pyproject.toml -> project.version
#   .NET:       integrations/<slug>/<project>.csproj -> <Version>
# release-plan fails the run on any mismatch, before touching a registry.
git tag integration-langgraph-v0.1.0
git push origin integration-langgraph-v0.1.0
```

What runs, in order:

1. `release-plan` resolves the tag to exactly one package, derives its toolchain from the manifest on
   disk, and asserts the tag's version equals the manifest's.
2. `matrix-coverage` plus **that package's whole toolchain matrix** must pass on that exact commit.
   Releasing an npm package requires all eight TypeScript legs green; it does **not** require the
   Python or .NET legs. This is deliberate — see the release-path comment block in
   `integrations.yml`.
3. The one matching publish job runs. The other two skip.

### If something goes wrong

**All three registries are append-only and none of them lets a version be reused.** npm: "once
`package@version` has been used, you can never use it again", and unpublishing all versions locks the
name for 24 hours. PyPI refuses to reuse a version *or even a filename*, "even once a project has been
deleted and recreated". nuget.org packages can only be unlisted, never deleted.

So a botched `0.1.0` is not re-releasable as `0.1.0` — fix forward to `0.1.1`. The gates exist to make
that outcome rare; do not route around them.

A re-run of a release tag is safe: NuGet pushes with `--skip-duplicate`, PyPI with `skip-existing`,
and the npm job checks the registry first and skips its publish step if the version is already there.

---

## 5. Optional hardening: a GitHub Environment with required reviewers

No publish job sets `environment:`. How many sides that has depends on the registry, and getting that
wrong is the trap:

- **NuGet — two-sided.** The nuget.org policy's *Environment* field is blank, and `publish-nuget` must
  stay blank to match, or the OIDC exchange 401s with an error whose text mentions nothing about
  environments.
- **PyPI and npm — one-sided, today.** Both authenticate with a stored API token, and a token carries
  no environment claim, so there is no registry field to keep in agreement. An Environment on those
  jobs would be exactly one thing: a human approval gate. (npm becomes two-sided at phase 4, §1.5 — a
  trusted publisher *does* have an environment, set with `npm trust github … --env`.)

Either way, add one deliberately: this repository has already been bitten by the other half of the
trap, a job pinned to an environment that did not exist and therefore never resolved (see
`python.yml`'s `publish-pypi` comment).

1. GitHub: repo → Settings → Environments → *New environment* → name it `pypi` (and/or `npm`,
   `nuget`) → Configure → add **Required reviewers**.
2. The workflow job: add `environment: pypi` to `publish-pypi` (and/or the others).
3. The registry — **only where one exists**: set the matching *Environment name* on the nuget.org
   policy, and, after §1.5, on each of the eight npm trusted publishers. PyPI has nothing to set while
   the token path is in use.

Half of a two-sided change is worse than none of it.

---

## 6. After the first release — docs to update

- [ ] `docs/integrations.md` carries a status note: *"Status — `0.1.0`, in this repo, not yet on the
      registries."* Update it once packages are actually published, **and update
      `website/src/content/docs/integrations.md` in the same commit** — the docs/website mirror is
      CI-enforced by `pr.yml`'s `docs-website-mirror` job. Check locally with
      `node .github/scripts/check-docs-mirror.mjs`.
- [ ] `integrations/openclaw`'s manifest carries an unpinned `npmSpec` with no `expectedIntegrity`,
      precisely because nothing had been released. Revisit it once `@cortadel/openclaw` exists.
- [ ] If npm phase 4 (§1.5) has landed, correct `CONTRIBUTING.md#releasing` — it will then be
      describing npm as token-authenticated when it is not.

---

## See also

- [`.github/workflows/integrations.yml`](workflows/integrations.yml) — the workflow. Its header
  documents the tag grammar, the security note, and why the auth mechanisms differ per registry.
- [`CONTRIBUTING.md#releasing`](../CONTRIBUTING.md#releasing) — the contributor-facing summary.
- [`integrations/README.md`](../integrations/README.md) — the contributor contract for these packages.
