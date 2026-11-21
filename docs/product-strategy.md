# Product direction: evidence for project reviews

Lifecycle: proposal

## The useful job

Help the owner of a software project understand what changed across its
repository, package and website, decide which observation deserves attention,
and return to the supporting evidence after taking an action.

The first commercial hypothesis is an independent developer or small
developer-tools team actively maintaining a product with a repository, a
distribution channel and a documentation or marketing site. A person with
several quiet hobby repositories can still benefit from the free, self-hosted
core; project count alone does not establish willingness to pay.

The human owns the question and the decision. A coding assistant can inspect
the evidence, read related documentation or code, propose an improvement and
link the resulting work. Pulse supplies durable observations and explicit
measurement limits.

## Three review situations

| Situation                           | Question                                | Useful result                                                                    |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Routine project or portfolio review | What deserves attention?                | A short supported finding, an uncertainty that matters and a concrete next check |
| Release or website change           | What changed around this event?         | Dated observations and comparable windows, with release context and uncertainty  |
| Focused investigation               | Can these sources answer this question? | The relevant evidence, missing coverage and a conclusion the owner can verify    |

Weekly and monthly reviews are possible cadences, not requirements. A quiet
period can produce no actionable finding. A release annotation supplies
context; it does not establish that the release caused a change.

The [project-review walkthrough](project-reviews.md) uses the existing
synthetic repository, package and website example. The
[pilot evaluation](pilot-evaluation.md) defines how to test usefulness with
independent owners. Neither document is a claim that external validation has
already happened.

## Product boundary

Pulse retains provider-native aggregates and their provenance. It does not
reconstruct people moving from search to documentation to an npm install.
Downloads, clones, daily unique counts and product events keep their own
meanings. Two changing sources can justify an investigation without proving
a shared audience, causality, or independent adoption.

An optional review record can connect a question, its evidence and a conclusion
or external PR. It should help retrieve work that already happens in the
owner's tools. It is not a task-management system, and writing a record is not
required for a useful review. A documented decision to take no action can be
a successful result.

Existing provider-native goal or completion counts are a possible next step
when a pilot needs them. Keep them opt-in and preserve their definitions.
A documentation download click is not proof of a successful package install.
An onboarding-completion count is not automatically a cross-source conversion
rate. Add outcome evidence for a concrete question, not a general tracking SDK.

## What should earn continued development

1. **Trustworthy coverage.** Every intended resource and dataset is either
   connected with inspectable freshness or explicitly missing, unsupported or
   blocked. A scheduled success does not imply complete source dates.
2. **A useful first review.** An owner can connect a small scope, inspect a
   convincing example, and explain the result without learning the collector
   architecture.
3. **A reliable agent interface.** The same report contracts are available to
   an assistant through bounded, read-oriented tools. Private reports remain
   private; source text is data, not instructions for the agent.
4. **Evidence of value.** Independent owners repeatedly resolve a real question
   more easily than with their existing dashboards or direct provider tools.

Test the product against the user's existing workflow. A marketplace install,
a passing fixture suite, a larger connector catalogue or a growing observation
count does not establish usefulness.

## Competitive choices

| Alternative                                    | Existing strength                                           | Pulse's hypothesis                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Provider dashboards and their MCP integrations | Direct access to each provider's analytics                  | Retained project context and consistent interpretation across sources and sessions |
| GitHub history tools such as ghstats           | Retain repository traffic beyond GitHub's short window      | Connect that history with a package and site for a useful project review           |
| Umami, Plausible and PostHog                   | Website or product analytics with provider-native behavior  | Read relevant existing aggregates while preserving their measurement boundaries    |
| Scarf and Reo                                  | Commercial usage intelligence and company/contact workflows | Serve owners who want private project evidence without identity enrichment         |
| DevLake and community-health platforms         | Delivery, contribution and community metrics                | Start with discovery, distribution and owner investigations                        |

MCP access is an interface and a potential installation channel. It is not a
competitive advantage by itself. Current examples include
[PostHog MCP](https://posthog.com/docs/model-context-protocol),
[Scarf MCP](https://docs.scarf.sh/scarf-ai/),
[Umami MCP](https://umami.is/blog/introducing-umami-mcp), and
[Plausible's documented community integration](https://plausible.io/docs/data-access).

## Hosted-service progression

The current source package is an MIT-licensed preview. The bundled local plugin
and private authenticated MCP interface are pilot integration paths; they do
not establish public-directory acceptance, OAuth support, customer tenancy,
billing, or a production SaaS.

Progress through these evidence gates:

| Stage                       | Deliverable                                                   | Gate to continue                                                 |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Useful private installation | Repair coverage and complete one project review               | An owner verifies the answer and next check                      |
| Independent pilot           | Small real portfolios using the current deployment model      | Repeatable findings and measured setup/support effort            |
| Managed private pilot       | A few isolated, explicitly provisioned installations          | Paid use, reliable collection, recovery and understandable costs |
| Repeatable small SaaS       | Account lifecycle, billing and shared operations as justified | Retention and support economics support the added platform       |

A hosted pilot still requires credential isolation, controlled access,
backup/restore, export and deletion. A collection job must never inherit
another customer's credentials or data. Isolated installations can keep the
first platform small; they do not make operating costs disappear.

Keep self-hosting available. A hosted offering would charge for reliable
collection, retained history, convenience and shared reviews. Candidate price
experiments are EUR 15–25 per month for an owner and EUR 49–99 for a small
team. These are **unvalidated hypotheses**, not announced plans or evidence of
willingness to pay. Measure support time, provider eligibility and real hosting
costs before choosing a price. A personal deployment fitting a free tier is
not a durable SaaS cost model.

Use direct signup and account management outside agent directories where
required. Listing requirements and billing rules must be rechecked before
submission. No directory traffic or conversion rate is assumed.

## Decisions deferred

A broad connector SDK, Kubernetes-first deployment, PostgreSQL HA, generic BI,
automatic growth recommendations and contact enrichment remain outside this
first product test. Runtime changes need a demonstrated operating constraint.

SEO, URL inspection and AI-visibility tools should participate when they
resolve an owner question. Do not merge every audit into a single dashboard
just because it exists.

Bronto Pulse remains the repository, package and CLI identity. A new brand is a
separate decision after testing the promise and checking naming availability;
a research candidate is not a cleared or launched brand.
