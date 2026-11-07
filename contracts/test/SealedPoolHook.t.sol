// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey, ModifyLiquidityParams, LiquiditySeeder, IPoolManager} from "../src/LiquiditySeeder.sol";
import {SandwichSwapper, IPoolManagerSwap} from "../src/SandwichSwapper.sol";
import {SealedPoolHook, IPoolManagerHook} from "../src/SealedPoolHook.sol";
import {TestUSD} from "../src/TestUSD.sol";

interface Vm {
    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 balance) external;
    function roll(uint256 height) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
}

interface IPoolInit {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24);
}

/// @notice Fork test: local v4.
contract SealedPoolHookTest {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address internal constant MANAGER = 0x6C9ed95FaeD924C07817796a0C1c183550fC7e37;
    uint160 internal constant SQRT_PRICE_1000 = 2505414483750479311864138015696;
    int256 internal constant LIQUIDITY = 3162277660168379;
    uint256 internal constant BOND = 1e9;

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant BOT = address(0xB07);
    address internal constant KEEPER = address(0x4EE9);

    TestUSD internal tusd;
    SealedPoolHook internal hook;

    receive() external payable {}

    function setUp() public {
        tusd = new TestUSD(1e24);
        SealedPoolHook impl = new SealedPoolHook(IPoolManagerHook(MANAGER), address(tusd), 3000, 60, 1, 1, BOND);
        address flagged = address(uint160((uint256(keccak256("sealed-pool")) & ~uint256(0x3FFF)) | 0x80));
        vm.etch(flagged, address(impl).code);
        hook = SealedPoolHook(payable(flagged));
        PoolKey memory key = hook.poolKey();
        IPoolInit(MANAGER).initialize(key, SQRT_PRICE_1000);
        LiquiditySeeder seeder = new LiquiditySeeder(IPoolManager(MANAGER));
        tusd.transfer(address(seeder), 2e17);
        vm.deal(address(this), 1e15);
        seeder.seed{value: 11e13}(key, ModifyLiquidityParams(-887220, 887220, LIQUIDITY, bytes32(0)));
        _fund(ALICE);
        _fund(BOB);
        _fund(BOT);
    }

    function test_outsideSwapIsBlocked() public {
        SandwichSwapper sw = new SandwichSwapper{value: 1e12}(IPoolManagerSwap(MANAGER));
        try sw.swapExactIn(hook.poolKey(), true, 1e10) {
            revert("outside swap went through");
        } catch (bytes memory err) {
            require(_contains(err, SealedPoolHook.OutsideSwap.selector), "reverted for another reason");
        }
    }

    function test_sameDirectionGetsSamePriceRegardlessOfOrder() public {
        uint256 r = _commit(BOT, true, 3e12, 0, "bot");
        _commit(ALICE, true, 1e12, 0, "alice");
        _next();
        _reveal(r, 0, BOT, true, 3e12, 0, "bot");
        _reveal(r, 1, ALICE, true, 1e12, 0, "alice");
        _next();
        uint256 botBefore = hook.tokenOf(BOT);
        uint256 aliceBefore = hook.tokenOf(ALICE);
        hook.settle();
        uint256 botOut = hook.tokenOf(BOT) - botBefore;
        uint256 aliceOut = hook.tokenOf(ALICE) - aliceBefore;
        require(aliceOut > 0, "alice got nothing");
        require(_absDiff(botOut, aliceOut * 3) <= 3, "different price per unit");
    }

    function test_oppositeSidesMatchAtPoolPriceWithoutMovingIt() public {
        uint256 r = _commit(ALICE, true, 1e12, 0, "a");
        _commit(BOB, false, 1e15, 0, "b");
        _next();
        _reveal(r, 0, ALICE, true, 1e12, 0, "a");
        _reveal(r, 1, BOB, false, 1e15, 0, "b");
        _next();
        uint256 aliceTok = hook.tokenOf(ALICE);
        uint256 bobEth = hook.ethOf(BOB);
        hook.settle();
        require(_absDiff(hook.tokenOf(ALICE) - aliceTok, 1e15) <= 1e3, "alice not at pool price");
        require(_absDiff(hook.ethOf(BOB) - bobEth, 1e12) <= 1e3, "bob not at pool price");
    }

    function test_minOutFailureIsRefundedOthersStillTrade() public {
        uint256 r = _commit(ALICE, true, 1e12, type(uint128).max, "a");
        _commit(BOB, true, 1e12, 0, "b");
        _next();
        _reveal(r, 0, ALICE, true, 1e12, type(uint128).max, "a");
        _reveal(r, 1, BOB, true, 1e12, 0, "b");
        _next();
        uint256 aliceEth = hook.ethOf(ALICE);
        hook.settle();
        require(hook.ethOf(ALICE) == aliceEth + 1e12, "alice not refunded");
        require(hook.tokenOf(BOB) > 0, "bob did not trade");
        require(hook.ordersOf(r)[0].excluded, "alice not excluded");
    }

    function test_unrevealedOrderLosesBondToSettler() public {
        _commit(ALICE, true, 1e12, 0, "a");
        uint256 aliceEth = hook.ethOf(ALICE);
        _next();
        _next();
        vm.prank(KEEPER);
        hook.settle();
        require(hook.ethOf(KEEPER) == BOND, "keeper did not get bond");
        require(hook.ethOf(ALICE) == aliceEth, "alice balance changed");
    }

    function test_revealRulesAndTiming() public {
        uint256 r = _commit(ALICE, true, 1e12, 0, "a");
        try hook.reveal(r, 0, true, 1e12, 0, "a") {
            revert("revealed during commit round");
        } catch {}
        _next();
        try hook.reveal(r, 0, true, 2e12, 0, "a") {
            revert("wrong order accepted");
        } catch {}
        try hook.settle() {
            revert("settled during reveal window");
        } catch {}
        hook.reveal(r, 0, true, 1e12, 0, "a");
        _next();
        hook.settle();
    }

    function _fund(address who) private {
        vm.deal(who, 1e14);
        tusd.transfer(who, 1e17);
        vm.startPrank(who);
        hook.deposit{value: 1e14}();
        tusd.approve(address(hook), 1e17);
        hook.depositToken(1e17);
        vm.stopPrank();
    }

    function _commit(address who, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes32 salt)
        private
        returns (uint256 round)
    {
        bytes32 c = hook.commitmentOf(who, zeroForOne, amountIn, minOut, salt);
        vm.prank(who);
        (round,) = hook.commit(c);
    }

    function _reveal(uint256 r, uint256 i, address who, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes32 salt)
        private
    {
        vm.prank(who);
        hook.reveal(r, i, zeroForOne, amountIn, minOut, salt);
    }

    function _next() private {
        vm.roll(block.number + 1);
    }

    function _contains(bytes memory data, bytes4 sel) private pure returns (bool) {
        for (uint256 i; i + 4 <= data.length; i++) {
            if (data[i] == sel[0] && data[i + 1] == sel[1] && data[i + 2] == sel[2] && data[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    function _absDiff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
