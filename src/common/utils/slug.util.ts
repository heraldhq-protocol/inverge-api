import { randomBytes } from 'crypto';

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const suffix = randomBytes(3).toString('hex');
  return `${base || 'idea'}-${suffix}`;
}
