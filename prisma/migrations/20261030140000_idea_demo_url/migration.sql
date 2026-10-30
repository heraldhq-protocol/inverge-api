-- Idea demo video: a YouTube or Vimeo link played in the idea hero
-- (docs/media/phase-1-audit.md 6). Additive and nullable: no existing row is
-- touched, and an idea without a demo keeps the cover as its hero media.

-- AlterTable
ALTER TABLE "Idea" ADD COLUMN "demoUrl" TEXT;
