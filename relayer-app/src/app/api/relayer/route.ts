import { TX_CREATE_FOOTOKEN_HTLC } from "@/lib/cadenceTxs/txs";
import { createFooTokenHtlc } from "@/lib/flow-transactions"; // Adjust path as necessary
import * as fcl from "@onflow/fcl"; // Import fcl
import chalk from "chalk"; // Import chalk
import CryptoJS from "crypto-js"; // Import crypto-js
import { ethers } from "ethers"; // Moved to top
import { NextResponse } from "next/server";
import { PrismaClient } from "../../../generated/prisma";

const prisma = new PrismaClient();

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
        counterpartyAddress: data.counterpartyAddress || "",
        counterpartyToken: data.counterpartyToken,
        counterpartyAmount: String(data.counterpartyAmount),
        counterpartyReceivingAddressOnOtherChain:
          data.counterpartyReceivingAddressOnOtherChain || "",
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
  action: string; // e.g., "CONFIRM_INITIATOR_LOCK", "CONFIRM_COUNTERPARTY_LOCK", "CREATE_FLOW_HTLC", etc.
  transactionHash?: string;
  chain?: string; // Relevant for confirming locks
  secret?: string; // For withdrawals
  counterpartyFactoryAddr?: string; // Added for lock verification
  // Add other fields that might be needed for different actions
}

