import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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
  ) {}

  // FR-202/203: creator builds/replaces the whole question set. Editable while DRAFT only
  // — locking it at publish keeps responses referencing stable question ids.
  async setQuestions(userId: string, ideaId: string, dto: SetSurveyDto) {
    const idea = await this.ownedDraft(userId, ideaId);
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
  async getQuestions(ideaId: string) {
    await this.exists(ideaId);
    return this.prisma.surveyQuestion.findMany({ where: { ideaId }, orderBy: { index: 'asc' } });
  }

  // FR-202/203: one response per (idea, user); validated against the current questions.
  async submitResponse(userId: string, ideaId: string, dto: SubmitResponseDto) {
    await this.assertSignalable(ideaId);
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

    return this.prisma.$transaction(async (tx) => {
      await tx.surveyResponse.upsert({
        where: { ideaId_userId: { ideaId, userId } },
        update: { answers: normalized as object },
        create: { ideaId, userId, answers: normalized as object },
      });
      return this.metrics.recompute(tx, ideaId);
    });
  }

  async withdrawResponse(userId: string, ideaId: string) {
    await this.exists(ideaId);
    return this.prisma.$transaction(async (tx) => {
      await tx.surveyResponse.deleteMany({ where: { ideaId, userId } });
      return this.metrics.recompute(tx, ideaId);
    });
  }

  private async exists(ideaId: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId }, select: { id: true } });
    if (!idea) throw new NotFoundException('Idea not found');
  }

  private async assertSignalable(ideaId: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId }, select: { status: true } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.status !== 'VALIDATING' && idea.status !== 'THRESHOLD_MET') {
      throw new BadRequestException('Idea is not open for survey responses');
    }
  }

  private async ownedDraft(userId: string, ideaId: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('The survey can only be edited while the idea is a draft');
    }
    return idea;
  }
}
