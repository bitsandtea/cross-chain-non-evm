/*
  Warnings:

  - The `state` column on the `Swap` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `direction` to the `Swap` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SwapDirection" AS ENUM ('EVM_TO_FLOW', 'FLOW_TO_EVM');

-- CreateEnum
CREATE TYPE "SwapState" AS ENUM ('PENDING_INITIATION', 'AWAITING_INITIATOR_LOCK', 'INITIATOR_LOCKED', 'AWAITING_COUNTERPARTY_LOCK', 'COUNTERPARTY_LOCKED', 'AWAITING_INITIATOR_WITHDRAWAL', 'INITIATOR_WITHDREW_AND_REVEALED_SECRET', 'AWAITING_COUNTERPARTY_WITHDRAWAL', 'COMPLETED', 'REFUND_INITIATED_BY_INITIATOR', 'REFUND_INITIATED_BY_COUNTERPARTY', 'REFUNDED_INITIATOR', 'REFUNDED_COUNTERPARTY', 'FAILED');

-- AlterTable
ALTER TABLE "Swap" ADD COLUMN     "direction" "SwapDirection" NOT NULL,
DROP COLUMN "state",
ADD COLUMN     "state" "SwapState" NOT NULL DEFAULT 'PENDING_INITIATION';
