import { BigNumber, ethers, providers } from "ethers";
import { config } from "../config/config";
import { UniswapV2RouterABI, UniswapV2PairABI } from "../abi";
import { HelpersWrapper, SANDWICHABLE_METHODS } from "../utils";
import { BacktestScenario } from "./engine";

/**
 * Pull real historical scenarios from an archive node so the backtest runs on
 * actual mainnet flow rather than fixtures. Requires an *archive* RPC (state at
 * historical blocks); a normal full node will fail the `getReserves` calls with
 * a blockTag in the past.
 *
 * For each block in [fromBlock, toBlock] it finds direct WETH->token exact-in
 * buys on the configured router and reconstructs the pool state at the parent
 * block, producing scenarios the engine can replay.
 */
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

export async function loadScenariosFromChain(
  fromBlock: number,
  toBlock: number,
  rpcUrl: string = config.RPC_URL
): Promise<BacktestScenario[]> {
  const provider = new providers.JsonRpcProvider(rpcUrl);
  const router = new ethers.utils.Interface(UniswapV2RouterABI);
  const factory = new ethers.Contract(config.UNIV2_FACTORY, FACTORY_ABI, provider);
  const weth = config.WETH.toLowerCase();
  const out: BacktestScenario[] = [];

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await provider.getBlockWithTransactions(bn);
    if (!block) continue;
    const parentBlock = await provider.getBlock(bn - 1);
    const nextBaseFee = HelpersWrapper.calculateNextBlockBaseFee(parentBlock);

    for (const tx of block.transactions) {
      if (!tx.to || tx.to.toLowerCase() !== config.UNIV2_ROUTER.toLowerCase()) {
        continue;
      }
      let parsed: ethers.utils.TransactionDescription;
      try {
        parsed = router.parseTransaction({ data: tx.data });
      } catch {
        continue;
      }
      if (!SANDWICHABLE_METHODS.has(parsed.name)) continue;

      const swap = HelpersWrapper.extractSwapDetails(parsed, tx.value);
      if (
        !swap ||
        swap.kind !== "exactIn" ||
        swap.amountIn == null ||
        swap.path.length !== 2 ||
        swap.path[0].toLowerCase() !== weth
      ) {
        continue;
      }

      const token = swap.path[1];
      const pair: string = await factory.getPair(config.WETH, token);
      if (!pair || pair === ethers.constants.AddressZero) continue;

      // Reserves as of the parent block (the state the bot would have acted on).
      const pairContract = new ethers.Contract(pair, UniswapV2PairABI, provider);
      const [reserves, token0] = await Promise.all([
        pairContract.getReserves({ blockTag: bn - 1 }),
        pairContract.token0(),
      ]);
      const wethIsToken0 = (token0 as string).toLowerCase() === weth;
      const reserveWeth: BigNumber = wethIsToken0 ? reserves[0] : reserves[1];
      const reserveToken: BigNumber = wethIsToken0 ? reserves[1] : reserves[0];

      out.push({
        label: `${bn}:${tx.hash}`,
        victimIn: swap.amountIn,
        victimMinOut: swap.amountOutMin ?? BigNumber.from(0),
        reserveWeth,
        reserveToken,
        nextBaseFee,
      });
    }
  }

  return out;
}
