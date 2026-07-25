-- CreateEnum
CREATE TYPE "SurveyQuestionType" AS ENUM ('RATING', 'TEXT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'BOOLEAN');

-- DropForeignKey
ALTER TABLE "IdeaFeedback" DROP CONSTRAINT "IdeaFeedback_ideaId_fkey";

-- DropForeignKey
ALTER TABLE "IdeaFeedback" DROP CONSTRAINT "IdeaFeedback_userId_fkey";

-- DropTable
DROP TABLE "IdeaFeedback";

-- CreateTable
CREATE TABLE "SurveyQuestion" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "type" "SurveyQuestionType" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SurveyQuestion_ideaId_idx" ON "SurveyQuestion"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyQuestion_ideaId_index_key" ON "SurveyQuestion"("ideaId", "index");

-- CreateIndex
CREATE INDEX "SurveyResponse_ideaId_idx" ON "SurveyResponse"("ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyResponse_ideaId_userId_key" ON "SurveyResponse"("ideaId", "userId");

-- AddForeignKey
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

