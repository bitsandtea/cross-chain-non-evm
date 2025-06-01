import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { EventLog } from "ethers"; // Import EventLog, Contract is not needed if token is any
import { ethers } from "hardhat";
import { MinimalEscrowFactory } from "../typechain-types"; // Adjust if your typechain output is different

describe("MinimalEscrowFactory", function () {
  let factory: MinimalEscrowFactory;
  let deployer: SignerWithAddress;
  let maker: SignerWithAddress;
  let taker: SignerWithAddress;
  let otherAccount: SignerWithAddress;
  let token: any; // Declare token with any type

  const RESCUE_DELAY_SRC = 3600; // 1 hour
  const RESCUE_DELAY_DST = 7200; // 2 hours

  beforeEach(async function () {
    [deployer, maker, taker, otherAccount] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MinimalEscrowFactory");
    factory = await Factory.deploy(RESCUE_DELAY_SRC, RESCUE_DELAY_DST);
    await factory.waitForDeployment();

    const MockERC20Factory = await ethers.getContractFactory("MockBooToken");
    token = await MockERC20Factory.deploy("Test Token", "TST");
    await token.waitForDeployment();
  });

  describe("createDstEscrow", function () {
    it("should create a destination escrow with an ERC20 token", async function () {
      const tokenAddress = await token.getAddress();
      const amount = ethers.parseEther("100");
      const safetyDeposit = ethers.parseEther("1");

      await token.mint(taker.address, amount); // No need for `as any` if token is `any`
      await token.connect(taker).approve(await factory.getAddress(), amount); // No need for `as any` if token.connect() returns `any` or compatible

      const orderHash = ethers.randomBytes(32);
      const hashlock = ethers.randomBytes(32);
      const srcCancellationTimestamp = Math.floor(Date.now() / 1000) + 3600;

      let packedTimelocks = 0n;
      const dstWithdrawalDelay = 100;
      const dstPublicWithdrawalDelay = 200;
      const dstCancellationDelay = 300;
      packedTimelocks |= BigInt(dstWithdrawalDelay) << (4n * 32n);
      packedTimelocks |= BigInt(dstPublicWithdrawalDelay) << (5n * 32n);
      packedTimelocks |= BigInt(dstCancellationDelay) << (6n * 32n);

      const dstImmutables = {
        orderHash: orderHash,
        hashlock: hashlock,
        maker: maker.address,
        taker: taker.address,
        token: tokenAddress,
        amount: amount,
        safetyDeposit: safetyDeposit,
        timelocks: packedTimelocks.toString(),
      };

      console.log(dstImmutables);

      const tx = await factory
        .connect(taker)
        .createDstEscrow(dstImmutables, srcCancellationTimestamp, {
          value: safetyDeposit,
        });

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const deployedAt = block!.timestamp;

      const expectedDstCancellationTime = deployedAt + dstCancellationDelay;
      expect(expectedDstCancellationTime).to.be.lte(srcCancellationTimestamp);

      await expect(tx)
        .to.emit(factory, "DstEscrowCreated")
        .withArgs(
          (value: any) => ethers.isAddress(value),
          hashlock,
          taker.address
        );

      const eventLog = receipt?.logs?.find(
        (log) => log instanceof EventLog && log.eventName === "DstEscrowCreated"
      ) as EventLog | undefined;
      expect(eventLog).to.not.be.undefined;
      const escrowAddress = eventLog!.args.escrow;

      expect(await token.balanceOf(escrowAddress)).to.equal(amount); // No need for `as any`
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(
        safetyDeposit
      );
    });
  });
});
