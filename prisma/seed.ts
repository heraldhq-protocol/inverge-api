import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { TAXONOMY } from '../src/modules/taxonomy/taxonomy.data';

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

  // FR-1004/1012: moderation harness. Any category at/above riskThreshold holds for
  // review. Auto-rejection is disabled at launch (D1) — kept as a flag for post-launch.
  'moderation.riskThreshold': 0.5,
  'moderation.autoRejectEnabled': 0,
  'moderation.dedupThreshold': 0.8, // near-duplicate similarity that triggers a POL-FRD hold

  // KYC (FR-104)
  'kyc.backerThresholdUSD': 200,

  // ─────────────── Discovery feed & ranking (all illustrative — calibrate on data) ───────────────
  // Retrieval (Stage 1)
  'feed.candidatePoolSize': 300, // hard cap on items scored per request
  // Organic score weights (Stage 2). Behavioural terms are z-scored; quality/trust are 0..1.
  'feed.weights': {
    prePledge: 0.3, // z(weighted pre-pledge intent) — strongest behavioural signal
    velocity: 0.2, // z(smoothed supporter velocity)
    feedback: 0.15, // z(Bayesian-smoothed feedback rating)
    quality: 0.15, // qualityScore (0..1), used directly
    trust: 0.2, // TrustScore (0..1) — thin at launch (KYC + co-sign), ramps with maturity
  },
  'feed.dupPenaltyWeight': 0.3, // coefficient on the [0..1] near-duplicate penalty (subtracted)
  // Bayesian smoothing (kills small-sample noise; higher C = more conservative)
  'feed.velocity.windowDays': 7, // trailing window for supporter-accrual rate
  'feed.velocity.bayesC': 5, // pseudo-count shrinking velocity toward the pool mean rate
  'feed.feedback.bayesC': 5, // pseudo-count shrinking rating toward the prior mean
  'feed.feedback.priorMean': 3.0, // prior rating (1..5) a no-response idea shrinks toward
  // Time decay: Final = Personalised / (age_hours + 2)^gravity. Moderate — exploration, not
  // aggressive decay, handles new-item exposure.
  'feed.gravity': 1.2,
  // Personalization (Stage 2 tilt — bounded so a strong item still crosses audiences)
  'feed.personalization': {
    min: 0.8,
    max: 1.5,
    categoryBonus: 0.25, // multiplier lift when the idea's category matches interest
    regionBonus: 0.2, // lift when region/origin matches
    similarityBonus: 0.25, // lift scaled by content similarity to the user's engaged ideas
    engagedCorpusMax: 10, // cap on engaged ideas compared for content similarity
  },
  // Trust score composition (0..1; sums to 1 at full trust). Delivery track record (Phase 2+)
  // will extend this — under-fed by design at launch.
  'feed.trustWeights': { kyc: 0.5, kyb: 0.3, cosign: 0.2 },
  // Exploration lane (Stage 3) — the principled rich-get-richer fix. Reserve a share of
  // slots for under-exposed items chosen by an upper-confidence-bound bonus. Cannot be bought.
  'feed.exploration.slotShare': 0.25, // fraction of the page reserved for under-exposed items
  'feed.exploration.beta': 1.0, // UCB exploration coefficient
  'feed.exploration.minQuality': 0.4, // quality floor an exploration pick must clear
  // Policy diversity (Stage 3)
  'feed.perCreatorCap': 2, // max items from one creator on a page (anti-flood)
  'feed.categoryMaxShare': 0.5, // max share of the page a single category may occupy
  // Paid placement (Stage 3 — walled off from Stage 2 scoring; FR-206a/NFR-15)
  'feed.paid.everyN': 4, // inject one clearly-labelled promoted slot per N organic items
  'feed.paid.maxSlots': 3, // frequency cap on promoted slots per page

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

    // D-038: the taxonomy is reference data, seeded from the same canonical list
    // the API validates writes against. Upsert by stable slug so a label edit is
    // applied without moving a published URL, and remove rows the list no longer
    // contains. Idea/Campaign assignments carry no FK, so a removed term never
    // blocks the seed.
    const categorySlugs = TAXONOMY.map((category) => category.slug);
    const subcategoryKeys = TAXONOMY.flatMap((category) =>
      category.subcategories.map((subcategory) => ({
        categorySlug: category.slug,
        slug: subcategory.slug,
      })),
    );

    await prisma.$transaction(async (tx) => {
      for (const [categoryIndex, category] of TAXONOMY.entries()) {
        await tx.taxonomyCategory.upsert({
          where: { slug: category.slug },
          update: { label: category.label, sortOrder: categoryIndex },
          create: {
            slug: category.slug,
            label: category.label,
            sortOrder: categoryIndex,
          },
        });

        for (const [subcategoryIndex, subcategory] of category.subcategories.entries()) {
          await tx.taxonomySubcategory.upsert({
            where: {
              categorySlug_slug: {
                categorySlug: category.slug,
                slug: subcategory.slug,
              },
            },
            update: { label: subcategory.label, sortOrder: subcategoryIndex },
            create: {
              categorySlug: category.slug,
              slug: subcategory.slug,
              label: subcategory.label,
              sortOrder: subcategoryIndex,
            },
          });
        }
      }

      if (subcategoryKeys.length > 0) {
        await tx.taxonomySubcategory.deleteMany({
          where: { NOT: { OR: subcategoryKeys } },
        });
      }
      await tx.taxonomyCategory.deleteMany({
        where: { slug: { notIn: categorySlugs } },
      });
    });

    console.log(
      `Seeded ${TAXONOMY.length} taxonomy categories and ${subcategoryKeys.length} subcategories.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
