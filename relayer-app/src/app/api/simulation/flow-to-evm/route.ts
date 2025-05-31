import CryptoJS from "crypto-js";
import { NextResponse } from "next/server";

// Helper function to make API calls to our relayer
async function callRelayerApi(endpoint: string, method: string, body?: object) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"; // Ensure this is set in your .env.local or vercel env
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
  const secret = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
  const hashlock = CryptoJS.SHA256(secret).toString(CryptoJS.enc.Hex);
  return { secret, hashlock };
};

export async function GET(_request: Request) {
  const simulationLog: string[] = [];
  let swapIdFromRelayer: string | null = null;

  try {
    simulationLog.push("Starting FLOW_TO_EVM swap simulation...");

    // 1. Generate secret and hashlock (Initiator does this)
    const { secret, hashlock } = generateSecretAndHashlock();
    simulationLog.push(
      `Generated Secret: (intentionally hidden), Hashlock: ${hashlock}`
    );

    // 2. Define Swap Parameters (Flow to EVM)
    const flowInitiatorAddress = "0xflowinitiator_simulated";
    const evmCounterpartyAddress = "0xevmcounterparty_simulated";
    const flowTokenContract = "A.432050232f9a49e7.FooToken";
    const evmTokenContract = "0x331E51974cF08DDB93f488f22B0d6797b2C8b374";
    const flowHtlcAddressUsed = "A.432050232f9a49e7.MinimalHTLC";
    const evmEscrowFactoryAddressUsed =
      "0x165f6274b44B0f469cfCf7D87F90866657180885";

    simulationLog.push(
      `Using Flow HTLC Address (for initiator lock): ${flowHtlcAddressUsed}`
    );
    simulationLog.push(
      `Using EVM Escrow Factory Address (for counterparty lock): ${evmEscrowFactoryAddressUsed}`
    );

    const swapDetails = {
      initiatorChain: "Flow",
      initiatorAddress: flowInitiatorAddress,
      initiatorToken: flowTokenContract,
      initiatorAmount: "100",
      initiatorReceivingAddressOnOtherChain: evmCounterpartyAddress,
      counterpartyChain: "EVM",
      counterpartyAddress: evmCounterpartyAddress,
      counterpartyToken: evmTokenContract,
      counterpartyAmount: "50",
      counterpartyReceivingAddressOnOtherChain: flowInitiatorAddress,
      direction: "FLOW_TO_EVM" as const,
      hashlock: hashlock,
    };
    simulationLog.push(
      `Initial Swap Details: ${JSON.stringify(swapDetails, null, 2)}`
    );

    // 3. Call Relayer to initiate swap (POST)
    simulationLog.push("Step 1: Initiating swap with Relayer...");
    const initResponse = await callRelayerApi("", "POST", swapDetails);
    swapIdFromRelayer = initResponse.swapId;
    simulationLog.push(
      `Swap initiated with Relayer. Swap ID: ${swapIdFromRelayer}`
    );
    if (!swapIdFromRelayer)
      throw new Error("Relayer did not return a swapId from POST.");

    // 4. Simulate Initiator (Flow) locking funds and confirming with Relayer (PUT)
    simulationLog.push(
      "Step 2: Simulating Initiator (Flow) lock and confirming..."
    );
    const initiatorLockTxHash = `0xflowlocktx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "CONFIRM_INITIATOR_LOCK",
      transactionHash: initiatorLockTxHash,
      chain: "Flow",
    });
    simulationLog.push(
      `Initiator (Flow) lock confirmed with Relayer. TxHash: ${initiatorLockTxHash}`
    );

    // 5. Simulate Counterparty (EVM) locking funds and confirming with Relayer (PUT)
    simulationLog.push(
      "Step 3: Simulating Counterparty (EVM) lock and confirming..."
    );
    const counterpartyLockTxHash = `0xevmlocktx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "CONFIRM_COUNTERPARTY_LOCK",
      transactionHash: counterpartyLockTxHash,
      chain: "EVM",
    });
    simulationLog.push(
      `Counterparty (EVM) lock confirmed with Relayer. TxHash: ${counterpartyLockTxHash}`
    );

    // 6. Simulate Initiator (Flow user) withdrawing from Counterparty's (EVM) lock (PUT)
    simulationLog.push(
      "Step 4: Simulating Initiator withdrawing from EVM lock (revealing secret)..."
    );
    const initiatorWithdrawTxHash = `0xevmwithdrawtx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "INITIATE_WITHDRAWAL",
      secret: secret,
      transactionHash: initiatorWithdrawTxHash,
      chain: "EVM",
    });
    simulationLog.push(
      `Initiator withdrawal from EVM lock confirmed. Secret revealed. TxHash: ${initiatorWithdrawTxHash}`
    );

    // 7. Simulate Counterparty (EVM user) withdrawing from Initiator's (Flow) lock (PUT)
    simulationLog.push(
      "Step 5: Simulating Counterparty withdrawing from Flow lock (using revealed secret)..."
    );
    const counterpartyWithdrawTxHash = `0xflowwithdrawtx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "COUNTERPARTY_WITHDRAW",
      transactionHash: counterpartyWithdrawTxHash,
      chain: "Flow",
    });
    simulationLog.push(
      `Counterparty withdrawal from Flow lock confirmed. Swap COMPLETED. TxHash: ${counterpartyWithdrawTxHash}`
    );

    simulationLog.push("FLOW_TO_EVM swap simulation completed successfully!");
    return NextResponse.json({ success: true, log: simulationLog });
  } catch (error) {
    let errorMessage = "An unknown error occurred during simulation.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    simulationLog.push(`Error during simulation: ${errorMessage}`);
    console.error("Simulation Error Details:", error);

    if (swapIdFromRelayer) {
      simulationLog.push(
        `Attempting to fetch final state of failed swap ${swapIdFromRelayer}...`
      );
      try {
        const finalSwapState = await callRelayerApi(
          `?swapId=${swapIdFromRelayer}`,
          "GET"
        );
        simulationLog.push(
          `Final Swap State: ${JSON.stringify(finalSwapState, null, 2)}`
        );
      } catch (fetchError) {
        let fetchErrorMessage = "Unknown error fetching final swap state.";
        if (fetchError instanceof Error) {
          fetchErrorMessage = fetchError.message;
        } else if (typeof fetchError === "string") {
          fetchErrorMessage = fetchError;
        }
        simulationLog.push(
          `Could not fetch final swap state: ${fetchErrorMessage}`
        );
        console.error("Fetch Final Swap State Error Details:", fetchError);
      }
    }
    return NextResponse.json(
      { success: false, error: errorMessage, log: simulationLog },
      { status: 500 }
    );
  }
}
