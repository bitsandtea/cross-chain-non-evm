import { NextResponse } from "next/server";
import { TX_UNLOCK_FOOTOKEN_HTLC } from "../../../../lib/cadenceTxs/txs"; // Corrected import
import { withdrawFromFooTokenHtlc } from "../../../../lib/flow-transactions"; // Corrected import
import { callRelayerApi } from "../../../../lib/relayerApi";

// Flow Configuration - FCL will use environment variables for node and PK
// Ensure FLOW_ACCESS_NODE, FLOW_ACCOUNT_ADDRESS (for U2's receiving account on Flow), and FLOW_PRIVATE_KEY are set.

export async function POST(request: Request) {
  const log: string[] = [];
  try {
    log.push(
      "Received request to withdraw from Flow HTLC (U2/EVM User action)..."
    );

    const { swapId, secret } = await request.json();

    if (!swapId || !secret) {
      throw new Error("Missing swapId or secret in the request body.");
    }
    log.push(
      `Swap ID: ${swapId}, Secret (prefix): ${secret.substring(0, 6)}...`
    );

    // 1. Fetch swap details from the relayer
    log.push(`Fetching swap details for ID: ${swapId} from relayer...`);
    const swapDetails = await callRelayerApi(`?swapId=${swapId}`, "GET");
    log.push(`Swap details fetched: ${JSON.stringify(swapDetails, null, 2)}`);

    if (!swapDetails || !swapDetails.id) {
      throw new Error(`Swap with ID ${swapId} not found or relayer error.`);
    }
    if (
      swapDetails.status === "COMPLETED" ||
      swapDetails.status === "CANCELLED" ||
      swapDetails.status === "EXPIRED"
    ) {
      throw new Error(
        `Swap ${swapId} is already in a final state: ${swapDetails.status}. Cannot withdraw.`
      );
    }
    if (!swapDetails.flowHtlcTxHash) {
      // Or a specific field indicating Flow HTLC address/details
      throw new Error(
        `Flow HTLC details not found in swap details for ${swapId}.`
      );
    }
    if (
      swapDetails.initiatorChain !== "Flow" ||
      swapDetails.counterpartyChain !== "EVM"
    ) {
      throw new Error(
        `Swap direction mismatch. Expected Flow -> EVM, but got ${swapDetails.initiatorChain} -> ${swapDetails.counterpartyChain}`
      );
    }

    // The secret revealed by U1 (Flow user on EVM side) is used by U2 (EVM user on Flow side)
    // Verify the provided secret matches the hashlock in swapDetails
    // Note: Flow typically uses SHA3-256 for its hashes, EVM uses Keccak256.
    // The `generateSecretAndHashlock` in `flow-to-evm` uses `ethers.keccak256`.
    // The Flow HTLC contract must be compatible with this hash type or expect the pre-image directly.
    // For this example, we assume the secret is directly usable or the contract handles the hash comparison correctly.
    // A robust solution would involve the relayer storing the specific hash type or the Flow contract being flexible.
    // For now, we assume the `secret` is what the Flow contract needs.

    log.push(
      `Attempting to withdraw from Flow HTLC for swap ${swapId} using secret.`
    );

    // Prepare arguments for the Flow transaction
    // These arguments depend on the specific Cadence script (TX_UNLOCK_FOOTOKEN_HTLC)
    const flowHtlcDeployerAddress = process.env.FLOW_HTLC_DEPLOYER_ADDRESS;
    if (!flowHtlcDeployerAddress) {
      throw new Error(
        "FLOW_HTLC_DEPLOYER_ADDRESS environment variable is not set (needed for HTLC interactions)."
      );
    }

    // The account that will sign this Flow transaction is the one that received the HTLC (counterpartyReceivingAddressOnOtherChain)
    // FCL needs to be configured with the private key for this address.
    // The actual `htlcAddress` might be derived or stored in swapDetails if not using a global one.
    // The `TX_UNLOCK_FOOTOKEN_HTLC` script will define what it needs.
    // For this example, let's assume `TX_UNLOCK_FOOTOKEN_HTLC` primarily needs the secret and deployer address.
    const withdrawArgs = {
      secret: secret, // The raw secret string
      htlcDeployerAddress: flowHtlcDeployerAddress, // Address where HTLC contract is deployed
    };
    log.push(`Flow HTLC withdrawal arguments: ${JSON.stringify(withdrawArgs)}`);

    let flowWithdrawTxHash: string;
    try {
      // The `withdrawFromFooTokenHtlc` helper must be set up to use FCL with server-side signing
      // configured for the `swapDetails.counterpartyReceivingAddressOnOtherChain` (U2's Flow address).
      // This means the FLOW_ACCOUNT_ADDRESS and FLOW_PRIVATE_KEY env vars for FCL should correspond
      // to this U2's Flow address.
      log.push(
        `Sending Flow transaction with FCL signer: ${process.env.FLOW_ACCOUNT_ADDRESS} (should be U2's Flow address: ${swapDetails.counterpartyReceivingAddressOnOtherChain})`
      );
      if (
        process.env.FLOW_ACCOUNT_ADDRESS?.toLowerCase() !==
        swapDetails.counterpartyReceivingAddressOnOtherChain?.toLowerCase()
      ) {
        log.push(
          `WARNING: FCL Signer (${process.env.FLOW_ACCOUNT_ADDRESS}) does not match swap's U2 Flow address (${swapDetails.counterpartyReceivingAddressOnOtherChain}). Ensure correct PK is configured.`
        );
        // Potentially throw error here if strict check is needed
      }

      flowWithdrawTxHash = await withdrawFromFooTokenHtlc(
        TX_UNLOCK_FOOTOKEN_HTLC,
        withdrawArgs
      );
      log.push(
        `Flow HTLC withdrawal transaction successful: ${flowWithdrawTxHash}`
      );
    } catch (flowError: unknown) {
      let message = "Unknown error during Flow HTLC withdrawal";
      if (flowError instanceof Error) message = flowError.message;
      log.push(`ERROR during Flow HTLC withdrawal: ${message}`);
      log.push(
        "Ensure FCL is configured for server-side transaction signing with the correct private key for the Flow recipient (U2)."
      );
      throw flowError;
    }

    // 3. Confirm withdrawal with Relayer
    log.push(`Confirming Flow withdrawal with Relayer for swap ${swapId}...`);
    await callRelayerApi("", "PUT", {
      swapId: swapId,
      action: "COMPLETE_SWAP_WITHDRAW_FLOW", // New relayer action
      transactionHash: flowWithdrawTxHash,
      chain: "Flow",
      // Secret may not be needed here if relayer already has it from EVM withdrawal, but can be sent for consistency.
    });
    log.push(
      `Flow withdrawal confirmed with Relayer. TxHash: ${flowWithdrawTxHash}.`
    );

    log.push(
      "Flow HTLC withdrawal (U2/EVM User action) completed successfully!"
    );
    return NextResponse.json({
      success: true,
      message: "Flow HTLC withdrawal successful",
      log: log,
      flowWithdrawTxHash: flowWithdrawTxHash,
    });
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred during Flow HTLC withdrawal.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    log.push(`Error during Flow HTLC withdrawal: ${errorMessage}`);
    console.error("Flow HTLC Withdrawal Error Details:", error);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        log: log,
      },
      { status: 500 }
    );
  }
}
