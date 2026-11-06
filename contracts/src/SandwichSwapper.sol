// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "./LiquiditySeeder.sol";

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerSwap {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IERC20Min {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Test MEV bot: exact-input swaps on a native-ETH v4 pool.
contract SandwichSwapper {
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IPoolManagerSwap public immutable manager;
    address public immutable owner;

    error NotOwner();
    error NotManager();

    constructor(IPoolManagerSwap manager_) payable {
        manager = manager_;
        owner = msg.sender;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external {
        require(msg.sender == owner, NotOwner());
        manager.unlock(abi.encode(key, zeroForOne, amountIn));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), NotManager());
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        uint160 limit = zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE;
        int256 delta = manager.swap(key, SwapParams(zeroForOne, -int256(amountIn), limit), "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        _settle(key.currency0, amount0);
        _settle(key.currency1, amount1);
        _take(key.currency0, amount0);
        _take(key.currency1, amount1);
        return "";
    }

    function _settle(address currency, int128 amount) private {
        if (amount >= 0) return;
        uint256 owed = uint128(-amount);
        if (currency == address(0)) {
            manager.settle{value: owed}();
        } else {
            manager.sync(currency);
            IERC20Min(currency).transfer(address(manager), owed);
            manager.settle();
        }
    }

    function _take(address currency, int128 amount) private {
        if (amount > 0) manager.take(currency, address(this), uint128(amount));
    }

    function withdraw() external {
        require(msg.sender == owner, NotOwner());
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
