# Evaluate independent project-review pilots

Lifecycle: proposal

This is a product-learning protocol. It is not evidence that pilots, paid
customers or independent recovery checks have occurred. Keep participant
records and analytics private. Do not publish the maintainer's production
counts as examples of customer adoption.

Use [private pilot acceptance](pilot-acceptance.md) for real source, transport,
comparison and recovery checks. This document asks whether the resulting review
is useful enough to keep using.

## Recruit for a real question

The first hypothesis is an independent developer or small developer-tools team
with an actively maintained product, a repository and at least one relevant
package or site. The owner should already spend time investigating discovery,
distribution or a meaningful provider-native outcome.

Aim for five to eight unrelated participants across more than one provider
configuration. These are proposed experiment targets, not current users.
Contact and onboarding require the participant's consent. This runbook does
not authorize sending invitations or accessing somebody else's accounts.

Before demonstrating Pulse, ask the participant to show a recent question:
what they checked, how long it took, what remained uncertain and where they
recorded the conclusion. Accept “I rarely need this” as a result.

## First session

1. Choose one project and a small source scope. Confirm that the participant's
   provider plan includes API access before configuring it.
2. Complete the relevant acceptance checks and record setup/support time.
   Aim to connect two useful sources in about 15 minutes; record the actual
   result, including failures.
3. Answer the participant's question using their usual workflow.
4. Answer the same question with Pulse, retaining the evidence and limits.
5. Ask what became easier, what Pulse missed and whether the result changed
   understanding or a decision. A useful conclusion can be no action.

Use completed dates and genuinely available history. Older GitHub traffic
cannot be recreated after its source window expires. Do not conceal a cold
start, substitute synthetic data or widen permissions to make the demo succeed.

## Return visits

Offer four review opportunities at a cadence appropriate to the participant:
weekly, after a release, or a monthly portfolio assessment. Quiet projects
need not manufacture a weekly finding.

For each visit, record the actual question, whether the participant returned
without prompting, time spent, any unexpected collection problem, the
conclusion, and a link or note about an action if one occurred. Ask whether the
same result was readily available from existing dashboards or direct provider
MCP integrations.

Do not require a Pulse journal entry. A private PR, issue or interview record
can establish the outcome. Zero manual annotations shows an unrecorded
workflow, not proof that no useful decision happened.

## Evaluate usefulness and costs separately

| Question                   | Evidence to retain                                                       | Avoid treating as success                     |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| Can an owner start?        | Time to a verified connection and first report; help required            | A successful demo on the maintainer's machine |
| Is the answer trustworthy? | Exact source/date references and comparison limits                       | A confident narrative or a fixture count      |
| Is the review useful?      | A resolved question, overlooked issue, saved effort or informed decision | Number of findings or annotations             |
| Does the owner return?     | Repeated voluntary review or a recurring task they depend on             | One marketplace install                       |
| Will someone pay?          | A clearly described offer and an actual payment where offered            | General enthusiasm or hypothetical intent     |
| Is hosting sustainable?    | Support minutes, collection failures, provider costs and hosting cost    | The personal instance fitting a free tier     |

Use a small paid managed-installation experiment only after the workflow is
useful and its operating boundaries are clear. Candidate prices in
[product direction](product-strategy.md) are hypotheses to test. Present the
scope and limits honestly; do not announce a generally available SaaS.

## Decide what to build next

Continue the hypothesis when several independent owners repeatedly resolve
worthwhile questions more easily, some accept a concrete paid offer, and
support effort is manageable.

If the finding is merely a consolidated chart, improve or narrow the review
job before expanding connectors. If onboarding dominates, fix source
eligibility and setup. If users mainly need one provider, compare a direct
provider integration before retaining an unnecessary aggregation layer.

When a user needs a meaningful outcome, first check whether an existing source
already measures it. An opt-in aggregate completion count can be valuable;
reconstructing cross-source people or causal conversion is a different claim.

## Private evaluation record

Record the following in the participant's approved private location:

- Reviewed source revision/runtime and acceptance gates actually completed.
- Participant's role, project scope and question, using the minimum identifiers needed.
- Existing workflow, Pulse workflow, actual time and assistance required.
- Findings, source dates, uncertainties and the participant's conclusion.
- Optional action link and later observations; retain causal uncertainty.
- Voluntary return visits, paid-offer result if applicable, support cost.
- Reasons to continue, narrow, defer or stop the experiment.

Repeated agreement between reviewers of the same code is useful prioritization
input. Independent users and their observed behavior supply the missing market
evidence.
