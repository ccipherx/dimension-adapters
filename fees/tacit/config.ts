import { Balances } from '@defillama/sdk'
import { AbiCoder, Interface, ZeroAddress, id as eventTopic } from 'ethers'
import { FetchOptions } from '../../adapters/types'
import { CHAIN } from '../../helpers/chains'
import { METRIC } from '../../helpers/metrics'

// Addresses: github.com/src-company/tacit contracts/deployments/{1-createx,1,evm-pool}.json, dapp/evm-pool-tokens.js
export const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC'
export const POOL_DEPLOY_BLOCK = 25998736
export const PUBLIC_AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119'
export const ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992'
export const SETTLE_TIP_FORWARDER = '0x0000008353ee6Dea1236544938C546E27010416D'
export const PROOF_MARKET = '0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609'
export const GAS_RELAY = '0x000000197E8f0B64463B2010e568fF42090Af88d'
export const TAC_BUYBACK = '0x6919cbEf0e70AFFA02Ae02c86c532A137154f250'
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'
export const WTAC = '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf' // WrappedTac.sol: 1:1 with TAC in base units
export const WRAP_TIP_FORWARDER = '0x000000D218B03db5837943b0b05DeA2965AE956e'
export const WRAP_TOKEN_TIP_FORWARDER = '0x0000007b1d93d72f698A861aA86Ac675D6AF7216'
export const ESCROW_TIP_FORWARDERS = ['0x000000006fcb52Aa67AC4A420a4D43A0e48F136F', '0x000000fB551f7Ef4936a59ECdD431ae253139E8d']
const EVM_ETH_POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9'

const lower = (list: string[]) => new Set(list.map((a) => a.toLowerCase()))
// Tacit's settle wallets and relay wallet (worker-relay render.yaml SETTLE_ADDRESS and RELAY_ADDRESS)
export const TACIT_RELAY = lower(['0x7a0F0511E1DcF399C2F7bbe8414b6a0D1ABc4331', '0xb2daf4571cf2afffa34482b34a6ece01137e59dd', '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7'])
// ops multisig, EthSplitter (pays the relay wallet, the settle wallet and TacBuyback) and the relay wallet
export const TACIT_TIP_RECIPIENTS = lower(['0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9', '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7'])
// ops multisig and the farm funding wallet: settles paying out to them move Tacit's own notes
export const TACIT_TREASURY = lower(['0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2', '0xfD1Fa372cA3f94F67E91595dD49dBF939381b5d2'])
// Tacit-made tokens, valued last when a swap has a better-priced leg
export const TACIT_TOKENS = lower([TAC, WTAC, '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696', '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564', '0xA0f6B02561C8ef08335B69aD25e022C0B342147C', '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570'])

// TacitEvmPool instances served by Tacit's keepers (tacit-evm-pool-keepers.onrender.com/chains), pool => immutable ASSET()
export const chainConfig: Record<string, { start: string, keeper: string, evmPools: Record<string, string> }> = {
  [CHAIN.ETHEREUM]: {
    start: '2026-09-18', keeper: '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0',
    evmPools: {
      [EVM_ETH_POOL]: ZeroAddress,
      '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe': TAC,
      '0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA': '0xA0f6B02561C8ef08335B69aD25e022C0B342147C',
      '0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1': '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570',
      '0x6C0be904750Fe1b50cd7207cc94731642d99e908': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0x73872ceEaADd2C603BD057073D403f08DCB31EB9': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      '0x0a83Fb67EE2708F10BCdd8FE23Fa3B30A0247Aac': '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    },
  },
  [CHAIN.BASE]: {
    start: '2026-09-27', keeper: '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec',
    evmPools: {
      [EVM_ETH_POOL]: ZeroAddress,
      '0xCAf6BE2e337AEcAB4a4eA183452f78800fD1616D': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0xC720d51Fa8B768F6b0ba58Bf0812CA76355bcee4': '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      '0x95e51d1BF626390c2C99b748d7A2D31829D94746': '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
    },
  },
  [CHAIN.ROBINHOOD]: {
    start: '2026-09-27', keeper: '0xc1F8DAc6BC910A5A794b4795b5F9997e0E8A5Fad',
    evmPools: {
      [EVM_ETH_POOL]: ZeroAddress,
      '0x4430C0eFdFef640d54abB5a7cDdC63819468d8CA': '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      '0x1BC62D5fF0a76b8f944C70Bf324EAf9a028f062F': '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    },
  },
}

