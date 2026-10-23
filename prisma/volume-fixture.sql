-- Synthetic volume fixture for index and query-plan work.
--
-- DISPOSABLE DATABASES ONLY. This inserts fixed ids (`user-0`, `idea-0`, ...)
-- and will fail on a second run. It is not part of `prisma db seed` and is
-- never run by the application.
--
-- Usage:
--   prisma migrate deploy
--   psql "$DATABASE_URL" -f prisma/volume-fixture.sql
--
-- Size: 10k users, 50k ideas, 10k campaigns, 30k milestones/claims,
-- 100k idea signals, 200k contributions and 200k on-chain events.
-- The exact plans and timings are recorded in docs/api/query-performance.md.

INSERT INTO "User" (id, "providerUserId", "updatedAt")
SELECT 'user-' || g, 'stub-user-' || g, now()
FROM generate_series(0, 9999) g;

INSERT INTO "Idea" (id, "creatorId", title, slug, problem, solution, roadmap, "askAmount", status, "discoverabilityTier", category, "createdAt", "updatedAt")
SELECT 'idea-' || g,
       'user-' || (g % 10000),
       'Idea ' || g,
       'idea-' || g,
       'Problem ' || g,
       'Solution ' || g,
       'Roadmap ' || g,
       1000 + (g % 5000),
       (ARRAY['VALIDATING','THRESHOLD_MET','DRAFT'])[1 + (g % 3)]::"IdeaStatus",
       (ARRAY['DISCOVERABLE','FEATURED','LINK_ONLY'])[1 + (g % 3)]::"DiscoverabilityTier",
       (ARRAY['software','agriculture','film','arts'])[1 + (g % 4)],
       now() - ((g % 525600) || ' minutes')::interval,
       now()
FROM generate_series(0, 49999) g;

INSERT INTO "Campaign" (id, "ideaId", "creatorId", type, status, "tokenType", "targetAmount", deadline, "totalRaised", "createdAt", "updatedAt")
SELECT 'campaign-' || g,
       'idea-' || g,
       'user-' || (g % 10000),
       'ALL_OR_NOTHING',
       (ARRAY['ACTIVE','FUNDED','FAILED','COMPLETED'])[1 + (g % 4)]::"CampaignStatus",
       'USDC',
       5000 + (g % 50000),
       now() + ((g % 365) || ' days')::interval,
       (g % 100000),
       now() - ((g % 525600) || ' minutes')::interval,
       now()
FROM generate_series(0, 9999) g;

INSERT INTO "Milestone" (id, "campaignId", index, title, deliverable, "tranchePct", "evidenceDefinition")
SELECT 'milestone-' || (c * 3 + i),
       'campaign-' || c,
       i,
       'Milestone ' || i,
       'Deliverable ' || i,
       33.33,
       '{}'::jsonb
FROM generate_series(0, 9999) c, generate_series(0, 2) i;

INSERT INTO "MilestoneClaim" (id, "milestoneId", "proofBundle", "submittedAt", "objectionWindowEndsAt", status)
SELECT 'claim-' || m,
       'milestone-' || m,
       '{}'::jsonb,
       now() - ((m % 525600) || ' minutes')::interval,
       now() + interval '7 days',
       (ARRAY['UNDER_REVIEW','APPROVED','FAILED','DISPUTED'])[1 + (m % 4)]::"ClaimStatus"
FROM generate_series(0, 29999) m;

INSERT INTO "IdeaSignal" (id, "ideaId", "userId", type, "createdAt")
SELECT 'signal-' || g,
       'idea-' || (g % 50000),
       'user-' || ((g / 50000) * 5000 + (g % 5000)),
       'SUPPORT',
       now() - ((g % 100000) || ' minutes')::interval
FROM generate_series(0, 99999) g;

INSERT INTO "Contribution" (id, "campaignId", "userId", amount, "tokenType", "txSignature", "createdAt")
SELECT 'contribution-' || g,
       'campaign-' || (g % 10000),
       'user-' || (g % 10000),
       10 + (g % 1000),
       'USDC',
       'tx-contrib-' || g,
       now() - ((g % 525600) || ' minutes')::interval
FROM generate_series(0, 199999) g;

INSERT INTO "OnChainEvent" (id, "campaignId", "eventType", amount, "txSignature", "blockTime")
SELECT 'event-' || g,
       'campaign-' || (g % 10000),
       (ARRAY['FUNDED','TRANCHE_RELEASED','REFUND_CLAIMED','MILESTONE_FAILED'])[1 + (g % 4)]::"OnChainEventType",
       10 + (g % 1000),
       'tx-event-' || g,
       now() - ((g % 525600) || ' minutes')::interval
FROM generate_series(0, 199999) g;

ANALYZE;
