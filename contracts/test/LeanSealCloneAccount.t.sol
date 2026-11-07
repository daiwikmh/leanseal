// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {LeanSealCloneAccount} from "../src/LeanSealCloneAccount.sol";
import {LeanSealFactory} from "../src/LeanSealFactory.sol";

contract RecordingModule {
    fallback() external {
        assembly {
            sstore(0, calldataload(0x00))
            sstore(1, calldataload(0x20))
            sstore(2, calldataload(0x40))
            sstore(3, calldataload(0x60))
            sstore(4, calldatasize())
            sstore(5, caller())
        }
    }
}

contract RevertingModule {
    fallback() external {
        revert("bad signature");
    }
}

contract LeanSealCloneAccountTest is Test {
    address internal constant ENTRY_POINT = address(0xaa);
    bytes32 internal constant SEED = bytes32(uint256(0x1111) << 128);
    bytes32 internal constant ROOT = bytes32(uint256(0x2222) << 128);
    address internal constant VERIFIER = address(0xbeef);

    LeanSealCloneAccount internal impl;
    LeanSealFactory internal factory;
    RecordingModule internal module;

    function setUp() public {
        impl = new LeanSealCloneAccount();
        factory = new LeanSealFactory();
        module = new RecordingModule();
    }

    function args(address m) internal pure returns (bytes memory) {
        return abi.encodePacked(SEED, ROOT, VERIFIER, m);
    }

    function test_predictMatchesCreateAndCloneCarriesConfig() public {
        bytes memory a = args(address(module));
        address predicted = factory.predict(address(impl), a, bytes32(uint256(7)));
        address account = factory.createAccount(address(impl), a, bytes32(uint256(7)));
        assertEq(account, predicted);
        assertEq(account.code.length, 0x2d + 104);
        (bytes32 s, bytes32 r, address v, address m) = LeanSealCloneAccount(payable(account)).config();
        assertEq(s, SEED);
        assertEq(r, ROOT);
        assertEq(v, VERIFIER);
        assertEq(m, address(module));
    }

    function test_verifyForwardsKeysAndIndexToTheModuleInTheAccountsContext() public {
        address account = factory.createAccount(address(impl), args(address(module)), bytes32(0));
        vm.prank(ENTRY_POINT);
        LeanSealCloneAccount(payable(account)).verifyFrameAndApprove(3);
        assertEq(vm.load(account, bytes32(uint256(0))), SEED);
        assertEq(vm.load(account, bytes32(uint256(1))), ROOT);
        assertEq(address(uint160(uint256(vm.load(account, bytes32(uint256(2)))))), VERIFIER);
        assertEq(uint256(vm.load(account, bytes32(uint256(3)))), 3);
        assertEq(uint256(vm.load(account, bytes32(uint256(4)))), 0x80);
        assertEq(address(uint160(uint256(vm.load(account, bytes32(uint256(5)))))), ENTRY_POINT);
    }

    function test_onlyTheEntryPointMayVerify() public {
        address account = factory.createAccount(address(impl), args(address(module)), bytes32(0));
        vm.expectRevert(LeanSealCloneAccount.NotEntryPoint.selector);
        LeanSealCloneAccount(payable(account)).verifyFrameAndApprove(0);
    }

    function test_aFailingModuleRevertsVerification() public {
        address account = factory.createAccount(address(impl), args(address(new RevertingModule())), bytes32(0));
        vm.prank(ENTRY_POINT);
        vm.expectRevert(bytes("bad signature"));
        LeanSealCloneAccount(payable(account)).verifyFrameAndApprove(0);
    }

    function test_theImplementationItselfIsNotUsable() public {
        vm.prank(ENTRY_POINT);
        vm.expectRevert(LeanSealCloneAccount.NotAClone.selector);
        impl.verifyFrameAndApprove(0);
    }

    function test_factoryRejectsWrongArgsAndAcceptsEth() public {
        vm.expectRevert(LeanSealFactory.BadArgs.selector);
        factory.createAccount(address(impl), hex"01", bytes32(0));
        address account = factory.createAccount(address(impl), args(address(module)), bytes32(0));
        vm.deal(address(this), 1 ether);
        (bool ok,) = account.call{value: 1 wei}("");
        assertTrue(ok);
        assertEq(account.balance, 1 wei);
    }
}