export const BPS = 10_000n
export const AMM_DEFAULT_FEE_BPS = 30n // dapp AMM_FEE, the only tier with initialized pools today
export const MAX_POOL_FEE_BPS = 1000 // ConfidentialPool MAX_POOL_FEE_BPS

export const LABEL = {
  RELAY: 'Relay Fees', RELAY_TO_TACIT: 'Relay Fees To Tacit Relay', RELAY_TO_OTHERS: 'Relay Fees To Third-Party Relayers',
  TIPS: 'Relay Tips', TIPS_TO_TACIT: 'Relay Tips To Tacit Relay', TIPS_TO_OTHERS: 'Relay Tips To Third-Party Relayers',
  PROVING: 'Proving Fees', PROVING_TO_TACIT: 'Proving Fees To Tacit Relay', PROVING_TO_OTHERS: 'Proving Fees To Third-Party Provers',
  GAS_RELAY: 'Gas Relay Fees', GAS_RELAY_TO_TACIT: 'Gas Relay Fees To Tacit Relay', GAS_RELAY_TO_OTHERS: 'Gas Relay Fees To Third-Party Solvers',
  SWAP: METRIC.SWAP_FEES, SWAP_TO_LPS: 'Token Swap Fees To LPs', SWAP_TO_CREATORS: 'Token Swap Fees To Pool Creators',
}

// ConfidentialPool.sol PublicValues (version 1, Sourcify full match)
const CDP_LEG = 'tuple(bytes32 asset, uint256 value)'
export const PV_TYPE = `tuple(uint16 version, bytes32 chainBinding, bytes32 spendRoot, bytes32[] nullifiers, bytes32[] leaves, bytes32[] depositsConsumed,
 tuple(bytes32 assetId, address recipient, uint256 value)[] withdrawals, tuple(bytes32 assetId, uint256 value)[] fees, bytes32[] bitcoinBurnsConsumed,
 tuple(uint16 destChain, bytes32 destCommitment, bytes32 nullifier, bytes32 assetId, bytes32 claimId)[] crossOuts, bytes32[] bitcoinRootsUsed,
 bytes32 bitcoinSpentRoot, bytes32 bitcoinBurnRoot,
 tuple(bytes32 poolId, uint256 reserveAPre, uint256 reserveBPre, uint256 reserveAPost, uint256 reserveBPost, uint256 cutA, uint256 cutB)[] swaps,
 tuple(bytes32 poolId, uint256 reserveAPre, uint256 reserveBPre, uint256 sharesPre, uint256 reserveAPost, uint256 reserveBPost, uint256 sharesPost)[] liquidity,
 uint64 deadline, bytes32 lockSetRoot, bytes32[] lockLeaves, bytes32[] lockNullifiers, bytes32[] adaptorClaimS, uint64 refundNotBefore, bytes32 cdpPositionRoot,
 tuple(address controller, bytes32 debtAsset, uint256 debtValue, bytes32 positionLeaf, uint256 rateSnapshot, ${CDP_LEG}[] legs, bytes32 owner)[] cdpMints,
 tuple(address controller, uint256 debtValue, uint256 repaid, uint256 rateSnapshot, bytes32 positionNullifier, ${CDP_LEG}[] legs)[] cdpCloses,
 tuple(address controller, uint256 debtValue, uint256 repaid, uint256 rateSnapshot, bytes32 positionNullifier, ${CDP_LEG}[] legs)[] cdpLiquidations,
 tuple(address controller, uint256 debtValue, uint256 rateSnapshot, bytes32 oldPositionNullifier, bytes32 newPositionLeaf, ${CDP_LEG}[] oldLegs, ${CDP_LEG}[] newLegs)[] cdpTopups,
 tuple(bytes32 outpoint, uint256 vBtc, bytes32 commitment)[] cbtcMints, bytes32 memoRoot, bytes32[] bitcoinConsumedSources, bytes32[] bitcoinBurnIdsConsumed,
 bytes32[] harvestActionIds)`.replace(/\s+/g, ' ')

