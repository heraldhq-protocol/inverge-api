# Web UI — open API gaps (TODO)

> Backlog raised on 2026-07-30 while specifying the `inverge-web` product screens (idea feed, idea
> detail, campaign detail) against this API. Every item is **additive**: no breaking change, no
> rename, no behaviour change to an existing field.
>
> Source of the requirement, in `inverge-web`: `docs/ideas-campaigns-brief.md` (build spec),
> `docs/campaign-data-contract.md` §4 (the same list from the consumer's side, with the provisional
> campaign shapes), `docs/pitch-narrative-playbook.md` §3 (why the content gaps matter).
> Web branch: `feat/ideas-campaigns-ui`; campaign surfaces on `feat/campaign-ui-and-flow`.
>
> Items 12–19 were added 2026-07-31/08-01 while building the campaign catalogue, campaign detail and
> the creator campaign flow (`inverge-web` `docs/campaign-brief.md` §11, and
> `docs/campaign-data-contract.md` §2 for the shapes the web is built against). None of them is P0.
>
> **P0 items block web work that is otherwise ready to build.** P1 unblocks screens that have a
> documented fallback. P2 is real but deferrable.

---

## The list at a glance

| # | Ask | Priority | Blocks / unblocks |
|---|---|---|---|
| 1 | Public creator identity (`displayName`, `avatarUrl`, `bio`, `links`) | **P0** | The card, the creator panel, the campaign header. Four surfaces on one gap |
| 2 | Comment author projection on `GET /ideas/:id/comments` | **P0** | The discussion thread cannot render at all |
| 3 | Media on an idea (`coverImageUrl`, then upload) | P1 | Image-led cards. Deterministic cover meanwhile |
| 4 | Owner filter on `GET /ideas` (`mine=true`, including `DRAFT`) | P1 | Creator dashboard, and step 1 of the campaign builder |
| 5 | Public gate progress on `GET /ideas/:id` | P1 | The FR-204 breakdown without exposing creator-only insights |
| 6 | `GET /campaigns` and `GET /campaigns/:id` | P1 | **Every campaign screen.** All of them run on fixtures today |
| 7 | Public receipts feed per campaign (`OnChainEvent`) | P1 | Receipt timeline and the campaign timeline tab |
| 12 | Platform escrow aggregates (FR-801) | P1 | The escrow band on the catalogue. Summed client-side meanwhile |
| 13 | Campaign list filters and sort | P1 | Server-side catalogue filtering |
| 14 | Creator campaign history on the creator projection | P1 | The Creator tab's track record |
| 15 | `POST /campaigns/:id/submit` plus owner visibility | P1 | The end of the creator flow. Today a draft nobody can read back |
| 16 | Campaign media (`videoUrl` **required**, poster, cover) | P1 | The above-the-fold player and every card thumbnail |
| 17 | A create path for a campaign with no backing idea | P1 | The standalone path in the builder |
| 18 | The escrow split, as a shared and documented rule | P1 | Nothing renders differently. It stops three implementations disagreeing about money |
| 19 | Reward tiers | P1 | The Rewards tab and step 4 of the builder |
| 8 | Idea-level `risks` field | P2 | Coaching, and backer context in objection voting |
| 9 | One-line `summary` on `Idea` | P2 | OpenGraph text, share copy |
| 10 | Objection threshold and window as readable params | P2 | Rendering the rule instead of hard-coding 30% and 7 days |
| 11 | Public aggregate support view | P2 | A public community tab |

**What the web is running on meanwhile.** Every campaign surface reads from
`inverge-web/src/lib/campaigns/campaigns-api.ts`, which returns fixtures behind one `USE_FIXTURES`
flag. Nothing in the campaign domain calls this API at all — not even `POST /ideas/:id/convert`, which
is live and correct. That is deliberate: the screens were built as UI first, against the written
contract, so the swap when item 6 lands is one file rather than a rewrite of every component.

---

## P0 — blocking

### 1. Public creator identity

