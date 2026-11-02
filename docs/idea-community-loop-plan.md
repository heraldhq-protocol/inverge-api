# Idea validation community loop: implementation plan

Status: **Draft for product owner review; no code written.**
Owner: Product and engineering.
Scope: extend the Phase 0 idea-validation module into a community loop (weekly sponsored
challenges, a monthly ideathon with judged shortlist, and early-supporter reputation badges).
Applies to `inverge-api` (NestJS, Prisma, BullMQ). Touches `inverge-web` for read surfaces only.

This document is a plan. It contains a proposed schema sketch and requirement tables (the
requested artefacts) and no implementation code.

## 0. The loop in one paragraph

A creator publishes an idea. Sponsors fund weekly **challenges** on a topic; ideas that fit the
topic are tagged into the challenge; the community supports, gives structured feedback, and
pre-pledges as it already can. A challenge surface shows **weighted support standings** (never raw
counts, never affected by money). At close, the standings are frozen into an immutable snapshot.
Admins review a shortlist and any anti-gaming flags, judges score the shortlist against a rubric
(declaring conflicts of interest), and public results are published. Prizes are fulfilled by the
sponsor off-platform; no money moves through the platform for a challenge or a prize. Separately,
accounts that supported an idea before it funded earn an early-supporter badge that is upgraded if
the idea later delivers.

Three hard invariants run through everything below. They are not configurable:

1. **Money never ranks.** Sponsorship, paid boosts, and prize value must not change any score,
   rank, shortlist position, or judge outcome.
2. **Weights, not counts.** Ranking uses the existing pre-pledge verification weights (email 0.25,
   verified social 0.7, KYC or previously funded 1.0).
3. **Nothing implies a return.** Prizes are recognition, not investment, and are fulfilled outside
   the platform.

---

## 1. What exists and what to reuse

Read this section with the code open. The loop is mostly assembly of existing parts.

| Need | Reuse | File |
| --- | --- | --- |
| Verification weights (0.25 / 0.7 / 1.0) and tier resolution | `resolveTier`, `baseTierId`, `DEFAULT_TIERS`, `round2`, `DEFAULT_MIN_ACCOUNT_AGE_HOURS` | `src/modules/metrics/pledge-weighting.ts` |
| One support and one pre-pledge per account per idea | `IdeaSignal @@unique([ideaId, userId, type])` | `prisma/schema.prisma` |
| One structured feedback per account per idea | `SurveyResponse @@unique([ideaId, userId])` | `prisma/schema.prisma` |
| Behavioural, recomputed-not-incremented metrics | `MetricsService.recompute(tx, ideaId, now)`, `loadWeightingParams()` | `src/modules/metrics/metrics.service.ts` |
| Point-in-time capture pattern | `IdeaMetricSnapshot`, `snapshotAllValidating`, `isSustained` | `src/modules/metrics/metrics.service.ts` |
| Admin-editable config with audit | `PlatformParamsService.get/set/auditLog`, `PlatformParam`, `PlatformParamAudit` | `src/modules/platform-params/platform-params.service.ts` |
| Admin config surface | `@Controller('admin')`, `AdminGuard` | `src/modules/admin/admin.controller.ts`, `src/modules/auth/guards/admin.guard.ts` |
| Auth for reads / writes | `OptionalPrivyAuthGuard`, `PrivyAuthGuard` | `src/modules/auth/guards/` |
| Scheduled jobs | `QueueModule`, `SnapshotScheduler`, `SnapshotProcessor` | `src/modules/queue/queue.module.ts`, `src/modules/metrics/snapshot.*` |
| Pure-logic convention | `pledge-weighting.ts`, `insights-compute.ts`, `moderation-routing.ts`, `survey-validation.ts` | `src/modules/**` |
| Vendor isolation | ports under `src/ports/`, selected by env | `src/ports/ports.module.ts` |
| Public creator projection | `toPublicCreator` | `src/common/projections/creator-profile.projection.ts` |
| Idea read shape and pagination idiom | `IdeasController`, `list(query, currentUserId)`, `skip`/`take` | `src/modules/ideas/ideas.controller.ts`, `ideas.service.ts`, `dto/idea.dto.ts` |
| Sponsorable, non-scoring placement precedent | `IdeaBoost` kept structurally separate from signals | `prisma/schema.prisma` |
| Web fixtures pattern | `content/preview-data.ts` per feature | `inverge-web/src/features/*/content/` |
| Web route split | public at `/ideas`, creator at `/d/ideas` | `inverge-web/docs/DECISIONS.md` D-011, D-014 |

**What already gives us the scoring inputs (so we do not add support tables).** Support,
structured feedback, and pre-pledge already have exactly-one-per-account-per-idea uniqueness. The
loop therefore needs new challenge, entry, snapshot, judging, conflict and badge tables plus a
**new pure scoring module**, not new signal tables. This keeps the FR-206a separation intact.

**Load-bearing facts to carry into implementation.**

- `pledge-weighting.ts` is amount-based. Challenge rank is count-based. The new pure module sits
  beside it and **reuses the same tier weights**, but computes a different figure (see section 6).
- `validation.minAccountAgeHours` (default 48) already exists. The loop reuses it; do not add a
  second account-age parameter.
- `pastFunder` is declared in `PledgerIdentity` but is **never populated anywhere in the codebase**.
  The VERIFIED tier is therefore KYC-only today. Flagged in section 8.
- The single BullMQ queue is `metrics-snapshot`; there is no Redis cache client. Standings caching
  is handled by a materialised table refreshed by a job (section 3), not by adding Redis cache
  infra. Flagged in section 8.