const PERMIT_SINGLE = '((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline)'
const INTENT = '(address payer, bytes32 opId, uint256 floorFee, uint256 maxFee, uint64 start, uint64 rampSecs, uint64 deadline, bytes32 tank)'
// verified functions that pass publicValues into ConfidentialPool.settle
export const SETTLE_CALLERS: Record<string, Interface> = {
  [POOL.toLowerCase()]: new Interface([
    'function settle(bytes publicValues, bytes proofBytes, bytes[] memos)',
    'function createPairAndSettle(bytes32 assetA, bytes32 assetB, uint32 feeBps, bytes publicValues, bytes proofBytes, bytes[] memos)',
  ]),
  [ROUTER.toLowerCase()]: new Interface([
    'function exitAndExecute(bytes publicValues, bytes proofBytes, bytes[] memos, (bytes32 exitedAsset, address feeAsset, address finalRecipient, uint64 deadline, uint256 nonce, (address target, uint256 value, address token, uint256 amount, bool push, bytes data)[] calls, address[] sweepTokens, uint256[] minOuts) recipe)',
    'function wrapAndMintCusdWithPermit(address token, uint256 amount, bytes32 commit, uint256 deadline, uint8 v, bytes32 r, bytes32 s, bytes publicValues, bytes proof, bytes[] memos)',
    `function wrapAndMintCusdWithPermit2(address token, uint256 amount, bytes32 commit, ${PERMIT_SINGLE} permitSingle, bytes signature, bytes publicValues, bytes proof, bytes[] memos)`,
    'function wrapAndSettleETH(uint256 wrapAmount, bytes32 commit, bytes publicValues, bytes proof, bytes[] memos, address feeRecipient) payable',
    'function wrapAndSettleWithPermit(address token, uint256 amount, bytes32 commit, uint256 deadline, uint8 v, bytes32 r, bytes32 s, bytes publicValues, bytes proof, bytes[] memos, address feeRecipient) payable',
    `function wrapAndSettleWithPermit2(address token, uint256 amount, bytes32 commit, ${PERMIT_SINGLE} permitSingle, bytes signature, bytes publicValues, bytes proof, bytes[] memos, address feeRecipient) payable`,
    'function wrapETHAndMintCusd(bytes32 commit, bytes publicValues, bytes proof, bytes[] memos) payable',
    'function zapETHIntoFarm(address tokenB, uint32 feeBps, uint256 ethLeg, uint256 tokenBLeg, uint256 minShares, uint64 deadline, bytes32 commit, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos) payable',
    'function zapETHToCanonicalCdpMint(bytes32 assetId, uint256 wrapAmount, bytes32 commit, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos) payable',
    'function zapETHToCdpMint(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos) payable',
    'function zapETHToPayment(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos) payable',
    `function zapTokenIntoFarm((address tokenB, uint32 feeBps, uint256 tokenAForSwap, uint256 tokenAForLP, uint256 tokenBLeg, uint256 minShares, uint64 deadline, bytes32 commit) z, ${PERMIT_SINGLE} permitSingle, bytes signature, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos)`,
    `function zapTokenToCanonicalCdpMintWithPermit2(bytes32 assetId, uint256 amountIn, uint256 wrapAmount, bytes32 commit, ${PERMIT_SINGLE} permitSingle, bytes signature, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos)`,
    `function zapTokenToCdpMintWithPermit2(address tokenOut, uint256 amountIn, uint256 wrapAmount, bytes32 commit, ${PERMIT_SINGLE} permitSingle, bytes signature, bytes zrSwapData, bytes publicValues, bytes proof, bytes[] memos)`,
  ]),
  [SETTLE_TIP_FORWARDER.toLowerCase()]: new Interface(['function settleWithTip(bytes publicValues, bytes proofBytes, bytes[] memos, address tipRecipient) payable']),
  [PROOF_MARKET.toLowerCase()]: new Interface([
    `function fulfill(${INTENT} i, bytes signature, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)`,
    `function fulfillFromTank((address payer, address delegate, uint256 cap, uint256 perOpMax, uint64 expiry, uint256 salt) t, bytes tankSig, ${INTENT} i, bytes intentSig, bytes publicValues, bytes proofBytes, bytes[] memos, uint8 v, bytes32 r, bytes32 s)`,
  ]),
}

