import PromisePool from "@supercharge/promise-pool";
import { FetchOptions, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { METRIC } from "../helpers/metrics";
import { postURL } from "../utils/fetchURL";

const RPC = 'https://api.verus.services';
// VRSC currency id (getinfo chainid)
const VRSC = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
// SUCCESS_FEE / SATOSHIDEN, src/pbaas/reserves.h
const CONVERSION_FEE = 0.00025;

async function rpc(method: string, params: any[]) {
  const { result, error } = await postURL(RPC, { jsonrpc: '1.0', id: 1, method, params });
  if (error) throw new Error(`verus rpc ${method}(${JSON.stringify(params)}): ${JSON.stringify(error)}`);
  return result;
}

const getBlockTime = async (height: number): Promise<number> => (await rpc('getblockheader', [await rpc('getblockhash', [height])])).time;

// first height with block time >= timestamp
async function findHeight(timestamp: number, low: number, high: number) {
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await getBlockTime(mid) < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

const fetch = async (options: FetchOptions) => {
  const tip: number = await rpc('getblockcount', []);
  if (await getBlockTime(tip) < options.toTimestamp) throw new Error(`verus tip ${tip} has not reached the end of the window yet`);
  const fromBlock = await findHeight(options.fromTimestamp, 1, tip);
  const toBlock = await findHeight(options.toTimestamp, fromBlock, tip); // window: [fromBlock, toBlock)

  // all baskets hold VRSC; other-chain baskets (Bridge.vARRR/CHIPS/vDEX) are not visible here
  const baskets = (await rpc('listcurrencies', [{ converter: [VRSC] }]))
    .map((currency: any) => currency.currencydefinition)
    .filter((basket: any) => basket.systemid === VRSC && basket.startblock < toBlock);

  const { results, errors } = await PromisePool.withConcurrency(5)
    .for(baskets)
    .process(async (basket: any) => {
      // buckets exclude their end block, so this one covers [fromBlock, toBlock); no totalvolume = 0
      const states = await rpc('getcurrencystate', [basket.currencyid, `${fromBlock - 1},${toBlock},${toBlock - fromBlock + 1}`, VRSC]);
      return Number(states.find((state: any) => state.totalvolume !== undefined)?.totalvolume ?? 0);
    });
  if (errors.length) throw errors[0];
  const volumeInVrsc = results.reduce((sum: number, volume: number) => sum + volume, 0);

  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const fees = volumeInVrsc * CONVERSION_FEE;
  dailyVolume.addCGToken('verus-coin', volumeInVrsc);
  dailyFees.addCGToken('verus-coin', fees, METRIC.SWAP_FEES);
  dailyRevenue.addCGToken('verus-coin', fees * 0.5, 'Conversion Fees To Block Rewards');
  dailySupplySideRevenue.addCGToken('verus-coin', fees * 0.5, 'Conversion Fees To Basket Reserves');

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
  };
};

const methodology = {
  Volume: "Value of every conversion through Verus DeFi liquidity baskets on the Verus chain, read from the Verus daemon (getcurrencystate) in VRSC.",
  Fees: "A 0.025% fee is charged to users on every conversion.",
  UserFees: "Users pay 0.025% fee on every conversion.",
  SupplySideRevenue: "The 50% of swap fee added to reserves of LPs.",
  ProtocolRevenue: "The 50% of swap fee added to the block reward for miners and stakers.",
}

const breakdownMethodology = {
  Fees: {
    [METRIC.SWAP_FEES]: "0.025% conversion fee charged on every conversion through a liquidity basket.",
  },
  Revenue: {
    'Conversion Fees To Block Rewards': "Half of the conversion fees, added to the block reward for miners and stakers.",
  },
  ProtocolRevenue: {
    'Conversion Fees To Block Rewards': "Half of the conversion fees, added to the block reward for miners and stakers.",
  },
  SupplySideRevenue: {
    'Conversion Fees To Basket Reserves': "Half of the conversion fees, added to the reserves of the basket the conversion went through.",
  },
}

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: false,
  fetch,
  chains: [CHAIN.VERUS],
  start: '2025-04-04',
  methodology,
  breakdownMethodology,
};

export default adapter;