---

## 2. Proposed Prisma schema changes

All models are additive. Existing tables (`IdeaSignal`, `SurveyResponse`, `Idea`, `User`) are
untouched except for new back-relation fields. Decimal fields follow the repo's `@db.Decimal`
convention. Sponsorship tables are deliberately separate from any scoring input, mirroring how
`IdeaBoost` is kept out of `MetricsService`.

### 2.1 Enums

```prisma
enum ChallengeKind {
  WEEKLY    // sponsored weekly challenge
  IDEATHON  // monthly judged ideathon
}

enum ChallengeStatus {
  DRAFT
  SCHEDULED
  OPEN
  CLOSED        // scoring frozen; FINAL snapshot captured
  SHORTLISTED   // admin-reviewed shortlist frozen
  PUBLISHED     // results public
  ARCHIVED
}

enum ChallengeEntrySource {
  AUTO_TAG
  CREATOR_OPT_IN
  ADMIN
}

enum ChallengeEntryStatus {
  ELIGIBLE
  WITHDRAWN
  FLAGGED
}

enum SnapshotKind {
  REFRESH
  FINAL
}

enum JudgeConflictDeclaration {
  NONE
  DECLARED
  EXCLUDED
}

enum ReputationBadgeType {
  EARLY_SUPPORTER
  EARLY_SUPPORTER_DELIVERED
}

enum AnomalyFlagType {
  BURST_VOTE
  SHARED_DEVICE_CLUSTER
  SHARED_IP_CLUSTER
  NEW_ACCOUNT_CLUSTER
  OTHER
}

enum AnomalyFlagStatus {
  OPEN
  REVIEWED
  DISMISSED
  CONFIRMED
}
```

### 2.2 Sponsors and challenges

```prisma
model Sponsor {
  id           String   @id @default(cuid())
  name         String   @unique   // internal key, matched against judge affiliations
  displayName  String
  logoUrl      String?
  websiteUrl   String?
  contactEmail String?  // admin only, never in a public projection
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  challenges Challenge[]
}

model Challenge {
  id          String          @id @default(cuid())
  kind        ChallengeKind   @default(WEEKLY)
  slug        String          @unique
  title       String
  topic       String          // sponsor-set topic; visibility only
  description String
  sponsorId   String?
  sponsor     Sponsor?        @relation(fields: [sponsorId], references: [id])
  status      ChallengeStatus @default(DRAFT)

  startsAt DateTime
  endsAt   DateTime

  // Prize is off-platform fulfilment only. Free text, no return language (NFR-14/NFR-25).
  prizeDescription String
  prizeValueUsd    Decimal? @db.Decimal(14, 2) // reference figure only, never a payout rail

  // Eligibility, set by admin from the sponsor's topic. Scoring config stays in PlatformParams.
  entryRule Json? // { categories?: string[], regions?: string[], minQuality?: number }

  finalSnapshotId String?   // plain field to avoid a circular FK with ChallengeSnapshot
  publishedAt     DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  entries   ChallengeEntry[]
  standings ChallengeStanding[]
  snapshots ChallengeSnapshot[]
  judges    ChallengeJudge[]
  flags     AnomalyFlag[]

  @@index([status])
  @@index([kind, status])
  @@index([sponsorId])
}
```

### 2.3 Entries and live standings

`ChallengeEntry` is both the tag and the participation record (one row per challenge and idea). A
creator opt-in and an admin or auto tag are the same shape; `source` records how it happened.

```prisma
model ChallengeEntry {
  id          String               @id @default(cuid())
  challengeId String
  challenge   Challenge            @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  ideaId      String
  idea        Idea                 @relation(fields: [ideaId], references: [id], onDelete: Cascade)
  source      ChallengeEntrySource @default(AUTO_TAG)
  status      ChallengeEntryStatus @default(ELIGIBLE)
  enteredAt   DateTime             @default(now())

  @@unique([challengeId, ideaId])
  @@index([challengeId, status])
  @@index([ideaId])
}

// Live, refreshed projection. Replaced (upsert) on recompute by the standings job.
// This IS the standings cache: reads are a simple ordered select, no Redis cache client.
model ChallengeStanding {
  id             String    @id @default(cuid())
  challengeId    String
  challenge      Challenge @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  ideaId         String
  rank           Int
  weightedScore  Decimal   @db.Decimal(12, 4)
  supporterCount Int
  pointsJson     Json      // { support, feedback, prePledge, perTier: {EMAIL,SOCIAL,VERIFIED} }
  computedAt     DateTime  @default(now())

  @@unique([challengeId, ideaId])
  @@index([challengeId, rank])
}
```

### 2.4 Immutable snapshots

A `FINAL` snapshot is written once at close and is the only source for shortlisting and results.
`ChallengeStanding` rows may keep changing after that; the snapshot does not. `checksum` makes the
frozen result tamper-evident and reproducible.

```prisma
model ChallengeSnapshot {
  id          String       @id @default(cuid())
  challengeId String
  challenge   Challenge    @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  kind        SnapshotKind
  capturedAt  DateTime     @default(now())
  frozenAt    DateTime?    // set for FINAL; immutable once set
  checksum    String       // hash of the ordered standings rows

  rows ChallengeStandingSnapshot[]

  @@index([challengeId, kind])
}

model ChallengeStandingSnapshot {
  id             String            @id @default(cuid())
  snapshotId     String
  snapshot       ChallengeSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
  ideaId         String
  rank           Int
  weightedScore  Decimal           @db.Decimal(12, 4)
  supporterCount Int
  pointsJson     Json

  @@unique([snapshotId, ideaId])
  @@index([snapshotId, rank])
}
```

