export type PublicCreatorLink = {
  label: string;
  url: string;
};

export type PublicCreator = {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  links: PublicCreatorLink[];
  tier: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
  completedCampaigns: number;
  ideasPublished: number;
  identityVerified: boolean;
  memberSince: string;
};

export type UserWithProfileForProjection = {
  id: string;
  kycStatus?: string;
  createdAt: Date;
  creatorProfile?: {
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    links?: unknown;
    tier?: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
    completedCampaigns?: number;
    tenureStartedAt?: Date;
  } | null;
  ideasPublished?: number;
  _count?: {
    ideas?: number;
  };
};

export function toPublicCreator(
  user: UserWithProfileForProjection | null | undefined,
): PublicCreator | null {
  if (!user) return null;

  const profile = user.creatorProfile;

  // Never derive a public name from the account email: this projection is served on
  // public creator surfaces. An unset display name stays null until the creator sets one.
  const displayName = profile?.displayName?.trim() || null;
  // Prefer the explicitly stored username; derive from displayName as fallback.
  const storedUsername = profile?.username?.trim().toLowerCase() || null;
  const derivedUsername = displayName
    ? displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    : null;
  const username = storedUsername || derivedUsername || user.id;
  const avatarUrl = profile?.avatarUrl?.trim() || null;
  const bio = profile?.bio?.trim() || null;

  let links: PublicCreatorLink[] = [];
  if (Array.isArray(profile?.links)) {
    links = (profile.links as Record<string, unknown>[])
      .filter((l) => l && typeof l.url === 'string' && typeof l.label === 'string')
      .map((l) => ({ label: String(l.label), url: String(l.url) }));
  }

  const memberSince = (profile?.tenureStartedAt ?? user.createdAt).toISOString();
  const ideasPublished = user.ideasPublished ?? user._count?.ideas ?? 0;

  return {
    id: user.id,
    username,
    displayName,
    avatarUrl,
    bio,
    links,
    tier: profile?.tier ?? 'STARTER',
    completedCampaigns: profile?.completedCampaigns ?? 0,
    ideasPublished,
    identityVerified: user.kycStatus === 'VERIFIED',
    memberSince,
  };
}
