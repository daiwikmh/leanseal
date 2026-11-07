// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Shared code for LeanSeal PQ accounts deployed as EIP-1167 clones with their
/// configuration appended to the clone's runtime code, so an account can be created by the
/// deploy frame of its own first transaction without writing storage.
///
/// Appended bytes (104): pkSeed (32) || pkRoot (32) || verifier (20) || frameModule (20).
/// The VERIFY frame forwards them to the SPHINCS frame module by DELEGATECALL, exactly as
/// SphincsFrameAccount does with its immutables, so the module checks the signature over
/// the canonical sig_hash and APPROVEs with ADDRESS == the clone.
contract LeanSealCloneAccount {
    address internal constant ENTRY_POINT = address(0xaa);
    uint256 internal constant CLONE_CODE_LEN = 0x2d;
    uint256 internal constant ARGS_LEN = 104;

    error NotEntryPoint();
    error NotAClone();

    function verifyFrameAndApprove(uint256 sigIndex) external {
        require(msg.sender == ENTRY_POINT, NotEntryPoint());
        require(address(this).code.length == CLONE_CODE_LEN + ARGS_LEN, NotAClone());
        assembly ("memory-safe") {
            let self := address()
            let p := mload(0x40)
            extcodecopy(self, p, CLONE_CODE_LEN, ARGS_LEN)
            let v := shr(96, mload(add(p, 0x40)))
            let m := shr(96, mload(add(p, 0x54)))
            mstore(add(p, 0x40), v)
            mstore(add(p, 0x60), sigIndex)
            if iszero(delegatecall(gas(), m, p, 0x80, 0, 0)) {
                returndatacopy(p, 0, returndatasize())
                revert(p, returndatasize())
            }
        }
    }

    /// @notice The configuration this clone carries.
    function config() external view returns (bytes32 pkSeed, bytes32 pkRoot, address verifier, address frameModule) {
        bytes memory a = new bytes(ARGS_LEN);
        address self = address(this);
        assembly ("memory-safe") {
            extcodecopy(self, add(a, 0x20), CLONE_CODE_LEN, ARGS_LEN)
            pkSeed := mload(add(a, 0x20))
            pkRoot := mload(add(a, 0x40))
            verifier := shr(96, mload(add(a, 0x60)))
            frameModule := shr(96, mload(add(a, 0x74)))
        }
    }

    receive() external payable {}
}
