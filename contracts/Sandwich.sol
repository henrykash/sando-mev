// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Sandwich
 * @notice Minimal, gas-conscious sandwich executor for UniswapV2-style pools.
 *
 * Design notes
 * ------------
 * - The frontrun and backrun legs are SEPARATE transactions inside a Flashbots
 *   bundle (front, victim, back), so this contract exposes a single `swap`
 *   entrypoint used by both legs rather than one atomic call.
 * - It swaps directly against the pair (`IUniswapV2Pair.swap`) instead of going
 *   through the router, which removes the router's overhead — gas is the
 *   dominant cost that decides whether a sandwich is net-profitable.
 * - Owner-gated: only the deployer can move funds or trigger swaps.
 * - `minOut` is enforced on-chain as a final guard; the off-chain bot has
 *   already simulated, but this prevents a bad fill if state shifts.
 *
 * This is intentionally readable Solidity. A production searcher would port the
 * hot path to Yul/Huff to shave further gas — see docs/PROFITABILITY_ANALYSIS.md.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV2Pair {
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}

contract Sandwich {
    address public immutable owner;

    error NotOwner();
    error InsufficientOutput();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @notice Execute one swap leg against a pair.
     * @param pair        The UniswapV2 pair to trade against.
     * @param tokenIn     Token this contract sends into the pair.
     * @param amountIn    Amount of `tokenIn` to send.
     * @param amountOut   Expected output (pre-computed off-chain via getAmountOut).
     * @param minOut      On-chain slippage guard; reverts if output < minOut.
     * @param zeroForOne  True if `tokenIn` is token0 (so output is token1).
     *
     * The caller (bot) funds this contract with `tokenIn` ahead of time (or in
     * the same bundle). We optimistically transfer `amountIn` to the pair and
     * request `amountOut` of the other token.
     */
    function swap(
        address pair,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minOut,
        bool zeroForOne
    ) external onlyOwner {
        if (amountOut < minOut) revert InsufficientOutput();

        if (!IERC20(tokenIn).transfer(pair, amountIn)) revert TransferFailed();

        (uint256 amount0Out, uint256 amount1Out) = zeroForOne
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));

        IUniswapV2Pair(pair).swap(amount0Out, amount1Out, address(this), "");
    }

    /// @notice Withdraw an ERC20 balance to the owner.
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
    }

    /// @notice Withdraw ETH to the owner.
    function rescueETH(uint256 amount) external onlyOwner {
        (bool ok, ) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    receive() external payable {}
}
