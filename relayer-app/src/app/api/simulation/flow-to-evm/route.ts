import CryptoJS from "crypto-js";
import { ethers, Interface, Log, LogDescription } from "ethers"; // Added Log and Interface for types
import { NextResponse } from "next/server";
import MinimalEscrowDstAbi from "../../../../abis/MinimalEscrowDst.json";
import MinimalEscrowFactoryAbi from "../../../../abis/MinimalEscrowFactory.json";
import { TX_CREATE_FOOTOKEN_HTLC } from "../../../../lib/cadenceTxs/txs"; // Corrected Import Cadence script
import { createFooTokenHtlc } from "../../../../lib/flow-transactions"; // Corrected Import Flow transaction helper

// --- START OF HARDCODED SIMULATION ADDRESSES ---
// TODO: Replace with your actual desired hardcoded addresses for simulation
const SIM_EVM_USER_RECEIVING_FLOW_ADDRESS = "0x5e5e07897a1b3daf"; // Example: Flow address where EVM user (Bob) receives Flow tokens
const SIM_EVM_LOCKER_ON_EVM_ADDRESS =
  "0x4AF867B06C96eCf44d23125f958D20d59FBc9921"; // Example: EVM address of the user (Bob) who locks funds on EVM
// --- END OF HARDCODED SIMULATION ADDRESSES ---

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
  // For EVM contracts, hash of bytes is usually needed.
  // CryptoJS.SHA256 expects a WordArray or string. If string, it converts to UTF8.
  // To match keccak256(bytes), we should hash the hex string as bytes.
  // Or, ensure secret is treated as bytes32 string on-chain.
  // The 1inch contracts use keccak256(_secret). Let's use ethers for hashing to be sure.
  const hashlock = ethers.keccak256("0x" + secret); // Hash the hex string directly as bytes
  return { secret, hashlock };
};

// EVM Configuration
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
const MINIMAL_ESCROW_FACTORY_ADDRESS =
  process.env.MINIMAL_ESCROW_FACTORY_ADDRESS;

const provider = EVM_RPC_URL ? new ethers.JsonRpcProvider(EVM_RPC_URL) : null;
const signer =
  EVM_PRIVATE_KEY && provider
    ? new ethers.Wallet(EVM_PRIVATE_KEY, provider)
    : null;

// Timelock constants (durations in seconds) - Should align with contract and cross-chain logic
const FLOW_WITHDRAWAL_TIMELOCK_OFFSET = process.env
  .FLOW_WITHDRAWAL_TIMELOCK_OFFSET
  ? parseInt(process.env.FLOW_WITHDRAWAL_TIMELOCK_OFFSET)
  : 100; // 100 seconds
const FLOW_CANCELLATION_TIMELOCK_OFFSET = process.env
  .FLOW_CANCELLATION_TIMELOCK_OFFSET
  ? parseInt(process.env.FLOW_CANCELLATION_TIMELOCK_OFFSET)
  : 100; // 100 seconds
const EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET = process.env
  .EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET
  ? parseInt(process.env.EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET)
  : 100; // 100 seconds
const EVM_DST_CANCELLATION_TIMELOCK_OFFSET = process.env
  .EVM_DST_CANCELLATION_TIMELOCK_OFFSET
  ? parseInt(process.env.EVM_DST_CANCELLATION_TIMELOCK_OFFSET)
  : 60; // 60 seconds, reduced from 100 to allow for tx propagation and mining delays
const EVM_SAFETY_DEPOSIT = process.env.EVM_SAFETY_DEPOSIT || "0.0001"; // In ETH

// Helper to pack timelocks for IBaseEscrow.Immutables
function packTimelocks(
  srcWithdrawalOffset: number,
  srcCancellationOffset: number,
  dstWithdrawalOffset: number,
  dstCancellationOffset: number
): bigint {
  let packed = BigInt(0);
  packed |= BigInt(srcWithdrawalOffset);
  packed |= BigInt(srcCancellationOffset) << BigInt(64);
  packed |= BigInt(dstWithdrawalOffset) << BigInt(128);
  packed |= BigInt(dstCancellationOffset) << BigInt(192);
  return packed;
}

interface EvmImmutables {
  orderHash: string;
  hashlock: string;
  maker: string;
  taker: string;
  token: string;
  amount: ethers.BigNumberish;
  safetyDeposit: ethers.BigNumberish;
  timelocks: ethers.BigNumberish;
}