### 2.5 Judging and conflicts

```prisma
model ChallengeJudge {
  id             String                    @id @default(cuid())
  challengeId    String
  challenge      Challenge                 @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  userId         String
  user           User                      @relation(fields: [userId], references: [id], onDelete: Cascade)
  affiliation    String                    // employer or organisation, matched against Sponsor.name
  conflict       JudgeConflictDeclaration  @default(NONE)
  conflictReason String?
  declaredAt     DateTime?
  active         Boolean                   @default(true)

  @@unique([challengeId, userId])
  @@index([userId])
}

model ChallengeJudgeScore {
  id          String   @id @default(cuid())
  challengeId String
  judgeUserId String
  ideaId      String
  rubric      Json     // rubric answers, published rubric version referenced
  totalScore  Decimal  @db.Decimal(8, 4)
  comment     String?
  submittedAt DateTime @default(now())

  @@unique([challengeId, judgeUserId, ideaId])
  @@index([challengeId, ideaId])
}
```

### 2.6 Reputation badges

```prisma
model ReputationBadge {
  id           String              @id @default(cuid())
  userId       String
  user         User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  ideaId       String
  idea         Idea                @relation(fields: [ideaId], references: [id], onDelete: Cascade)
  type         ReputationBadgeType
  awardedAt    DateTime            @default(now())
  upgradedAt   DateTime?
  evidenceJson Json                // support timestamp vs funding event, campaign id

  @@unique([userId, ideaId, type])
  @@index([userId])
}
```

### 2.7 Anti-gaming

`AnomalyFlag` is the human-review queue. `SignalFingerprint` is the new device/network signal and
is **personal data**; store salted hashes only, with a retention purge job (section 6, section 8).

```prisma
model AnomalyFlag {
  id          String            @id @default(cuid())
  challengeId String
  challenge   Challenge         @relation(fields: [challengeId], references: [id], onDelete: Cascade)
  ideaId      String?
  userId      String?
  type        AnomalyFlagType
  severity    Int               @default(1)
  detail      Json
  status      AnomalyFlagStatus @default(OPEN)
  reviewedBy  String?
  reviewedAt  DateTime?
  createdAt   DateTime          @default(now())

  @@index([challengeId, status])
}

// Deliberately not related by FK so rows can be purged on retention without touching signals.
model SignalFingerprint {
  id         String   @id @default(cuid())
  ideaId     String
  userId     String
  ipHash     String
  deviceHash String
  uaHash     String?
  createdAt  DateTime @default(now())

  @@index([ideaId, createdAt])
  @@index([ipHash])
  @@index([deviceHash])
}
```

### 2.8 Back-relations to add

- `Idea`: `challengeEntries ChallengeEntry[]`, `reputationBadges ReputationBadge[]`
- `User`: `challengeJudgeRoles ChallengeJudge[]`, `reputationBadges ReputationBadge[]`

### 2.9 Config keys (reuse `PlatformParam`, do not add a config table)

Seeded with defaults, admin-editable via the existing `PATCH /admin/params`, audited via
`PlatformParamAudit`. Namespaced `challenges.*`:

```text
challenges.scoring.supportPoints            1
challenges.scoring.feedbackPoints           1
challenges.scoring.prePledgePoints          1     // flat, once per account per idea; amount does not rank
challenges.shortlistSize                    10
challenges.rateLimit.supportsPerHour        30    // per account, across challenge-tagged ideas
challenges.anomaly.burstWindowMinutes       60
challenges.anomaly.burstAccounts            10
challenges.anomaly.sharedClusterMin         5
challenges.standingsRefreshMinutes          5
challenges.fingerprintRetentionDays         90
challenges.autoDisqualifyEnabled            false // launch: automated disqualification OFF
```

`challenges.minAccountAgeHours` is **not** added; reuse `validation.minAccountAgeHours`.

---

## 3. Proposed API endpoints

New module `src/modules/challenges/` with `challenges.module.ts`, `challenges.controller.ts`,
`challenges.service.ts`, `judging.controller.ts`, a pure `challenge-scoring.ts`, `dto/`, and a
BullMQ queue `challenge-lifecycle` (`challenge-jobs.scheduler.ts` + `challenge-jobs.processor.ts`).
A `judging.guard.ts` (new) and, in Phase B, a `reputation` service. Registration goes into
`app.module.ts` beside `CampaignsModule`.

Conventions to match: no global prefix and no versioning; `skip`/`take` query pagination with
`@Type(() => Number)`; `OptionalPrivyAuthGuard` on public reads, `PrivyAuthGuard` on writes,
`PrivyAuthGuard` plus `AdminGuard` on admin writes; plain JSON responses (Prisma decimals serialise
as strings, as the existing e2e asserts with `Number(body.x)`).

