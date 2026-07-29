# Web UI — open API gaps (TODO)

> Backlog raised on 2026-07-30 while specifying the `inverge-web` product screens (idea feed, idea
> detail, campaign detail) against this API. Every item is **additive**: no breaking change, no
> rename, no behaviour change to an existing field.
>
> Source of the requirement, in `inverge-web`: `docs/ideas-campaigns-brief.md` (build spec),
> `docs/campaign-data-contract.md` §4 (the same list from the consumer's side, with the provisional
> campaign shapes), `docs/pitch-narrative-playbook.md` §3 (why the content gaps matter).
> Web branch: `feat/ideas-campaigns-ui`.
>
> **P0 items block web work that is otherwise ready to build.** P1 unblocks screens that have a
> documented fallback. P2 is real but deferrable.

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
- **Do not add reward tiers, add-ons or stretch goals** to satisfy a reference screenshot. Rewards are
  optional in FR-301 and out of launch scope; stretch goals are excluded permanently.

---

## Suggested order

1 → 2 (same projection work, and together they unblock two web stages) → 4 → 5 → 3 → 6 → 7 → the P2s.

Items 1 and 2 are one piece of work with one migration and are worth doing as a single change set.