export async function GET() {
  // Removed _request: Request
  const simulationLog: string[] = [];
  let swapIdFromRelayer: string | null = null;
  let actualEvmEscrowAddress: string | null = null; // To store deployed DstEscrow address

  try {
    simulationLog.push(
      "Starting FLOW_TO_EVM swap simulation with ON-CHAIN EVM interactions..."
    );

    if (!signer || !provider || !MINIMAL_ESCROW_FACTORY_ADDRESS) {
      throw new Error(
        "EVM environment not configured. Check EVM_RPC_URL, EVM_PRIVATE_KEY, MINIMAL_ESCROW_FACTORY_ADDRESS."
      );
    }
    simulationLog.push(
      `Using EVM Signer for on-chain EVM operations: ${signer.address}`
    );
    simulationLog.push(
      `MinimalEscrowFactory Address: ${MINIMAL_ESCROW_FACTORY_ADDRESS}`
    );

    // 1. Generate secret and hashlock
    const { secret, hashlock } = generateSecretAndHashlock();
    simulationLog.push(
      `Generated Secret: ${secret.substring(
        0,
        6
      )}... (full secret logged to server console only for demo), Hashlock: ${hashlock}`
    );

    // 2. Define Swap Parameters (Flow to EVM)

    // ----- Flow Side Addresses -----
    const flowLockerAddress = process.env.FLOW_SIGNER_ADDRESS; // Alice's Flow address, locks funds on Flow
    if (!flowLockerAddress) {
      throw new Error(
        "FLOW_SIGNER_ADDRESS env variable is required for the Flow user locking funds."
      );
    }
    simulationLog.push(
      `Flow Locker (Initiator on Flow): ${flowLockerAddress}. This account's PK (FLOW_PRIVATE_KEY) must be configured for FCL to sign Flow transactions.`
    );

    const evmUserReceivingFlowAddress = SIM_EVM_USER_RECEIVING_FLOW_ADDRESS; // Bob's Flow address, receives from Flow HTLC
    if (
      !evmUserReceivingFlowAddress ||
      evmUserReceivingFlowAddress === "0x5e5e07897a1b3daf"
    ) {
      simulationLog.push(
        `WARNING: SIM_EVM_USER_RECEIVING_FLOW_ADDRESS is using a placeholder: ${evmUserReceivingFlowAddress}. Update it in the code.`
      );
      // Decide if you want to throw an error or allow placeholder for initial tests
      // throw new Error("Placeholder SIM_EVM_USER_RECEIVING_FLOW_ADDRESS is being used. Update it in the code.");
    }
    simulationLog.push(
      `EVM User will receive Flow tokens at (Flow Address): ${evmUserReceivingFlowAddress}. This is the Flow HTLC recipient.`
    );

    // ----- EVM Side Addresses -----
    // The EVM user who locks funds in the DstEscrow (Maker of DstEscrow)
    const evmLockerAddress = SIM_EVM_LOCKER_ON_EVM_ADDRESS; // Bob's EVM address
    if (
      !evmLockerAddress ||
      evmLockerAddress === "0x4AF867B06C96eCf44d23125f958D20d59FBc9921"
    ) {
      simulationLog.push(
        `WARNING: SIM_EVM_LOCKER_ON_EVM_ADDRESS is using a placeholder: ${evmLockerAddress}. Update it in the code.`
      );
      // Decide if you want to throw an error or allow placeholder for initial tests
      // throw new Error("Placeholder SIM_EVM_LOCKER_ON_EVM_ADDRESS is being used. Update it in the code.");
    }
    simulationLog.push(
      `EVM Locker (Counterparty on EVM): ${evmLockerAddress}. This account locks funds in DstEscrow.`
    );

    // The Flow user's EVM address, where they will receive funds from DstEscrow (Taker of DstEscrow)
    // For this simulation, this must be the signer.address to allow DstEscrow.withdraw call.
    const flowUserEvmReceivingAddress = signer.address;
    simulationLog.push(
      `Flow User will receive EVM tokens at (EVM Address): ${flowUserEvmReceivingAddress}. This is the DstEscrow Taker and must be the current EVM signer for withdrawal step.`
    );

    if (
      evmLockerAddress.toLowerCase() ===
      flowUserEvmReceivingAddress.toLowerCase()
    ) {
      simulationLog.push(
        `Note: EVM Locker address (${evmLockerAddress}) and Flow User's EVM Receiving address (${flowUserEvmReceivingAddress}) are the same. This is okay for simulation if one entity plays multiple roles on EVM or if the counterparty sends to self initially.`
      );
    }

    // Forcing Native ETH for EVM side for simplicity in this iteration
    const evmTokenContract = ethers.ZeroAddress; // Native ETH
    const originalEvmTokenFromSim =
      "0x331E51974cF08DDB93f488f22B0d6797b2C8b374"; // Original from simulation
    simulationLog.push(
      `Note: EVM Token is FORCED to Native ETH (${evmTokenContract}) for this on-chain simulation. Original was ${originalEvmTokenFromSim}.`
    );

    const flowTokenContract = "A.432050232f9a49e7.FooToken"; // Example
    const flowHtlcAddressUsed = "A.432050232f9a49e7.MinimalHTLC"; // Example

    simulationLog.push(
      `Using Flow HTLC Address (for initiator lock): ${flowHtlcAddressUsed}`
    );
    simulationLog.push(
      `Using EVM Escrow Factory Address (for counterparty lock): ${MINIMAL_ESCROW_FACTORY_ADDRESS}`
    );

    const swapDetails = {
      initiatorChain: "Flow",
      initiatorAddress: flowLockerAddress, // Flow user (Alice) locking funds on Flow
      initiatorToken: flowTokenContract,
      initiatorAmount: "5", // Example amount on Flow
      initiatorReceivingAddressOnOtherChain: flowUserEvmReceivingAddress, // Flow user's (Alice's) EVM address to receive EVM tokens

      counterpartyChain: "EVM",
      counterpartyAddress: evmLockerAddress, // EVM user (Bob) locking funds on EVM
      counterpartyToken: evmTokenContract,
      counterpartyAmount: "0.0001",
      counterpartyReceivingAddressOnOtherChain: evmUserReceivingFlowAddress, // EVM user's (Bob's) Flow address to receive Flow tokens
      direction: "FLOW_TO_EVM" as const,
      hashlock: hashlock,
    };
    // swapDetails.hashlock = hashlock; // Already set

    simulationLog.push(`Swap Details: ${JSON.stringify(swapDetails, null, 2)}`);

    // 3. Call Relayer to initiate swap (POST)
    simulationLog.push("Step 1: Initiating swap with Relayer...");
    const initResponse = await callRelayerApi("", "POST", swapDetails);
    swapIdFromRelayer = initResponse.swapId; // Use let for swapIdFromRelayer
    simulationLog.push(
      `Swap initiated with Relayer. Swap ID: ${swapIdFromRelayer}`
    );
    if (!swapIdFromRelayer)
      throw new Error("Relayer did not return a swapId from POST.");

    // 4. Initiator (Flow) locks funds ON-CHAIN and confirms with Relayer (PUT)
    simulationLog.push(
      "Step 2: Initiator (Flow) locking funds ON-CHAIN and confirming..."
    );

    const flowHtlcDeployerAddress = process.env.FLOW_HTLC_DEPLOYER_ADDRESS;
    if (!flowHtlcDeployerAddress) {
      throw new Error(
        "FLOW_HTLC_DEPLOYER_ADDRESS environment variable is not set."
      );
    }
    simulationLog.push(`Using Flow HTLC Deployer: ${flowHtlcDeployerAddress}`);

    // Extract token name, assuming format like "A.xxxx.TokenName"
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
    // Format for UFix64 string argument, e.g., "123.0"
    const flowTimelockString = flowHtlcCancellationTimestamp.toString() + ".0";
    const flowAmountString = parseFloat(swapDetails.initiatorAmount).toFixed(8); // Ensure UFix64 format, e.g., "5.00000000"

    const htlcArgs = {
      receiverAddress: swapDetails.counterpartyReceivingAddressOnOtherChain, // Corrected: EVM User's Flow Address (Bob's Flow Addr)
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
      // IMPORTANT: Server-side FCL signing needs to be properly configured for this to work.
      // The createFooTokenHtlc -> sendFlowTransaction might fail if fcl.currentUser().authenticate() is hit.
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
        "Ensure FCL is configured for server-side transaction signing (e.g., with admin keys)."
      );
      throw flowError;
    }

    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "CONFIRM_INITIATOR_LOCK",
      transactionHash: actualFlowLockTxHash, // Use actual Flow tx hash
      chain: "Flow",
    });
    simulationLog.push(
      `Initiator (Flow) lock ON-CHAIN confirmed with Relayer. TxHash: ${actualFlowLockTxHash}. Flow HTLC Expiry: ${flowTimelockString}`
    );

    // 5. Counterparty (EVM) locks funds ON-CHAIN
    simulationLog.push("Step 3: Counterparty (EVM) locking funds ON-CHAIN...");
    // Check if the signer is the one designated as the EVM locker.
    // If SIM_EVM_COUNTERPARTY_ADDR is set and different from signer.address,
    // it means signer is acting on behalf of evmLockerAddress.
    // The funds for createDstEscrow will come from signer.address.
    if (signer.address.toLowerCase() !== evmLockerAddress.toLowerCase()) {
      simulationLog.push(
        `INFO: EVM Signer (${signer.address}) is different from the designated EVM Locker (${evmLockerAddress}). The DstEscrow will be created by the signer, with its 'maker' field set to ${evmLockerAddress}.`
      );
    }

    const factoryContract = new ethers.Contract(
      MINIMAL_ESCROW_FACTORY_ADDRESS,
      MinimalEscrowFactoryAbi,
      signer
    );

    const orderHash = ethers.keccak256(
      ethers.toUtf8Bytes(`flow-to-evm-swap-${swapIdFromRelayer}`)
    );
    const safetyDepositWei = ethers.parseEther(EVM_SAFETY_DEPOSIT);
    const evmAmountWei = ethers.parseEther(swapDetails.counterpartyAmount);

    const packedRelTimelocks = packTimelocks(
      FLOW_WITHDRAWAL_TIMELOCK_OFFSET,
      FLOW_CANCELLATION_TIMELOCK_OFFSET,
      EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET,
      EVM_DST_CANCELLATION_TIMELOCK_OFFSET
    );

    const immutablesDst: EvmImmutables = {
      orderHash: orderHash,
      hashlock: swapDetails.hashlock,
      maker: swapDetails.counterpartyAddress, // EVM Locker (Bob's EVM Addr)
      taker: swapDetails.initiatorReceivingAddressOnOtherChain, // Flow User's EVM Addr (Alice's EVM Addr, which is signer.address)
      token: swapDetails.counterpartyToken, // Should be ZeroAddress for native ETH
      amount: evmAmountWei,
      safetyDeposit: safetyDepositWei,
      timelocks: packedRelTimelocks,
    };

    let evmDstEscrowTxHash: string;
    try {
      simulationLog.push(
        `Attempting to predict DstEscrow address for immutables: ${JSON.stringify(
          immutablesDst,
          (k, v) => (typeof v === "bigint" ? v.toString() : v)
        )}`
      );
      actualEvmEscrowAddress = await factoryContract.addressOfEscrowDst(
        immutablesDst
      );
      simulationLog.push(
        `Predicted EVM DstEscrow Address: ${actualEvmEscrowAddress}`
      );

      let totalValueToSend = safetyDepositWei;
      if (swapDetails.counterpartyToken === ethers.ZeroAddress) {
        totalValueToSend = safetyDepositWei + evmAmountWei;
      }
      simulationLog.push(`Calling factory.createDstEscrow with arguments:`);
      simulationLog.push(
        `  - Immutables (for DstEscrow): ${JSON.stringify(
          immutablesDst,
          (k, v) => (typeof v === "bigint" ? v.toString() : v)
        )}`
      );
      simulationLog.push(
        `  - flowHtlcCancellationTimestamp (arg for createDstEscrow): ${flowHtlcCancellationTimestamp.toString()}`
      );
      simulationLog.push(
        `  - Transaction Value (msg.value): ${ethers.formatEther(
          totalValueToSend
        )} ETH (${totalValueToSend.toString()} wei)`
      );

      const tx = await factoryContract.createDstEscrow(
        immutablesDst,
        flowHtlcCancellationTimestamp,
        { value: totalValueToSend }
      );
      simulationLog.push(`createDstEscrow Tx Sent: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(
          `EVM DstEscrow creation transaction failed. Hash: ${tx.hash}`
        );
      }
      evmDstEscrowTxHash = receipt.hash;
      simulationLog.push(
        `EVM DstEscrow Tx Confirmed: ${evmDstEscrowTxHash}. GasUsed: ${receipt.gasUsed.toString()}`
      );

      // Verify address from event if needed (optional, addressOf should be reliable)
      const iface = new Interface(MinimalEscrowFactoryAbi);
      const createdEventLog = receipt.logs?.find((log: Log) => {
        try {
          const parsedLog: LogDescription | null = iface.parseLog(log);
          return parsedLog?.name === "DstEscrowCreated";
        } catch {
          return false;
        }
      }) as LogDescription | null;
      if (
        createdEventLog &&
        createdEventLog.args &&
        createdEventLog.args.escrow.toLowerCase() !==
          actualEvmEscrowAddress?.toLowerCase()
      ) {
        simulationLog.push(
          `WARNING: Predicted DstEscrow address ${actualEvmEscrowAddress} differs from event address ${createdEventLog.args.escrow}. Using event address.`
        );
        actualEvmEscrowAddress = createdEventLog.args.escrow;
      }
    } catch (e: unknown) {
      let message = "Unknown error during EVM DstEscrow creation";
      if (e instanceof Error) message = e.message;
      simulationLog.push(`ERROR during EVM DstEscrow creation: ${message}`);
      throw e;
    }

    simulationLog.push(
      `Counterparty (EVM) lock ON-CHAIN successful. DstEscrow: ${actualEvmEscrowAddress}, TxHash: ${evmDstEscrowTxHash}`
    );
    // Confirm with Relayer
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "CONFIRM_COUNTERPARTY_LOCK",
      transactionHash: evmDstEscrowTxHash,
      chain: "EVM",
      escrowAddress: actualEvmEscrowAddress, // Also send the escrow address
    });
    simulationLog.push(`Counterparty (EVM) lock confirmed with Relayer.`);

    // 6. Simulate Initiator (Flow user) withdrawing from Counterparty's (EVM) lock ON-CHAIN
    simulationLog.push(
      "Step 4: Simulating Initiator withdrawing from EVM lock ON-CHAIN (revealing secret)..."
    );
    if (!actualEvmEscrowAddress) {
      throw new Error(
        "EVM DstEscrow address is not set, cannot proceed with withdrawal."
      );
    }
    // For DstEscrow, Taker is swapDetails.initiatorReceivingAddressOnOtherChain (flowUserEvmReceivingAddress).
    // We've set flowUserEvmReceivingAddress = signer.address, so the signer is the taker.
    // The original warning comparing signer.address to a Flow address was incorrect.
    // This log confirms the setup for withdrawal.
    simulationLog.push(
      `DstEscrow Taker is ${immutablesDst.taker}. EVM Signer is ${signer.address}. These must match for withdrawal.`
    );
    if (signer.address.toLowerCase() !== immutablesDst.taker.toLowerCase()) {
      // This should not happen given flowUserEvmReceivingAddress = signer.address
      throw new Error(
        `CRITICAL MISCONFIGURATION: EVM Signer (${signer.address}) does not match DstEscrow Taker (${immutablesDst.taker}). Withdrawal will fail.`
      );
    }

    const dstEscrowContract = new ethers.Contract(
      actualEvmEscrowAddress,
      MinimalEscrowDstAbi,
      signer
    );
    let initiatorWithdrawTxHashEvm: string;
    try {
      // Immutables for withdraw must match exactly those used for creation/addressOf
      // The 'timelocks' field for the struct should be the original packed offsets,
      // not including deployedAt. The contract's .get() method handles deployedAt.

      // --- START: Wait for EVM DstEscrow Withdrawal Timelock ---
      const withdrawalDelayMs =
        EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET * 1000 + 5000; // Offset in seconds * 1000 + 5s buffer
      simulationLog.push(
        `Waiting for DstEscrow withdrawal timelock to pass: ${EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET} seconds + 5s buffer. Waiting for ${
          withdrawalDelayMs / 1000
        }s...`
      );
      await new Promise((resolve) => setTimeout(resolve, withdrawalDelayMs));
      simulationLog.push(`Finished waiting for DstEscrow withdrawal timelock.`);
      // --- END: Wait for EVM DstEscrow Withdrawal Timelock ---

      simulationLog.push(
        `Attempting to withdraw from DstEscrow ${actualEvmEscrowAddress} with secret ${secret.substring(
          0,
          6
        )}... and immutables: ${JSON.stringify(immutablesDst, (k, v) =>
          typeof v === "bigint" ? v.toString() : v
        )}`
      );

      const calculatedHashlockFromSecret = ethers.keccak256("0x" + secret);
      if (calculatedHashlockFromSecret !== immutablesDst.hashlock) {
        throw new Error(
          `Hashlock mismatch: Secret hashes to ${calculatedHashlockFromSecret}, but escrow used ${immutablesDst.hashlock}`
        );
      }

      const withdrawTx = await dstEscrowContract.withdraw(
        "0x" + secret,
        immutablesDst
      );
      simulationLog.push(`Initiator EVM Withdraw Tx Sent: ${withdrawTx.hash}`);
      const withdrawReceipt = await withdrawTx.wait();
      if (!withdrawReceipt || withdrawReceipt.status !== 1) {
        throw new Error(
          `Initiator EVM withdrawal transaction failed. Hash: ${withdrawTx.hash}`
        );
      }
      initiatorWithdrawTxHashEvm = withdrawReceipt.transactionHash;
      simulationLog.push(
        `Initiator EVM Withdraw Tx Confirmed: ${initiatorWithdrawTxHashEvm}. GasUsed: ${withdrawReceipt.gasUsed.toString()}`
      );
    } catch (e: unknown) {
      let message = "Unknown error during Initiator EVM withdrawal";
      if (e instanceof Error) message = e.message;
      simulationLog.push(`ERROR during Initiator EVM withdrawal: ${message}`);
      throw e;
    }
    // Confirm with Relayer
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "INITIATE_WITHDRAWAL", // This action on relayer indicates secret is revealed
      secret: secret,
      transactionHash: initiatorWithdrawTxHashEvm,
      chain: "EVM", // Withdrawal happened on EVM
    });
    simulationLog.push(
      `Initiator withdrawal from EVM lock ON-CHAIN successful. Secret revealed. TxHash: ${initiatorWithdrawTxHashEvm}. Confirmed with Relayer.`
    );

    // 7. Simulate Counterparty (EVM user) withdrawing from Initiator's (Flow) lock (PUT)
    // This part remains simulated against the relayer as it involves Flow chain.
    simulationLog.push(
      "Step 5: Simulating Counterparty withdrawing from Flow lock (using revealed secret)..."
    );
    const counterpartyWithdrawTxHashFlowSim = `0xflowwithdrawtx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRelayer,
      action: "COUNTERPARTY_WITHDRAW", // Relayer action
      transactionHash: counterpartyWithdrawTxHashFlowSim,
      chain: "Flow", // Withdrawal happens on Flow
      // Secret is not explicitly sent here as relayer should have it from INITIATE_WITHDRAWAL
    });
    simulationLog.push(
      `Counterparty withdrawal from Flow lock confirmed (simulated). Swap COMPLETED. TxHash: ${counterpartyWithdrawTxHashFlowSim}`
    );

    simulationLog.push(
      "FLOW_TO_EVM swap simulation with ON-CHAIN EVM steps completed successfully!"
    );
    return NextResponse.json({
      success: true,
      log: simulationLog,
      swapId: swapIdFromRelayer,
      evmEscrowAddress: actualEvmEscrowAddress,
    });
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred during simulation.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    simulationLog.push(`Error during simulation: ${errorMessage}`);
    console.error("Simulation Error Details:", error);

    // ... (rest of your existing error handling and final state fetching) ...
    if (swapIdFromRelayer) {
      simulationLog.push(
        `Attempting to fetch final state of failed/partial swap ${swapIdFromRelayer}...`
      );
      try {
        const finalSwapState = await callRelayerApi(
          `?swapId=${swapIdFromRelayer}`,
          "GET"
        );
        simulationLog.push(
          `Final Swap State: ${JSON.stringify(finalSwapState, null, 2)}`
        );
      } catch (fetchError: unknown) {
        let message = "Unknown error fetching final swap state.";
        if (fetchError instanceof Error) message = fetchError.message;
        else if (typeof fetchError === "string") message = fetchError;
        simulationLog.push(`Could not fetch final swap state: ${message}`);
      }
    }
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
