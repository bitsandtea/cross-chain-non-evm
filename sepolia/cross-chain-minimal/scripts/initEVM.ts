import { ethers } from "hardhat";
import { MinimalEscrowFactory as MinimalEscrowFactoryType } from "../typechain-types";
import { verifyContract } from "./verify/contract"; // Import the verifyContract function
// Removed MockBooTokenType import due to persistent linter issues.
// The script will rely on ethers.js dynamic typing for mockBooToken.

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Initializing contracts with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await ethers.provider.getBalance(deployer.address)).toString()
  );

  // 1. Deploy MinimalEscrowFactory
  const RESCUE_DELAY_SRC = 7 * 24 * 60 * 60; // 7 days in seconds
  const RESCUE_DELAY_DST = 7 * 24 * 60 * 60; // 7 days in seconds
  const factoryConstructorArgs = [RESCUE_DELAY_SRC, RESCUE_DELAY_DST];

  console.log("\nDeploying MinimalEscrowFactory...");
  const MinimalEscrowFactory = await ethers.getContractFactory(
    "MinimalEscrowFactory"
  );
  const factory = (await MinimalEscrowFactory.deploy(
    RESCUE_DELAY_SRC,
    RESCUE_DELAY_DST
  )) as MinimalEscrowFactoryType;
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("MinimalEscrowFactory deployed to:", factoryAddress);
  console.log(
    "  Source Escrow Implementation:",
    await factory.ESCROW_SRC_IMPLEMENTATION()
  );
  console.log(
    "  Destination Escrow Implementation:",
    await factory.ESCROW_DST_IMPLEMENTATION()
  );

  // 2. Deploy MockBooToken
  const tokenName = "Mock Boo Token";
  const tokenSymbol = "MBOO";
  const tokenConstructorArgs = [tokenName, tokenSymbol];

  console.log(`\nDeploying MockBooToken (${tokenName}, ${tokenSymbol})...`);
  const MockBooTokenFactory = await ethers.getContractFactory("MockBooToken");
  const mockBooToken = await MockBooTokenFactory.deploy(tokenName, tokenSymbol);
  await mockBooToken.waitForDeployment();
  const mockBooTokenAddress = await mockBooToken.getAddress();
  console.log(
    `MockBooToken (${tokenSymbol}) deployed to:`,
    mockBooTokenAddress
  );

  // 3. Mint tokens for the deployer
  const mintAmount = ethers.parseUnits("1000000", 18); // 1,000,000 tokens
  console.log(
    `\nMinting ${ethers.formatUnits(
      mintAmount,
      18
    )} ${tokenSymbol} to ${deployer.address}...`
  );
  // ethers.js will resolve .mint and .balanceOf at runtime
  const mintTx = await mockBooToken.mint(deployer.address, mintAmount);
  await mintTx.wait();
  console.log("Minting transaction successful. Hash:", mintTx.hash);

  // Verify balance
  const balance = await mockBooToken.balanceOf(deployer.address);
  console.log(
    `Deployer's ${tokenSymbol} balance: ${ethers.formatUnits(balance, 18)}`
  );

  console.log("\n--- Initialization Complete ---");
  console.log("Deployed Contracts:");
  console.log("  MinimalEscrowFactory:", factoryAddress);
  console.log(`  MockBooToken (${tokenSymbol}):`, mockBooTokenAddress);
  console.log("\nDeployed by account:", deployer.address);
  console.log(
    `  Current ${tokenSymbol} balance: ${ethers.formatUnits(balance, 18)}`
  );
  console.log("---");

  // Verify contracts on Etherscan if not on a local network
  console.log("\nStarting Etherscan verification process...");
  await verifyContract(factoryAddress, factoryConstructorArgs);

  // Wait 30 seconds before verifying the next contract
  console.log("Waiting 30 seconds before verifying the next contract...");
  await new Promise((resolve) => setTimeout(resolve, 30000));

  await verifyContract(mockBooTokenAddress, tokenConstructorArgs);
  console.log("Etherscan verification process attempted.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