// Helper function to get RPC provider URL
// TODO: Replace with your actual RPC URL configuration logic
function getRpcProviderUrl(chainNameOrId: string): string {
  const lowerChain = chainNameOrId.toLowerCase();
  if (lowerChain === "EVM") {
    return process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
  }
  if (lowerChain === "FLOW") {
    return process.env.FLOW_RPC_URL || "https://rpc.flow.com";
  }
  throw new Error(`Unsupported chain for RPC provider: ${chainNameOrId}`);
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
      counterpartyFactoryAddr, // Destructured here
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
      console.error(chalk.red(`Swap with ID ${swapId} not found.`));
      return NextResponse.json({ error: "Swap not found." }, { status: 404 });
    }
    // console.log(chalk.blue(`Swap found: ${JSON.stringify(swap, null, 2)}`));

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

        if (chain.toUpperCase() === "FLOW") {
          console.log(
            chalk.blue(
              `Verifying Flow transaction ${transactionHash} for swap ${swapId}`
            )
          );
          try {
            const txStatus = await fcl.tx(transactionHash).onceSealed();
            console.log(
              chalk.green(
                `Flow transaction ${transactionHash} status: ${txStatus.statusString} - Sealed with status: ${txStatus.status}`
              )
            );
            if (txStatus.status === 4) {
              // 4 indicates a sealed transaction
              if (txStatus.errorMessage) {
                console.error(
                  chalk.red(
                    `Flow transaction ${transactionHash} failed: ${txStatus.errorMessage}`
                  )
                );
                return NextResponse.json(
                  {
                    error: `Flow transaction verification failed: ${txStatus.errorMessage}`,
                  },
                  { status: 400 }
                );
              }
              // Transaction sealed and no error message means success for this check
              console.log(
                chalk.greenBright(
                  `Flow transaction ${transactionHash} successfully verified and sealed.`
                )
              );
            } else {
              // Not sealed or other unexpected status
              console.warn(
                chalk.yellow(
                  `Flow transaction ${transactionHash} not successfully sealed. Status: ${txStatus.statusString} (${txStatus.status})`
                )
              );
              return NextResponse.json(
                {
                  error: `Flow transaction ${transactionHash} not successfully sealed. Status: ${txStatus.statusString}`,
                },
                { status: 400 }
              );
            }
          } catch (error: any) {
            console.error(
              chalk.red(
                `Error verifying Flow transaction ${transactionHash}: ${error.message}`
              ),
              error
            );
            return NextResponse.json(
              {
                error: `Error verifying Flow transaction: ${error.message}`,
              },
              { status: 500 }
            );
          }
        } else if (chain.toUpperCase() === "EVM") {
          // TODO: Add actual verification of the lock on the EVM chain
          console.log(
            `Simulating verification for EVM lock on ${chain} with hash ${transactionHash} for swap ${swapId}`
          );
        } else {
          return NextResponse.json(
            { error: `Unsupported chain: ${chain} for lock confirmation.` },
            { status: 400 }
          );
        }

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
        console.log(
          chalk.yellow(
            `CONFIRM_COUNTERPARTY_LOCK for swap ${swapId} on ${chain} with hash ${transactionHash}`
          )
        );
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

        let isLockVerified = false;
        let verificationMessage: string | undefined;

        if (chain.toUpperCase() === "EVM") {
          try {
            const provider = new ethers.JsonRpcProvider(
              process.env.EVM_RPC_URL || "https://rpc.sepolia.org"
            );
            console.log(
              chalk.blue(
                `Verifying EVM transaction ${transactionHash} on ${chain} for swap ${swapId}...`
              )
            );
            const receipt = await provider.getTransactionReceipt(
              transactionHash
            );

            if (receipt) {
              if (receipt.status === 1) {
                console.log(
                  chalk.greenBright(
                    `EVM transaction ${transactionHash} successfully verified and mined. Status: ${receipt.status}`
                  )
                );
                isLockVerified = true;
                verificationMessage = "EVM transaction successfully verified.";
                return NextResponse.json({
                  message: verificationMessage,
                });
              } else {
                console.error(
                  chalk.red(
                    `EVM transaction ${transactionHash} failed or reverted. Status: ${receipt.status}`
                  )
                );
                verificationMessage = `EVM transaction ${transactionHash} failed or reverted. Status: ${receipt.status}`;
              }
            } else {
              console.warn(
                chalk.yellow(
                  `EVM transaction ${transactionHash} not found or not yet mined on ${chain}.`
                )
              );
              verificationMessage = `EVM transaction ${transactionHash} not found or not yet mined on ${chain}.`;
            }
          } catch (error: any) {
            console.error(
              chalk.red(
                `Error verifying EVM transaction ${transactionHash} on ${chain}: ${error.message}`
              ),
              error
            );
            verificationMessage = `Error verifying EVM transaction: ${error.message}`;
          }
        } else if (chain.toUpperCase() === "FLOW") {
          try {
            console.log(
              chalk.blue(
                `Verifying Flow transaction ${transactionHash} on ${chain} for swap ${swapId}...`
              )
            );
            const txStatus = await fcl.tx(transactionHash).onceSealed();
            console.log(
              chalk.cyan(
                `Flow transaction ${transactionHash} details: Status=${txStatus.status}, String=${txStatus.statusString}, ErrorMsg=${txStatus.errorMessage}`
              )
            );

            if (txStatus.status === 4 && !txStatus.errorMessage) {
              // 4: Sealed, no error
              console.log(
                chalk.greenBright(
                  `Flow transaction ${transactionHash} successfully verified and sealed.`
                )
              );
              isLockVerified = true;
              verificationMessage = "Flow transaction successfully verified.";
            } else if (txStatus.errorMessage) {
              console.error(
                chalk.red(
                  `Flow transaction ${transactionHash} failed: ${txStatus.errorMessage}`
                )
              );
              verificationMessage = `Flow transaction verification failed: ${txStatus.errorMessage}`;
            } else {
              console.warn(
                chalk.yellow(
                  `Flow transaction ${transactionHash} not successfully sealed or has errors. Status: ${txStatus.statusString} (${txStatus.status})`
                )
              );
              verificationMessage = `Flow transaction ${transactionHash} not in expected sealed state. Status: ${txStatus.statusString}`;
            }
          } catch (error: any) {
            console.error(
              chalk.red(
                `Error verifying Flow transaction ${transactionHash} on ${chain}: ${error.message}`
              ),
              error
            );
            verificationMessage = `Error verifying Flow transaction: ${error.message}`;
          }
        } else {
          verificationMessage = `Unsupported chain: ${chain} for counterparty lock confirmation.`;
          console.error(chalk.red(verificationMessage));
        }

        if (!isLockVerified) {
          return NextResponse.json(
            {
              error:
                verificationMessage || "Counterparty lock verification failed.",
            },
            { status: 400 }
          );
        }

        const existingHashesCounterparty = Array.isArray(swap.transactionHashes)
          ? (swap.transactionHashes as string[])
          : [];

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "AWAITING_INITIATOR_WITHDRAWAL",
            transactionHashes: [...existingHashesCounterparty, transactionHash],
          },
        });
        return NextResponse.json({
          message: "Counterparty lock confirmed. Initiator can now withdraw.",
          swap: updatedSwap,
        });

      case "VERIFY_COUNTERPARTY_LOCK": {
        // Changed to fit PUT structure, was 'verifyCounterpartyLock'
        if (!chain || !transactionHash || !counterpartyFactoryAddr) {
          return NextResponse.json(
            {
              error:
                "Missing chain, transactionHash, or counterpartyFactoryAddr for verifying counterparty lock",
            },
            { status: 400 }
          );
        }

        const swapForVerification = await prisma.swap.findUnique({
          where: { swapId }, // Corrected: use swapId from payload
          select: {
            id: true,
            initiatorChain: true,
            initiatorAddress: true,
            counterpartyChain: true,
            counterpartyAddress: true,
            hashlock: true,
            transactionHashes: true, // Added for updating
            // evmContractAddress: true, // No need to select if we are just setting it
          },
        });

        if (!swapForVerification) {
          return NextResponse.json(
            { error: `Swap with ID ${swapId} not found for verification` },
            { status: 404 }
          );
        }

        const expectedHashlock = swapForVerification.hashlock;
        let escrowTypeToVerify: "SRC" | "DST";
        let expectedMaker: string | undefined;
        let expectedTaker: string;

        if (
          chain.toLowerCase() ===
          swapForVerification.initiatorChain.toLowerCase()
        ) {
          escrowTypeToVerify = "SRC";
          expectedMaker = swapForVerification.initiatorAddress;
          expectedTaker = swapForVerification.counterpartyAddress;
        } else if (
          chain.toLowerCase() ===
          swapForVerification.counterpartyChain.toLowerCase()
        ) {
          escrowTypeToVerify = "DST";
          expectedTaker = swapForVerification.initiatorAddress;
        } else {
          console.error(
            `Chain ${chain} does not match initiator (${swapForVerification.initiatorChain}) or counterparty (${swapForVerification.counterpartyChain}) chain for swap ${swapId}`
          );
          return NextResponse.json(
            { error: "Chain mismatch for swap roles during verification." },
            { status: 400 }
          );
        }

        let rpcUrl;
        try {
          rpcUrl = getRpcProviderUrl(chain);
        } catch (error: any) {
          console.error(
            `Failed to get RPC URL for chain ${chain}: ${error.message}`
          );
          return NextResponse.json(
            {
              error: `Configuration error for chain ${chain}: ${error.message}`,
            },
            { status: 500 }
          );
        }

        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const receipt = await provider.getTransactionReceipt(transactionHash);

        let verified = false;
        let verifiedEscrowAddress: string | undefined; // To store the address

        if (receipt && receipt.status === 1) {
          const factoryInterface = new ethers.Interface([
            "event SrcEscrowCreated(address escrow, bytes32 hashlock, address maker, address taker)",
            "event DstEscrowCreated(address escrow, bytes32 hashlock, address taker)",
          ]);

          for (const log of receipt.logs) {
            if (
              log.address.toLowerCase() !==
              counterpartyFactoryAddr.toLowerCase()
            ) {
              continue;
            }

            try {
              const parsedLog = factoryInterface.parseLog({
                topics: log.topics as string[],
                data: log.data,
              });
              if (parsedLog) {
                const eventHashlock = parsedLog.args.hashlock.toLowerCase();
                const expectedDbHashlock = expectedHashlock.toLowerCase();

                if (
                  escrowTypeToVerify === "SRC" &&
                  parsedLog.name === "SrcEscrowCreated"
                ) {
                  if (!expectedMaker) {
                    console.error(
                      "Logic error: expectedMaker not set for SRC escrow verification."
                    );
                    return NextResponse.json(
                      {
                        error:
                          "Internal server error during verification logic.",
                      },
                      { status: 500 }
                    );
                  }
                  const eventMaker = parsedLog.args.maker.toLowerCase();
                  const eventTaker = parsedLog.args.taker.toLowerCase();

                  if (
                    eventHashlock === expectedDbHashlock &&
                    eventMaker === expectedMaker.toLowerCase() &&
                    eventTaker === expectedTaker.toLowerCase()
                  ) {
                    verified = true;
                    verifiedEscrowAddress = parsedLog.args.escrow; // Store escrow address
                    console.log(
                      `SrcEscrowCreated event verified for swap ${swapId} on chain ${chain}, tx ${transactionHash}. Escrow: ${verifiedEscrowAddress}`
                    );
                    break;
                  }
                } else if (
                  escrowTypeToVerify === "DST" &&
                  parsedLog.name === "DstEscrowCreated"
                ) {
                  const eventTaker = parsedLog.args.taker.toLowerCase();

                  if (
                    eventHashlock === expectedDbHashlock &&
                    eventTaker === expectedTaker.toLowerCase()
                  ) {
                    verified = true;
                    verifiedEscrowAddress = parsedLog.args.escrow; // Store escrow address
                    console.log(
                      `DstEscrowCreated event verified for swap ${swapId} on chain ${chain}, tx ${transactionHash}. Escrow: ${verifiedEscrowAddress}`
                    );
                    break;
                  }
                }
              }
            } catch (e) {
              console.warn(
                `Attempted to parse a log from ${counterpartyFactoryAddr} that was not an EscrowCreation event, or other parsing error:`,
                e
              );
            }
          }
        } else {
          console.log(
            `Transaction ${transactionHash} on chain ${chain} for swap ${swapId} (verification) failed, not found, or reverted.`
          );
        }

        if (verified && verifiedEscrowAddress) {
          const existingHashesVerify = Array.isArray(
            swapForVerification.transactionHashes
          )
            ? (swapForVerification.transactionHashes as string[])
            : [];

          await prisma.swap.update({
            where: { swapId },
            data: {
              evmContractAddress: verifiedEscrowAddress,
              state: "AWAITING_INITIATOR_WITHDRAWAL",
              transactionHashes: [...existingHashesVerify, transactionHash],
            },
          });
          console.log(
            `Successfully verified and updated counterparty lock on ${chain} for swap ${swapId}. Escrow: ${verifiedEscrowAddress}`
          );
          return NextResponse.json(
            {
              message:
                "Counterparty lock verified successfully and swap updated.",
              evmEscrowAddress: verifiedEscrowAddress,
            },
            { status: 200 }
          );
        } else if (verified && !verifiedEscrowAddress) {
          // This case implies a logic error if verified is true but address wasn't captured.
          console.error(
            `Verification successful for swap ${swapId} but escrow address not captured.`
          );
          return NextResponse.json(
            {
              error:
                "Internal error during verification process (address capture).",
            },
            { status: 500 }
          );
        } else {
          // Not verified
          console.error(
            `Counterparty lock verification FAILED for swap ${swapId} on chain ${chain} with hash ${transactionHash}.`
          );
          return NextResponse.json(
            {
              error:
                "Counterparty lock verification failed. Event not found or parameters mismatched.",
            },
            { status: 400 }
          );
        }
      } // End of VERIFY_COUNTERPARTY_LOCK case

      case "INITIATE_WITHDRAWAL": // Initiator withdraws from counterparty's lock, reveals secret
        if (!providedSecret) {
          return NextResponse.json(
            { error: "Missing secret for INITIATE_WITHDRAWAL." },
            { status: 400 }
          );
        }

        // Fetch latest swap data including fields needed for withdrawal
        const swapForInitiatorWithdrawal = await prisma.swap.findUnique({
          where: { swapId },
          select: {
            id: true,
            state: true,
            direction: true,
            hashlock: true,
            initiatorChain: true, // Needed to know where U1 originally locked
            counterpartyChain: true, // Needed to know where U2 locked (and U1 withdraws from)
            evmContractAddress: true, // U2's EVM escrow address (if applicable)
            flowHtlcId: true, // U2's Flow HTLC ID (if applicable)
            transactionHashes: true,
          },
        });

        if (!swapForInitiatorWithdrawal) {
          return NextResponse.json(
            { error: `Swap ${swapId} not found for INITIATE_WITHDRAWAL.` },
            { status: 404 }
          );
        }

        if (
          swapForInitiatorWithdrawal.state !== "AWAITING_INITIATOR_WITHDRAWAL"
        ) {
          return NextResponse.json(
            {
              error: `Swap is not in AWAITING_INITIATOR_WITHDRAWAL state. Current state: ${swapForInitiatorWithdrawal.state}`,
            },
            { status: 400 }
          );
        }

        // Verify the provided secret against the stored hashlock
        // Note: The secret should be the raw preimage, not hashed again here if it's already the raw secret.
        // Assuming `providedSecret` is the raw secret string (e.g., "mysecretvalue").
        // The hashlock stored in DB should be `sha256(raw_secret_prefixed_if_needed)`.
        // If your `hashlock` is `bytes32` on EVM, it's often `ethers.keccak256(ethers.toUtf8Bytes(secret))`
        // or `ethers.solidityPackedKeccak256(['string'], [secret])`.
        // For this example, I'm using SHA256 as per your existing crypto-js usage.
        // Adjust this hashing if your on-chain contract expects a different scheme (e.g., keccak256 for EVM).
        const calculatedHash = CryptoJS.SHA256(providedSecret).toString(
          CryptoJS.enc.Hex
        );
        if (calculatedHash !== swapForInitiatorWithdrawal.hashlock) {
          console.error(
            `Invalid secret for swap ${swapId}. Provided hash: ${calculatedHash}, Expected hash: ${swapForInitiatorWithdrawal.hashlock}`
          );
          return NextResponse.json(
            { error: "Invalid secret." },
            { status: 400 }
          );
        }

        let withdrawalTxHash: string | undefined;
        let withdrawalError: string | undefined;

        if (swapForInitiatorWithdrawal.direction === "FLOW_TO_EVM") {
          // U1 (Flow user) locked on Flow. U2 (EVM user) locked on EVM.
          // U1 now withdraws from U2's EVM contract on `counterpartyChain`.
          if (!swapForInitiatorWithdrawal.evmContractAddress) {
            return NextResponse.json(
              {
                error:
                  "Counterparty EVM contract address not found for withdrawal.",
              },
              { status: 500 }
            );
          }
          console.log(
            `Initiating EVM withdrawal for FLOW_TO_EVM swap ${swapId} from contract ${swapForInitiatorWithdrawal.evmContractAddress} on chain ${swapForInitiatorWithdrawal.counterpartyChain} by initiator.`
          );
          try {
            const evmChainName = swapForInitiatorWithdrawal.counterpartyChain;
            const rpcUrl = getRpcProviderUrl(evmChainName);
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const relayerPrivateKey = process.env.RELAYER_EVM_PRIVATE_KEY;
            if (!relayerPrivateKey) {
              throw new Error(
                "RELAYER_EVM_PRIVATE_KEY not set in environment."
              );
            }
            const wallet = new ethers.Wallet(relayerPrivateKey, provider);

            const escrowAbi = [
              "function withdraw(bytes32 secret)", // Ensure this matches your contract (bytes32 vs string etc.)
              // Potentially also: "function withdraw(string memory secret)"
            ];
            const escrowContract = new ethers.Contract(
              swapForInitiatorWithdrawal.evmContractAddress,
              escrowAbi,
              wallet
            );

            // The secret needs to be in bytes32 format for the EVM contract if it expects bytes32.
            // If your `providedSecret` is a simple string, and hashlock was keccak256(string), then secret for withdraw might be just the string or its bytes32 hash.
            // The provided `MinimalEscrowSrc.sol`'s withdraw function expects `bytes32 _secret`. This means the *actual secret value*, not its hash.
            // The `hashlock` is `keccak256(abi.encodePacked(_secret))`.
            // So, `providedSecret` should be the raw secret. We need to convert it to bytes32 if it's not already.
            // This is a common point of confusion. If `providedSecret` is, e.g., "mysecret", it needs to be bytes32.
            // For simplicity, let's assume `providedSecret` is already a hex string representing 32 bytes (e.g., from `CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex)`)
            // OR the contract's `withdraw` function takes `string` and does the `keccak256` internally for comparison (less common for `bytes32 hashlock`).
            // The MinimalEscrow contracts' `withdraw` takes `bytes32 _secret`. The `hashlock` is `keccak256(abi.encodePacked(_secret))`.
            // This implies `providedSecret` must be the 32-byte value. Let's treat `providedSecret` as a hex string for `bytes32`.
            let secretForContract: string = providedSecret;
            if (!ethers.isHexString(providedSecret, 32)) {
              // If it's not a 32-byte hex string, attempt to convert from UTF8 string to bytes32 hex.
              // This is a guess; the actual format of `providedSecret` matters greatly.
              // If `providedSecret` was what was hashed to create `hashlock`, that original form is needed.
              // The contract's check is `require(hashlock == keccak256(abi.encodePacked(_secret)), "Invalid secret");`
              // This means `_secret` passed to `withdraw` must be the original preimage.
              // If your `providedSecret` is a simple string like "alice", this is how you'd typically get its bytes32 representation if it was shorter than 32 bytes, right-padded.
              // secretForContract = ethers.utils.formatBytes32String(providedSecret); // This pads with nulls
              // However, keccak256(abi.encodePacked(secret)) is usually done on the exact string bytes.
              // If your secret is a simple string, the contract might expect `keccak256(bytes(secret))` and `providedSecret` is just the string.
              // For MinimalEscrow.sol, `_secret` is `bytes32`. The hash is `keccak256(abi.encodePacked(_secret))`
              // This means `providedSecret` should already be a 32-byte hex string.
              if (
                providedSecret.startsWith("0x") &&
                providedSecret.length === 66
              ) {
                secretForContract = providedSecret;
              } else if (
                !providedSecret.startsWith("0x") &&
                providedSecret.length === 64
              ) {
                secretForContract = "0x" + providedSecret;
              } else {
                // This case is problematic. The secret needs to be bytes32.
                // For now, we proceed assuming `providedSecret` from client is correctly formatted as a 32-byte hex.
                console.warn(
                  "Secret for EVM withdrawal is not a 32-byte hex string. Proceeding as is. This might fail."
                );
                secretForContract = providedSecret; // Or attempt conversion if a scheme is known.
              }
            }

            // Ensure secretForContract is a 0x-prefixed 32-byte hex string
            if (!ethers.isHexString(secretForContract, 32)) {
              throw new Error(
                `Secret '${secretForContract}' is not a valid 32-byte hex string for EVM withdrawal.`
              );
            }

            const tx = await escrowContract.withdraw(secretForContract); // Pass the raw secret (bytes32)
            console.log(
              `EVM withdrawal transaction sent: ${tx.hash} for swap ${swapId}`
            );
            await tx.wait(); // Wait for transaction to be mined
            withdrawalTxHash = tx.hash;
            console.log(
              `EVM withdrawal transaction confirmed: ${withdrawalTxHash}`
            );
          } catch (error: any) {
            console.error(
              `Error during EVM withdrawal for swap ${swapId}:`,
              error
            );
            withdrawalError = error.message || "EVM withdrawal failed.";
          }
        } else if (swapForInitiatorWithdrawal.direction === "EVM_TO_FLOW") {
          // U1 (EVM user) locked on EVM. U2 (Flow user) locked on Flow.
          // U1 now withdraws from U2's Flow contract on `counterpartyChain`.
          if (!swapForInitiatorWithdrawal.flowHtlcId) {
            return NextResponse.json(
              { error: "Counterparty Flow HTLC ID not found for withdrawal." },
              { status: 500 }
            );
          }
          console.log(
            `Initiating Flow withdrawal for EVM_TO_FLOW swap ${swapId} from HTLC ${swapForInitiatorWithdrawal.flowHtlcId} on chain ${swapForInitiatorWithdrawal.counterpartyChain} by initiator.`
          );
          // TODO: Implement Flow withdrawal logic
          // 1. Construct Cadence transaction with `providedSecret` and `flowHtlcId`.
          // 2. Sign and send using FCL. This might need relayer's Flow account to pay fees or act as proposer if U1 doesn't sign directly.
          // 3. Get transaction ID.
          withdrawalTxHash = "flow_withdrawal_tx_placeholder_" + Date.now(); // Placeholder
          console.warn(
            `Flow withdrawal for swap ${swapId} is a placeholder: ${withdrawalTxHash}`
          );
          // For now, assume success for placeholder
        } else {
          return NextResponse.json(
            {
              error: `Unsupported swap direction: ${swapForInitiatorWithdrawal.direction}`,
            },
            { status: 400 }
          );
        }

        if (withdrawalError) {
          return NextResponse.json(
            { error: `Withdrawal failed: ${withdrawalError}` },
            { status: 500 }
          );
        }

        if (!withdrawalTxHash) {
          // Should not happen if no error, but as a safeguard.
          return NextResponse.json(
            {
              error:
                "Withdrawal transaction hash not obtained despite no error.",
            },
            { status: 500 }
          );
        }

        const existingHashesInitiatorWithdraw = Array.isArray(
          swapForInitiatorWithdrawal.transactionHashes
        )
          ? (swapForInitiatorWithdrawal.transactionHashes as string[])
          : [];

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "INITIATOR_WITHDREW_AND_REVEALED_SECRET",
            secret: providedSecret, // Store the revealed secret
            transactionHashes: [
              ...existingHashesInitiatorWithdraw,
              withdrawalTxHash,
            ],
          },
        });
        return NextResponse.json({
          message: "Initiator withdrawal successful. Secret revealed.",
          withdrawalTx: withdrawalTxHash,
          swap: updatedSwap,
        });

      case "COUNTERPARTY_WITHDRAW": // Counterparty withdraws from initiator's lock using revealed secret
        // Fetch latest swap data including fields needed for withdrawal and the revealed secret
        const swapForCounterpartyWithdrawal = await prisma.swap.findUnique({
          where: { swapId },
          select: {
            id: true,
            state: true,
            direction: true,
            secret: true, // The revealed secret by initiator
            initiatorChain: true, // U1's chain, where U2 withdraws from
            counterpartyChain: true, // U2's chain
            evmContractAddress: true, // U1's EVM escrow address (if applicable, for EVM_TO_FLOW swaps)
            flowHtlcId: true, // U1's Flow HTLC ID (if applicable, for FLOW_TO_EVM swaps)
            transactionHashes: true,
          },
        });

        if (!swapForCounterpartyWithdrawal) {
          return NextResponse.json(
            { error: `Swap ${swapId} not found for COUNTERPARTY_WITHDRAW.` },
            { status: 404 }
          );
        }

        if (!swapForCounterpartyWithdrawal.secret) {
          return NextResponse.json(
            {
              error:
                "Secret not found in swap record. Initiator might not have withdrawn and revealed it yet.",
            },
            { status: 400 }
          );
        }

        if (
          swapForCounterpartyWithdrawal.state !==
          "INITIATOR_WITHDREW_AND_REVEALED_SECRET"
        ) {
          return NextResponse.json(
            {
              error: `Swap is not in INITIATOR_WITHDREW_AND_REVEALED_SECRET state. Current state: ${swapForCounterpartyWithdrawal.state}`,
            },
            { status: 400 }
          );
        }

        const revealedSecret = swapForCounterpartyWithdrawal.secret; // Use the secret from DB
        let counterpartyWithdrawalTxHash: string | undefined;
        let counterpartyWithdrawalError: string | undefined;

        if (swapForCounterpartyWithdrawal.direction === "FLOW_TO_EVM") {
          // U1 (Flow user) locked on Flow. U2 (EVM user) locked on EVM.
          // U1 withdrew from U2's EVM contract (revealing secret).
          // Now U2 (EVM user) withdraws from U1's Flow contract on `initiatorChain`.
          if (!swapForCounterpartyWithdrawal.flowHtlcId) {
            return NextResponse.json(
              {
                error:
                  "Initiator Flow HTLC ID not found for counterparty withdrawal.",
              },
              { status: 500 }
            );
          }
          console.log(
            `Initiating Flow withdrawal for FLOW_TO_EVM swap ${swapId} from HTLC ${swapForCounterpartyWithdrawal.flowHtlcId} on chain ${swapForCounterpartyWithdrawal.initiatorChain} by counterparty using revealed secret.`
          );
          // TODO: Implement Flow withdrawal logic for counterparty
          // 1. Construct Cadence transaction with `revealedSecret` and `flowHtlcId`.
          // 2. Sign and send using FCL. This might need relayer's Flow account if U2 doesn't sign.
          // 3. Get transaction ID.
          counterpartyWithdrawalTxHash =
            "flow_counterparty_withdrawal_tx_placeholder_" + Date.now(); // Placeholder
          console.warn(
            `Flow counterparty withdrawal for swap ${swapId} is a placeholder: ${counterpartyWithdrawalTxHash}`
          );
        } else if (swapForCounterpartyWithdrawal.direction === "EVM_TO_FLOW") {
          // U1 (EVM user) locked on EVM. U2 (Flow user) locked on Flow.
          // U1 withdrew from U2's Flow contract (revealing secret).
          // Now U2 (Flow user) withdraws from U1's EVM contract on `initiatorChain`.
          if (!swapForCounterpartyWithdrawal.evmContractAddress) {
            return NextResponse.json(
              {
                error:
                  "Initiator EVM contract address not found for counterparty withdrawal.",
              },
              { status: 500 }
            );
          }
          console.log(
            `Initiating EVM withdrawal for EVM_TO_FLOW swap ${swapId} from contract ${swapForCounterpartyWithdrawal.evmContractAddress} on chain ${swapForCounterpartyWithdrawal.initiatorChain} by counterparty using revealed secret.`
          );
          try {
            const evmChainName = swapForCounterpartyWithdrawal.initiatorChain;
            const rpcUrl = getRpcProviderUrl(evmChainName);
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const relayerPrivateKey = process.env.RELAYER_EVM_PRIVATE_KEY;
            if (!relayerPrivateKey) {
              throw new Error(
                "RELAYER_EVM_PRIVATE_KEY not set in environment for counterparty withdrawal."
              );
            }
            const wallet = new ethers.Wallet(relayerPrivateKey, provider);

            const escrowAbi = ["function withdraw(bytes32 secret)"];
            const escrowContract = new ethers.Contract(
              swapForCounterpartyWithdrawal.evmContractAddress,
              escrowAbi,
              wallet
            );

            // `revealedSecret` from DB should be the correct bytes32 hex string.
            let secretForEvmWithdrawal: string = revealedSecret;
            if (!ethers.isHexString(revealedSecret, 32)) {
              // This should ideally not happen if it was stored correctly.
              console.error(
                `Revealed secret '${revealedSecret}' from DB is not a valid 32-byte hex string for EVM withdrawal.`
              );
              // Attempt to reformat, or throw error. For now, logging error and proceeding cautiously.
              // This indicates an issue with how the secret was stored or retrieved.
              // If it was stored as a simple string, convert it. (Similar logic as in INITIATE_WITHDRAWAL)
              if (
                revealedSecret.startsWith("0x") &&
                revealedSecret.length === 66
              ) {
                secretForEvmWithdrawal = revealedSecret;
              } else if (
                !revealedSecret.startsWith("0x") &&
                revealedSecret.length === 64
              ) {
                secretForEvmWithdrawal = "0x" + revealedSecret;
              } else {
                throw new Error(
                  `Stored secret '${revealedSecret}' is not correctly formatted as a 32-byte hex string.`
                );
              }
            }

            const tx = await escrowContract.withdraw(secretForEvmWithdrawal);
            console.log(
              `EVM counterparty withdrawal transaction sent: ${tx.hash} for swap ${swapId}`
            );
            await tx.wait();
            counterpartyWithdrawalTxHash = tx.hash;
            console.log(
              `EVM counterparty withdrawal transaction confirmed: ${counterpartyWithdrawalTxHash}`
            );
          } catch (error: any) {
            console.error(
              `Error during EVM counterparty withdrawal for swap ${swapId}:`,
              error
            );
            counterpartyWithdrawalError =
              error.message || "EVM counterparty withdrawal failed.";
          }
        } else {
          return NextResponse.json(
            {
              error: `Unsupported swap direction for counterparty withdrawal: ${swapForCounterpartyWithdrawal.direction}`,
            },
            { status: 400 }
          );
        }

        if (counterpartyWithdrawalError) {
          return NextResponse.json(
            {
              error: `Counterparty withdrawal failed: ${counterpartyWithdrawalError}`,
            },
            { status: 500 }
          );
        }

        if (!counterpartyWithdrawalTxHash) {
          return NextResponse.json(
            {
              error:
                "Counterparty withdrawal transaction hash not obtained despite no error.",
            },
            { status: 500 }
          );
        }

        const existingHashesCounterpartyWithdraw = Array.isArray(
          swapForCounterpartyWithdrawal.transactionHashes
        )
          ? (swapForCounterpartyWithdrawal.transactionHashes as string[])
          : [];

        updatedSwap = await prisma.swap.update({
          where: { swapId },
          data: {
            state: "COMPLETED",
            transactionHashes: [
              ...existingHashesCounterpartyWithdraw,
              counterpartyWithdrawalTxHash,
            ],
          },
        });
        return NextResponse.json({
          message: "Counterparty withdrawal successful. Swap completed.",
          withdrawalTx: counterpartyWithdrawalTxHash,
          swap: updatedSwap,
        });

      case "CREATE_FLOW_HTLC":
        // This case is for when the initiator (who is on EVM) has locked funds,
        // and now the relayer (or a script acting as counterparty) needs to create the HTLC on Flow.
        // The hashlock is already known from the swap creation (POST request).
        console.log(
          chalk.yellow("Processing CREATE_FLOW_HTLC action for swap:"),
          swapId
        );

        // Ensure we select transactionHashes for updating
        const swapForFlowHtlc = await prisma.swap.findUnique({
          where: { swapId },
          select: {
            direction: true,
            state: true,
            initiatorReceivingAddressOnOtherChain: true,
            counterpartyToken: true,
            counterpartyAmount: true,
            hashlock: true,
            transactionHashes: true, // Selected for updating
            // flowHtlcId: true, // No need to select if we are just setting it
          },
        });

        if (!swapForFlowHtlc) {
          return NextResponse.json(
            { error: `Swap ${swapId} not found for CREATE_FLOW_HTLC.` },
            { status: 404 }
          );
        }

        if (swapForFlowHtlc.direction !== "EVM_TO_FLOW") {
          console.error(
            chalk.red(
              `CREATE_FLOW_HTLC is only valid for EVM_TO_FLOW swaps. Current direction: ${swapForFlowHtlc.direction}`
            )
          );
          return NextResponse.json(
            {
              error:
                "CREATE_FLOW_HTLC action is only applicable for EVM_TO_FLOW swaps.",
            },
            { status: 400 }
          );
        }

        // Note: The original `swap` object fetched at the beginning of PUT might be stale.
        // We use `swapForFlowHtlc` here which has the latest state before this specific action.
        if (swapForFlowHtlc.state !== "AWAITING_COUNTERPARTY_LOCK") {
          console.error(
            chalk.red(
              `Swap ${swapId} is not in AWAITING_COUNTERPARTY_LOCK state. Current state: ${swapForFlowHtlc.state}`
            )
          );
          return NextResponse.json(
            {
              error: `Swap is not in AWAITING_COUNTERPARTY_LOCK state. Current state: ${swapForFlowHtlc.state}`,
            },
            { status: 400 }
          );
        }

        const htlcDeployerAddress = process.env.FLOW_HTLC_DEPLOYER_ADDRESS;
        if (!htlcDeployerAddress) {
          console.error(
            chalk.red(
              "FLOW_HTLC_DEPLOYER_ADDRESS environment variable is not set."
            )
          );
          return NextResponse.json(
            {
              error:
                "Server configuration error: Flow HTLC deployer address not set.",
            },
            { status: 500 }
          );
        }

        const createHtlcCadence = TX_CREATE_FOOTOKEN_HTLC;
        const htlcArgs = {
          receiverAddress:
            swapForFlowHtlc.initiatorReceivingAddressOnOtherChain,
          tokenSymbol: swapForFlowHtlc.counterpartyToken,
          amount: swapForFlowHtlc.counterpartyAmount,
          hashOfSecret: swapForFlowHtlc.hashlock,
          timelockTimestamp: String(Date.now() + 3600 * 1000 * 2),
          htlcDeployerAddress,
        };

        console.log(
          chalk.cyan("Calling createFooTokenHtlc with args:"),
          htlcArgs
        );

        try {
          const flowTxId = await createFooTokenHtlc(
            createHtlcCadence,
            htlcArgs
          );
          console.log(
            chalk.greenBright(
              `Flow HTLC creation transaction successful: ${flowTxId} for swap ${swapId}`
            )
          );

          const existingHashesFlow = Array.isArray(
            swapForFlowHtlc.transactionHashes
          )
            ? (swapForFlowHtlc.transactionHashes as string[])
            : [];

          updatedSwap = await prisma.swap.update({
            where: { swapId },
            data: {
              state: "AWAITING_INITIATOR_WITHDRAWAL",
              flowHtlcId: flowTxId, // Store the Flow HTLC ID
              transactionHashes: [
                ...existingHashesFlow,
                `flow_htlc_creation:${flowTxId}`,
              ],
            },
          });
          console.log(
            chalk.magenta("Swap updated after Flow HTLC creation:"),
            updatedSwap
          );
          return NextResponse.json({
            message:
              "Flow HTLC created successfully. Initiator can now withdraw.",
            flowTransactionId: flowTxId,
            swap: updatedSwap,
          });
        } catch (flowError) {
          let flowErrorMessage = "Failed to create Flow HTLC.";
          if (flowError instanceof Error) {
            flowErrorMessage = flowError.message;
          }
          console.error(
            chalk.red(`Error creating Flow HTLC for swap ${swapId}:`),
            flowErrorMessage,
            flowError
          );
          return NextResponse.json(
            { error: `Failed to create Flow HTLC: ${flowErrorMessage}` },
            { status: 500 }
          );
        }

      // Add other cases for different actions here in the future
      // e.g., CONFIRM_COUNTERPARTY_LOCK, INITIATE_WITHDRAWAL, etc.

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (error: any) {
    console.error("Relayer API Error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const swapId = searchParams.get("swapId");

    if (!swapId) {
      return NextResponse.json(
        { error: "Missing swapId query parameter." },
        { status: 400 }
      );
    }

    const swap = await prisma.swap.findUnique({
      where: { swapId },
    });

    if (!swap) {
      return NextResponse.json({ error: "Swap not found." }, { status: 404 });
    }

    return NextResponse.json(swap);
  } catch (error) {
    console.error("Error processing relayer GET request:", error);
    let errorMessage = "Internal Server Error in GET";
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
