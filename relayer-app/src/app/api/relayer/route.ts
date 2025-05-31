import { prisma } from "@/lib/prisma"; // Assuming @ is alias for src
import { JsonValue } from "@prisma/client/runtime/library"; // Import for JsonValue
import { NextResponse } from "next/server";

interface SwapData {
  swapId: string;
  initiatorChain: string;
  initiatorAddress: string;
  initiatorToken: string;
  initiatorAmount: number | string;
  initiatorReceivingAddressOnOtherChain: string;
  counterpartyChain: string;
  counterpartyAddress: string;
  counterpartyToken: string;
  counterpartyAmount: number | string;
  counterpartyReceivingAddressOnOtherChain: string;
  hashlock: string;
  // Add other optional fields from your Prisma schema that might be part of initial data
  evmContractAddress?: string;
  flowHtlcId?: string;
  timelocksJson?: JsonValue;
  transactionHashes?: string[];
}

// Placeholder for actual relayer logic
async function processSwapRelay(data: SwapData) {
  console.log("Processing swap relay with data:", data);

  try {
    const newSwap = await prisma.swap.create({
      data: {
        swapId: data.swapId,
        state: "AWAITING_INITIATOR_LOCK", // Initial state
        initiatorChain: data.initiatorChain,
        initiatorAddress: data.initiatorAddress,
        initiatorToken: data.initiatorToken,
        initiatorAmount: String(data.initiatorAmount), // Ensure amounts are strings
        initiatorReceivingAddressOnOtherChain:
          data.initiatorReceivingAddressOnOtherChain,
        counterpartyChain: data.counterpartyChain,
        counterpartyAddress: data.counterpartyAddress,
        counterpartyToken: data.counterpartyToken,
        counterpartyAmount: String(data.counterpartyAmount),
        counterpartyReceivingAddressOnOtherChain:
          data.counterpartyReceivingAddressOnOtherChain,
        hashlock: data.hashlock,
        // Optional fields from SwapData
        evmContractAddress: data.evmContractAddress,
        flowHtlcId: data.flowHtlcId,
        timelocksJson: data.timelocksJson,
        transactionHashes: data.transactionHashes,
      },
    });
    console.log("New swap created:", newSwap);
    // TODO: Continue with actual relayer logic based on docs/relayer/relayerDescription.md
    // This would involve interacting with EVM and Flow chains
    return {
      success: true,
      message: "Swap initiated and record created (simulated)",
      swap: newSwap,
    };
  } catch (error) {
    console.error("Error creating swap record:", error);
    let dbErrorMessage = "Failed to create swap record in DB";
    if (error instanceof Error && error.message) {
      dbErrorMessage += `: ${error.message}`;
    }
    return { success: false, message: dbErrorMessage };
  }
}

export async function POST(request: Request) {
  try {
    const requestBody = await request.json();

    // TODO: Add robust request body validation here (e.g., using Zod)
    // For now, we assume the body matches SwapData structure
    if (!requestBody.swapId || !requestBody.hashlock) {
      return NextResponse.json(
        { error: "Missing required fields: swapId, hashlock" },
        { status: 400 }
      );
    }

    const result = await processSwapRelay(requestBody as SwapData);

    if (result.success) {
      return NextResponse.json(result);
    } else {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Error processing relayer request:", error);
    let errorMessage = "Internal Server Error";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