### 3.1 Public reads (label public standings "Community standings")

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/challenges` | Optional | Filters `kind`, `status`, `sponsorId`; sort `starting-soon`/`ending-soon`/`newest`. `skip`/`take`. |
| GET | `/challenges/:id` | Optional | Public projection: topic, dates, sponsor public fields, prize description, `sponsored: true`, entry rule summary. |
| GET | `/challenges/:id/standings` | Optional | Reads `ChallengeStanding`, ordered by `rank`. Rows carry the public idea projection, weighted score, rank. |
| GET | `/challenges/:id/entries` | Optional | Public idea projections for `ELIGIBLE` entries. |
| GET | `/challenges/:id/results` | Optional | 404 unless `PUBLISHED`. Reads the `FINAL` snapshot plus judge totals (published fields only). |

### 3.2 Participant writes

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| POST | `/challenges/:id/entries` | Privy | Body `{ ideaId }`. Caller must own the idea; challenge must be `SCHEDULED` or `OPEN`; entry rule must pass; idea must be eligible (see section 8, visibility). |
| DELETE | `/challenges/:id/entries/:ideaId` | Privy | Owner or admin withdraws. Sets `WITHDRAWN`, never deletes the row. |

### 3.3 Admin (new `@Controller('admin/challenges')` and `@Controller('admin/sponsors')`, `AdminGuard`)

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/admin/sponsors` | List and create sponsors. |
| PATCH | `/admin/sponsors/:id` | Update sponsor visibility fields. |
| GET/POST | `/admin/challenges` | List and create challenges. |
| PATCH | `/admin/challenges/:id` | Update topic, dates, prize text, entry rule. |
| POST | `/admin/challenges/:id/open` | Force `OPEN`. |
| POST | `/admin/challenges/:id/close` | Force close and write the `FINAL` snapshot. |
| GET | `/admin/challenges/:id/snapshot` | Read the frozen snapshot. |
| POST | `/admin/challenges/:id/shortlist` | Review frozen snapshot plus open flags, freeze the shortlist (`SHORTLISTED`). Body carries the reviewed flag decisions. |
| GET | `/admin/challenges/:id/flags` | Anomaly queue. |
| PATCH | `/admin/challenges/:id/flags/:flagId` | `REVIEWED` / `DISMISSED` / `CONFIRMED`. Human action only. |
| POST | `/admin/challenges/:id/publish` | Publish results (`PUBLISHED`). |

Config: reuse `PATCH /admin/params` with `challenges.*`. Boost-style typed sub-resource is optional
and not required.

### 3.4 Judging (Phase B; judges are not admins)

`@Controller('challenges/:id/judging')`, protected by the new `JudgeGuard` (an active
`ChallengeJudge` for this challenge, enforcing the conflict exclusion).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/challenges/:id/judging/worklist` | Shortlisted ideas, excluding any idea the judge is conflict-excluded from. |
| POST | `/challenges/:id/judging/conflicts` | Declare a conflict. Sets `conflict`, `conflictReason`, `declaredAt`. |
| POST | `/challenges/:id/judging/scores` | Submit a score per shortlisted idea. Rejected when the judge is `EXCLUDED`. |
| GET | `/challenges/:id/judging/scores` | The judge's own submissions. |

### 3.5 Badges (Phase B design, Phase 3 view)

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/me/badges` | Privy | The caller's badges. Data ships Phase B; the public reputation view is Phase 3 and out of launch scope. |

Awarding is event-driven from the funding and delivery lifecycle and is idempotent; no public
award endpoint exists.

### 3.6 Scheduled work (new queue `challenge-lifecycle`)

Register with `BullModule.registerQueue({ name: 'challenge-lifecycle' })` in the challenges module,
following the resilient `onModuleInit` pattern in `snapshot.scheduler.ts` (a Redis outage must not
crash boot).

- `challenge-lifecycle-tick` (repeatable, hourly): transition `SCHEDULED` to `OPEN` at `startsAt`
  and `OPEN` to `CLOSED` at `endsAt`; on close, write the `FINAL` snapshot with a checksum.
- `challenge-standings-refresh` (repeatable, `challenges.standingsRefreshMinutes`): recompute open
  challenges' `ChallengeStanding` via the pure scoring module.
- `challenge-anomaly-scan` (repeatable, hourly): compute burst and shared-cluster flags into
  `AnomalyFlag`. Never auto-disqualifies at launch.
- `signal-fingerprint-purge` (repeatable, daily): delete `SignalFingerprint` older than
  `challenges.fingerprintRetentionDays`.

Signal writes (support, pre-pledge, survey response) enqueue a refresh for any affected open
challenge, so the board is near-live without recomputing on every read.

---

## 4. Proposed web pages and components

The web repo is fixture-only today: no shadcn/ui, no TanStack Query, no generated OpenAPI client,
and no network calls from product features. Every feature renders from a `content/preview-data.ts`
module. The loop follows that pattern exactly, with one swap point per feature, and does **not**
introduce a data library or a generated client in this work. This is recorded as an open decision
in section 8.

Public routes sit with the public idea pages (marketing shell, per D-014); creator routes sit under
the `/d` dashboard (per D-011).

### 4.1 Feature module

```text
inverge-web/src/features/challenges/
  components/            # challenge-card, challenge-header, sponsored-label, prize-panel,
                         # community-standings, standing-row, challenge-ribbon, entry-list,
                         # supporter-badge, judge-score-form, conflict-declaration
  content/preview-data.ts
  lib/                   # pure: rank/sort, score formatting, standings derivations
  types.ts
```

### 4.2 Public pages

| Route | Purpose |
| --- | --- |
| `src/app/(marketing)/challenges/page.tsx` | Active, upcoming and past challenges. `Sponsored challenge` label on each. |
| `src/app/(marketing)/challenges/[id]/page.tsx` | Topic, dates, sponsor, prize panel (off-platform wording), `Community standings`, entries. |
| `src/app/(marketing)/challenges/[id]/results/page.tsx` | Published results from the frozen snapshot; unavailable state before publication. |

### 4.3 Creator and judge pages

