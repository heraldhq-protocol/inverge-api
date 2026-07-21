import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

// Launch-parameter defaults (docs/phase0-refined-plan.md §5). Admin-tunable at runtime
// via PATCH /admin/params — reseeding never clobbers values an admin has changed.
const DEFAULT_PARAMS: Record<string, number> = {
  // Boost pricing (FR-206, FR-904)
  'boost.basic.priceNGN': 5000,
  'boost.featured.priceNGN': 20000,
  'boost.basic.durationDays': 7,
  'boost.featured.durationDays': 30,
  // FR-204 validation gate thresholds
  'validation.minSupporters': 30,
  'validation.minPrePledgeAbsUSD': 500,
  'validation.minPrePledgePctOfAsk': 0.1,
  'validation.minFeedbackCount': 10,
  'validation.minAvgFeedbackRating': 3.0,
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
        create: { key, value: value as unknown as object },
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
