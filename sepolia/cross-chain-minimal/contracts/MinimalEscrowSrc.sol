// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@1inch/solidity-utils/contracts/libraries/SafeERC20.sol";
import { AddressLib, Address } from "@1inch/solidity-utils/contracts/libraries/AddressLib.sol";

import { Timelocks, TimelocksLib } from "./libraries/TimelocksLib.sol";
import { ImmutablesLib } from "./libraries/ImmutablesLib.sol";

import { MinimalBaseEscrow } from "./MinimalBaseEscrow.sol";
import { MinimalEscrow } from "./MinimalEscrow.sol";

/**
 * @title Minimal Source Escrow contract for cross-chain atomic swap.
 * @notice Simple HTLC contract to lock funds and unlock them with verification of the secret.
 */
contract MinimalEscrowSrc is MinimalEscrow {
    using AddressLib for Address;
    using ImmutablesLib for Immutables;
    using SafeERC20 for IERC20;
    using TimelocksLib for Timelocks;

    constructor(uint32 rescueDelay) MinimalBaseEscrow(rescueDelay) {}

    
    function PROXY_BYTECODE_HASH() external pure returns (bytes32) {
        return bytes32(0);
    }

    /**
     * @notice Withdraw funds to taker with the correct secret.
     * @param secret The secret that unlocks the escrow.
     * @param immutables The immutable values used to deploy the clone contract.
     */
    function withdraw(bytes32 secret, Immutables calldata immutables)
        external
        onlyTaker(immutables)
        onlyAfter(immutables.timelocks.get(TimelocksLib.Stage.SrcWithdrawal))
        onlyBefore(immutables.timelocks.get(TimelocksLib.Stage.SrcCancellation))
    {
        _withdrawTo(secret, msg.sender, immutables);
    }

    /**
     * @notice Withdraw funds to a specified target.
     * @param secret The secret that unlocks the escrow.
     * @param target The address to transfer ERC20 tokens to.
     * @param immutables The immutable values used to deploy the clone contract.
     */
    function withdrawTo(bytes32 secret, address target, Immutables calldata immutables)
        external
        onlyTaker(immutables)
        onlyAfter(immutables.timelocks.get(TimelocksLib.Stage.SrcWithdrawal))
        onlyBefore(immutables.timelocks.get(TimelocksLib.Stage.SrcCancellation))
    {
        _withdrawTo(secret, target, immutables);
    }

    /**
     * @notice Cancel the escrow and return funds to maker after timelock expires.
     * @param immutables The immutable values used to deploy the clone contract.
     */
    function cancel(Immutables calldata immutables)
        external
        onlyTaker(immutables)
        onlyAfter(immutables.timelocks.get(TimelocksLib.Stage.SrcCancellation))
    {
        _cancel(immutables);
    }

    /**
     * @dev Transfers ERC20 tokens to the target and native tokens to the caller.
     */
    function _withdrawTo(bytes32 secret, address target, Immutables calldata immutables)
        internal
        onlyValidImmutables(immutables)
        onlyValidSecret(secret, immutables)
    {
        IERC20(immutables.token.get()).safeTransfer(target, immutables.amount);
        _ethTransfer(msg.sender, immutables.safetyDeposit);
        emit EscrowWithdrawal(secret);
    }

    /**
     * @dev Transfers ERC20 tokens to the maker and native tokens to the caller.
     */
    function _cancel(Immutables calldata immutables) internal onlyValidImmutables(immutables) {
        IERC20(immutables.token.get()).safeTransfer(immutables.maker.get(), immutables.amount);
        _ethTransfer(msg.sender, immutables.safetyDeposit);
        emit EscrowCancelled();
    }
} 