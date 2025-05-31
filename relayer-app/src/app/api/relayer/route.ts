import { prisma } from "@/lib/prisma"; // Assuming @ is alias for src
import CryptoJS from "crypto-js"; // Import crypto-js
import { NextResponse } from "next/server";

interface SwapDataFromRequest {
  // Renamed to avoid conflict with Prisma's Swap type if imported
  // Fields expected from the client initiating the swap
  initiatorChain: string;
  initiatorAddress: string;
  initiatorToken: string;
  initiatorAmount: number | string;
  initiatorReceivingAddressOnOtherChain: string;
  counterpartyChain: string;
  // counterpartyAddress might not be known at initiation
  counterpartyAddress?: string;
  counterpartyToken: string;
  counterpartyAmount: number | string;
  // counterpartyReceivingAddressOnOtherChain might not be known at initiation
  counterpartyReceivingAddressOnOtherChain?: string;
  direction: "EVM_TO_FLOW" | "FLOW_TO_EVM"; // Assuming direction is provided
  hashlock: string; // Added: Initiator provides the hashlock
  // evmContractAddress, flowHtlcId, etc., are usually not provided at initiation by user
}

// Removed: Relayer no longer generates secret/hashlock at initiation
// const generateSecretAndHashlock = () => { ... };

// Updated processSwapRelay to handle new swap creation with secret and hashlock
async function createNewSwap(data: SwapDataFromRequest, swapId: string) {
  // Removed secret, hashlock params
  console.log("Creating new swap with data:", data);

  try {
    const newSwap = await prisma.swap.create({
      data: {
        swapId: swapId,
        direction: data.direction,
        state: "PENDING_INITIATION",
        initiatorChain: data.initiatorChain,
        initiatorAddress: data.initiatorAddress,
        initiatorToken: data.initiatorToken,
        initiatorAmount: String(data.initiatorAmount),
        initiatorReceivingAddressOnOtherChain:
          data.initiatorReceivingAddressOnOtherChain,
        counterpartyChain: data.counterpartyChain,
        counterpartyAddress: data.counterpartyAddress || null,
        counterpartyToken: data.counterpartyToken,
        counterpartyAmount: String(data.counterpartyAmount),
        counterpartyReceivingAddressOnOtherChain:
          data.counterpartyReceivingAddressOnOtherChain || null,
        hashlock: data.hashlock, // Use provided hashlock
        secret: null, // Secret is not known at this stage
        transactionHashes: [],
      },
    });
    console.log("New swap created:", newSwap);
    return {
      success: true,
      message: "Swap initiated successfully. Initiator to lock funds.",
      swapId: newSwap.swapId,
      // hashlock is not returned as client already knows it
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
    const requestBody = (await request.json()) as SwapDataFromRequest;

    // Basic validation
    if (
      !requestBody.initiatorChain ||
      !requestBody.initiatorAddress /* ... add other necessary checks ... */ ||
      !requestBody.direction ||
      !requestBody.hashlock
    ) {
      return NextResponse.json(
        {
          error:
            "Missing required fields for swap initiation, including hashlock.",
        },
        { status: 400 }
      );
    }

    // Relayer generates a unique swapId
    const swapId = CryptoJS.lib.WordArray.random(16).toString(CryptoJS.enc.Hex);

    // Pass requestBody directly, it contains the hashlock
    const result = await createNewSwap(requestBody, swapId);

    if (result.success) {
      return NextResponse.json({ swapId: result.swapId }); // Only return swapId
    } else {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }
  } catch (error) {
    console.error("Error processing relayer POST request:", error);
    let errorMessage = "Internal Server Error in POST";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

interface UpdateSwapPayload {
  swapId: string;
  action: string; // e.g., "CONFIRM_INITIATOR_LOCK", "CONFIRM_COUNTERPARTY_LOCK", etc.
  transactionHash?: string;
  chain?: string; // Relevant for confirming locks
  secret?: string; // For withdrawals
  // Add other fields that might be needed for different actions
}

export async function PUT(request: Request) {
  try {
    const payload = (await request.json()) as UpdateSwapPayload;
    const {
      swapId,
      action,
      transactionHash,
      chain,
      secret: providedSecret,
    } = payload;

    if (!swapId || !action) {
      return NextResponse.json(
        { error: "Missing required fields: swapId and action." },
        { status: 400 }
      );
    }

    const swap = await prisma.swap.findUnique({
      where: { swapId },
    });

    if (!swap) {
      return NextResponse.json({ error: "Swap not found." }, { status: 404 });
    }

    let updatedSwap;

    switch (action) {
      case "CONFIRM_INITIATOR_LOCK":
        if (!transactionHash || !chain) {
          return NextResponse.json(
            {
              error:
                "Missing transactionHash or chain for CONFIRM_INITIATOR_LOCK.",
            },
            { status: 400 }
          );
        }
        if (swap.state !== "PENDING_INITIATION") {
          return NextResponse.json(
            {
              error: `Swap is not in PENDING_INITIATION state. Current state: ${swap.state}`,
            },
            { status: 400 }
          );
        }

        // TODO: Add actual verification of the lock on the respective chain (EVM or Flow)
        // This is a critical step and would involve using ethers.js/web3.js or FCL.
        console.log(
          `Simulating verification for initiator lock on ${chain} with hash ${transactionHash} for swap ${swapId}`
        );

        // Update transactionHashes: ensure it's an array and push new hash
        const existingHashes = Array.isArray(swap.transactionHashes)
          ? (swap.transactionHashes as string[])
          : [];

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "AWAITING_COUNTERPARTY_LOCK", // Or "INITIATOR_LOCKED" if preferred, then to "AWAITING_COUNTERPARTY_LOCK"
            transactionHashes: [...existingHashes, transactionHash],
            // Potentially update timelocks if provided or determined here
          },
        });
        return NextResponse.json({
          message: "Initiator lock confirmed, awaiting counterparty lock.",
          swap: updatedSwap,
        });

      case "CONFIRM_COUNTERPARTY_LOCK":
        if (!transactionHash || !chain) {
          return NextResponse.json(
            {
              error:
                "Missing transactionHash or chain for CONFIRM_COUNTERPARTY_LOCK.",
            },
            { status: 400 }
          );
        }
        // Ensure the swap is in the correct state to accept counterparty lock
        if (swap.state !== "AWAITING_COUNTERPARTY_LOCK") {
          return NextResponse.json(
            {
              error: `Swap is not in AWAITING_COUNTERPARTY_LOCK state. Current state: ${swap.state}`,
            },
            { status: 400 }
          );
        }

        // TODO: Add actual verification of the counterparty's lock on their respective chain.
        console.log(
          `Simulating verification for counterparty lock on ${chain} with hash ${transactionHash} for swap ${swapId}`
        );

        const existingHashesCounterparty = Array.isArray(swap.transactionHashes)
          ? (swap.transactionHashes as string[])
          : [];

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "AWAITING_INITIATOR_WITHDRAWAL", // Both parties have locked, initiator can now withdraw
            transactionHashes: [...existingHashesCounterparty, transactionHash],
            // Optionally, counterpartyAddress and counterpartyReceivingAddressOnOtherChain could be confirmed/updated here if not provided initially
            // counterpartyAddress: payload.counterpartyAddress || swap.counterpartyAddress,
            // counterpartyReceivingAddressOnOtherChain: payload.counterpartyReceivingAddressOnOtherChain || swap.counterpartyReceivingAddressOnOtherChain,
          },
        });
        return NextResponse.json({
          message: "Counterparty lock confirmed. Initiator can now withdraw.",
          swap: updatedSwap,
        });

      case "INITIATE_WITHDRAWAL": // Initiator withdraws from counterparty's lock
        if (!providedSecret) {
          return NextResponse.json(
            { error: "Missing secret for INITIATE_WITHDRAWAL." },
            { status: 400 }
          );
        }

        if (swap.state !== "AWAITING_INITIATOR_WITHDRAWAL") {
          return NextResponse.json(
            {
              error: `Swap is not in AWAITING_INITIATOR_WITHDRAWAL state. Current state: ${swap.state}`,
            },
            { status: 400 }
          );
        }

        // Verify the provided secret against the stored hashlock
        const calculatedHash = CryptoJS.SHA256(providedSecret).toString(
          CryptoJS.enc.Hex
        );
        if (calculatedHash !== swap.hashlock) {
          return NextResponse.json(
            { error: "Invalid secret." },
            { status: 400 }
          );
        }

        // TODO: Add actual on-chain withdrawal logic for the initiator.
        // This would involve using the secret to unlock funds from the HTLC on the counterparty's chain.
        // The chain (swap.counterpartyChain) and HTLC details (swap.flowHtlcId or swap.evmContractAddress) are in the 'swap' object.
        console.log(
          `Simulating initiator withdrawal for swap ${swapId} using the revealed secret.`
        );

        // Assume withdrawal is successful, update state and store revealed secret if not already (though it was stored at creation)
        // Storing the secret was already done at POST, but good to ensure it is there.
        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "INITIATOR_WITHDREW_AND_REVEALED_SECRET",
            secret: providedSecret, // Ensure the revealed secret is stored (or confirmed)
            // Add transaction hash of this withdrawal if available and makes sense
            // transactionHashes: [...(swap.transactionHashes as string[]), withdrawalTxHash]
          },
        });
        return NextResponse.json({
          message: "Initiator withdrawal successful. Secret revealed.",
          swap: updatedSwap,
        });

      case "COUNTERPARTY_WITHDRAW": // Counterparty withdraws from initiator's lock using revealed secret
        // The secret should have been revealed and stored in the swap record by the initiator's withdrawal
        if (!swap.secret) {
          // This case should ideally not happen if the flow is correct
          return NextResponse.json(
            {
              error:
                "Secret not found in swap record. Initiator might not have withdrawn yet.",
            },
            { status: 400 }
          );
        }

        if (swap.state !== "INITIATOR_WITHDREW_AND_REVEALED_SECRET") {
          return NextResponse.json(
            {
              error: `Swap is not in INITIATOR_WITHDREW_AND_REVEALED_SECRET state. Current state: ${swap.state}`,
            },
            { status: 400 }
          );
        }

        // TODO: Add actual on-chain withdrawal logic for the counterparty.
        // This uses swap.secret to unlock funds from the HTLC on the initiator's chain (swap.initiatorChain).
        console.log(
          `Simulating counterparty withdrawal for swap ${swapId} using revealed secret.`
        );

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "COMPLETED", // Swap is now complete
            // Add transaction hash of this withdrawal
            // transactionHashes: [...(swap.transactionHashes as string[]), counterpartyWithdrawalTxHash]
          },
        });
        return NextResponse.json({
          message: "Counterparty withdrawal successful. Swap completed.",
          swap: updatedSwap,
        });

      // Add other cases for different actions here in the future
      // e.g., CONFIRM_COUNTERPARTY_LOCK, INITIATE_WITHDRAWAL, etc.

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Error processing relayer PUT request:", error);
    let errorMessage = "Internal Server Error in PUT";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