**Problem.** There is no display name, avatar or bio anywhere in the data model. `User` holds
`privyDid`, `email`, verification state and preferences; `CreatorProfile` holds tier and track record.
So `GET /feed` returns `creatorId` and nothing renderable, and the same is true of `GET /ideas/:id`.

Three separate web surfaces are blocked by this one gap: the idea card (creator line and avatar), the
creator panel on idea detail, and the campaign header. It is also the single thing the reference
material is most emphatic about, on the grounds that people back people.

**Proposed shape.** A public projection, embedded wherever a creator is referenced:

```ts
type PublicCreator = {
  id: string;
  displayName: string | null;   // user-supplied, moderated (see invariants)
  avatarUrl: string | null;
  bio: string | null;           // short, ~280 chars
  links: { label: string; url: string }[];  // website / social, validated as https
  tier: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
  completedCampaigns: number;
  identityVerified: boolean;    // derived: KYC VERIFIED. NOT the raw kycStatus
  memberSince: string;          // ISO; CreatorProfile.tenureStartedAt or User.createdAt
};
```

Storage: extend `CreatorProfile` (it already exists, is 1:1 with `User`, and already carries the
track-record fields) rather than widening `User`. Add `displayName`, `avatarUrl`, `bio`, `links Json`.
Write path: `PATCH /me/profile`.

**Invariants that must hold.**

- **Never fall back to `email`** for a missing display name, in any projection, ever. An email is not
  a display name and leaking one through a public feed would be a privacy incident. Fall back to
  `null` and let the client render initials.
- Do not expose `kycStatus`, `amlStatus`, `bannedAt`, `privyDid`, `oauthSubject`, `role` or
  `institutionalCosign` publicly. `identityVerified` is a derived boolean and the only leak permitted.
- `activeStrikes` stays internal. Track record may affect ranking; it must never become a public
  scarlet letter (FR-270 doc: no silent shadow-ban, and equally no public one).
- `displayName`, `bio` and `links` are **user-supplied free text on a public surface**, which is a new
  abuse channel: run them through `ModerationService.screenSafe()` on write, cap lengths, reject
  non-https links, and strip control characters. This is the first field we would ship that is public
  and unmoderated by default, so do not ship it unmoderated.

**Tests.** Unit: projection excludes every forbidden field; email never substitutes for a name;
moderation is invoked on write. E2E: feed and idea detail carry `creator`; a banned or unverified
creator projects correctly; `PATCH /me/profile` rejects over-length and non-https input.

**Blocks:** web build stage 3 (the card).

---

### 2. Comment author projection

**Problem.** `GET /ideas/:id/comments` returns `IdeaComment` rows carrying `userId` and nothing else.
A thread cannot render: no name, no avatar, no way to mark the creator's own replies. The web spec
has a nested, likeable, creator-highlightable thread designed and it cannot be built at all.

**Proposed shape.** Add to each comment in the list response:

```ts
author: {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  isCreator: boolean;      // author is the idea's creator — drives the "Creator" pill
}
```

Depends on item 1 for the underlying fields. Same forbidden-field rules; same no-email-fallback rule.
`list()` already caps at 300 rows and orders `highlighted → likeCount → createdAt`, so this is a
`select` widening on one query, not a new endpoint.

**Also worth adding while in there:** `likedByMe` when the request is authenticated, so the client
does not have to guess like state or fetch a second list. Absent for anonymous callers.

**Tests.** E2E: author block present and correct; `isCreator` true only for the idea's creator;
`likedByMe` reflects the caller and is absent when anonymous; **no email in any response body**.

**Blocks:** web build stage 6 (survey and comments).

---

## P1 — has a fallback, but the fallback is a compromise

### 3. Media on an idea

`coverImageUrl` on `Idea`, plus an upload path. The web fallback is a deterministic typographic cover
generated from the title and category, which looks deliberate rather than broken, but the reference's
whole visual engine is image-led cards.

Sequence: accept and store a URL first (cheap, unblocks cards for creators who host their own),
then add upload. Optional short `videoUrl` after that — rationale and its caveats are in the web
playbook §6; it is not urgent and the reported conversion figure behind it is confounded.

