// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockBooToken is ERC20 {
    constructor(string memory name, string memory symbol)
    ERC20(name, symbol) {}

    function mint(address account, uint amount) external {
        _mint(account, amount);
    }
}