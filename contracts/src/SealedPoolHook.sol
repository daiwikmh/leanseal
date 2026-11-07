// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "./LiquiditySeeder.sol";
import {SwapParams} from "./SandwichSwapper.sol";

interface IPoolManagerHook {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Hook {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice Commit-reveal batch swaps, one price.
contract SealedPoolHook {
    struct Order {
        address user;
        bytes32 commitment;
        bool revealed;
        bool excluded;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minOut;
    }

    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    IPoolManagerHook public immutable manager;
    address public immutable token;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    uint256 public immutable roundBlocks;
    uint256 public immutable revealRounds;
    uint256 public immutable bond;

    mapping(address => uint256) public ethOf;
    mapping(address => uint256) public tokenOf;
    mapping(uint256 => Order[]) internal orders;
    uint256[] public queue;
    uint256 public head;

    event Committed(uint256 indexed round, uint256 index, address indexed user, bytes32 commitment);
    event Revealed(uint256 indexed round, uint256 index, bool zeroForOne, uint128 amountIn, uint128 minOut);
    event Excluded(uint256 indexed round, uint256 index);
    event Settled(uint256 indexed round, uint256 ethIn, uint256 tokenIn, uint256 ethOut, uint256 tokenOut);

    error OutsideSwap();
    error NotManager();
    error WrongPhase();
    error BadReveal();
    error NothingToSettle();
    error MinOutFailed(uint256 index);

    constructor(
        IPoolManagerHook manager_,
        address token_,
        uint24 fee_,
        int24 tickSpacing_,
        uint256 roundBlocks_,
        uint256 revealRounds_,
        uint256 bond_
    ) {
        manager = manager_;
        token = token_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        roundBlocks = roundBlocks_;
        revealRounds = revealRounds_;
        bond = bond_;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(address(0), token, fee, tickSpacing, address(this));
    }

    function currentRound() public view returns (uint256) {
        return block.number / roundBlocks;
    }

    function commitmentOf(address user, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), user, zeroForOne, amountIn, minOut, salt));
    }

    function ordersOf(uint256 round) external view returns (Order[] memory) {
        return orders[round];
    }

    function deposit() external payable {
        ethOf[msg.sender] += msg.value;
    }

    function depositToken(uint256 amount) external {
        IERC20Hook(token).transferFrom(msg.sender, address(this), amount);
        tokenOf[msg.sender] += amount;
    }

    function withdraw(uint256 ethAmount, uint256 tokenAmount) external {
        ethOf[msg.sender] -= ethAmount;
        tokenOf[msg.sender] -= tokenAmount;
        if (tokenAmount > 0) IERC20Hook(token).transfer(msg.sender, tokenAmount);
        if (ethAmount > 0) {
            (bool ok,) = msg.sender.call{value: ethAmount}("");
            require(ok);
        }
    }

    function commit(bytes32 commitment) external returns (uint256 round, uint256 index) {
        round = currentRound();
        ethOf[msg.sender] -= bond;
        Order[] storage os = orders[round];
        if (os.length == 0) queue.push(round);
        index = os.length;
        os.push(Order(msg.sender, commitment, false, false, false, 0, 0));
        emit Committed(round, index, msg.sender, commitment);
    }

    function reveal(uint256 round, uint256 index, bool zeroForOne, uint128 amountIn, uint128 minOut, bytes32 salt)
        external
    {
        uint256 cur = currentRound();
        require(cur > round && cur <= round + revealRounds, WrongPhase());
        Order storage o = orders[round][index];
        require(
            !o.revealed && o.commitment == commitmentOf(o.user, zeroForOne, amountIn, minOut, salt), BadReveal()
        );
        ethOf[o.user] += bond;
        _debit(o.user, zeroForOne, amountIn);
        o.revealed = true;
        o.zeroForOne = zeroForOne;
        o.amountIn = amountIn;
        o.minOut = minOut;
        emit Revealed(round, index, zeroForOne, amountIn, minOut);
    }

    function settle() external {
        require(head < queue.length, NothingToSettle());
        uint256 round = queue[head];
        require(currentRound() > round + revealRounds, WrongPhase());
        head++;
        Order[] storage os = orders[round];
        for (uint256 i; i < os.length; i++) {
            if (!os[i].revealed) ethOf[msg.sender] += bond;
        }
        while (true) {
            try manager.unlock(abi.encode(round)) {
                return;
            } catch (bytes memory err) {
                if (err.length != 36 || bytes4(err) != MinOutFailed.selector) {
                    assembly {
                        revert(add(err, 32), mload(err))
                    }
                }
                uint256 index;
                assembly {
                    index := mload(add(err, 36))
                }
                Order storage o = os[index];
                o.excluded = true;
                _credit(o.user, o.zeroForOne, o.amountIn);
                emit Excluded(round, index);
            }
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), NotManager());
        uint256 round = abi.decode(data, (uint256));
        Order[] storage os = orders[round];
        (uint256 ethIn, uint256 tokenIn) = _totals(os);
        if (ethIn == 0 && tokenIn == 0) return "";
        uint160 sqrtP = _sqrtPrice();
        uint256 ethOut;
        uint256 tokenOut;
        uint256 tokenInAsEth = _toEth(tokenIn, sqrtP);
        if (ethIn >= tokenInAsEth) {
            ethOut = tokenInAsEth;
            tokenOut = tokenIn + _swap(true, ethIn - tokenInAsEth);
        } else {
            tokenOut = _toToken(ethIn, sqrtP);
            ethOut = ethIn + _swap(false, tokenIn - tokenOut);
        }
        for (uint256 i; i < os.length; i++) {
            Order storage o = os[i];
            if (!o.revealed || o.excluded) continue;
            uint256 out = o.zeroForOne ? tokenOut * o.amountIn / ethIn : ethOut * o.amountIn / tokenIn;
            if (out < o.minOut) revert MinOutFailed(i);
            _credit(o.user, !o.zeroForOne, out);
        }
        emit Settled(round, ethIn, tokenIn, ethOut, tokenOut);
        return "";
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, int256, uint24)
    {
        revert OutsideSwap();
    }

    receive() external payable {
        require(msg.sender == address(manager), NotManager());
    }

    function _totals(Order[] storage os) private view returns (uint256 ethIn, uint256 tokenIn) {
        for (uint256 i; i < os.length; i++) {
            Order storage o = os[i];
            if (!o.revealed || o.excluded) continue;
            if (o.zeroForOne) ethIn += o.amountIn;
            else tokenIn += o.amountIn;
        }
    }

    function _swap(bool zeroForOne, uint256 amountIn) private returns (uint256) {
        if (amountIn == 0) return 0;
        uint160 limit = zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE;
        int256 delta = manager.swap(poolKey(), SwapParams(zeroForOne, -int256(amountIn), limit), "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        if (zeroForOne) {
            manager.settle{value: uint128(-amount0)}();
            manager.take(token, address(this), uint128(amount1));
            return uint128(amount1);
        }
        manager.sync(token);
        IERC20Hook(token).transfer(address(manager), uint128(-amount1));
        manager.settle();
        manager.take(address(0), address(this), uint128(amount0));
        return uint128(amount0);
    }

    function _sqrtPrice() private view returns (uint160) {
        bytes32 id = keccak256(abi.encode(poolKey()));
        return uint160(uint256(manager.extsload(keccak256(abi.encodePacked(id, POOLS_SLOT)))));
    }

    function _toEth(uint256 tokenAmount, uint160 sqrtP) private pure returns (uint256) {
        return (((tokenAmount << 96) / sqrtP) << 96) / sqrtP;
    }

    function _toToken(uint256 ethAmount, uint160 sqrtP) private pure returns (uint256) {
        return (((ethAmount * sqrtP) >> 96) * sqrtP) >> 96;
    }

    function _credit(address user, bool eth, uint256 amount) private {
        if (eth) ethOf[user] += amount;
        else tokenOf[user] += amount;
    }

    function _debit(address user, bool eth, uint256 amount) private {
        if (eth) ethOf[user] -= amount;
        else tokenOf[user] -= amount;
    }
}
