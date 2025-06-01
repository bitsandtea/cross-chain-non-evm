import CryptoJS from "crypto-js";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { TX_CREATE_FOOTOKEN_HTLC } from "../../../../lib/cadenceTxs/txs";
import { createFooTokenHtlc } from "../../../../lib/flow-transactions";

// Helper function to make API calls to our relayer
async function callRelayerApi(endpoint: string, method: string, body?: object) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const response = await fetch(`${baseUrl}/api/relayer${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(
      `Relayer API call failed with status ${response.status}: ${errorData}`
    );
  }
  return response.json();
}

// Function to generate a secret and its hash (hashlock)
const generateSecretAndHashlock = () => {
  const secretBuffer = CryptoJS.lib.WordArray.random(32);
  const secret = secretBuffer.toString(CryptoJS.enc.Hex);
  const hashlock = ethers.keccak256("0x" + secret);
  return { secret, hashlock };
};

// Timelock constant for Flow HTLC
const FLOW_CANCELLATION_TIMELOCK_OFFSET = process.env
  .FLOW_CANCELLATION_TIMELOCK_OFFSET
  ? parseInt(process.env.FLOW_CANCELLATION_TIMELOCK_OFFSET)
  : 100; // 100 seconds

interface InitiateFlowLockRequest {
  // Flow side (initiator)
  initiatorFlowToken: string; // e.g., "A.432050232f9a49e7.FooToken"
  initiatorFlowAmount: string; // e.g., "5.0"
  initiatorReceivingEvmAddress: string; // Alice's EVM address

  // EVM side (counterparty, details needed for full swap object for relayer)
  counterpartyEvmLockerAddress: string; // Bob's EVM address (e.g., SIM_EVM_LOCKER_ON_EVM_ADDRESS)
  counterpartyEvmToken: string; // e.g., ethers.ZeroAddress for native ETH
  counterpartyEvmAmount: string; // e.g., "0.01"
  counterpartyReceivingFlowAddress: string; // Bob's Flow address (e.g., SIM_EVM_USER_RECEIVING_FLOW_ADDRESS)
}

export async function POST(request: Request) {
  const simulationLog: string[] = [];
  let swapIdFromRelayer: string | null = null;

  try {
    const body: InitiateFlowLockRequest = await request.json();
    simulationLog.push(
      "Starting INITIATE_FLOW_LOCK simulation (Flow-side actions)..."
    );

    // Basic input validation
    if (
      !body.initiatorFlowToken ||
      !body.initiatorFlowAmount ||
      !body.initiatorReceivingEvmAddress ||
      !body.counterpartyEvmLockerAddress ||
      !body.counterpartyEvmToken ||
      !body.counterpartyEvmAmount ||
      !body.counterpartyReceivingFlowAddress
    ) {
      throw new Error("Missing one or more required fields in request body.");
    }
    simulationLog.push(`Request Body: ${JSON.stringify(body)}`);

    // 1. Generate secret and hashlock
    const { secret, hashlock } = generateSecretAndHashlock();
    simulationLog.push(
      `Generated Secret: ${secret.substring(
        0,
        6
      )}... (full secret logged to server console only for demo), Hashlock: ${hashlock}`
    );

    // 2. Define Swap Parameters for Relayer
    const flowLockerAddress = process.env.FLOW_SIGNER_ADDRESS;
    if (!flowLockerAddress) {
      throw new Error(
        "FLOW_SIGNER_ADDRESS env variable is required for the Flow user locking funds."
      );
    }
    simulationLog.push(`Flow Locker (Initiator on Flow): ${flowLockerAddress}`);

    const swapDetails = {
      initiatorChain: "Flow" as const,
      initiatorAddress: flowLockerAddress,
      initiatorToken: body.initiatorFlowToken,
      initiatorAmount: body.initiatorFlowAmount,
      initiatorReceivingAddressOnOtherChain: body.initiatorReceivingEvmAddress,

      counterpartyChain: "EVM" as const,
      counterpartyAddress: body.counterpartyEvmLockerAddress,
      counterpartyToken: body.counterpartyEvmToken,
      counterpartyAmount: body.counterpartyEvmAmount,
      counterpartyReceivingAddressOnOtherChain:
        body.counterpartyReceivingFlowAddress,
      direction: "FLOW_TO_EVM" as const,
      hashlock: hashlock, // Use the generated hashlock
    };
    simulationLog.push(
      `Swap Details for Relayer: ${JSON.stringify(swapDetails, null, 2)}`
    );

    // 3. Call Relayer to initiate swap (POST)
    simulationLog.push("Step 1: Initiating swap with Relayer...");
    const initResponse = await callRelayerApi("", "POST", swapDetails);
    swapIdFromRelayer = initResponse.swapId;
    simulationLog.push(
      `Swap initiated with Relayer. Swap ID: ${swapIdFromRelayer}`
    );
    if (!swapIdFromRelayer) {
      throw new Error("Relayer did not return a swapId from POST.");
    }

    // 4. Initiator (Flow) locks funds ON-CHAIN
    simulationLog.push("Step 2: Initiator (Flow) locking funds ON-CHAIN...");

    const flowHtlcDeployerAddress = process.env.FLOW_HTLC_DEPLOYER_ADDRESS;
    if (!flowHtlcDeployerAddress) {
      throw new Error(
        "FLOW_HTLC_DEPLOYER_ADDRESS environment variable is not set."
      );
    }
    simulationLog.push(`Using Flow HTLC Deployer: ${flowHtlcDeployerAddress}`);

    const initiatorTokenParts = swapDetails.initiatorToken.split(".");
    const flowTokenSymbol =
      initiatorTokenParts.length === 3
        ? initiatorTokenParts[2]
        : swapDetails.initiatorToken;
    simulationLog.push(`Using Flow Token Symbol: ${flowTokenSymbol}`);

    const flowLockTimestamp = Math.floor(Date.now() / 1000);
    const flowHtlcCancellationTimestamp = BigInt(
      flowLockTimestamp + FLOW_CANCELLATION_TIMELOCK_OFFSET
    );
    const flowTimelockString = flowHtlcCancellationTimestamp.toString() + ".0";
    const flowAmountString = parseFloat(swapDetails.initiatorAmount).toFixed(8);

    const htlcArgs = {
      receiverAddress: swapDetails.counterpartyReceivingAddressOnOtherChain,
      tokenSymbol: flowTokenSymbol,
      amount: flowAmountString,
      hashOfSecret: swapDetails.hashlock,
      timelockTimestamp: flowTimelockString,
      htlcDeployerAddress: flowHtlcDeployerAddress,
    };

    simulationLog.push(
      `Attempting to create Flow HTLC with args: ${JSON.stringify(htlcArgs)}`
    );

    let actualFlowLockTxHash: string;
    try {
      actualFlowLockTxHash = await createFooTokenHtlc(
        TX_CREATE_FOOTOKEN_HTLC,
        htlcArgs
      );
      simulationLog.push(
        `Flow HTLC creation transaction successful: ${actualFlowLockTxHash}`
      );
    } catch (flowError: unknown) {
      let message = "Unknown error during Flow HTLC creation";
      if (flowError instanceof Error) message = flowError.message;
      simulationLog.push(`ERROR during Flow HTLC creation: ${message}`);
      simulationLog.push(
        "Ensure FCL is configured for server-side transaction signing."
      );
      throw flowError;
    }

    // Confirm with Relayer
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "CONFIRM_INITIATOR_LOCK",
      transactionHash: actualFlowLockTxHash,
      chain: "Flow",
    });
    simulationLog.push(
      `Initiator (Flow) lock ON-CHAIN confirmed with Relayer. TxHash: ${actualFlowLockTxHash}. Flow HTLC Expiry: ${flowTimelockString}`
    );

    simulationLog.push(
      "INITIATE_FLOW_LOCK simulation step completed successfully!"
    );
    return NextResponse.json({
      success: true,
      log: simulationLog,
      swapId: swapIdFromRelayer,
      secret: secret, // Crucial for the EVM withdrawal step
      hashlock: swapDetails.hashlock, // Needed for EVM DstEscrow immutables
      flowLockTxHash: actualFlowLockTxHash,
      flowHtlcCancellationTimestamp: flowHtlcCancellationTimestamp.toString(), // For EVM DstEscrow creation check
      // Pass all details that might be needed by the next step
      fullSwapDetailsForNextStep: swapDetails,
    });
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred during Flow initiation.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    simulationLog.push(`Error during Flow initiation: ${errorMessage}`);
    console.error("Flow Initiation Error Details:", error);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        log: simulationLog,
        swapId: swapIdFromRelayer,
      },
      { status: 500 }
    );
  }
}
