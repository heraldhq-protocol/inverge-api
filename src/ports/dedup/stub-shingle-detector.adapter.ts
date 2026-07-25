import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DuplicateCandidate, DuplicateDetectorPort, DuplicateMatch } from './dedup.port';
import { similarity } from './shingle';

// Deterministic near-duplicate detector: shingle-Jaccard similarity of the candidate
// against the existing idea corpus. Offline, no external deps. Returns matches above a
// low floor (the moderation harness applies the hold threshold).
@Injectable()
export class StubShingleDetector implements DuplicateDetectorPort {
  private static readonly FLOOR = 0.3;

  constructor(private readonly prisma: PrismaService) {}

  async findSimilar(candidate: DuplicateCandidate): Promise<DuplicateMatch[]> {
    const corpus = await this.prisma.idea.findMany({
      where: {
        status: { in: ['VALIDATING', 'THRESHOLD_MET', 'CONVERTED'] },
        ...(candidate.excludeIdeaId ? { id: { not: candidate.excludeIdeaId } } : {}),
      },
      select: { id: true, title: true, problem: true, solution: true, targetUser: true },
      take: 500,
    });

    return corpus
      .map((i) => ({
        ideaId: i.id,
        title: i.title,
        similarity: similarity(
          candidate.text,
          [i.title, i.problem, i.solution, i.targetUser].filter(Boolean).join(' '),
        ),
      }))
      .filter((m) => m.similarity >= StubShingleDetector.FLOOR)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
  }
}
