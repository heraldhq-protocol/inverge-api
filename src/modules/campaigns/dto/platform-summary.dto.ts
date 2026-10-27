import { ApiProperty } from '@nestjs/swagger';

/**
 * Public platform counters.
 *
 * Counts only: no money, no escrow figure, no per-user data. Clients render the
 * `asOf` instant so a cached snapshot is never mistaken for a live reading.
 */
export class PlatformSummaryDto {
  @ApiProperty({
    example: '2026-10-26T09:30:00.000Z',
    description: 'When the counters were read. The response may be served from a 60 s cache.',
  })
  asOf!: string;

  @ApiProperty({
    example: 128,
    description:
      'Ideas a visitor can find through GET /ideas: published (VALIDATING or THRESHOLD_MET) and discoverable (DISCOVERABLE or FEATURED).',
  })
  publishedIdeas!: number;

  @ApiProperty({
    example: 12,
    description: 'Campaigns with status ACTIVE.',
  })
  activeCampaigns!: number;

  @ApiProperty({
    example: 34,
    description: 'Campaigns with status COMPLETED.',
  })
  completedCampaigns!: number;

  @ApiProperty({
    example: 58,
    description:
      'Campaigns in any public state (ACTIVE, FUNDED, FAILED, COMPLETED). Drafts, review and rejected rows are excluded.',
  })
  totalCampaigns!: number;
}
