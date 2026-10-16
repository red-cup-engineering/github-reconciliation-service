# github-reconciliation-service

Settles the open pull requests, branches and issues of the 561 Group organizations without a model in the loop.

```
github-reconcile --org red-cup-engineering --org 561-group [--repo OWNER/NAME] [--apply]
                 [--merge-green-pulls] [--close-issues] [--register DIR]
                 [--merge-method squash] [--max-merges 25] [--min-age-days 2]
```

Without `--apply` it reads and reports. With `--apply` it **only prunes
proven contained, unprotected branches**; qualified PR merges additionally
require `--merge-green-pulls`, and closing issues separately requires
`--close-issues`. This prevents merely asking to clean obsolete refs from
silently merging a proposal or changing an issue. Supply at least one
`--repo` or `--org`; invalid or empty scopes are refused. Duplicate targets
are deduplicated, and malformed limits refuse before mutation.

The token is `$GITHUB_TOKEN` or the systemd credential `github-token`.
The REST client refuses a pagination Link to any origin other than the
authorized GitHub API origin, even if the Link came from an authenticated
response. Any incomplete page inventory refuses rather than deleting based
on a partial set.

## Classes and actions

| Item | Test | Action |
| --- | --- | --- |
| Branch | `compare` shows `ahead_by` 0; immediately before deletion, the original SHA, branch protection, fresh ahead count and newly opened PRs are independently rechecked | Delete the branch only if all checks pass. A squash-merged PR head is not sufficient evidence. |
| Branch | has commits the default branch lacks, last commit older than `--min-age-days` | Debt record `unique-commits`. |
| Branch | default, protected, or has an open pull request | Nothing. |
| Pull request | `mergeable` true, `mergeable_state` clean, at least one check and all passing, not a draft, against the default branch | Merge only with `--apply --merge-green-pulls` (at most `--max-merges` per run); otherwise report candidate. |
| Pull request | conflicting, checks failing, no checks, not clean, or every file it changes was changed on the default branch after its base commit | Debt record with that class. |
| Pull request | draft, or mergeability not yet computed | Nothing. |
| Issue | named by a closing keyword in a merged pull request | Only with explicit `--close-issues`, comment and close as completed. |

Nothing is archived and no repository is deleted. A debt record has the shape of `system-debt-records` in Bare Cedar Fog, written to `--register`.

### Event-driven Engineering repo cleanup

The **declarative** `.github/workflows/github-reconcile-contained-branches.yml`
in the Engineering parent consumes this single Engineering-owned implementation.
On source-owner changes, merged PRs and explicitly requested manual dispatch,
it first runs the original Node tests, then invokes only its own repository
with `--apply --max-merges 0`. GitHub's short-lived workflow token has
`contents:write` only for that repository; it never sends credentials to
another host or receives authority over Science/Data/Operations repositories.
No GitHub Actions cron or ChatGPT Scheduled Task was created. A workflow
file being committed is **not** evidence a hosted runner started or passed:
check its actual job conclusion and deletion receipt.

For additional owners, an authorized Operations receiver must arrange a
similarly scoped caller, or install the original CLI on credentialed compute.
Do **not** copy this reconciliation implementation into each repository or
confuse a source merge, release package, and running service. The CLI's
`--org` scope is supported when the installed credential really has
cross-repository permissions; the parent repository's `GITHUB_TOKEN` does not.

Merging this source does not install or enable its optional systemd timer.
Operational credentials, host selection, and activation require independent
receiving.

## On Cold Red Gate

`systemd/github-reconcile.timer` and its service file describe an **optional, not-yet-independently-received deployment**. They are not evidence of an installed/active timer, an available sealed credential, a published registry artifact, or completed host receiving. Do not enable the timer merely by merging this source. The intended design uses `LoadCredentialEncrypted` when an authorized host installs it.

`cd services/.../github-reconciliation-service && node --test test/*.test.mjs`
