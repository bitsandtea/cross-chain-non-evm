import * as fcl from "@onflow/fcl";
import * as fs from "fs";
import * as path from "path";

import { flowSigner } from "./flow-signer"; // Import the new signer

// const projectRoot = process.cwd(); // This resolves to .../relayer-app

// Construct the absolute path to flow.json
const flowJsonPath = path.resolve("./src/abis/flow.json");
const flowJSONFileContent = fs.readFileSync(flowJsonPath, "utf-8");
const flowJSON = JSON.parse(flowJSONFileContent);

// Configure FCL
// It's important to set this. Usually done once at the application's entry point.
// Ensure environment variables are available where this code runs.
fcl
  .config()
  .put(
    "accessNode.api",
    process.env.FLOW_ACCESS_NODE_API || "https://rest-testnet.onflow.org"
  )
  .put("flow.network", process.env.FLOW_NETWORK || "testnet") // "testnet", "mainnet", or "emulator"
  .load({ flowJSON });

interface CreateFooTokenHtlcArgs {
  receiverAddress: string;
  tokenSymbol: string; // e.g., "FOO" for FooToken
  amount: string; // UFix64 format, e.g., "10.0"
  hashOfSecret: string; // SHA256 hash of the secret
  timelockTimestamp: string; // Unix timestamp for the timelock, as UFix64 string
  htlcDeployerAddress: string; // Address where the HTLC contract is deployed
}

export async function createFooTokenHtlc(
  cadenceCode: string,
  args: CreateFooTokenHtlcArgs
): Promise<string> {
  console.log("Attempting to create FooToken HTLC with args:", args);

  if (
    !args.receiverAddress ||
    !args.tokenSymbol ||
    !args.amount ||
    !args.hashOfSecret ||
    !args.timelockTimestamp ||
    !args.htlcDeployerAddress
  ) {
    console.error("Missing one or more required arguments for HTLC creation.");
    throw new Error("Missing required arguments for createFooTokenHtlc.");
  }

  try {
    const transactionId = await fcl.mutate({
      cadence: cadenceCode,
      args: (arg: any, t_1: any) => [
        // Renamed t to t_1 to avoid conflict with the import alias
        arg(args.receiverAddress, t_1.Address),
        arg(args.tokenSymbol, t_1.String),
        arg(args.amount, t_1.UFix64),
        arg(args.hashOfSecret, t_1.String),
        arg(args.timelockTimestamp, t_1.UFix64),
        arg(args.htlcDeployerAddress, t_1.Address),
      ],
      payer: flowSigner,
      proposer: flowSigner,
      authorizations: [flowSigner],
      limit: 999,
    });

    console.log("Flow HTLC creation transaction sent, ID:", transactionId);
    return transactionId;
  } catch (error) {
    console.error("Error in createFooTokenHtlc:", error);
    throw error;
  }
}

// Add other Flow transaction functions here as needed
// e.g., withdrawFromHtlc, refundHtlc, etc.
