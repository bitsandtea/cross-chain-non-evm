// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { Address, AddressLib } from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";

import { ImmutablesLib } from "./libraries/ImmutablesLib.sol";
import { Timelocks, TimelocksLib } from "./libraries/TimelocksLib.sol";

import { IBaseEscrow } from "./interfaces/IBaseEscrow.sol";
import { MinimalEscrowSrc } from "./MinimalEscrowSrc.sol";
import { MinimalEscrowDst } from "./MinimalEscrowDst.sol";

/**
 * @title Minimal Escrow Factory contract
 * @notice Simple factory to create escrow contracts for cross-chain atomic swap.
 */
contract MinimalEscrowFactory {
    using AddressLib for Address;
    using Clones for address;
    using ImmutablesLib for IBaseEscrow.Immutables;
    using SafeERC20 for IERC20;
    using TimelocksLib for Timelocks;

    /// @notice Implementation contract for source chain escrows.
    address public immutable ESCROW_SRC_IMPLEMENTATION;
    /// @notice Implementation contract for destination chain escrows.
    address public immutable ESCROW_DST_IMPLEMENTATION;

    error InsufficientEscrowBalance();
    error InvalidCreationTime();

    /**
     * @notice Emitted on source escrow deployment.
     * @param escrow The address of the created escrow.
     * @param hashlock The hash of the secret.
     * @param maker The address of the maker.
     * @param taker The address of the taker.
     */
    event SrcEscrowCreated(address escrow, bytes32 hashlock, address maker, address taker);
    
    /**
     * @notice Emitted on destination escrow deployment.
     * @param escrow The address of the created escrow.
     * @param hashlock The hash of the secret.
     * @param taker The address of the taker.
     */
    event DstEscrowCreated(address escrow, bytes32 hashlock, Address taker);

    constructor(uint32 rescueDelaySrc, uint32 rescueDelayDst) {
        ESCROW_SRC_IMPLEMENTATION = address(new MinimalEscrowSrc(rescueDelaySrc));
        ESCROW_DST_IMPLEMENTATION = address(new MinimalEscrowDst(rescueDelayDst));
    }

    /**
     * @notice Creates a new escrow contract for the source chain.
     * @param immutables The immutables of the escrow contract.
     */
    function createSrcEscrow(IBaseEscrow.Immutables calldata immutables) external payable {
        address token = immutables.token.get();
        uint256 nativeAmount = immutables.safetyDeposit;
        if (token == address(0)) {
            nativeAmount += immutables.amount;
        }
        if (msg.value != nativeAmount) revert InsufficientEscrowBalance();

        IBaseEscrow.Immutables memory srcImmutables = immutables;
        srcImmutables.timelocks = srcImmutables.timelocks.setDeployedAt(block.timestamp);

        bytes32 salt = srcImmutables.hashMem();
        address escrow = _deployEscrow(salt, msg.value, ESCROW_SRC_IMPLEMENTATION);
        
        if (token != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, escrow, immutables.amount);
        }

        emit SrcEscrowCreated(escrow, immutables.hashlock, immutables.maker.get(), immutables.taker.get());
    }

    /**
     * @notice Creates a new escrow contract for the destination chain.
     * @param dstImmutables The immutables of the escrow contract.
     * @param srcCancellationTimestamp The start of the cancellation period for the source chain.
     */
    function createDstEscrow(IBaseEscrow.Immutables calldata dstImmutables, uint256 srcCancellationTimestamp) external payable {
        address token = dstImmutables.token.get();
        uint256 nativeAmount = dstImmutables.safetyDeposit;
        if (token == address(0)) {
            nativeAmount += dstImmutables.amount;
        }
        if (msg.value != nativeAmount) revert InsufficientEscrowBalance();

        IBaseEscrow.Immutables memory immutables = dstImmutables;
        immutables.timelocks = immutables.timelocks.setDeployedAt(block.timestamp);
        
        // Check that the escrow cancellation will start not later than the cancellation time on the source chain.
        if (immutables.timelocks.get(TimelocksLib.Stage.DstCancellation) > srcCancellationTimestamp) revert InvalidCreationTime();

        bytes32 salt = immutables.hashMem();
        address escrow = _deployEscrow(salt, msg.value, ESCROW_DST_IMPLEMENTATION);
        
        if (token != address(0)) {
            IERC20(token).safeTransferFrom(msg.sender, escrow, immutables.amount);
        }

        emit DstEscrowCreated(escrow, dstImmutables.hashlock, dstImmutables.taker);
    }

    /**
     * @notice Returns the deterministic address of the source escrow.
     * @param immutables The immutable arguments used to compute salt for escrow deployment.
     * @return The computed address of the escrow.
     */
    function addressOfEscrowSrc(IBaseEscrow.Immutables calldata immutables) external view returns (address) {
        return Clones.predictDeterministicAddress(ESCROW_SRC_IMPLEMENTATION, immutables.hash(), address(this));
    }

    /**
     * @notice Returns the deterministic address of the destination escrow.
     * @param immutables The immutable arguments used to compute salt for escrow deployment.
     * @return The computed address of the escrow.
     */
    function addressOfEscrowDst(IBaseEscrow.Immutables calldata immutables) external view returns (address) {
        return Clones.predictDeterministicAddress(ESCROW_DST_IMPLEMENTATION, immutables.hash(), address(this));
    }

    /**
     * @notice Deploys a new escrow contract.
     * @param salt The salt for the deterministic address computation.
     * @param value The value to be sent to the escrow contract.
     * @param implementation Address of the implementation.
     * @return escrow The address of the deployed escrow contract.
     */
    function _deployEscrow(bytes32 salt, uint256 value, address implementation) internal returns (address escrow) {
        escrow = implementation.cloneDeterministic(salt, value);
    }
} 