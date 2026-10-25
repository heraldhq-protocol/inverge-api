-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "taxonomyCategorySlug" TEXT,
ADD COLUMN     "taxonomySubcategorySlug" TEXT;

-- AlterTable
ALTER TABLE "Idea" ADD COLUMN     "taxonomyCategorySlug" TEXT,
ADD COLUMN     "taxonomySubcategorySlug" TEXT;

-- CreateTable
CREATE TABLE "TaxonomyCategory" (
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomyCategory_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "TaxonomySubcategory" (
    "categorySlug" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxonomySubcategory_pkey" PRIMARY KEY ("categorySlug","slug")
);

-- CreateIndex
CREATE INDEX "TaxonomySubcategory_categorySlug_sortOrder_idx" ON "TaxonomySubcategory"("categorySlug", "sortOrder");

-- CreateIndex
CREATE INDEX "Campaign_taxonomyCategorySlug_taxonomySubcategorySlug_creat_idx" ON "Campaign"("taxonomyCategorySlug", "taxonomySubcategorySlug", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Idea_taxonomyCategorySlug_taxonomySubcategorySlug_createdAt_idx" ON "Idea"("taxonomyCategorySlug", "taxonomySubcategorySlug", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "TaxonomySubcategory" ADD CONSTRAINT "TaxonomySubcategory_categorySlug_fkey" FOREIGN KEY ("categorySlug") REFERENCES "TaxonomyCategory"("slug") ON DELETE CASCADE ON UPDATE CASCADE;
