import { ethers } from "ethers";
import { NextResponse } from "next/server";
import MinimalEscrowDstAbi from "../../../../abis/MinimalEscrowDst.json";
import { callRelayerApi } from "../../../../lib/relayerApi"; // Corrected path

// EVM Configuration
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY; // This should be the Flow user's (U1) private key for withdrawal

const provider = EVM_RPC_URL ? new ethers.JsonRpcProvider(EVM_RPC_URL) : null;
const signer =
  EVM_PRIVATE_KEY && provider
    ? new ethers.Wallet(EVM_PRIVATE_KEY, provider)
    : null;

// Timelock constants (durations in seconds) - Copied from flow-to-evm for packTimelocks
// These might be fetchable from the swap details or contract state in a real scenario
const FLOW_WITHDRAWAL_TIMELOCK_OFFSET = process.env
  .FLOW_WITHDRAWAL_TIMELOCK_OFFSET
  ? parseInt(process.env.FLOW_WITHDRAWAL_TIMELOCK_OFFSET)
  : 100;
const FLOW_CANCELLATION_TIMELOCK_OFFSET = process.env
  .FLOW_CANCELLATION_TIMELOCK_OFFSET
  ? parseInt(process.env.FLOW_CANCELLATION_TIMELOCK_OFFSET)
  : 100;
const EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET = process.env
  .EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET
  ? parseInt(process.env.EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET)
  : 100;
const EVM_DST_CANCELLATION_TIMELOCK_OFFSET = process.env
  .EVM_DST_CANCELLATION_TIMELOCK_OFFSET
  ? parseInt(process.env.EVM_DST_CANCELLATION_TIMELOCK_OFFSET)
  : 200;
const EVM_SAFETY_DEPOSIT = process.env.EVM_SAFETY_DEPOSIT || "0.0001";

// Helper to pack timelocks for IBaseEscrow.Immutables
// Ensure this matches the one used during DstEscrow creation
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
  maker: string; // EVM Locker (Bob)
  taker: string; // Flow User's EVM address (Alice)
  token: string;
  amount: ethers.BigNumberish;
  safetyDeposit: ethers.BigNumberish;
  timelocks: ethers.BigNumberish; // Packed timelocks (offsets)
}

