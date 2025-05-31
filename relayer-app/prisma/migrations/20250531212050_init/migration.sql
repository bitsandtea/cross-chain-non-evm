-- CreateTable
CREATE TABLE "Swap" (
    "id" TEXT NOT NULL,
    "swapId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "initiatorChain" TEXT NOT NULL,
    "initiatorAddress" TEXT NOT NULL,
    "initiatorToken" TEXT NOT NULL,
    "initiatorAmount" TEXT NOT NULL,
    "initiatorReceivingAddressOnOtherChain" TEXT NOT NULL,
    "counterpartyChain" TEXT NOT NULL,
    "counterpartyAddress" TEXT NOT NULL,
    "counterpartyToken" TEXT NOT NULL,
    "counterpartyAmount" TEXT NOT NULL,
    "counterpartyReceivingAddressOnOtherChain" TEXT NOT NULL,
    "hashlock" TEXT NOT NULL,
    "secret" TEXT,
    "evmContractAddress" TEXT,
    "flowHtlcId" TEXT,
    "timelocksJson" JSONB,
    "transactionHashes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Swap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Swap_swapId_key" ON "Swap"("swapId");
