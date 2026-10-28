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
> Items 20–25 were added 2026-10-16 while rebuilding the public ideas surfaces in `inverge-web`
> (`feature/ideas-ui`): the editorial homepage, the category catalogue, the public idea page and the topic
> pages, plus the community-loop plan in `docs/idea-community-loop-plan.md`. Item 25 is a bug rather than
> an enhancement: it breaks the one path every authenticated web screen depends on.
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
| 25 | Session token on `POST /auth/session` | **P0** | Every authenticated web call returns 401 |
| 20 | Committed OpenAPI document + generated typed client | P1 | Types the web's TanStack Query + `openapi-typescript` stack |
| 21 | Topics/category browse endpoint | P1 | The topic directory and `/topics/[slug]` |
| 23 | Public idea detail fields (story, risks, updates) | P1 | `/ideas/[id]` renders a real page, not a fixture stub |
| 22 | Feed pagination and total | P2 | A real load-more instead of client-side paging |
| 24 | Community loop endpoints (challenges, standings, judging) | P2 | Planned; see `docs/idea-community-loop-plan.md` |

**What the web is running on meanwhile.** Every campaign surface reads from
`inverge-web/src/lib/campaigns/campaigns-api.ts`, which returns fixtures behind one `USE_FIXTURES`
flag. Nothing in the campaign domain calls this API at all — not even `POST /ideas/:id/convert`, which
is live and correct. That is deliberate: the screens were built as UI first, against the written
contract, so the swap when item 6 lands is one file rather than a rewrite of every component.

---

## P0 — blocking

### 1. Public creator identity

**Problem.** There is no display name, avatar or bio anywhere in the data model. `User` holds
`providerUserId`, `email`, verification state and preferences; `CreatorProfile` holds tier and track record.
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
- Do not expose `kycStatus`, `amlStatus`, `bannedAt`, `providerUserId`, `oauthSubject`, `role` or
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

> **Status (2026-10-27):** both routes exist. `GET /campaigns` supports status,
> taxonomy, region, three sorts and a keyset cursor. `GET /campaigns/{id}` also
> resolves the source idea's public slug and hides non-public campaigns from
> anonymous callers. The web campaign index and detail route now read them; the
> detail page still omits sections the API does not publish (updates, receipts,
> FAQ entities) rather than borrowing fixtures.

`GET /campaigns` and `GET /campaigns/:idOrSlug` now implement the read half of
`docs/campaign-data-contract.md` §2. Fixtures remain only for deployments with no
API configured; an API-backed deployment never falls back to them.

Implementation notes:

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

