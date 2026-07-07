-- DropIndex
DROP INDEX "Card_nameNorm_trgm_idx";

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "faces" JSONB;