| Route | Purpose |
| --- | --- |
| `src/app/(product)/d/challenges/page.tsx` | A creator's entries and an "Enter an idea" action. |
| `src/app/(product)/d/judging/[challengeId]/page.tsx` | Judge worklist and score form (Phase B). Flagged in section 8 because the web repo has no admin surface yet. |

### 4.4 Idea page changes

- `ideas/components/idea-discovery-card.tsx` and the idea detail composition: add a
  `challenge-ribbon` when the idea is tagged into an open challenge.
- Show a `supporter-badge` ("Supported early") on the viewer's own view when applicable. The badge
  is fixture-backed until the API lands.
- Do **not** merge a challenge or sponsor label into the validation metric strip. Sponsorship is a
  separate, plainly labelled element, exactly as `Promoted` is handled today.

### 4.5 Naming and copy

- Public standings are called **Community standings** (subtitle: "Ranked by verified support").
  A neutral alternative on the shortlist is **Support standings**. The word "leaderboard" is
  internal only and must not appear in any UI string.
- UK English, no em dashes, no chain jargon in default flows.
- Sponsor-facing wording: "Sponsored challenge by X". No wording implies that a sponsor, a boost,
  or a prize affects ranking, validation quality, or approval odds.
- Prize wording examples: "Prize: a place on the sponsor's accelerator shortlist", "Winners
  announced on 30 November". Never "return", "reward yield", "ROI", or anything investment-like.

### 4.6 Shared primitives

Reuse `components/ui` (card, pill, status-badge, meter, avatar, amount, metric-strip, tabs). Add one
domain-neutral primitive, `components/ui/sponsored-label.tsx`, so `Sponsored` / `Promoted` stays a
single implementation across ideas and challenges.

---

## 5. Build order and phasing

The phases map to the brief. Phase C is documented and **not built**.

### Phase A: challenges, tagging, weighted scoring, weekly standings, idea page changes

1. **Pure scoring module first.** `src/modules/challenges/challenge-scoring.ts` plus
   `challenge-scoring.spec.ts`. Inputs: per-idea participant rows with identity fields
   (`kycStatus`, `oauthSubject`, `emailVerified`, `bannedAt`, `createdAt`), flags for
   `hasSupport`, `hasFeedback`, `hasPrePledge`. Outputs: per-idea weighted score and an ordered
   standings list with deterministic tie-breaks. Reuses `resolveTier`, `round2`, `TierConfig` from
   `pledge-weighting.ts`. One implementation of the score maths.
2. **Schema migration (Phase A tables).** `Sponsor`, `Challenge`, `ChallengeEntry`,
   `ChallengeStanding`, `ChallengeSnapshot`, `ChallengeStandingSnapshot`, `AnomalyFlag`,
   `SignalFingerprint`, plus the `Idea`/`User` back-relations. Follow the Prisma v7 migrate flow in
   `inverge-api/AGENTS.md`.
3. **Param defaults.** Add the `challenges.*` keys to `prisma/seed.ts`.
4. **Challenges module and endpoints.** Public reads (3.1), participant writes (3.2), admin
   (3.3 minus shortlist/publish detail), using the response and pagination conventions in section 3.
5. **Queue `challenge-lifecycle`.** Open/close, standings refresh, anomaly scan, fingerprint purge.
6. **Idea integration.** Expose a challenge association on `GET /ideas/:id`; admin tagging; emit a
   standings refresh on signal writes. `assertSignalable` stays as is; the loop does not change the
   idea lifecycle.
7. **Anti-gaming basics.** Write `SignalFingerprint` on support/pre-pledge/survey writes; rate
   limit; burst and shared-cluster flags into `AnomalyFlag`. Auto-disqualification stays off.
8. **Web (fixtures).** `features/challenges/` types, preview data, and the section 4 pages; the
   idea-page ribbon.
9. **Tests.** Unit tests for `challenge-scoring.ts` (weights, once-per-account caps, banned
   exclusion, account-age, tie-breaks, money-is-ignored). E2E mirroring `ideas.e2e-spec.ts` (section
   5, acceptance below), including a boost-and-sponsor isolation test that asserts the standing is
   byte-for-byte unchanged.

### Phase B: shortlist, judging tools, results, supporter badges

1. **Shortlist admin review.** Freeze shortlist from the `FINAL` snapshot only; flag review
   decisions recorded on the challenge.
2. **Judging.** `ChallengeJudge`, `ChallengeJudgeScore`, `JudgeGuard`, conflict declaration and
   enforcement, judge worklist and score submission.
3. **Results publication.** `POST /admin/challenges/:id/publish` and the public results endpoint
   and page.
4. **Badges.** `ReputationBadge`, award on support-before-funding, upgrade on delivery, all
   idempotent and event-driven; `GET /me/badges`; `supporter-badge` component. The public
   reputation view stays Phase 3.
5. **Schema migration (Phase B tables).** Separate migration for judging and badges.

### Phase C (documented, do NOT build)

- Sponsor self-serve portal (sponsor login, sponsor dashboards, sponsor-submitted eligibility).
- Automated prize payouts (explicitly out of platform scope; prizes are fulfilled off-platform).
- A public challenges API for third parties.

### Acceptance tests (Phase A and B)

- Standings rank by weighted score, not raw counts: two ideas with equal raw supports but different
  tier mixes rank differently.
- Support, structured feedback, and pre-pledge each add at most one flat point per account per idea;
  pre-pledge amount never changes the score.
- A banned account contributes nothing; a below-min-age account does not contribute to challenge
  scoring (see section 8 for the floor-versus-exclude decision).
