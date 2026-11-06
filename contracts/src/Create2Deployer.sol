// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Deploys contracts with CREATE2, for v4 hook addresses with flag bits.
contract Create2Deployer {
    event Deployed(address addr, bytes32 salt);

    error DeployFailed();

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        bytes memory code = initCode;
        assembly {
            addr := create2(0, add(code, 32), mload(code), salt)
        }
        require(addr != address(0), DeployFailed());
        emit Deployed(addr, salt);
    }
}
