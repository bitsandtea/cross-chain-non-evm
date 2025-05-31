// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { ImmutablesLib } from "./libraries/ImmutablesLib.sol";

import { IEscrow } from "./interfaces/IEscrow.sol";
import { MinimalBaseEscrow } from "./MinimalBaseEscrow.sol";

/**
 * @title Minimal Abstract Escrow contract for cross-chain atomic swap.
 * @dev Withdraw and cancel functions must be implemented in the derived contracts.
 */
abstract contract MinimalEscrow is MinimalBaseEscrow, IEscrow {
    using ImmutablesLib for Immutables;

    /**
     * @dev Verifies that the computed escrow address matches the address of this contract.
     */
    function _validateImmutables(Immutables calldata immutables) internal view virtual override {
        bytes32 salt = immutables.hash();
        address predicted = Clones.predictDeterministicAddress(
            address(this),
            salt,
            FACTORY
        );
        if (predicted != address(this)) {
            revert InvalidImmutables();
        }
    }
} 