# Public source preview

Lifecycle: current

Bronto Pulse is published as MIT-licensed source so contributors can inspect,
run and improve it without access to a maintainer's private infrastructure.
Source publication is separate from npm distribution and live analytics hosting.

## Publication boundaries

| Public                                                           | Private or explicitly deferred                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Source, tests, synthetic demo, examples and metric definitions   | Provider tokens, OAuth grants, database contents and report exports         |
| Contribution policy, security contact and development workflows  | Private deployment routes, real account/database IDs and recovery archives  |
| Standard GitHub-hosted validation and CodeQL analysis            | Recurring collectors, production account activation and paid platform plans |
| MIT license and Git history with GitHub no-reply author metadata | npm publication, which remains blocked by `private: true`                   |

The three pre-publication commits were inspected for tracked artifacts and
scanned with Gitleaks. Their source trees and parent relationships were retained;
work-email author/committer metadata was normalized before publishing the branch
history. A recovery copy stays outside the repository. This is not a claim that
all hosting-provider caches can be erased by rewriting a branch.

The old private CI jobs never executed a step. There were no release assets,
workflow artifacts or repository webhooks at the publication audit. Issues and
PR discussion were reviewed separately from source files because those also
become visible with the repository.

## Ongoing checks

`npm run publication:check` rejects tracked runtime/private artifacts, populated
credential examples, private registry URLs and active example deployment routes
or cron triggers. CI and CodeQL always use standard `ubuntu-24.04` runners,
immutable action pins and the minimum permissions for their purpose. No workflow
receives live provider credentials or uploads an analytics database.

GitHub's public-repository security settings complement these source checks:
private vulnerability reporting, dependency alerts and secret push protection.
They do not replace review, secure deployment or independently restored backups.

## Maturity

The preview includes working source adapters and fixture-tested contracts. The
GitHub/npm pilot and restore comparisons are distinct evidence from account-specific
Cloudflare, Search Console and Sense6 activation. Those deployment checks remain
tracked in issue #1 and do not prevent public code review.

Read [validation](validation.md), [security](../SECURITY.md) and
[maintainer releases](releasing.md) before describing an installation as
production-ready or publishing its collected analytics.
