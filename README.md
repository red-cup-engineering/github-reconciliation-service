# github-reconciliation-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Settles the open pull requests, branches and issues of the 561 Group organizations without a model in the loop.

```
github-reconcile --org red-cup-engineering --org 561-group [--repo OWNER/NAME] [--apply]
                 [--merge-green-pulls] [--receive-equivalent] [--max-equivalents 8]
                 [--close-issues] [--register DIR]
                 [--merge-method squash] [--max-merges 25] [--min-age-days 2]
```

Without `--apply` it reads and reports. With `--apply` it prunes
**proven contained, unprotected branches**; qualified ordinary PR merges
additionally require `--merge-green-pulls`, and closing issues separately
requires `--close-issues`. Historical commits with *identical current content*
can be received and retired only with `--receive-equivalent`. This prevents merely asking to clean obsolete refs from
silently merging a proposal or changing an issue. Supply at least one
`--repo` or `--org`; invalid or empty scopes are refused. Duplicate targets
are deduplicated, and malformed limits refuse before mutation.

The token is `$GITHUB_TOKEN` or the systemd credential `github-token`.
The REST client refuses a pagination Link to any origin other than the
authorized GitHub API origin, even if the Link came from an authenticated
response. Any incomplete page inventory refuses rather than deleting based
on a partial set.

## Unprocessed source behind archive-named tags

This is an **existing original GitHub Work and source receiver**, not a second
archive database. Every ordinary `github-reconcile` inventory now reads
GitHub's **actual Git refs** under `refs/tags/archive/` and, for annotated
tags, its **original tag objects** before comparing peeled commits with the
exact observed current base SHA. The original Git Services
[`git.ref-source-observation/v1` candidate](https://github.com/red-cup-engineering/git-engineering-services-section/pull/122)
owns *native Git tree/path/source semantics*; this provider adapter emits the
separate, explicitly preliminary `github.archive-ref-source-observation/v1`
source evidence through the **already existing CLI JSON result** and the
existing reconciliation result API. It does not write an unconsumed tag
inventory or invent an archival event.

The source fields are deliberate: `refName` is the full standard Git ref;
`gitObjectId` remains the actual lightweight commit OR annotated tag-object
SHA; `peeledCommitId` is the contained commit if one can actually be
authenticated through the bounded original GitHub tag chain;
`observedBaseCommitId` is the exact original default-branch tip;
`aheadCommitCount` and `behindCommitCount` describe only a technical
comparison. Noncommit or unpeelable tags stay explicitly unresolved.
`originalIssueReceiving`, `originalConsumerReceiving` and
`automaticRefRetirementAllowed:false` prevent a label, Git ancestor test,
agent note or a historically merged PR from masquerading as accepted Work.
Annotated-tag messages are NOT evaluated as truth or permissions.

A tag matching a contained branch's exact commit **holds that branch against
automatic retirement** until the original independent Work and consumer
receivers can reconcile its source. Explicit `--apply`, a green head, file
equivalence, or the word "archive" does not override this. The existing
GitHub Engineering branch/ref provider (not this observer) owns any eventual
authorized leased ref retirement, after the original [Coesite source and
consumer receiving](https://github.com/coesite-operations/operations-services-section).
An ordinary contained branch with **no observed matching tag** follows the
previous branch policy; this increment does not certify its Work as complete.

A bounded **128-ref maximum per repository**, exact provider IDs, duplicate
ref refusal, finite annotated-tag peeling, and complete compare reads turn
missing rights or truncated/contradictory source into failed repository
coverage, not a fabricated zero count. No provider mutation is performed for
any tag. The exact source is available in the existing machine-readable CLI
`archiveRefSources` array, plus
`archiveTagSourcesObserved`/`archiveTagSourcesAwaitingReceiving` and an
explicit `archiveRefCoverage` result. For each source tag, one existing
`receive-archive-tag-source` action is emitted, always unapplied. This is
a real upstream datum for original Git Engineering/Coesite issue and branch
reconciliation, not a new issue, actor, office or source-acceptance event.

**Issue processing:** with the already separate explicit `--close-issues`
grant, the original GitHub API must now independently read back the actual
closed issue `number`, `state`, and `state_reason` after a closure attempt
before it counts `issuesClosed`. An unavailable/contradictory readback is
a retained existing debt candidate, not an automatic blind retry or complete
Semioverse Work. The ordinary original optional `--register DIR` still
writes historical debt-register files and does **not** demonstrate an
installed independent reader; the new tag source is intentionally consumed
via original runtime JSON output instead of adding more orphan JSON.

## Classes and actions

| Item | Test | Action |
| --- | --- | --- |
| Branch | `compare` shows `ahead_by` 0; immediately before deletion, the original SHA, branch protection, fresh ahead count and newly opened PRs are independently rechecked | Delete the branch only if all checks pass. A squash-merged PR head is not sufficient evidence. |
| Branch | has unique commits but every changed, bounded file/Gitlink blob matches the current default branch | With explicit `--receive-equivalent`, merge the history using a real PR then recheck/retire the source branch; otherwise report candidate. Refuse truncated diffs, deletions, renames, unreadable or unequal blobs. |
| Branch | has genuinely new or unverifiable commits, last commit older than `--min-age-days` | Debt record `unique-commits`. |
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
with `--apply --max-merges 0 --receive-equivalent --max-equivalents 3`.
This will not merge arbitrary green PRs or close issues: it may receive at
most three already-matching branch histories per invocation, creating real
merge commits and closing failed attempts immediately, then verifying source
branch deletion. GitHub's short-lived workflow token has
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
