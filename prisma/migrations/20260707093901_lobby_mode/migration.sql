-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('MANUAL', 'ENFORCED');

-- AlterTable
ALTER TABLE "Lobby" ADD COLUMN     "mode" "GameMode" NOT NULL DEFAULT 'MANUAL';