Note the moderation consequence: an image is a policy surface the current classifier does not cover
(it is text-only). Either constrain to a trusted host, or accept that image moderation is a separate
piece of work, or hold first-upload behind review. Do not quietly ship an unmoderated public image
field.

### 4. Owner filter on `GET /ideas`

The creator dashboard needs "my ideas", including `DRAFT`, which the public browse deliberately hides.
Today the web app would have to over-fetch the public list and filter client-side, which cannot see
drafts at all, so the dashboard is simply wrong until this lands.

`GET /ideas?mine=true` with `PrivyAuthGuard`, or `GET /me/ideas`. Owner sees every status of their
own; nobody else's visibility changes. Keep the existing tier and status filtering for the public
path untouched.

### 5. Public gate progress on `GET /ideas/:id`

`InsightsService` already computes the FR-204 breakdown (have / need / pct / met per criterion,
`requiredWeighted = max(floor, pct·ask, creatorTarget)`), but `GET /ideas/:id/insights` is creator-only
and returns 403 to everyone else, correctly.

The public idea page wants the same four criteria so a supporter can see *what* is still missing
rather than one opaque bar. That is a strictly smaller payload than insights: criteria progress only,
no per-tier breakdown, no survey internals, no comment analytics, no snapshot series.

Reuse the pure functions in `insights-compute.ts` so there is one implementation of the gate maths and
no drift between what a creator sees and what the public sees.

### 6. Campaign read endpoints

`GET /campaigns` and `GET /campaigns/:id` per the shapes in the web repo's
`docs/campaign-data-contract.md` §2. Until they exist the campaign screens run on fixtures behind one
swap point, which is fine for building and useless for launch.

Notes for whoever implements this:

- **Milestone state is derived, not stored** — there is no status column on `Milestone`; it comes from
  the latest `MilestoneClaim.status` plus `objectionWindowEndsAt`. The web app derives it in a pure
  function; if the API derives it too, the two must agree, so put it in one pure module and consider
  exposing it rather than having both sides compute it.
- **Objection data is aggregate only** in any public response: `objectionWeightPct` and the threshold,
  never per-backer identities. FR-608's public voting history is a separate surface with its own
  privacy pass.
- `termsHash` and `txSignature` may be returned but are never rendered as strings by the client; they
  exist so a receipt link can be built.
- `myContribution` is the only per-user field; absent means "not a backer", not zero.

### 7. Public receipts feed per campaign

`OnChainEvent` rows for a campaign, read-only (FR-802). Respect FR-803: written **only** by the
indexer, never by business logic, so this is a read endpoint over data that does not exist until the
Phase 2 indexer runs. Worth defining now so the receipt timeline is not designed twice.

---

## P1 — campaign surfaces

Raised 2026-07-31 by the campaign catalogue, campaign detail and the creator campaign flow. Each has a
fallback that works today and stops working at scale, except item 15, which leaves the flow ending in a
draft nobody can read back.

### 12. Platform escrow aggregates (FR-801)

FR-801 requires a public dashboard showing total value escrowed, released and refunded, plus counts of
active, completed and refunded campaigns, and FR-803 requires those figures to come from the indexer
rather than backend records. Nothing serves them today, so the web catalogue sums them from the campaign
list it already fetched. That is correct while there are four campaigns and wrong the moment the list
paginates.

`GET /platform/escrow` (or a block on an existing stats route), read-only, derived from `OnChainEvent`:

```ts
{ heldUsd: string; releasedUsd: string; refundedUsd: string;
  counts: { active: number; completed: number; refunded: number } }
```

Same FR-803 rule as item 7: indexer-derived, never summed from `Contribution` rows.

### 13. Campaign list filters and sort

`GET /campaigns?status=&category=&region=&sort=` with `sort` in
`closing-soon | newest | most-backed | most-delivered`, matching the feed's query idiom so the two
discovery surfaces do not diverge. Without it the web app fetches every campaign and filters in
`campaigns-api.ts`.

