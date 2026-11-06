// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Adds liquidity to a v4 pool (native ETH or ERC-20 on either side).
contract LiquiditySeeder {
    IPoolManager public immutable manager;
    address public immutable owner;

    error NotManager();
    error NotOwner();

    constructor(IPoolManager manager_) {
        manager = manager_;
        owner = msg.sender;
    }

    function seed(PoolKey calldata key, ModifyLiquidityParams calldata params) external payable {
        require(msg.sender == owner, NotOwner());
        manager.unlock(abi.encode(key, params));
        uint256 leftoverEth = address(this).balance;
        if (leftoverEth > 0) payable(owner).transfer(leftoverEth);
        _refund(key.currency0);
        _refund(key.currency1);
    }

    function _refund(address currency) private {
        if (currency == address(0)) return;
        uint256 left = IERC20(currency).balanceOf(address(this));
        if (left > 0) IERC20(currency).transfer(owner, left);
    }

    function _pay(address currency, int128 amount) private {
        if (amount >= 0) return;
        if (currency == address(0)) {
            manager.settle{value: uint128(-amount)}();
            return;
        }
        manager.sync(currency);
        IERC20(currency).transfer(address(manager), uint128(-amount));
        manager.settle();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), NotManager());
        (PoolKey memory key, ModifyLiquidityParams memory params) = abi.decode(data, (PoolKey, ModifyLiquidityParams));
        (int256 delta,) = manager.modifyLiquidity(key, params, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        _pay(key.currency0, amount0);
        _pay(key.currency1, amount1);
        return "";
    }

    receive() external payable {}
}