export const EVENTS = {
  nullifiersSpent: 'event NullifiersSpent(bytes32[] nullifiers)',
  leavesInserted: 'event LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos)',
  assetRegistered: 'event AssetRegistered(bytes32 indexed assetId, address indexed underlying, uint256 unitScale, string name, string symbol, uint8 decimals)',
  transact: 'event Transact(bytes32 indexed nf0, bytes32 indexed nf1, bytes32 outLeaf0, bytes32 outLeaf1, uint256 firstIndex, bytes32 newRoot, address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1)',
  wrappedWithTip: 'event WrappedWithTip(bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient)',
  tokenWrappedWithTip: 'event WrappedWithTip(bytes32 indexed assetId, bytes32 indexed depositCommit, uint256 amount, uint256 tip, address indexed tipRecipient)',
  settledWithTip: 'event SettledWithTip(address indexed caller, uint256 tip, address indexed tipRecipient)',
  escrowSettledWithTip: 'event EscrowSettledWithTip(bytes32 indexed outpoint, uint256 stakeAmount, uint256 tip, address indexed tipRecipient)',
  fulfilled: 'event Fulfilled(bytes32 indexed opId, address indexed payer, address indexed solver, uint256 price)',
  executed: 'event Executed(address indexed payer, address indexed submitter, uint256 indexed nonce, address feeToken, uint256 fee)',
  bought: 'event Bought(uint8 indexed venue, uint256 ethIn, uint256 tacOut)',
  transfer: 'event Transfer(address indexed from, address indexed to, uint256 value)',
}
export const POOLS_ABI = 'function pools(bytes32) view returns (bool init, bytes32 assetA, bytes32 assetB, uint256 reserveA, uint256 reserveB, uint32 feeBps, uint256 totalShares)'
const ASSETS_ABI = 'function assets(bytes32) view returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals)'
export const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)')
export const coder = AbiCoder.defaultAbiCoder()

export type Out = { dailyFees: Balances, dailyRevenue: Balances, dailySupplySideRevenue: Balances, dailyVolume: Balances }
export type Asset = { underlying: string, unitScale: bigint, poolMinted: boolean }
export type Settle = { hash: string, block: number, logIndex: number, from: string, pv: any, skim?: { fee: bigint, recipient: string } }

export const blockOf = (log: any) => Number(log.blockNumber)
export const hashOf = (log: any) => String(log.transactionHash).toLowerCase()
export function logIndexOf(log: any): number {
  const index = Number(log.logIndex ?? log.index)
  if (!Number.isInteger(index)) throw new Error(`tacit: log without a log index in ${log.transactionHash}`)
  return index
}

export function addAsset(balances: Balances, asset: Asset, amount: bigint, label?: string) {
  if (asset.underlying === ZeroAddress) balances.addGasToken(amount, label)
  else balances.add(asset.underlying.toLowerCase() === WTAC.toLowerCase() ? TAC : asset.underlying, amount, label)
}

export function addSplit(out: Out, isTacit: boolean, add: (b: Balances, label: string) => void, labels: [string, string, string]) {
  add(out.dailyFees, labels[0])
  if (isTacit) add(out.dailyRevenue, labels[1])
  else add(out.dailySupplySideRevenue, labels[2])
}

export async function loadAssets(options: FetchOptions, assetIds: string[]): Promise<Record<string, Asset>> {
  const unique = [...new Set(assetIds.map((a) => a.toLowerCase()))]
  const rows = await options.toApi.multiCall({ abi: ASSETS_ABI, target: POOL, calls: unique })
  const out: Record<string, Asset> = {}
  unique.forEach((id, i) => {
    if (!rows[i]?.registered) throw new Error(`tacit: asset ${id} is not registered in the pool`)
    out[id] = { underlying: String(rows[i].underlying).toLowerCase(), unitScale: BigInt(rows[i].unitScale), poolMinted: rows[i].poolMinted }
  })
  return out
}