- A boost purchase, a boost activation, and adding a sponsor leave every standing unchanged.
- The `FINAL` snapshot is written once at close, is immutable, and its checksum verifies; later
  signal changes cannot alter the shortlist or the results.
- A judge whose affiliation matches the sponsor cannot see the worklist item or submit a score.
- Anomaly flags are created but never auto-disqualify; only an admin action changes a status.
- `SignalFingerprint` rows are purged past the retention window; no raw IP or device string is ever
  stored.

---

## 6. Anti-gaming and judge-conflict rules

### 6.1 The scoring rule (pure, unit-tested, money-blind)

For each account `u` and idea `i` in a challenge:

```text
base(u, i) = (hasSupport ? 1 : 0) + (hasFeedback ? 1 : 0) + (hasPrePledge ? 1 : 0)   // max 3
weight(u)  = tier weight from resolveTier(u)   // EMAIL 0.25, SOCIAL 0.7, VERIFIED 1.0
points(u, i) = base(u, i) * weight(u)
score(i) = sum over eligible u of points(u, i)
```

Only counts are used, so the pre-pledge amount is shown but cannot drive rank. `resolveTier` already
returns null for banned accounts and floors low-age accounts to EMAIL. The challenge module reuses
this rather than re-implementing tier logic.

Tie-breaks are deterministic: weighted score descending, then supporter count descending, then the
earliest qualifying signal timestamp, then `ideaId`. This keeps the frozen snapshot reproducible.

### 6.2 Rank is money-blind by construction

The scoring module reads only signal flags and account identity. It never reads `Challenge.sponsor`,
`Sponsor`, prize value, `IdeaBoost`, or `FlatFeeCharge`. Sponsorship surfaces and boosts are
separate tables, exactly as the FR-206a separation already keeps `IdeaBoost` out of
`MetricsService`. A boost or a sponsor record therefore cannot enter a score by accident.

### 6.3 Anti-gaming controls

- **One support per account per idea.** Already enforced by `IdeaSignal @@unique([ideaId, userId,
  type])`. Structured feedback: `SurveyResponse @@unique([ideaId, userId])`. No new uniqueness work.
- **Minimum account age.** Reuse `validation.minAccountAgeHours` (48). See section 8 for the
  floor-versus-exclude decision.
- **Rate limits.** `challenges.rateLimit.supportsPerHour` caps scoring-input writes per account
  across challenge-tagged ideas. Applied at the write path.
- **Anomaly flags (advisory, human-reviewed).** Burst voting (many accounts supporting one idea
  inside `challenges.anomaly.burstWindowMinutes`), shared-device clusters, shared-IP clusters, and
  new-account clusters each produce an `AnomalyFlag`. Automated disqualification is **off** at
  launch (`challenges.autoDisqualifyEnabled = false`); only a human admin can confirm or dismiss.
- **Fingerprints are privacy-limited.** `SignalFingerprint` stores salted, non-reversible hashes of
  IP, device and user agent, never raw values, and is purged by a daily job after
  `challenges.fingerprintRetentionDays` (default 90). This is new personal-data collection and must
  be covered by the privacy notice and NDPA handling (NFR-13). See section 8.
- **Immutable snapshot.** Shortlisting and results read only the `FINAL` snapshot, so a late burst
  of supports after close cannot change the shortlist.

### 6.4 Judge conflict of interest

- Every judge declares an `affiliation`. A conflict is declared per challenge.
- A pure helper `hasSponsorConflict(judge, challenge)` returns true when the judge's affiliation
  matches the challenge's sponsor. The match is normalised (case and whitespace) against
  `Sponsor.name` and `Sponsor.displayName`. This is a pure function and is unit-tested.
- Enforcement is structural: a judge with a conflict is set to `EXCLUDED`, is removed from the
  worklist, and `POST /challenges/:id/judging/scores` rejects them. The check runs in the
  `JudgeGuard` and again in the service, so a direct API call cannot bypass it.
- Declarations, reasons, and exclusions are stored (`ChallengeJudge.conflict`, `conflictReason`,
  `declaredAt`) for audit.

---

## 7. Proposed FR / NFR addendum

Written in the SRS v1.2 style. Assumption on numbering: SRS v1.2 defines FR-101 to 105,
FR-201 to 206a, FR-301 to 311, FR-401 to 406, FR-501 to 509, FR-601 to 608, FR-701 to 703,
FR-801 to 803, FR-901 to 904, and NFR-01 to 15. Code comments already cite FR-204a, FR-207 to 216,
FR-270 to 275, FR-1001 to 1012 and NFR-17 to 19, none of which appear in the SRS. The community loop
is a community feature, so it continues the 7xx community block. The ranges FR-704 to 729 and
NFR-20 to 25 are proposed as reserved and non-colliding. See section 8, conflict 1.

