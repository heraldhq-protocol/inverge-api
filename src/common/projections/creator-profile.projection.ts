export type PublicCreatorLink = {
  label: string;
  url: string;
};

export type PublicCreator = {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  links: PublicCreatorLink[];
  tier: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
  completedCampaigns: number;
  identityVerified: boolean;
  memberSince: string;
};

export type UserWithProfileForProjection = {
  id: string;
  kycStatus?: string;
  createdAt: Date;
  creatorProfile?: {
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    links?: unknown;
    tier?: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
    completedCampaigns?: number;
    tenureStartedAt?: Date;
  } | null;
};

export function toPublicCreator(
  user: UserWithProfileForProjection | null | undefined,
): PublicCreator | null {
  if (!user) return null;

  const profile = user.creatorProfile;

  // Invariant: NEVER fall back to user.email for missing displayName.
  const displayName = profile?.displayName?.trim() || null;
  const avatarUrl = profile?.avatarUrl?.trim() || null;
  const bio = profile?.bio?.trim() || null;

  let links: PublicCreatorLink[] = [];
  if (Array.isArray(profile?.links)) {
    links = (profile.links as Record<string, unknown>[])
      .filter((l) => l && typeof l.url === 'string' && typeof l.label === 'string')
      .map((l) => ({ label: String(l.label), url: String(l.url) }));
  }

  const memberSince = (profile?.tenureStartedAt ?? user.createdAt).toISOString();

  return {
    id: user.id,
    displayName,
    avatarUrl,
    bio,
    links,
    tier: profile?.tier ?? 'STARTER',
    completedCampaigns: profile?.completedCampaigns ?? 0,
    identityVerified: user.kycStatus === 'VERIFIED',
    memberSince,
  };
}
