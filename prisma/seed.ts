import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// Launch-parameter defaults (docs/phase0-refined-plan.md §5, docs/srs-pre-pledge-weighting.md §12).
// Admin-tunable at runtime via PATCH /admin/params — reseeding never clobbers values an
// admin has changed (upsert update:{}).
const DEFAULT_PARAMS: Record<string, unknown> = {
  // Boost pricing in USD (FR-206, FR-904)
  'boost.basic.priceUSD': 5,
  'boost.featured.priceUSD': 20,
  'boost.basic.durationDays': 7,
  'boost.featured.durationDays': 30,

  // FR-204/204a validation gate
  'validation.minSupporters': 50,
  'validation.minWeightedUSD': 2000, // FR-207 weighted "estimated interest" floor
  'validation.minPrePledgePctOfAsk': 0.1, // pct-of-ask backstop
  'validation.minFeedbackCount': 10,
  'validation.minAvgFeedbackRating': 3.0,
  'validation.windowDays': 90, // renewable once
  'validation.sustainmentDays': 14, // threshold must hold this many consecutive days
  'validation.minAccountAgeHours': 48, // FR-213: below this, pledge counts at floor weight

  // FR-207/208: verification tier table (weight + per-account USD cap). EMAIL cap kept
  // deliberately small so email-only accounts cannot manipulate the figure.
  'validation.pledgeTiers': [
    { id: 'EMAIL', weight: 0.25, capUSD: 100 },
    { id: 'SOCIAL', weight: 0.7, capUSD: 500 },
    { id: 'VERIFIED', weight: 1.0, capUSD: 1000 },
  ],

  // FR-210: NGN→USD normalization rate (admin/job-refreshed)
  'fx.ngnPerUsd': 1600,

  // FR-271/272/275: idea quality floor (0..1) + per-creator active-idea cap
  'idea.qualityFloor': 0.7,
  'idea.maxActivePerCreator': 3,

  // KYC (FR-104)
  'kyc.backerThresholdUSD': 200,

  // Stored now, consumed Phase 1/2
  'campaign.applicationFeeNGN': 10000,
  'objection.windowDays': 7,
  'objection.thresholdPct': 30,
  'objection.perWalletCapPct': 15,
};

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    for (const [key, value] of Object.entries(DEFAULT_PARAMS)) {
      await prisma.platformParam.upsert({
        where: { key },
        update: {}, // preserve admin-tuned values on reseed
        create: { key, value: value as object },
      });
    }
    console.log(`Seeded ${Object.keys(DEFAULT_PARAMS).length} platform params.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