**Status 2026-10-28:** `POST /campaigns/:id/submit` and
`POST /campaigns/:id/application-fee` are live and wired through the web BFF; the
wizard can pay the fee and submit the saved draft. Owner visibility through
`GET /campaigns?mine=true` remains the remaining piece of this gap.

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
initial = 20%                 of  targetAmount                 (FR-503a, fixed)
stages  = tranchePct%         of  (totalRaised - initial)      (weights sum to 10,000)
```

The initial tranche is 20% of the **target** because it is the only money that moves before anything
is verified, and because a creator should not receive more up front just for overfunding: pegged to
the raise, a $1,000 target that raises $20,000 would pay $4,000 against nothing. The milestone weights
divide the **raise after that tranche**, so a campaign that overfunds keeps the extra under the same
milestone and objection rules. The last milestone absorbs the integer remainder, so the stages sum to
exactly `totalRaised - initial`; the initial plus the stages sum to the amount raised.

If the API or the on-chain programme derives these too, all three must agree. The web now has one pure
module (`inverge-web/src/features/campaigns/lib/allocation.ts`) and the API's readiness gate enforces
the same fixed 20% / 10,000 split. Returning the derived amounts from the API is still preferable to
the client being a second implementation, and the indexer must eventually make `totalRaised`
authoritative rather than a fixture. No release endpoint or `TrancheRelease` projection exists yet, so
none of these amounts is evidence that a transfer happened.

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

## Items 20–25 — ideas discovery, detail and topics

Raised 2026-10-16 by rebuilding the public ideas surfaces in `inverge-web` (`feature/ideas-ui`): the
editorial homepage, the category catalogue (`/ideas`), the public idea page (`/ideas/[id]`) and the topic
pages (`/topics/[slug]`). All additive.

### 25. Session token on `POST /auth/session` — **P0**

**Problem.** `AuthController.session` calls `AuthService.authenticate`, which returns
`token: privyAccessToken` — the *provider* token echoed straight back — and never calls
`SessionService.sign`. But `PrivyAuthGuard` verifies an HS256 session JWT through
`SessionService.verify`. So the token `/auth/session` hands out can never pass a guarded route:
`GET /auth/me`, `PATCH /auth/me/profile`, `GET /ideas?mine=true` and every future authenticated call
return 401. The web app has no network layer yet, and that is the only reason this has stayed hidden.

**Proposed.** Mint the session in `authenticate` (or the controller): `const sessionToken = await
this.sessions.sign(user.id)` and return it. Name it `sessionToken`, not `token`, to stop conflating it with
the provider token, and keep the provider token out of the response body. Align the web client and the e2e
expectation on the one field name.

**Tests.** E2E: `/auth/session` returns a token that `GET /auth/me` accepts; a garbage or expired token
401s; the provider token never appears in the response body.

### 20. Committed OpenAPI document and generated typed client — P1

**Problem.** Swagger is wired (`main.ts`: `DocumentBuilder` + `SwaggerModule.setup('docs', ...)`), so a
spec exists at runtime under `/docs` and `/docs-json`. It is not committed or versioned, and it is thin on
*responses*: the `@nestjs/swagger` CLI plugin is not enabled in `nest-cli.json`, and most controllers
return plain service objects, so many responses carry no schema. The web's approved stack (TanStack Query
plus `openapi-typescript`) needs a stable, committed `openapi.json` to generate from.

**Proposed.** Enable the `@nestjs/swagger` CLI plugin (or annotate response DTOs and add `@ApiOkResponse`),
add a script that emits `openapi.json` at build, and publish it — commit it, or serve a versioned
`/openapi.json`. Generate the web types from that artefact.

**Invariants.** The emitted spec is a public interface: generate it from the same projections the runtime
uses, so it cannot describe a forbidden field (see item 1's list).

**Tests.** A CI drift guard: regenerate and fail if the committed spec differs from the live one.

### 21. Topics and categories as a browse axis — P1

**Problem.** The catalogue's category chips, the topic directory and `/topics/[slug]` all read from web
fixtures (`inverge-web/src/features/ideas/content/topics.ts`). Nothing lists topics or filters ideas by one.

**Proposed.** `GET /topics` (`slug`, `title`, `description`, `publicIdeaCount`) and either
`GET /topics/:slug/ideas` or a `topic=` filter on `GET /ideas`, matching the feed's existing query idiom.

**Invariants.** A topic's count respects visibility: it counts public ideas only and must never surface or
count an unlisted/private idea (the web scopes with `ideasInTopic(topic, ideas, "public")`). Counts follow
the recompute-never-increment rule, not a stored counter.

**Open question.** Does the API already model a browse axis (category enum, tags) that topics map onto, or
is this net-new taxonomy? Confirm before building.

### 23. Public idea detail fields — P1

**Problem.** `/ideas/[id]` now renders a full page — pitch story, FR-204 gate progress and a published date
— but all of it comes from the web fixture (`inverge-web/src/features/ideas/content/preview-details.ts`).
The public `GET /ideas/:id` projection still returns no `story`, `risks`, `publishedAt` or `updates`, so
the page cannot leave preview mode. Items 1, 5 and 9 supply the creator, the gate thresholds and a
one-line summary; the rest are unlisted.

**Proposed.** Widen the public `GET /ideas/:id` projection with `story` (the pitch body, rich text),
`risks` (item 8), `publishedAt`, and `updates: { id, title, body, createdAt }[]`. Gate thresholds and
progress arrive through item 5. No new endpoint — a widening of the existing detail read, reusing the
item 1 creator projection and the item 2 author rules wherever comments appear.

**Invariants.** Same forbidden-field rules as item 1. The story is user-supplied public content: moderate
on write, strip control characters, cap length.

### 22. Feed pagination and total — P2

**Problem.** The catalogue's "Show more" pages client-side over the whole fixture set. `GET /ideas` accepts
`skip`/`take` but returns no total or cursor, so a real load-more cannot know when to stop.

**Proposed.** Add `total` (and/or `nextCursor`) to the feed response, keeping the existing `skip`/`take`.

### 24. Community loop endpoints — P2, planned

The weekly challenges, monthly ideathon, weighted standings, judging and reputation badges are specified in
`docs/idea-community-loop-plan.md` (schema, endpoints, phasing A/B/C, anti-gaming and judge-conflict
rules). Grouped here so this document stays the single index of web-driven API asks. Not scheduled until
that plan is approved.

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

**Items 20–25, raised 2026-10-16, slot in as follows.** Item 25 comes first regardless of the rest: it is
the one that is a bug, and it gates every authenticated web screen. Then, after the existing ideas run
(1 → 2 → 4 → 5 → 3): 21 → 23 → 20 → 22. Item 24 waits on the community-loop plan being approved.

---

## Verification domain — delivered 2026-10-27

The creator/backer verification work (FR-103, FR-104, FR-105, FR-311) landed as one domain rather than
the three separate asks this document would otherwise have carried. It is recorded here because the web
consumer contract lives here too. Source: `inverge-api src/modules/kyc/` (verification domain),
`docs/campaign-review-sprint.md` (submission gate), `inverge-web/docs/DECISIONS.md` D-047.

### Endpoints

Creator-facing, all behind `PrivyAuthGuard`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/verification/state` | Normalised account state: account type, per-subject case, requirements, blockers, `nextAction`, `policyVersion`, `identityVerified`, `fundsCleared`, `complianceHold` |
| `GET` | `/verification/eligibility?purpose=` | Gate preview for one purpose (`IDEA_VALIDATION`, `CAMPAIGN_CREATOR`, `BACKER_THRESHOLD`): `eligible`, stable `code`, `blockers`, `requirements` |
| `POST` | `/verification/session` | Start/restart a hosted session (`subject`, `purpose`); returns `caseId` + `verificationUrl` |
| `POST` | `/verification/business/session` | Register the business and start KYB (legal name required) |
| `GET` | `/verification/business` | Business registration + KYB/AML projection |
| `POST` | `/verification/account-type` | Switch `INDIVIDUAL`/`BUSINESS`; cases stay attached to their type |
| `POST` | `/verification/contributions/authorize` | FR-104 cumulative-threshold authorisation with reserved headroom |
| `POST` | `/verification/webhook` | Provider callback (public, signature-verified, acknowledges fast) |