### 3.10 Community challenges (weekly, sponsored)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-704 | An admin shall be able to create a weekly sponsored challenge defining: sponsor, topic, title, description, start and end timestamps, a prize description, and an eligibility rule (category and/or region). | Must |
| FR-705 | A challenge shall follow the lifecycle DRAFT to SCHEDULED to OPEN to CLOSED to SHORTLISTED to PUBLISHED to ARCHIVED, with the OPEN, CLOSED and snapshot transitions driven by a scheduled job. | Must |
| FR-706 | Ideas shall be attached to a challenge as entries by automatic tagging (eligibility rule), creator opt-in, or admin action, with at most one entry per challenge and idea. | Should |
| FR-707 | Challenge standings shall be ranked by weighted support, never by raw counts. An idea's score shall be the sum over participating accounts of one point for support, one point for structured feedback, and one flat point for a pre-pledge, each counted at most once per account per idea, multiplied by the account's verification weight (email-only 0.25, verified social 0.7, KYC-verified or previously funded 1.0). | Must |
| FR-707a | A pre-pledge's stated amount shall be displayed but shall not contribute to the challenge score beyond the flat once-per-account point. | Must |
| FR-708 | Money shall never influence challenge scoring, ranking, shortlisting, or results. Sponsorship and paid boosts shall not alter any challenge score, rank, shortlist position, or judge outcome. | Must |
| FR-709 | Sponsored challenges and promoted entries shall be visibly labelled (for example "Sponsored challenge" and "Promoted"), and no label shall imply that sponsorship affects validation quality or approval odds. | Must |
| FR-710 | The system shall permit at most one support per account per idea, shall apply a minimum account age before a support contributes to challenge scoring, and shall rate-limit scoring-input writes per account. | Must |
| FR-711 | The system shall flag anomalous patterns (burst voting, shared device or network clusters, new-account clusters) for human review. Automated disqualification shall be disabled at launch; only a human reviewer may confirm or dismiss a flag. | Must |
| FR-712 | At challenge close the system shall capture an immutable, checksummed snapshot of the standings. Shortlisting and results shall be derived from that snapshot only, and subsequent signal changes shall not affect them. | Must |
| FR-713 | An admin shall review the frozen snapshot and any open anomaly flags before a shortlist is finalised. | Must |
| FR-714 | A sponsor shall receive visibility only. A sponsor shall never access private user data and shall never set or influence scoring, shortlisting, or results beyond the declared topic. | Must |

### 3.11 Ideathon and judging

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-715 | A monthly ideathon shall be creatable as a challenge with a judged shortlist and one or more prizes fulfilled off-platform. | Must |
| FR-716 | Judging shall be performed against a published rubric by assigned judges, each submitting a score per shortlisted idea. | Should |
| FR-717 | A judge shall declare any affiliation with a challenge's sponsor. A judge whose declared affiliation matches the sponsor shall be excluded from that challenge's scoring, and the system shall enforce the exclusion. | Must |
| FR-718 | Judge conflict declarations and enforced exclusions shall be stored for audit. | Must |
| FR-719 | Ideathon results shall be published publicly after judging; sponsors shall see only the published public results. | Must |
| FR-720 | Prizes shall be fulfilled off-platform by the sponsor. No prize shall route through campaign escrow, and no prize copy shall imply financial return. | Must |
| FR-721 | A shortlist shall be generated from the frozen snapshot (default top N by weighted score, admin-editable), subject to anomaly review and judge conflict exclusion. | Should |
| FR-722 | The platform shall not run automated prize payouts; prize settlement remains outside platform scope. | Must |
| FR-723 | Challenge, ideathon and prize copy shall use UK English and shall avoid chain jargon in default flows. | Should |

### 3.12 Supporter reputation badges

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-725 | The system shall award an early-supporter badge to an account that supported an idea before it converted to a funded campaign. | Should |
| FR-726 | An early-supporter badge shall be upgraded when the backed campaign delivers, recording the funding and delivery evidence. | Should |
| FR-727 | The badge data model and award logic shall ship before the reputation view. The public reputation view (FR-703) remains Phase 3 and is outside launch scope. | Should |
| FR-728 | Badges shall be behavioural and unpurchasable. No payment, boost, or sponsorship shall create, upgrade, or remove a badge. | Must |
| FR-729 | Badge award and upgrade shall be idempotent per account, idea and type, and shall be auditable. | Must |

### 4.6 Community loop

- NFR-20: Challenge scoring inputs and standings shall be recomputed from behavioural signals, never incremented in place, and shall be unaffected by boost or sponsorship code paths (extends FR-206a).
- NFR-21: Anti-gaming device and network signals shall be stored only as salted, non-reversible hashes and retained no longer than the configured retention period (default 90 days), consistent with NFR-13.
- NFR-22: Public challenge standings and results shall expose public and aggregate data only, never sponsor-private data, conflict declarations, anomaly detail, or device fingerprints.
- NFR-23: The final standings snapshot shall be immutable and checksummed so results are reproducible and tamper-evident.
- NFR-24: Standings shall be served from a cached projection refreshed by a scheduled job (default five minutes) so a read does not recompute the full score.
- NFR-25: Challenge, ideathon and prize copy shall avoid language implying investment, equity, profit, yield, or returns (extends NFR-14).

---

## 8. Open conflicts and recommended resolution

Each item needs the product owner's decision. Recommendation is engineering's view, not a silent
choice.

1. **Requirement numbering.** SRS v1.2 defines only FR-201 to 206a, FR-701 to 703, FR-901 to 904 and
   NFR-01 to 15, yet code already cites FR-204a, FR-207 to 216, FR-270 to 275, FR-1001 to 1012 and
   NFR-17 to 19. No document defines FR-207+. **Recommended:** adopt one requirements register,
   back-fill the code-only IDs, and reserve FR-704 to 729 and NFR-20 to 25 for the loop (section 7).
   Assumption stated: 7xx is the community block, so the loop continues it and nothing collides with
   the 2xx validation or 10xx moderation families.

2. **Config table versus `PlatformParam`.** **Recommended:** reuse `PlatformParam` under a
   `challenges.*` namespace. It already gives admin editing, audit (`PlatformParamAudit`), and a
   read-through service. A new table would duplicate all of that. Flagged for confirmation.

