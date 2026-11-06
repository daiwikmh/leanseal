// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SphincsFrameAccount} from "./vendor/sphincs/SphincsFrameAccount.sol";

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// @notice PQ account that stakes itself.
contract LeanSealAccount is SphincsFrameAccount {
    constructor(
        bytes32 seed,
        bytes32 root,
        address verifier,
        address owner_,
        address frameModule,
        address registry,
        uint256 stakeWei,
        uint32 unstakeDelaySec
    ) payable SphincsFrameAccount(seed, root, verifier, owner_, frameModule) {
        IStakingRegistry(registry).addStake{value: stakeWei}(unstakeDelaySec);
    }
}
