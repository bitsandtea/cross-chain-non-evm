import { ethers } from "hardhat";

async function main() {
  const RESCUE_DELAY_SRC = 3600; // 7 days in seconds
  const RESCUE_DELAY_DST = 7200; // 7 days in seconds

  const MinimalEscrowFactory = await ethers.getContractFactory(
    "MinimalEscrowFactory"
  );
  const factory = await MinimalEscrowFactory.deploy(
    RESCUE_DELAY_SRC,
    RESCUE_DELAY_DST
  );

  await factory.waitForDeployment();

  console.log("MinimalEscrowFactory deployed to:", await factory.getAddress());
  console.log(
    "Source Escrow Implementation:",
    await factory.ESCROW_SRC_IMPLEMENTATION()
  );
  console.log(
    "Destination Escrow Implementation:",
    await factory.ESCROW_DST_IMPLEMENTATION()
  );

  // Example timelock periods (in seconds from deployment)
  // These are short for demonstration purposes.
  // --- Source Chain Timelocks (Escrow funded by Maker) ---
  // SRC_WITHDRAWAL: Time window for the Taker to withdraw funds from the source escrow using the secret.
  const SRC_WITHDRAWAL = 1 * 60; // 1 minute
  // SRC_PUBLIC_WITHDRAWAL: Extended window for withdrawal from source escrow, potentially by other authorized parties or publicly.
  const SRC_PUBLIC_WITHDRAWAL = 2 * 60; // 2 minutes
  // SRC_CANCELLATION: Time after which the Maker can cancel the source escrow and reclaim funds if the Taker hasn't withdrawn.
  const SRC_CANCELLATION = 3 * 60; // 3 minutes
  // SRC_PUBLIC_CANCELLATION: Longer period after which anyone can trigger cancellation of the source escrow if unresolved, returning funds to Maker.
  const SRC_PUBLIC_CANCELLATION = 4 * 60; // 4 minutes

  // --- Destination Chain Timelocks (Escrow funded by Taker) ---
  // DST_WITHDRAWAL: Time window for the Maker to withdraw funds from the destination escrow using the secret (revealed by Taker's source withdrawal).
  const DST_WITHDRAWAL = 45; // 45 seconds
  // DST_PUBLIC_WITHDRAWAL: Extended window for withdrawal from destination escrow by the Maker.
  const DST_PUBLIC_WITHDRAWAL = 1 * 90; // 1.5 minutes
  // DST_CANCELLATION: Time after which the Taker can cancel the destination escrow and reclaim funds if the Maker hasn't withdrawn.
  const DST_CANCELLATION = 2 * 60 + 30; // 2.5 minutes

  console.log("\n=== Example HTLC Usage ===");

  // Example secret and hashlock
  const secret = ethers.keccak256(ethers.toUtf8Bytes("my_secret_phrase"));
  const hashlock = ethers.keccak256(ethers.toBeArray(secret));

  console.log("Example Secret (keccak256('my_secret_phrase')):");
  console.log(secret);
  console.log("Example Hashlock (keccak256(secret)):");
  console.log(hashlock);

  // Example addresses (replace with real addresses or get deployer/signer)
  const [deployer] = await ethers.getSigners();
  const maker = deployer.address; // Using deployer as an example
  const taker = ethers.getAddress("0x9876543210987654321098765432109876543210"); // Example taker
  const token = ethers.ZeroAddress; // ETH
  const amount = ethers.parseEther("1");
  const safetyDeposit = ethers.parseEther("0.1");

  // Pack timelocks
  // Format: [deployedAt:32][dstCancellation:32][dstPublicWithdrawal:32][dstWithdrawal:32][srcPublicCancellation:32][srcCancellation:32][srcPublicWithdrawal:32][srcWithdrawal:32]
  let packedTimelocks = BigInt(0);
  packedTimelocks |= BigInt(SRC_WITHDRAWAL);
  packedTimelocks |= BigInt(SRC_PUBLIC_WITHDRAWAL) << BigInt(32);
  packedTimelocks |= BigInt(SRC_CANCELLATION) << BigInt(64);
  packedTimelocks |= BigInt(SRC_PUBLIC_CANCELLATION) << BigInt(96);
  packedTimelocks |= BigInt(DST_WITHDRAWAL) << BigInt(128);
  packedTimelocks |= BigInt(DST_PUBLIC_WITHDRAWAL) << BigInt(160);
  packedTimelocks |= BigInt(DST_CANCELLATION) << BigInt(192);

  const immutables = {
    orderHash: ethers.keccak256(ethers.toUtf8Bytes("example_order")),
    hashlock: hashlock,
    maker: maker,
    taker: taker,
    token: token,
    amount: amount,
    safetyDeposit: safetyDeposit,
    timelocks: packedTimelocks,
  };

  const srcEscrowAddr = await factory.addressOfEscrowSrc(immutables);
  const dstEscrowAddr = await factory.addressOfEscrowDst(immutables);

  console.log("\nExample Escrow Addresses:");
  console.log("Source Escrow Address:", srcEscrowAddr);
  console.log("Destination Escrow Address:", dstEscrowAddr);

  console.log("\nTo create source escrow, call:");
  console.log(
    `factory.createSrcEscrow(immutables) with ${ethers.formatEther(amount + safetyDeposit)} ETH`
  );

  console.log("\nTo create destination escrow, call:");
  // Note: srcCancellationTimestamp needs to be calculated based on actual source escrow creation time for a real scenario
  const exampleSrcCancellationTimestamp =
    Math.floor(Date.now() / 1000) + SRC_CANCELLATION;
  console.log(
    `factory.createDstEscrow(immutables, ${exampleSrcCancellationTimestamp}) with ${ethers.formatEther(amount + safetyDeposit)} ETH`
  );

  console.log("\nHTLC Workflow:");
  console.log("1. Maker creates source escrow with tokens");
  console.log("2. Taker creates destination escrow with tokens");
  console.log("3. Taker withdraws from source escrow with secret");
  console.log(
    "4. Maker withdraws from destination escrow with revealed secret"
  );
  console.log("5. Or after timelock expires, funds can be cancelled/refunded");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
