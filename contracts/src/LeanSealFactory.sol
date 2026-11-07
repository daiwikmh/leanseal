// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Creates LeanSeal accounts as EIP-1167 clones with immutable args (OpenZeppelin's
/// layout), using a bare CREATE2 and no storage, so it can run as the deploy frame of the new
/// account's first transaction: the validation rules allow one CREATE2 there and ban
/// SELFBALANCE, and an unstaked factory may not touch other storage.
contract LeanSealFactory {
    uint256 public constant ARGS_LEN = 104;

    event AccountCreated(address indexed account, address indexed implementation, bytes32 salt);

    error BadArgs();
    error NoImplementation();
    error CreateFailed();

    function initCode(address implementation, bytes calldata args) public pure returns (bytes memory) {
        return abi.encodePacked(
            hex"61",
            uint16(args.length + 0x2d),
            hex"3d81600a3d39f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            args
        );
    }

    function createAccount(address implementation, bytes calldata args, bytes32 salt) external returns (address account) {
        require(args.length == ARGS_LEN, BadArgs());
        require(implementation.code.length != 0, NoImplementation());
        bytes memory code = initCode(implementation, args);
        assembly ("memory-safe") {
            account := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(account != address(0), CreateFailed());
        emit AccountCreated(account, implementation, salt);
    }

    function predict(address implementation, bytes calldata args, bytes32 salt) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode(implementation, args))));
        return address(uint160(uint256(h)));
    }
}
