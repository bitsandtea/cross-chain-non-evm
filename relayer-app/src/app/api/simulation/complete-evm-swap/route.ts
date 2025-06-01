import { ethers, Interface, Log, LogDescription } from "ethers";
import { NextResponse } from "next/server";
import ERC20Abi from "../../../../abis/ERC20Abi.json";
import MinimalEscrowDstAbi from "../../../../abis/MinimalEscrowDst.json";
import MinimalEscrowFactoryAbi from "../../../../abis/MinimalEscrowFactory.json";

// Helper function to make API calls to our relayer
async function callRelayerApi(endpoint: string, method: string, body?: object) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/relayer${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
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

// Timelock constants - Should align with contract and cross-chain logic
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
  : 60; // 60 seconds
const EVM_SAFETY_DEPOSIT = process.env.EVM_SAFETY_DEPOSIT || "0.0001"; // In ETH

// Helper to pack timelocks
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

interface CompleteEvmSwapRequest {
  swapId: string;
  secret: string;
  hashlock: string;
  flowHtlcCancellationTimestamp: string; // BigInt as string
  // The full swap details object as returned by the first API
  fullSwapDetailsFromInitiate: {
    initiatorChain: string;
    initiatorAddress: string;
    initiatorToken: string;
    initiatorAmount: string;
    initiatorReceivingAddressOnOtherChain: string;
    counterpartyChain: string;
    counterpartyAddress: string; // EVM Locker (Bob's EVM Addr)
    counterpartyToken: string; // EVM Token (e.g. ZeroAddress)
    counterpartyAmount: string; // EVM Amount
    counterpartyReceivingAddressOnOtherChain: string;
    direction: string;
    hashlock: string;
  };
}

export async function POST(request: Request) {
  const simulationLog: string[] = [];
  let actualEvmEscrowAddress: string | null = null;
  let swapIdFromRequest: string | null = null;

  try {
    simulationLog.push(
      "[DEBUG] Entered POST /api/simulation/complete-evm-swap try block."
    );
    const body: CompleteEvmSwapRequest = await request.json();
    console.log(
      "[CONSOLE DEBUG] Body parsed successfully:",
      JSON.stringify(body).substring(0, 500)
    );
    swapIdFromRequest = body.swapId;
    simulationLog.push(
      `Starting COMPLETE_EVM_SWAP simulation (EVM-side actions) for Swap ID: ${swapIdFromRequest}...`
    );

    if (
      !signer ||
      !provider ||
      !MINIMAL_ESCROW_FACTORY_ADDRESS ||
      !body.swapId ||
      !body.secret ||
      !body.hashlock ||
      !body.flowHtlcCancellationTimestamp ||
      !body.fullSwapDetailsFromInitiate
    ) {
      throw new Error(
        "EVM environment not configured or missing required fields in request body."
      );
    }
    simulationLog.push(
      `Using EVM Signer: ${signer.address}, Factory: ${MINIMAL_ESCROW_FACTORY_ADDRESS}`
    );
    simulationLog.push(`Request Body: ${JSON.stringify(body)}`);

    const swapDetails = body.fullSwapDetailsFromInitiate;
    const secret = body.secret;
    const hashlock = body.hashlock;
    const flowHtlcCancellationTimestampBigInt = BigInt(
      body.flowHtlcCancellationTimestamp
    );

    // Log key addresses from swapDetails for clarity
    simulationLog.push(
      `EVM Locker (DstEscrow Maker): ${swapDetails.counterpartyAddress}`
    );
    simulationLog.push(
      `Flow User EVM Receiving Address (DstEscrow Taker): ${swapDetails.initiatorReceivingAddressOnOtherChain}`
    );

    // Ensure the Flow user's EVM receiving address is the current signer for withdrawal simulation
    simulationLog.push(
      `[DEBUG] Checking signer.address against initiatorReceivingAddressOnOtherChain.`
    );
    simulationLog.push(`[DEBUG] signer.address: ${signer.address}`);
    simulationLog.push(
      `[DEBUG] swapDetails.initiatorReceivingAddressOnOtherChain: ${swapDetails.initiatorReceivingAddressOnOtherChain}`
    );
    if (
      signer.address.toLowerCase() !==
      swapDetails.initiatorReceivingAddressOnOtherChain.toLowerCase()
    ) {
      throw new Error(
        `CRITICAL MISCONFIGURATION: EVM Signer (${signer.address}) ` +
          `must be the Flow user\'s EVM receiving address (${swapDetails.initiatorReceivingAddressOnOtherChain}) for DstEscrow.withdraw simulation.`
      );
    }

    // 1. Counterparty (EVM) locks funds ON-CHAIN
    simulationLog.push("Step 1: Counterparty (EVM) locking funds ON-CHAIN...");

    const factoryContract = new ethers.Contract(
      MINIMAL_ESCROW_FACTORY_ADDRESS,
      MinimalEscrowFactoryAbi,
      signer
    );

    const orderHash = ethers.keccak256(
      ethers.toUtf8Bytes(`flow-to-evm-swap-${swapIdFromRequest}`)
    );
    const safetyDepositWei = ethers.parseEther(EVM_SAFETY_DEPOSIT);
    const evmAmountWei = ethers.parseEther(swapDetails.counterpartyAmount);

    const erc20 = new ethers.Contract(
      swapDetails.counterpartyToken,
      ERC20Abi,
      signer
    );

    const balance = await erc20.balanceOf(signer.address);
    console.log("balance", balance);
    if (balance < evmAmountWei) {
      throw new Error(
        `Insufficient balance for ${swapDetails.counterpartyToken}. Balance: ${balance}, Required: ${evmAmountWei}`
      );
    }

    const allowance = await erc20.allowance(
      signer.address,
      MINIMAL_ESCROW_FACTORY_ADDRESS
    );
    console.log("allowance", allowance);
    if (allowance < evmAmountWei) {
      await erc20.approve(MINIMAL_ESCROW_FACTORY_ADDRESS, evmAmountWei);
    }

    const packedRelTimelocks = packTimelocks(
      FLOW_WITHDRAWAL_TIMELOCK_OFFSET,
      FLOW_CANCELLATION_TIMELOCK_OFFSET,
      EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET,
      EVM_DST_CANCELLATION_TIMELOCK_OFFSET
    );

    const immutablesDst: EvmImmutables = {
      orderHash: orderHash,
      hashlock: hashlock, // Use hashlock from request body
      maker: swapDetails.counterpartyAddress, // EVM Locker (Bob's EVM Addr)
      taker: swapDetails.initiatorReceivingAddressOnOtherChain, // Flow User's EVM Addr (Alice's EVM Addr, which is signer.address)
      token: swapDetails.counterpartyToken, // e.g. ZeroAddress for native ETH
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

      // Enhanced logging for debugging InvalidSafetyDeposit
      simulationLog.push(
        `[Debug Safety Deposit] EVM_SAFETY_DEPOSIT (string): "${EVM_SAFETY_DEPOSIT}"`
      );
      simulationLog.push(
        `[Debug Safety Deposit] swapDetails.counterpartyAmount (string): "${swapDetails.counterpartyAmount}"`
      );
      simulationLog.push(
        `[Debug Safety Deposit] swapDetails.counterpartyToken: "${
          swapDetails.counterpartyToken
        }" (Is Native: ${swapDetails.counterpartyToken === ethers.ZeroAddress})`
      );
      simulationLog.push(
        `[Debug Safety Deposit] safetyDepositWei (BigInt): ${safetyDepositWei.toString()}`
      );
      simulationLog.push(
        `[Debug Safety Deposit] evmAmountWei (BigInt): ${evmAmountWei.toString()}`
      );
      simulationLog.push(
        `[Debug Safety Deposit] totalValueToSend (BigInt for msg.value): ${totalValueToSend.toString()} (${ethers.formatEther(
          totalValueToSend
        )} ETH)`
      );
      simulationLog.push(
        `[Debug Safety Deposit] immutablesDst.safetyDeposit (BigInt): ${immutablesDst.safetyDeposit.toString()}`
      );
      simulationLog.push(
        `[Debug Safety Deposit] immutablesDst.amount (BigInt): ${immutablesDst.amount.toString()}`
      );

      console.log("[CONSOLE DEBUG] -------------------------------------");

      simulationLog.push(`Calling factory.createDstEscrow with arguments:`);
      simulationLog.push(
        `  - Immutables (for DstEscrow): ${JSON.stringify(
          immutablesDst,
          (k, v) => (typeof v === "bigint" ? v.toString() : v)
        )}`
      );
      simulationLog.push(
        `  - flowHtlcCancellationTimestampBigInt (arg for createDstEscrow): ${flowHtlcCancellationTimestampBigInt.toString()}`
      );
      simulationLog.push(
        `  - Transaction Value (msg.value): ${ethers.formatEther(
          totalValueToSend
        )} ETH (${totalValueToSend.toString()} wei)`
      );

      console.log("creatingDSTEscrow", immutablesDst);
      const tx = await factoryContract.createDstEscrow(
        immutablesDst,
        flowHtlcCancellationTimestampBigInt, // Use the timestamp from the request
        { value: totalValueToSend }
      );
      simulationLog.push(`createDstEscrow Tx Sent: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(
          `EVM DstEscrow creation transaction failed. Hash: ${tx.hash}`
        );
      }
      evmDstEscrowTxHash = receipt.hash; // Use receipt.hash
      simulationLog.push(
        `EVM DstEscrow Tx Confirmed: ${evmDstEscrowTxHash}. GasUsed: ${receipt.gasUsed.toString()}`
      );

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
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRequest,
      action: "CONFIRM_COUNTERPARTY_LOCK",
      transactionHash: evmDstEscrowTxHash,
      chain: "EVM",
      escrowAddress: actualEvmEscrowAddress,
    });
    simulationLog.push(`Counterparty (EVM) lock confirmed with Relayer.`);

    // 2. Initiator (Flow user) withdraws from Counterparty's (EVM) lock ON-CHAIN
    simulationLog.push(
      "Step 2: Initiator withdrawing from EVM lock ON-CHAIN (revealing secret)..."
    );
    if (!actualEvmEscrowAddress) {
      throw new Error(
        "EVM DstEscrow address is not set, cannot proceed with withdrawal."
      );
    }

    const dstEscrowContract = new ethers.Contract(
      actualEvmEscrowAddress,
      MinimalEscrowDstAbi,
      signer
    );
    let initiatorWithdrawTxHashEvm: string;
    try {
      const withdrawalDelayMs =
        EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET * 1000 + 5000;
      simulationLog.push(
        `Waiting for DstEscrow withdrawal timelock: ${EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET}s + 5s buffer. Waiting for ${
          withdrawalDelayMs / 1000
        }s...`
      );
      await new Promise((resolve) => setTimeout(resolve, withdrawalDelayMs));
      simulationLog.push(`Finished waiting for DstEscrow withdrawal timelock.`);

      simulationLog.push(
        `Attempting to withdraw from DstEscrow ${actualEvmEscrowAddress} with secret ${secret.substring(
          0,
          6
        )}... and immutables: ${JSON.stringify(immutablesDst, (k, v) =>
          typeof v === "bigint" ? v.toString() : v
        )}`
      );

      const withdrawTx = await dstEscrowContract.withdraw(
        "0x" + secret, // Use secret from request body, 0x-prefixed
        immutablesDst
      );
      simulationLog.push(`Initiator EVM Withdraw Tx Sent: ${withdrawTx.hash}`);
      const withdrawReceipt = await withdrawTx.wait();
      if (!withdrawReceipt || withdrawReceipt.status !== 1) {
        throw new Error(
          `Initiator EVM withdrawal transaction failed. Hash: ${withdrawTx.hash}`
        );
      }
      initiatorWithdrawTxHashEvm = withdrawReceipt.hash; // Use receipt.hash
      simulationLog.push(
        `Initiator EVM Withdraw Tx Confirmed: ${initiatorWithdrawTxHashEvm}. GasUsed: ${withdrawReceipt.gasUsed.toString()}`
      );
    } catch (e: unknown) {
      let message = "Unknown error during Initiator EVM withdrawal";
      if (e instanceof Error) message = e.message;
      simulationLog.push(`ERROR during Initiator EVM withdrawal: ${message}`);
      throw e;
    }
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRequest,
      action: "INITIATE_WITHDRAWAL",
      secret: secret, // Reveal the secret
      transactionHash: initiatorWithdrawTxHashEvm,
      chain: "EVM",
    });
    simulationLog.push(
      `Initiator withdrawal from EVM lock ON-CHAIN successful. Secret revealed. TxHash: ${initiatorWithdrawTxHashEvm}. Confirmed with Relayer.`
    );

    // 3. Simulate Counterparty (EVM user) withdrawing from Initiator's (Flow) lock
    simulationLog.push(
      "Step 3: Simulating Counterparty withdrawing from Flow lock (using revealed secret)..."
    );
    const counterpartyWithdrawTxHashFlowSim = `0xflowwithdrawtx_sim_${Date.now()}`;
    await callRelayerApi("", "PUT", {
      swapId: swapIdFromRequest,
      action: "COUNTERPARTY_WITHDRAW",
      transactionHash: counterpartyWithdrawTxHashFlowSim,
      chain: "Flow",
    });
    simulationLog.push(
      `Counterparty withdrawal from Flow lock confirmed (simulated). Swap COMPLETED. TxHash: ${counterpartyWithdrawTxHashFlowSim}`
    );

    simulationLog.push(
      "COMPLETE_EVM_SWAP simulation with ON-CHAIN EVM steps completed successfully!"
    );
    return NextResponse.json({
      success: true,
      log: simulationLog,
      swapId: swapIdFromRequest,
      evmEscrowAddress: actualEvmEscrowAddress,
      evmLockTxHash: evmDstEscrowTxHash,
      evmWithdrawTxHash: initiatorWithdrawTxHashEvm,
    });
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred during EVM completion.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    simulationLog.push(`Error during EVM completion: ${errorMessage}`);
    console.error("EVM Completion Error Details:", error);

    if (swapIdFromRequest) {
      simulationLog.push(
        `Attempting to fetch final state of failed/partial swap ${swapIdFromRequest}...`
      );
      try {
        const finalSwapState = await callRelayerApi(
          `?swapId=${swapIdFromRequest}`,
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
        swapId: swapIdFromRequest,
      },
      { status: 500 }
    );
  }
}