3. **Web data layer.** The repo has no shadcn/ui, no TanStack Query, no generated OpenAPI client, and
   no network calls (fixtures only). Building networked challenge pages is a material change.
   **Recommended:** ship Phase A and B on fixtures with one swap point per feature, and record the
   real client decision (generated client and/or server-side fetch) separately before integration.
   This is an open decision, not an assumed change.

4. **Visibility mapping.** Web `IdeaVisibility = "public" | "private"` versus API
   `DiscoverabilityTier { LINK_ONLY, DISCOVERABLE, FEATURED }`. **Recommended:** map
   private to LINK_ONLY and public to DISCOVERABLE, with FEATURED orthogonal (quality and boost).
   Confirm whether a LINK_ONLY idea may appear on a **public** challenge standings board; engineering
   recommends requiring DISCOVERABLE to be listed publicly, with private ideas enterable but shown
   only to their creator.

5. **Anti-gaming personal data.** IP and device signals do not exist today. Collecting them is new
   personal-data processing under NDPA and NFR-13. **Recommended:** store salted hashes only, retain
   at most `challenges.fingerprintRetentionDays` (default 90), purge daily, and disclose in the
   privacy notice. Confirm the retention period and the lawful basis with whoever owns privacy.

6. **Prizes and escrow.** FR-501+ is campaign escrow only. **Recommended:** prizes never touch
   escrow, are never paid by the platform, and are fulfilled off-platform by the sponsor; no copy
   implies a return. Confirm the prize wording and the off-platform fulfilment claim.

7. **Badge scope.** FR-703 (backer reputation view) is Phase 3 in the PRD roadmap. **Recommended:**
   design and ship the badge data and award logic now (Phase B), but do not ship the public
   reputation view at launch. Confirm.

8. **Auth discrepancy (verify before relying on it).** `AuthService.authenticate` returns
   `token: privyAccessToken` (the echoed provider token) and never calls `SessionService.sign`,
   while `PrivyAuthGuard` and `OptionalPrivyAuthGuard` verify an HS256 session JWT via
   `SessionService.verify`, and the e2e suites read `res.body.sessionToken`. As it stands the
   returned `token` and the expected `sessionToken` disagree, and `sign` is unused on the login
   path. **Recommended:** resolve before building any authenticated challenge flow, because judge and
   participant writes depend on it. Engineering will confirm which side is correct and fix the
   mismatch, but the product owner should know the authenticated session path is currently
   inconsistent.

9. **Public name for standings.** UI must not use "leaderboard". **Recommended:** "Community
   standings", with the shortlist alternative "Support standings". Confirm the public name.

10. **Branch strategy.** `inverge-api` is on `docs/campaign-api-gaps`; `inverge-web` is on
    `feature/ideas-ui` with uncommitted work (featured-carousel, feed-sections, filter-rail,
    topic-directory and edits to ideas pages). **Recommended:** commit `feature/ideas-ui` first (do
    not build on uncommitted work), then branch `feat/challenges-api` off the API default for the
    loop, and `feat/challenges-ui` off the committed `feature/ideas-ui`. Keep the plan doc as its own
    docs commit. Note the loop touches idea pages, so it must not diverge from uncommitted
    `feature/ideas-ui` work.

11. **`pastFunder` is unwired.** Declared in `PledgerIdentity` and used by `baseTierId`, but never
    populated anywhere, so the VERIFIED tier is KYC-only in practice. **Recommended:** decide
    whether challenge scoring should honour previously-funded accounts. If yes, wire a source; if
    no, document that VERIFIED is KYC-only so the 1.0 weight is understood.

12. **Minimum age: floor or exclude.** FR-213 floors low-age accounts to EMAIL weight for idea
    metrics. The brief's hard rule says a support does not count until the account is old enough.
    **Recommended:** for challenge scoring, exclude below-min-age accounts entirely, and state that
    this intentionally differs from the idea-metric floor. Confirm, because the two behaviours would
    otherwise look inconsistent.

13. **Judge model.** `UserRole` has only USER and ADMIN, yet SRS user classes include a Reviewer.
    **Recommended:** do not add a global role; model judges by a `ChallengeJudge` row plus a
    `JudgeGuard` (least privilege, per-challenge). Flag the pre-existing Reviewer role gap for the
    register.

14. **Standings cache.** The repo has no Redis cache client. **Recommended:** a materialised
    `ChallengeStanding` table refreshed by a job (occasionally stale, which is fine for a board).
    Alternative is adding a Redis cache client, which is new infrastructure. Confirm.

15. **Sponsor entity.** **Recommended:** a standalone `Sponsor` table, optionally linked later to
    `BusinessProfile` for KYB if sponsors ever onboard. Confirm whether sponsor KYB is in scope
    (engineering assumes not at launch).

16. **Judge console surface.** The web repo has no admin surface. **Recommended:** judge tooling is
    API-first in Phase B with a minimal `/d/judging` page; a full admin web surface is a separate
    slab. Confirm.

17. **Sponsor self-serve, automated payouts, public API.** All Phase C. **Recommended:** document
    only; build none. Confirm.

---

## 9. Copy guardrails (apply to every string in this feature)

- UK English, plain conversational tone, no em dashes.
- No crypto or chain jargon in default flows.
- No wording that implies investment, equity, profit, yield, or return (NFR-14, NFR-25).
- "Promoted" and "Sponsored challenge" are labels, never claims about quality or approval odds.
- Explain that sponsorship never affects ranking, and show the weighted score with a plain-language
  "Ranked by verified support" note.
- Prize copy states what the prize is and when it is announced, and that the sponsor fulfils it.