One product rule to preserve server-side: **`FAILED` campaigns are never excluded from a default list.**
A visible failure is the proof the refund guarantee works, so hiding one would undercut the only claim
the product makes. Filtering them out must require an explicit `status=` filter.

### 14. Creator campaign history on the public creator projection

Extends item 1. Per campaign the creator has run: `title`, `slug`, `status`, `milestonesReleased`,
`milestoneTotal`. The web Creator tab renders an outcome label derived from those counts
(`All 4 stages delivered`, `3 of 4 stages delivered`) rather than a self-reported fulfilment flag, which
is the one place the Kickstarter reference is deliberately inverted.

Two invariants carry over from item 1: `activeStrikes` stays internal and must not be inferable from this
payload, and a demoted creator projects as their current tier with no marker of the demotion.

### 15. Campaign submission and owner visibility

`POST /campaigns/:id/submit` (FR-304 curation entry, gated on the FR-311 application fee) plus
`GET /campaigns?mine=true` returning the owner's `DRAFT` and `IN_REVIEW` campaigns. Today
`POST /ideas/:id/convert` creates a `DRAFT` that neither the creator nor anyone else can then read,
so the campaign builder's last step has nowhere to go and the created draft is invisible.

The web builder is built to stop cleanly at a saved draft, so this is not blocking — it is the difference
between a flow that ends in a dead end and one that ends in a queue.

### 16. Campaign media

`videoUrl`, `videoPosterUrl` and `coverImageUrl` on `Campaign`, plus upload paths. **The video is
required to publish a campaign**, which is a deliberate asymmetry with ideas: publishing an idea is
free and must stay frictionless, but a campaign asks strangers for money and the reference's
highest-converting element is a creator explaining the plan in their own voice.

Same moderation consequence as item 3, and worse: video is a policy surface the text-only classifier
does not cover at all, on the surface where money changes hands. Constrain to trusted hosts, or hold
first upload behind review, or treat video moderation as its own piece of work — but do not ship an
unmoderated public video field.

The web client already accepts all three fields and falls back to a deterministic cover, so this is a
data change rather than a UI change when it lands.

### 17. Campaigns with no backing idea

`POST /ideas/:id/convert` is the only create path and it requires an idea that cleared FR-204. The web
builder also offers a standalone path, for creators who arrive with an audience already, so it needs a
create path carrying its own `title`, `summary`, `category` and `region`.

Everything else about such a campaign is identical: same milestone rules, same escrow, same curation.
What it lacks is the validation evidence, and the web UI says so in place rather than presenting the two
paths as equivalent. Worth deciding explicitly whether curation weighs them differently.

### 18. Derived escrow amounts, or the split as a documented rule

The web app derives what each stage releases from two different bases, and getting it wrong is a money
bug rather than a rendering one:

```
upfront = workingCapitalPct%  of  targetAmount          (FR-503a)
stages  = tranchePct%         of  (totalRaised - upfront)
```

The upfront is a share of the **target** because it is the only money that moves before anything is
verified: pegged to the raise, a $1,000 target that raises $20,000 pays out $4,000 against nothing. The
stages divide the **raise** because a campaign that overfunds is being asked to do more, and the extra
must be available while the work happens. The two always sum to exactly the amount raised.

If the API or the on-chain programme derives these too, all three must agree. Put it in one pure module
— the same treatment as milestone state in item 6 — and consider returning the derived amounts so the
client is not a second implementation.

### 19. Reward tiers

Optional per FR-301, and `ConvertIdeaDto` accepts no rewards field today, so a creator can define tiers
in the web builder and nothing can store them.

```ts
type RewardTier = {
  id: string;
  title: string;
  description: string;
  amount: string;            // minimum pledge, USD
  estimatedDelivery: string; // ISO; rendered as a month
  limitedQuantity: number | null;  // null = unlimited
  claimed: number;
  items: { label: string; quantity: number }[];
  shipping: 'WORLDWIDE' | 'REGION_ONLY' | 'NOTHING_TO_SHIP';
};
```

