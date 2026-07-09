-- CreateTable
CREATE TABLE "TokenImage" (
    "nameNorm" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "typeLine" TEXT,
    "imageSmall" TEXT,
    "imageNormal" TEXT,

    CONSTRAINT "TokenImage_pkey" PRIMARY KEY ("nameNorm")
);
