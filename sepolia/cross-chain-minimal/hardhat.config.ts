import { HardhatUserConfig } from "hardhat/config";

import { config as dotenvConfig } from "dotenv";

import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import "@tableland/hardhat";

dotenvConfig();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: "0.8.30" }],
  },
  networks: {
    sepolia: {
      url: `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}` || "",
      chainId: 11155111,
      accounts: [process.env.DEPLOYER || ""],
    },
  },

  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API || "",
    },
  },
};

export default config;
