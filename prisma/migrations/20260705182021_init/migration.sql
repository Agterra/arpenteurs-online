-- CreateEnum
CREATE TYPE "CommanderLegality" AS ENUM ('LEGAL', 'BANNED', 'RESTRICTED', 'NOT_LEGAL');

-- CreateEnum
CREATE TYPE "DeckSection" AS ENUM ('COMMANDER', 'MAIN');

-- CreateEnum
CREATE TYPE "LobbyStatus" AS ENUM ('OPEN', 'STARTING', 'IN_GAME', 'FINISHED');

-- CreateEnum
CREATE TYPE "LobbyVisibility" AS ENUM ('PUBLIC', 'UNLISTED');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('ACTIVE', 'FINISHED', 'ABANDONED');

-- CreateTable
CREATE TABLE "Card" (
    "id" TEXT NOT NULL,
    "scryfallOracleId" UUID NOT NULL,
    "scryfallId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameNorm" TEXT NOT NULL,
    "asciiName" TEXT,
    "faceNames" TEXT[],
    "layout" TEXT NOT NULL,
    "manaCost" TEXT,
    "manaValue" DOUBLE PRECISION NOT NULL,
    "typeLine" TEXT NOT NULL,
    "oracleText" TEXT,
    "power" TEXT,
    "toughness" TEXT,
    "loyalty" TEXT,
    "defense" TEXT,
    "colors" TEXT[],
    "colorIdentity" TEXT[],
    "keywords" TEXT[],
    "supertypes" TEXT[],
    "commanderLegality" "CommanderLegality" NOT NULL,
    "canBeCommander" BOOLEAN NOT NULL DEFAULT false,
    "hasAltDeckLimit" BOOLEAN NOT NULL DEFAULT false,
    "isFunny" BOOLEAN NOT NULL DEFAULT false,
    "edhrecRank" INTEGER,
    "imageSmall" TEXT,
    "imageNormal" TEXT,
    "backImageSmall" TEXT,
    "backImageNormal" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardAlias" (
    "alias" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,

    CONSTRAINT "CardAlias_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deck" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rawText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeckCard" (
    "id" TEXT NOT NULL,
    "deckId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "section" "DeckSection" NOT NULL DEFAULT 'MAIN',
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DeckCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lobby" (
    "id" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "visibility" "LobbyVisibility" NOT NULL DEFAULT 'UNLISTED',
    "hostId" TEXT NOT NULL,
    "status" "LobbyStatus" NOT NULL DEFAULT 'OPEN',
    "maxSeats" INTEGER NOT NULL DEFAULT 4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lobby_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LobbySeat" (
    "id" TEXT NOT NULL,
    "lobbyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "deckId" TEXT,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LobbySeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "lobbyId" TEXT NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'ACTIVE',
    "snapshot" JSONB NOT NULL,
    "snapshotSeq" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "winnerSeat" INTEGER,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamePlayer" (
    "gameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "deckId" TEXT,

    CONSTRAINT "GamePlayer_pkey" PRIMARY KEY ("gameId","userId")
);

-- CreateTable
CREATE TABLE "GameEvent" (
    "id" BIGSERIAL NOT NULL,
    "gameId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "actorSeat" INTEGER,
    "type" TEXT NOT NULL,
    "publicLine" TEXT,
    "privateLines" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Card_scryfallOracleId_key" ON "Card"("scryfallOracleId");

-- CreateIndex
CREATE UNIQUE INDEX "Card_nameNorm_key" ON "Card"("nameNorm");

-- CreateIndex
CREATE INDEX "CardAlias_cardId_idx" ON "CardAlias"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tokenHash_key" ON "User"("tokenHash");

-- CreateIndex
CREATE INDEX "Deck_ownerId_idx" ON "Deck"("ownerId");

-- CreateIndex
CREATE INDEX "DeckCard_cardId_idx" ON "DeckCard"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "DeckCard_deckId_cardId_section_key" ON "DeckCard"("deckId", "cardId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "Lobby_inviteCode_key" ON "Lobby"("inviteCode");

-- CreateIndex
CREATE INDEX "Lobby_visibility_status_createdAt_idx" ON "Lobby"("visibility", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LobbySeat_lobbyId_userId_key" ON "LobbySeat"("lobbyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LobbySeat_lobbyId_seatIndex_key" ON "LobbySeat"("lobbyId", "seatIndex");

-- CreateIndex
CREATE INDEX "Game_lobbyId_idx" ON "Game"("lobbyId");

-- CreateIndex
CREATE INDEX "Game_status_updatedAt_idx" ON "Game"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GamePlayer_gameId_seatIndex_key" ON "GamePlayer"("gameId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "GameEvent_gameId_seq_key" ON "GameEvent"("gameId", "seq");

-- AddForeignKey
ALTER TABLE "CardAlias" ADD CONSTRAINT "CardAlias_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deck" ADD CONSTRAINT "Deck_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeckCard" ADD CONSTRAINT "DeckCard_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "Deck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeckCard" ADD CONSTRAINT "DeckCard_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LobbySeat" ADD CONSTRAINT "LobbySeat_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "Lobby"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LobbySeat" ADD CONSTRAINT "LobbySeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "Lobby"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamePlayer" ADD CONSTRAINT "GamePlayer_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamePlayer" ADD CONSTRAINT "GamePlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- pg_trgm: fuzzy card-name search (autocomplete + did-you-mean suggestions)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Card_nameNorm_trgm_idx" ON "Card" USING gin ("nameNorm" gin_trgm_ops);
