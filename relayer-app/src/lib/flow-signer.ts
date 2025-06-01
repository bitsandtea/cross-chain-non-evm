import { sansPrefix, withPrefix } from "@onflow/fcl";
import elliptic from "elliptic";
import { SHA3 } from "sha3";

const ec = new elliptic.ec("p256");

const hashMessageHex = (msgHex: string): Buffer => {
  const sha = new SHA3(256);
  sha.update(Buffer.from(msgHex, "hex"));
  return sha.digest();
};

const signWithKey = (privateKeyHex: string, msgHex: string): string => {
  const key = ec.keyFromPrivate(Buffer.from(privateKeyHex, "hex"));
  const sig = key.sign(hashMessageHex(msgHex));
  const n = 32; // Byte length of r and s
  const r = sig.r.toArrayLike(Buffer, "be", n);
  const s = sig.s.toArrayLike(Buffer, "be", n);
  return Buffer.concat([r, s]).toString("hex");
};

interface Signable {
  message: string;
  // other fields if necessary, but message is the key for signing
}

interface SignedOutput {
  addr: string;
  keyId: number;
  signature: string;
}

export const flowSigner = async (account: unknown) => {
  // account param is part of FCL's signer interface, but might not be fully used here if address is from env
  const accountAddress = process.env.FLOW_SIGNER_ADDRESS;
  const privateKey = process.env.FLOW_PRIVATE_KEY;
  const keyId = process.env.FLOW_SIGNER_KEY_ID
    ? parseInt(process.env.FLOW_SIGNER_KEY_ID, 10)
    : 0;

  if (!accountAddress) {
    throw new Error("FLOW_SIGNER_ADDRESS environment variable is not set.");
  }
  if (!privateKey) {
    throw new Error("FLOW_PRIVATE_KEY environment variable is not set.");
  }
  if (isNaN(keyId)) {
    throw new Error(
      "FLOW_SIGNER_KEY_ID environment variable is not a valid number."
    );
  }

  return {
    ...(typeof account === "object" && account !== null ? account : {}), // Spread account if it's an object
    tempId: `${sansPrefix(accountAddress)}-${keyId}`,
    addr: sansPrefix(accountAddress),
    keyId: Number(keyId),
    signingFunction: async (signable: Signable): Promise<SignedOutput> => {
      if (!signable.message) {
        throw new Error("Missing message to sign");
      }
      const signature = signWithKey(privateKey, signable.message);
      return {
        addr: withPrefix(accountAddress),
        keyId: Number(keyId),
        signature,
      };
    },
  };
};

// Ensure FCL config is set up somewhere, typically once at application start or before first FCL call.
// For example, in your main transaction handling file or a shared FCL setup:
// import { config } from "@onflow/fcl";
// config({
//   "accessNode.api": process.env.FLOW_ACCESS_NODE_API || "https://rest-testnet.onflow.org", // Or your mainnet/emulator endpoint
//   "discovery.wallet": "https://fcl-discovery.onflow.org/testnet/authn", // Optional: For discovery if needed, less relevant for backend signing
// });