export async function POST(request: Request) {
  const log: string[] = [];
  try {
    log.push(
      "Received request to withdraw from EVM escrow (U1/Flow User action)..."
    );

    if (!signer || !provider) {
      throw new Error(
        "EVM environment not configured for withdrawal. Check EVM_RPC_URL and EVM_PRIVATE_KEY (should be U1's key)."
      );
    }
    log.push(`Using EVM Signer for withdrawal: ${signer.address}`);

    const { swapId, secret } = await request.json();

    if (!swapId || !secret) {
      throw new Error("Missing swapId or secret in the request body.");
    }
    log.push(`Swap ID: ${swapId}, Secret: ${secret.substring(0, 6)}...`);

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
    if (!swapDetails.evmEscrowAddress) {
      throw new Error(
        `EVM Escrow address not found in swap details for ${swapId}.`
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

    const evmEscrowAddress = swapDetails.evmEscrowAddress;
    log.push(`Target EVM DstEscrow Address: ${evmEscrowAddress}`);

    // Reconstruct Immutables for the DstEscrow.withdraw call
    // These must match exactly what was used to create the DstEscrow.
    // The relayer should store/provide all necessary fields for this.

    const orderHash = ethers.keccak256(
      ethers.toUtf8Bytes(`flow-to-evm-swap-${swapId}`) // Ensure this matches the original orderHash generation
    );
    const safetyDepositWei = ethers.parseEther(EVM_SAFETY_DEPOSIT); // This should ideally come from swapDetails or be consistent
    const evmAmountWei = ethers.parseEther(swapDetails.counterpartyAmount); // Amount locked by counterparty

    // Critical: The 'taker' for DstEscrow is the Flow user's EVM address
    // The 'maker' is the EVM user who locked funds.
    // The current signer MUST be the 'taker'.
    if (
      signer.address.toLowerCase() !==
      swapDetails.initiatorReceivingAddressOnOtherChain.toLowerCase()
    ) {
      throw new Error(
        `Signer address ${signer.address} does not match the DstEscrow taker address ${swapDetails.initiatorReceivingAddressOnOtherChain}. Ensure EVM_PRIVATE_KEY is for the Flow user (U1).`
      );
    }

    const packedRelTimelocks = packTimelocks(
      FLOW_WITHDRAWAL_TIMELOCK_OFFSET,
      FLOW_CANCELLATION_TIMELOCK_OFFSET,
      EVM_DST_WITHDRAWAL_TIMELOCK_OFFSET,
      EVM_DST_CANCELLATION_TIMELOCK_OFFSET
    );

    const immutablesDst: EvmImmutables = {
      orderHash: orderHash,
      hashlock: swapDetails.hashlock, // Use hashlock from fetched swap details
      maker: swapDetails.counterpartyAddress, // EVM Locker (Bob's EVM Addr)
      taker: swapDetails.initiatorReceivingAddressOnOtherChain, // Flow User's EVM Addr (Alice's EVM Addr, which is signer.address)
      token: swapDetails.counterpartyToken, // Should be ZeroAddress if native ETH
      amount: evmAmountWei,
      safetyDeposit: safetyDepositWei,
      timelocks: packedRelTimelocks, // Packed original offsets
    };
    log.push(
      `Reconstructed DstEscrow Immutables: ${JSON.stringify(
        immutablesDst,
        (k, v) => (typeof v === "bigint" ? v.toString() : v)
      )}`
    );

    // Verify secret against hashlock stored in swap details
    const calculatedHashlockFromSecret = ethers.keccak256("0x" + secret);
    if (calculatedHashlockFromSecret !== swapDetails.hashlock) {
      throw new Error(
        `Hashlock mismatch: Provided secret hashes to ${calculatedHashlockFromSecret}, but swap details hashlock is ${swapDetails.hashlock}. Incorrect secret?`
      );
    }
    log.push("Secret successfully verified against swap's hashlock.");

    // 2. Interact with DstEscrow contract
    const dstEscrowContract = new ethers.Contract(
      evmEscrowAddress,
      MinimalEscrowDstAbi,
      signer
    );

    let withdrawTxHash: string;
    try {
      // Optional: Check if withdrawal window is open based on contract state + timelocks
      // const { deployedAt, timelocks: contractTimelocks } = await dstEscrowContract.get();
      // const currentBlock = await provider.getBlock("latest");
      // if (!currentBlock) throw new Error("Could not get current EVM block.");
      // const currentTime = currentBlock.timestamp;
      // const withdrawalWindowStart = deployedAt + (contractTimelocks.dstWithdrawalOffset); // Pseudocode for unpacking
      // if (currentTime < withdrawalWindowStart) {
      //   log.push(`Withdrawal window not yet open. Current: ${new Date(currentTime * 1000).toISOString()}, Opens: ${new Date(withdrawalWindowStart * 1000).toISOString()}`);
      //   // For simulation, we might proceed or wait. For real endpoint, throw error.
      //   // Adding a small delay here for simulation if it's close, like in flow-to-evm route
      //    const delayNeeded = (withdrawalWindowStart - currentTime + 5) * 1000; // +5s buffer
      //    if (delayNeeded > 0) {
      //        log.push(`Waiting for ${delayNeeded/1000}s for withdrawal window to open...`);
      //        await new Promise(resolve => setTimeout(resolve, delayNeeded));
      //    }
      // }

      log.push(
        `Attempting to call withdraw on DstEscrow ${evmEscrowAddress} with secret 0x${secret.substring(
          0,
          6
        )}...`
      );
      const tx = await dstEscrowContract.withdraw(
        "0x" + secret,
        immutablesDst // Pass the fully reconstructed immutables
      );
      log.push(`EVM Withdraw Tx Sent: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(
          `EVM withdrawal transaction failed or reverted. Hash: ${tx.hash}`
        );
      }
      withdrawTxHash = receipt.hash; // Corrected from receipt.transactionHash to receipt.hash
      log.push(
        `EVM Withdraw Tx Confirmed: ${withdrawTxHash}. GasUsed: ${receipt.gasUsed.toString()}`
      );
    } catch (e: unknown) {
      let message = "Unknown error during EVM withdrawal from DstEscrow";
      if (e instanceof Error) message = e.message;
      log.push(`ERROR during EVM withdrawal: ${message}`);
      // Try to fetch contract state or revert reason if possible
      // For example, if (e.revert) log.push(e.revert.args)
      throw e;
    }

    // 3. Confirm withdrawal with Relayer
    log.push(`Confirming EVM withdrawal with Relayer for swap ${swapId}...`);
    await callRelayerApi("", "PUT", {
      swapId: swapId,
      action: "COMPLETE_SWAP_WITHDRAW_EVM", // New relayer action or use existing if suitable
      transactionHash: withdrawTxHash,
      chain: "EVM",
      secret: secret, // Send secret so relayer knows it and can mark swap as fully complete if Flow side also done
    });
    log.push(
      `EVM withdrawal confirmed with Relayer. TxHash: ${withdrawTxHash}.`
    );

    log.push("EVM withdrawal (U1/Flow User action) completed successfully!");
    return NextResponse.json({
      success: true,
      message: "EVM withdrawal successful",
      log: log,
      evmWithdrawTxHash: withdrawTxHash,
    });
  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred during EVM withdrawal.";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    log.push(`Error during EVM withdrawal simulation: ${errorMessage}`);
    console.error("EVM Withdrawal Error Details:", error);

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
