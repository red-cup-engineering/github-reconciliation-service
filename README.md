# github-reconciliation-service

Settles the open pull requests, branches and issues of the 561 Group organizations without a model in the loop.

```
github-reconcile --org red-cup-engineering --org 561-group [--repo OWNER/NAME] [--apply] [--close-issues]
                 [--register DIR] [--merge-method squash] [--max-merges 25] [--min-age-days 2]
```

Without `--apply` it reads and reports. The token is `$GITHUB_TOKEN` or the systemd credential `github-token`.

## Classes and actions

| Item | Test | Action |
| --- | --- | --- |
| Branch | `compare` shows `ahead_by` 0, with matching head and containment rechecked before deletion | Delete the branch. A squash-merged PR head is not sufficient evidence. |
| Branch | has commits the default branch lacks, last commit older than `--min-age-days` | Debt record `unique-commits`. |
| Branch | default, protected, or has an open pull request | Nothing. |
| Pull request | `mergeable` true, `mergeable_state` clean, at least one check and all passing, not a draft, against the default branch | Merge (at most `--max-merges` per run). |
| Pull request | conflicting, checks failing, no checks, not clean, or every file it changes was changed on the default branch after its base commit | Debt record with that class. |
| Pull request | draft, or mergeability not yet computed | Nothing. |
| Issue | named by a closing keyword in a merged pull request | Only with explicit `--close-issues`, comment and close as completed. |

Nothing is archived and no repository is deleted. A debt record has the shape of `system-debt-records` in Bare Cedar Fog, written to `--register`.

Merging this source does not install or enable a scheduled timer. Operational credentials, target scope, and activation require independent receiving.

## On Cold Red Gate

`systemd/github-reconcile.timer` runs `github-reconcile.service` every six hours. The token is a systemd credential sealed to the host (`LoadCredentialEncrypted`). The package is published to registry.561.group and installed by the pull path.

`cd services/.../github-reconciliation-service && node --test test/*.test.mjs`
