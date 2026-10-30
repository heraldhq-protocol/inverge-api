import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { ProductAnalyticsService } from '../analytics/product-analytics.service';
import { MetricsService } from '../metrics/metrics.service';
import { SetSurveyDto, SubmitResponseDto } from './dto/survey.dto';
import {
  Answer,
  QuestionInput,
  QuestionRef,
  validateAnswers,
  validateQuestionSet,
} from './survey-validation';

@Injectable()
export class SurveyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly analytics?: ProductAnalyticsService,
  ) {}

  private async resolveIdea(idOrSlug: string) {
    const idea = await this.prisma.idea.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true, status: true, creatorId: true },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    return idea;
  }

  // FR-202/203: creator builds/replaces the whole question set. Editable while DRAFT only
  // — locking it at publish keeps responses referencing stable question ids.
  async setQuestions(userId: string, ideaIdOrSlug: string, dto: SetSurveyDto) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('The survey can only be edited while the idea is a draft');
    }
    const problems = validateQuestionSet(dto.questions as QuestionInput[]);
    if (problems.length) throw new BadRequestException(problems);

    return this.prisma.$transaction(async (tx) => {
      await tx.surveyQuestion.deleteMany({ where: { ideaId: idea.id } });
      await tx.surveyQuestion.createMany({
        data: dto.questions.map((q) => ({
          ideaId: idea.id,
          index: q.index,
          prompt: q.prompt,
          type: q.type,
          options: (q.options ?? undefined) as object | undefined,
          required: q.required ?? true,
        })),
      });
      return tx.surveyQuestion.findMany({ where: { ideaId: idea.id }, orderBy: { index: 'asc' } });
    });
  }

  // Public: the form backers fill in.
  async getQuestions(ideaIdOrSlug: string) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    return this.prisma.surveyQuestion.findMany({ where: { ideaId: idea.id }, orderBy: { index: 'asc' } });
  }

  /**
   * The owning creator's response list for one idea.
   *
   * Responses are anonymous by design: this projection never includes the
   * respondent id, email, or profile. Questions are the current form's, so the
   * web can resolve labels; an answer whose question was removed is dropped by
   * the client rather than shown as a raw id.
   */
  async listResponses(userId: string, ideaIdOrSlug: string, limit = 100) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');

    const take = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const [questions, responses] = await Promise.all([
      this.prisma.surveyQuestion.findMany({
        where: { ideaId: idea.id },
        orderBy: { index: 'asc' },
      }),
      this.prisma.surveyResponse.findMany({
        where: { ideaId: idea.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: { id: true, answers: true, createdAt: true },
      }),
    ]);

    return {
      questions,
      data: responses.map((response) => ({
        answers: response.answers,
        createdAt: response.createdAt.toISOString(),
        id: response.id,
      })),
      truncated: responses.length === take,
    };
  }

  /**
   * Anonymous feedback responses across every idea the caller owns.
   *
   * The inbox is a creator surface, so ownership is the only filter. The query
   * never selects the respondent relation; a response is represented by its
   * answers and timestamp alone.
   */
  async listMyFeedback(userId: string, limit = 100) {
    const take = Math.min(Math.max(Math.trunc(limit) || 100, 1), 200);
    const ideas = await this.prisma.idea.findMany({
      where: { creatorId: userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        surveyQuestions: { orderBy: { index: 'asc' } },
      },
    });
    const ideaIds = ideas.map((idea) => idea.id);

    if (ideaIds.length === 0) {
      return { data: [], totalResponses: 0, truncated: false };
    }

    const [responses, totalResponses] = await Promise.all([
      this.prisma.surveyResponse.findMany({
        where: { ideaId: { in: ideaIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: { id: true, ideaId: true, answers: true, createdAt: true },
      }),
      this.prisma.surveyResponse.count({ where: { ideaId: { in: ideaIds } } }),
    ]);

    const byIdea = new Map<string, typeof responses>();
    for (const response of responses) {
      const group = byIdea.get(response.ideaId) ?? [];
      group.push(response);
      byIdea.set(response.ideaId, group);
    }

    return {
      data: ideas.flatMap((idea) => {
        const group = byIdea.get(idea.id);
        if (!group || group.length === 0) return [];

        return [
          {
            ideaId: idea.id,
            ideaSlug: idea.slug,
            ideaStatus: idea.status,
            ideaTitle: idea.title,
            questions: idea.surveyQuestions,
            responses: group.map((response) => ({
              answers: response.answers,
              createdAt: response.createdAt.toISOString(),
              id: response.id,
            })),
          },
        ];
      }),
      totalResponses,
      truncated: responses.length === take && totalResponses > take,
    };
  }

  // FR-202/203: one response per (idea, user); validated against the current questions.
  async submitResponse(userId: string, ideaIdOrSlug: string, dto: SubmitResponseDto) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    if (idea.status !== 'VALIDATING' && idea.status !== 'THRESHOLD_MET') {
      throw new BadRequestException('Idea is not open for survey responses');
    }
    const ideaId = idea.id;
    const questions = await this.prisma.surveyQuestion.findMany({
      where: { ideaId },
      select: { id: true, type: true, options: true, required: true },
    });
    if (questions.length === 0) throw new BadRequestException('This idea has no survey to answer');

    const refs: QuestionRef[] = questions.map((q) => ({
      id: q.id,
      type: q.type as QuestionRef['type'],
      options: (q.options as string[] | null) ?? null,
      required: q.required,
    }));
    const { normalized, problems } = validateAnswers(refs, dto.answers as Answer[]);
    if (problems.length) throw new BadRequestException(problems);

    const { result, responseId } = await this.prisma.$transaction(async (tx) => {
      const response = await tx.surveyResponse.upsert({
        where: { ideaId_userId: { ideaId, userId } },
        update: { answers: normalized as object },
        create: { ideaId, userId, answers: normalized as object },
      });
      return {
        result: await this.metrics.recompute(tx, ideaId),
        responseId: response.id,
      };
    });
    this.invalidateIdea();
    // One confirmed feedback event per response row; editing the same response
    // updates the domain row without inflating the analytics count.
    await this.analytics?.record({
      eventKey: `FEEDBACK_SUBMITTED:${responseId}`,
      name: 'FEEDBACK_SUBMITTED',
      userId,
      ideaId,
      occurredAt: new Date(),
    });
    return result;
  }

  async withdrawResponse(userId: string, ideaIdOrSlug: string) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    const ideaId = idea.id;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.surveyResponse.deleteMany({ where: { ideaId, userId } });
      return this.metrics.recompute(tx, ideaId);
    });
    this.invalidateIdea();
    return result;
  }

  /** Feedback count/score appear on the idea detail and list projections. */
  private invalidateIdea(): void {
    this.cache?.bumpEventually('idea');
    this.cache?.bumpEventually('ideas');
  }
}
