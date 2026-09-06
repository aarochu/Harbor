# Bedrock access setup

Harbor's model calls are the only metered cost in the project, and they are
meant to draw down a $100 AWS credit balance rather than a card. That balance
lives in **one specific account**, so this setup is less about permissions than
about making sure the calls leave from the right account.

## The situation on this machine

| | Account |
|---|---|
| Holds the $100 credits | **318432260537** |
| What the default AWS CLI profile is authenticated as | `arn:aws:iam::350073489433:user/aaronchu` |

Two different accounts, same username. Attaching the Bedrock policy to
`350073489433` would produce working Bedrock calls that bill a real card and
leave the credits untouched — a failure that is silent until an invoice arrives,
which is why it is worth being deliberate here.

The fix is a **named profile** rather than changing the default, so the existing
`350073489433` setup keeps working for whatever else uses it.

## Steps

These involve creating an IAM user, attaching a policy, and handling an access
key. Do them yourself — I don't modify IAM or handle credentials.

**1. Sign in to the credits account**

<https://318432260537.signin.aws.amazon.com/console>

Confirm the account ID in the top-right menu reads `318432260537` before
continuing. Everything below is wasted effort in the wrong account.

**2. Create the policy**

IAM → Policies → Create policy → JSON tab. Paste the contents of
[bedrock-policy.json](bedrock-policy.json). Name it `HarborBedrockInvoke`.

It grants `InvokeModel` and `InvokeModelWithResponseStream` on Anthropic
foundation models and inference profiles, plus the read-only List/Get calls used
to check what is available. Nothing else — no account-wide Bedrock admin, no
other model vendors.

**3. Create a user and attach it**

IAM → Users → Create user, named `harbor-agent`. Attach `HarborBedrockInvoke`
directly. Don't give it console access; it only ever calls an API.

A separate user, rather than reusing a personal one, keeps the blast radius of a
leaked key at "can invoke Claude" and nothing more.

**4. Create an access key**

On the new user → Security credentials → Create access key → *Command Line
Interface (CLI)*. Copy both values now; the secret is shown once.

**5. Configure a named profile**

```bash
aws configure --profile harbor
```

Enter the key and secret, region `us-east-1`, output `json`. This writes a new
profile and leaves `default` alone.

**6. Enable model access**

Bedrock console → **switch the region to `us-east-1`** → Model access → enable
**Anthropic Claude Sonnet 4.6**.

This is a separate gate from IAM, and its failure mode looks identical: an
`AccessDeniedException` on invoke. Having the policy attached is not sufficient
on its own.

Model access is granted per region. The CLI's `default` profile on this machine
points at `us-west-1`, and `AWS_REGION` in `.env` overrides the profile region
outright — `model.ts` reads the variable, not your AWS config. All three have to
name the same region.

**7. Point Harbor at the profile**

In `agent/.env`:

```
AWS_PROFILE=harbor
AWS_REGION=us-east-1
```

Leave `ANTHROPIC_API_KEY` empty — `agent/src/model.ts` prefers it when set and
falls through to Bedrock only when it is blank.

## Verify

```bash
aws sts get-caller-identity --profile harbor
```

Expect `arn:aws:iam::318432260537:user/harbor-agent`. If the account reads
`350073489433`, the profile did not take.

Then the real test, which exercises the whole path — provider factory, model
call, tool round-trip:

```bash
cd agent && npm run dev
```

Expect a line naming the provider, then the agent choosing the `letter_counter`
tool on its own. That is M0's last open item.

## If you would rather not do any of this

`ANTHROPIC_API_KEY` in `agent/.env` skips every step above; `model.ts` takes that
path first. It bills Anthropic directly rather than drawing down the AWS credits,
which is the whole reason Bedrock is the default — but it unblocks development
immediately, and the two paths are interchangeable at runtime.

## Cost guardrails

Harbor's model calls are the only metered cost in the project, and the whole
premise is that they come out of a $100 credit balance rather than a card. Two
budgets make that verifiable instead of assumed.

Neither can be created from Harbor's own credentials: the `harbor` IAM user
holds only `HarborBedrockInvoke`, and granting it `budgets:*` would widen a
deploy agent's key to cover billing. Create them in the console instead.

**Billing console → Budgets → Create budget** (account `318432260537`).

### 1. Zero-spend alert — "did real money start moving?"

Use the **Zero spend budget** template. It creates a $0.01 monthly cost budget
and emails you the moment actual charges exceed it.

By default a budget counts credits as payment, so this stays silent for as long
as the $100 covers usage and fires on the first cent that does not. That is
exactly the signal worth having: not "Harbor is spending", but "the credits ran
out and this is now costing money".

### 2. Credit burn warning — "how much of the $100 is left?"

The zero-spend alert only fires *after* the credits are gone, which is late. A
second budget gives you warning:

- Budget type: **Cost budget**, monthly
- Amount: **80 USD**
- Under *Advanced options*, **uncheck "Credits"** so the budget measures gross
  usage rather than what you were charged
- Alert at **80% of actual**

That fires at roughly $64 of the $100 consumed — enough runway to decide whether
to keep going before anything is at stake.

### Why not do this from the CLI

If you would rather script it, the account needs `budgets:CreateBudget`, and the
call is:

```bash
aws budgets create-budget --account-id 318432260537 --profile <admin-profile> \
  --budget '{"BudgetName":"harbor-zero-spend","BudgetLimit":{"Amount":"0.01","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":0.01,"ThresholdType":"ABSOLUTE_VALUE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"YOUR_EMAIL"}]}]'
```

Run it as an admin principal, not as `harbor`.

### Harbor's own ceiling

These are AWS-side backstops. Harbor caps itself independently — `RunBudget`
enforces a per-run turn cap, wall-clock cap, fix budget and a soft cost ceiling,
and `HARBOR_MAX_TOKENS` bounds every model response. The AWS budgets exist to
catch the case where that reasoning is wrong.