Compliance-facing, behind `PrivyAuthGuard` + `ComplianceReviewerGuard` (ADMIN and the new
`COMPLIANCE_REVIEWER` role; least privilege is enforced server-side):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/verification/admin/queues` | Pending/escalated queues, status counts, provider errors, review-open, policy version |
| `GET` | `/verification/admin/cases` | Paginated case list: `status`, `risk`, `type`, `requiresReview`, `cursor`, `limit` |
| `GET` | `/verification/admin/cases/:id` | Case, subject, business, append-only event history |
| `POST` | `/verification/admin/cases/:id/resolve` | Reasoned risk resolution (`decision`, `reasonCode`, `reason`); audited, never automatic |

Legacy `/kyc/*` and `/kyb/*` remain as a compatibility facade over the same domain so already-shipped
clients are not broken. Their `reasons` field is the new `blockers` list under the old name.

### Status model

`NOT_STARTED · SESSION_CREATED · AWAITING_USER · SUBMITTED · IN_REVIEW · APPROVED · DECLINED ·
ACTION_REQUIRED · EXPIRED · CANCELLED · ERROR`, with `RiskOutcome = NOT_ASSESSED | CLEAR | REVIEW |
FLAGGED`. Provider strings (`Not Started`, `In Progress`, `Awaiting User`, `Approved`, `Declined`,
`In Review`, `Resubmitted`, `Expired`, `Abandoned`, `Kyc Expired`) are case-sensitive and never escape
the adapter. An unmapped string becomes `ERROR`, which is a support signal, not a decline.

### Stable error codes

`VERIFICATION_REQUIRED`, `VERIFICATION_IN_PROGRESS`, `VERIFICATION_IN_REVIEW`,
`VERIFICATION_ACTION_REQUIRED`, `VERIFICATION_DECLINED`, `VERIFICATION_EXPIRED`,
`VERIFICATION_PROVIDER_ERROR`, `VERIFICATION_COMPLIANCE_HOLD`, `VERIFICATION_BUSINESS_PROFILE_REQUIRED`,
`VERIFICATION_ACCOUNT_TYPE_MISMATCH`, `VERIFICATION_ATTEMPTS_EXCEEDED`, `VERIFICATION_UNAVAILABLE`,
`CONTRIBUTION_THRESHOLD_EXCEEDED`, `CONTRIBUTION_CAMPAIGN_NOT_FUNDABLE`, plus
`APPLICATION_FEE_REQUIRED` from the campaign review gate. Clients switch on `code`; the message is copy.

### Gates

- **Campaign submission** (`POST /campaigns/:id/submit`) evaluates the verification domain before the
  transaction and the review preconditions inside it: ownership, submittable status, identity/funds
  clearance, no compliance hold, and a succeeded application fee bound to this creator and campaign.
- **Backer threshold** (`POST /verification/contributions/authorize`) serialises per user with
  `pg_advisory_xact_lock`, so two concurrent pledges cannot both sit below the cumulative threshold.
  A reservation has a TTL (`VERIFICATION_AUTHORIZATION_TTL_SECONDS`).

### Webhook and reconciliation

Signature schemes: `X-Signature-V2` (canonical JSON), `X-Signature` (raw bytes), `X-Signature-Simple`
(envelope only; not treated as authenticating the payload), plus `*-Previous` rotation headers verified
against `DIDIT_WEBHOOK_SECRET_PREVIOUS`. `X-Timestamp` is bounded to ±300 s. Events are deduplicated on
`providerEventReference`; a replay is acknowledged without re-applying. The handler never trusts the
callback's decision body: it re-fetches the decision from the provider before writing, and heavy work is
queued when `QUEUE_ENABLED` (otherwise processed inline).

A reconciliation job sweeps cases whose last provider sync is older than
`VERIFICATION_RECONCILE_AFTER_MINUTES`, with bounded exponential backoff and jitter
(`VERIFICATION_RECONCILE_MAX_ATTEMPTS`), then stops and flags the case as escalated rather than looping.
Redis is a queue, not the record: every state transition is persisted, so a queue outage only delays sync.

### Provider configuration still to do (Didit console, not code)

1. Publish the identity workflow used for `DIDIT_KYC_WORKFLOW_ID` — the one currently in the console
   ("Free KYC") is a draft, and a draft workflow cannot start a session.
2. Register the webhook destination: `POST https://<api-host>/api/v1/verification/webhook`, subscribed to
   `status.updated` and `data.updated`, with the same secret as `DIDIT_WEBHOOK_SECRET`. Browser redirects
   are never used as the source of truth.
3. Confirm the KYB workflow actually runs the key-people step. If it does not, leave
   `DIDIT_KYB_REQUIRE_KEY_PEOPLE=true`: the domain will refuse to treat KYB as complete, which is correct.

### Deferred, and deliberately not invented

- Risk thresholds for auto-`REVIEW` vs `FLAGGED`, country/sanctions-list policy, and which optional
  provider checks are mandatory are product/compliance decisions. The domain implements the mechanism and
  a configurable policy version; the values are open.
- Ongoing AML re-screening schedules, on-chain/wallet L1 gates and geo restrictions are not part of this
  change.
- Document deletion/retention jobs are specified but not scheduled; no raw documents or identity numbers
  are stored by this domain in any case.