**The invariant that matters more than the shape: a reward must never touch escrow.** It cannot gate a
tranche, cannot accelerate one, and is not what a milestone claim is judged against — the evidence
definition is. Keep rewards out of the release path entirely, or the objection mechanism ends up
adjudicating late t-shirts instead of undelivered work.

`title` and `description` are user-supplied free text on a public surface, so the same moderation rule
as item 1 applies on write.

---

## P2 — real, deferrable

### 8. Idea-level `risks` field

Kickstarter mandates a "Risks and Challenges" section on every project and the practitioner guidance
is that specificity there signals competence. Our **campaigns** have the equivalent; our **ideas have
nothing**.

Optional `risks` text on `Idea`, prompted as "What is most likely to go wrong, and what would you do
about it?", and scored by `QualityScorerPort` for presence and specificity as **coaching only** —
FR-271a is explicit that quality scoring never rejects. It also gives backers useful context later in
objection voting: a creator who named a risk up front and then hit it is in a different position from
one who did not.

### 9. One-line `summary` on `Idea`

For OpenGraph text, campaign headers and share copy. Deliberately low priority: the web cards lead
with `problem`, which for a validation product is the better default, and an unfalsifiable tagline is
not something the quality scorer should reward.

### 10. Objection threshold and window as readable params

The web app should render the actual rule rather than hard-coding "30%" and "7 days". Expose the
relevant `PlatformParam` values read-only (they are already admin-tunable and audited) so the copy
tracks configuration.

### 11. Public aggregate support view

Geography of support, and first-time versus returning supporters, is the diaspora-to-home story the
PRD is built on, and `insights` already computes most of it for the creator. A public version needs
its own endpoint **and its own privacy pass**: aggregate only, minimum bucket sizes so a city with two
supporters cannot identify them, and nothing that reverses into an individual's pre-pledge amount.
Creator dashboard covers the need until then.

---

## Explicitly not asks

Recorded so nobody "helpfully" adds them:

- **Do not expose raw `prePledgeTotal`.** The public figure is `weightedPrePledgeTotal`, labelled
  "Estimated interest". The raw sum stays internal (FR-207).
- **Do not make `GET /ideas/:id/insights` public.** Creator-only is a deliberate boundary; item 5 is
  the smaller public payload instead.
- **Do not add a save/bookmark endpoint.** The web spec has no bookmark: `support` is already the
  low-cost signal (FR-202), and a second weak signal would dilute it.
- **Do not add view or impression counts to any public response.** `feedImpressions` drives the UCB
  exploration bonus and is not a validation metric; publishing it invites exactly the
  impression-gaming the flat-fee pricing model exists to avoid (PRD §6).
- **Do not add add-ons or stretch goals.** Add-ons are a shop's upsell mechanic; stretch goals are
  excluded permanently. Reward *tiers* are no longer on this list — see item 19.

---

## Suggested order

**Ideas first, because two of them are P0 and most of the rest is downstream:**

> 1 → 2 → 4 → 5 → 3

Items 1 and 2 are one piece of work with one migration and are worth doing as a single change set.
Item 4 is on the campaign path too: it is what step 1 of the builder needs in order to list a creator's
own ideas.

**Then campaigns, and item 6 gates all of them** — nothing else here means anything until a campaign
can be read:

> 6 → 19 → 16 → 13 → 14 → 7 → 12 → 15 → 17

19 and 16 sit directly behind 6 because both are columns on `Campaign` rather than new endpoints:
doing them in the same migration as the read shape avoids a second one. 13 is performance. 14 rides on
1 and cannot ship before it. 7 and 12 both wait on the Phase 2 indexer and are the same work seen at
two scales, so do them together.

**Item 18 is not code.** It is a decision to settle before the escrow programme hard-codes a different
split. It costs nothing today and is expensive the moment a tranche has been released against the
wrong base.

**Then the P2s**, in whatever order suits.
