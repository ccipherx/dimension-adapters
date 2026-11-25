import { ZeroAddress } from 'ethers'
import { FetchOptions, SimpleAdapter } from '../../adapters/types'
import { CHAIN } from '../../helpers/chains'
import { getTransactionsWithRetry } from '../../helpers/getTxReceipts'
import { addAmmSwaps } from './amm'
import {
  Asset, ESCROW_TIP_FORWARDERS, EVENTS, GAS_RELAY, LABEL, Out, POOL, PROOF_MARKET, PV_TYPE, SETTLE_CALLERS, SETTLE_TIP_FORWARDER, Settle,
  TAC, TACIT_RELAY, TACIT_TIP_RECIPIENTS, TACIT_TREASURY, WRAP_TIP_FORWARDER, WRAP_TOKEN_TIP_FORWARDER, addAsset, addSplit, blockOf, chainConfig,
  coder, hashOf, loadAssets, logIndexOf,
} from './config'

const MAX_SETTLE_TXS = 20_000
const PV_VERSION = 1n

// TacitEvmPool: one relayer fee per transact, paid from the shielded note in the pool's asset
async function addEvmPoolRelayFees(options: FetchOptions, out: Out) {
  const { keeper, evmPools } = chainConfig[options.chain]
  const assetOf = Object.fromEntries(Object.entries(evmPools).map(([pool, asset]) => [pool.toLowerCase(), asset]))
  const logs = await options.getLogs({ targets: Object.keys(evmPools), eventAbi: EVENTS.transact, onlyArgs: false })
  for (const log of logs) {
    const fee = BigInt(log.args.fee)
    if (fee === 0n) continue
    const token = assetOf[String(log.address ?? log.source).toLowerCase()]
    if (token === undefined) throw new Error(`tacit: Transact from unknown pool ${log.address ?? log.source}`)
    const asset = { underlying: token, unitScale: 1n, poolMinted: false }
    const isTacit = String(log.args.relayer).toLowerCase() === keeper.toLowerCase()
    addSplit(out, isTacit, (b, l) => addAsset(b, asset, fee, l), [LABEL.RELAY, LABEL.RELAY_TO_TACIT, LABEL.RELAY_TO_OTHERS])
  }
}

function decodeSettleTx(tx: any): { pv: any, skim?: { fee: bigint, recipient: string } } | null {
  const iface = SETTLE_CALLERS[String(tx.to ?? '').toLowerCase()]
  const parsed = iface?.parseTransaction({ data: tx.data, value: tx.value })
  if (!parsed) return null
  const pvHex: string = parsed.args.publicValues
  const [pv] = coder.decode([PV_TYPE], pvHex)
  if (BigInt(pv.version) !== PV_VERSION) throw new Error(`tacit: PublicValues version ${pv.version} in ${tx.hash}`)
  if (coder.encode([PV_TYPE], [pv]).toLowerCase() !== pvHex.toLowerCase()) throw new Error(`tacit: PublicValues round-trip mismatch in ${tx.hash}`)
  let skim
  // ConfidentialRouter._skimFee: the ETH sent on top of the wrap goes to the caller-named relay
  if (parsed.name === 'wrapAndSettleETH') skim = { fee: BigInt(tx.value) - BigInt(parsed.args.wrapAmount), recipient: parsed.args.feeRecipient }
  else if (parsed.name.startsWith('wrapAndSettleWithPermit')) skim = { fee: BigInt(tx.value), recipient: parsed.args.feeRecipient }
  return { pv, skim }
}

// every fee, swap and liquidity change sits only in settle() calldata, found via the pool's note events
async function loadSettles(options: FetchOptions): Promise<{ settles: Settle[], undecodedTxs: Map<string, number> }> {
  const [spent, inserted] = await Promise.all([
    options.getLogs({ target: POOL, eventAbi: EVENTS.nullifiersSpent, entireLog: true, parseLog: false }),
    options.getLogs({ target: POOL, eventAbi: EVENTS.leavesInserted, entireLog: true, parseLog: false }),
  ])
  const first = new Map<string, { block: number, logIndex: number }>()
  for (const log of [...spent, ...inserted]) {
    const seen = first.get(hashOf(log))
    if (!seen || logIndexOf(log) < seen.logIndex) first.set(hashOf(log), { block: blockOf(log), logIndex: logIndexOf(log) })
  }
  if (first.size > MAX_SETTLE_TXS) throw new Error(`tacit: ${first.size} settle txs exceeds the bound ${MAX_SETTLE_TXS}`)
  const hashes = [...first.keys()]
  const txs = await getTransactionsWithRetry(options.chain, hashes)
  const settles: Settle[] = []
  const undecodedTxs = new Map<string, number>()
  hashes.forEach((hash, i) => {
    const tx = txs[i]
    if (!tx) throw new Error(`tacit: transaction ${hash} not found on ${options.chain}`)
    const decoded = decodeSettleTx(tx)
    // third-party contracts (7702 relayers, 4337 bundlers) call settle internally and cannot be decoded from tx input
    if (!decoded) {
      undecodedTxs.set(hash, first.get(hash)!.block)
      return
    }
    settles.push({ hash, ...first.get(hash)!, from: String(tx.from).toLowerCase(), ...decoded })
  })
  return { settles, undecodedTxs }
}

// the settler earns the fee bound in the proof: Tacit's relay is revenue, an independent relay is supply side
function addSettleRelayFees(out: Out, settles: Settle[], assets: Record<string, Asset>) {
  for (const s of settles) {
    const recipients = s.pv.withdrawals.map((w: any) => String(w.recipient).toLowerCase())
    if (recipients.some((r: string) => TACIT_TREASURY.has(r))) continue
    const isTacit = TACIT_RELAY.has(s.from)
    // a sender that also takes the withdrawal pays the fee back to itself
    if (!isTacit && recipients.includes(s.from)) continue
    for (const f of s.pv.fees) {
      const asset = assets[String(f.assetId).toLowerCase()]
      const amount = BigInt(f.value) * asset.unitScale
      addSplit(out, isTacit, (b, l) => addAsset(b, asset, amount, l), [LABEL.RELAY, LABEL.RELAY_TO_TACIT, LABEL.RELAY_TO_OTHERS])
    }
  }
}

async function addTips(options: FetchOptions, out: Out, settles: Settle[]) {
  const eth: Asset = { underlying: ZeroAddress, unitScale: 1n, poolMinted: false }
  const [wrapTips, tokenWrapTips, settleTips, escrowTips] = await Promise.all([
    options.getLogs({ target: WRAP_TIP_FORWARDER, eventAbi: EVENTS.wrappedWithTip }),
    options.getLogs({ target: WRAP_TOKEN_TIP_FORWARDER, eventAbi: EVENTS.tokenWrappedWithTip }),
    options.getLogs({ target: SETTLE_TIP_FORWARDER, eventAbi: EVENTS.settledWithTip }),
    options.getLogs({ targets: ESCROW_TIP_FORWARDERS, eventAbi: EVENTS.escrowSettledWithTip }),
  ])
  const tips: { fee: bigint, recipient: string }[] = [...wrapTips, ...tokenWrapTips, ...settleTips, ...escrowTips]
    .map((e: any) => ({ fee: BigInt(e.tip), recipient: e.tipRecipient }))
  for (const s of settles) if (s.skim) tips.push(s.skim)
  for (const t of tips) {
    if (t.fee <= 0n || t.recipient === ZeroAddress) continue
    const isTacit = TACIT_TIP_RECIPIENTS.has(t.recipient.toLowerCase())
    addSplit(out, isTacit, (b, l) => addAsset(b, eth, t.fee, l), [LABEL.TIPS, LABEL.TIPS_TO_TACIT, LABEL.TIPS_TO_OTHERS])
  }
}

async function addProvingFees(options: FetchOptions, out: Out) {
  const tac: Asset = { underlying: TAC, unitScale: 1n, poolMinted: true }
  const fills = await options.getLogs({ target: PROOF_MARKET, eventAbi: EVENTS.fulfilled })
  for (const f of fills) {
    const isTacit = TACIT_RELAY.has(String(f.solver).toLowerCase())
    addSplit(out, isTacit, (b, l) => addAsset(b, tac, BigInt(f.price), l), [LABEL.PROVING, LABEL.PROVING_TO_TACIT, LABEL.PROVING_TO_OTHERS])
  }
}

// TacitGasRelay: a signed order pays its submitter a fee in TAC or the token it spends
async function addGasRelayFees(options: FetchOptions, out: Out) {
  const orders = await options.getLogs({ target: GAS_RELAY, eventAbi: EVENTS.executed })
  for (const o of orders) {
    const fee = BigInt(o.fee)
    if (fee === 0n) continue
    const asset: Asset = { underlying: String(o.feeToken).toLowerCase(), unitScale: 1n, poolMinted: false }
    const isTacit = TACIT_RELAY.has(String(o.submitter).toLowerCase())
    addSplit(out, isTacit, (b, l) => addAsset(b, asset, fee, l), [LABEL.GAS_RELAY, LABEL.GAS_RELAY_TO_TACIT, LABEL.GAS_RELAY_TO_OTHERS])
  }
}

const fetch = async (options: FetchOptions) => {
  const out: Out = {
    dailyFees: options.createBalances(), dailyRevenue: options.createBalances(),
    dailySupplySideRevenue: options.createBalances(), dailyVolume: options.createBalances(),
  }
  await addEvmPoolRelayFees(options, out)
  if (options.chain === CHAIN.ETHEREUM) {
    const { settles, undecodedTxs } = await loadSettles(options)
    const feeAssets = await loadAssets(options, settles.flatMap((s) => s.pv.fees.map((f: any) => String(f.assetId))))
    addSettleRelayFees(out, settles, feeAssets)
    await addTips(options, out, settles)
    await addProvingFees(options, out)
    await addGasRelayFees(options, out)
    await addAmmSwaps(options, out, settles, undecodedTxs)
  }
  return {
    dailyFees: out.dailyFees,
    dailyUserFees: out.dailyFees.clone(),
    dailyRevenue: out.dailyRevenue,
    dailyProtocolRevenue: out.dailyRevenue.clone(),
    dailySupplySideRevenue: out.dailySupplySideRevenue,
    dailyVolume: out.dailyVolume,
  }
}

const methodology = {
  Fees: 'Relay fees and tips users pay to have their private Tacit transactions proved and submitted, TAC paid through ProofMarket for proving, fees on gasless TacitGasRelay orders, and swap fees on Tacit\'s own AMM pools. Excludes fees a sender pays back to itself.',
  UserFees: 'All relay fees, tips, proving fees, gas relay fees and swap fees, paid directly by Tacit users.',
  Revenue: 'Relay fees, tips, proving fees and gas relay fees collected by Tacit\'s own relay, keeper and splitter wallets. Gas and proving costs the relay pays are not deducted.',
  ProtocolRevenue: 'Relay fees, tips, proving fees and gas relay fees collected by Tacit\'s own relay, keeper and splitter wallets, which the team operates. The 10% of relay income that buys back TAC stays inside protocol revenue because the bought TAC goes to the ops-multisig reserve.',
  SupplySideRevenue: 'Swap fees earned by Tacit AMM liquidity providers, plus relay, tip, proving and gas relay fees earned by independent relayers, provers and solvers.',
  Volume: 'Swaps on Tacit\'s own AMM. Private batch swaps count at the net amount each batch moves through the pool, because the size of each shielded trade is hidden. Public swaps are rebuilt one by one from the pool state and token transfers, and a block that cannot be rebuilt exactly counts its net change, so the total is a lower bound. Excludes deposits, withdrawals, liquidity changes, TacBuyback\'s own buys and swaps routed to outside venues.',
}

const breakdownMethodology = {
  Fees: {
    [LABEL.RELAY]: 'Fees users pay the relay that proves and submits their private transactions, taken from the shielded balance (ConfidentialPool settle fee payments and Tacit EVM pool relayer fees).',
    [LABEL.TIPS]: 'ETH tips users add when a relay settles their deposit into the Tacit pool, through the tip forwarders or the router.',
    [LABEL.PROVING]: 'TAC users pay through ProofMarket to have an operation proved and settled.',
    [LABEL.GAS_RELAY]: 'Fees users pay in TAC or the spent token to have a gasless TacitGasRelay order submitted.',
    [LABEL.SWAP]: 'The pool fee on the input of each swap on Tacit\'s AMM pools.',
  },
  UserFees: {
    [LABEL.RELAY]: 'Relay fees paid by users from their shielded balance.',
    [LABEL.TIPS]: 'ETH tips paid by users for relayed deposits.',
    [LABEL.PROVING]: 'TAC paid by users for proving.',
    [LABEL.GAS_RELAY]: 'Fees paid by users for gasless orders.',
    [LABEL.SWAP]: 'Swap fees paid by traders on Tacit\'s AMM pools.',
  },
  Revenue: {
    [LABEL.RELAY_TO_TACIT]: 'Relay fees collected by Tacit\'s settle wallets and EVM pool keepers.',
    [LABEL.TIPS_TO_TACIT]: 'Tips paid to Tacit\'s ops multisig, relay wallet or EthSplitter.',
    [LABEL.PROVING_TO_TACIT]: 'ProofMarket payments to Tacit\'s settle wallet acting as prover.',
    [LABEL.GAS_RELAY_TO_TACIT]: 'Gas relay fees earned by Tacit\'s relay wallets as the order submitter.',
  },
  ProtocolRevenue: {
    [LABEL.RELAY_TO_TACIT]: 'Relay fees collected by Tacit\'s settle wallets and EVM pool keepers.',
    [LABEL.TIPS_TO_TACIT]: 'Tips paid to Tacit\'s ops multisig, relay wallet or EthSplitter.',
    [LABEL.PROVING_TO_TACIT]: 'ProofMarket payments to Tacit\'s settle wallet acting as prover.',
    [LABEL.GAS_RELAY_TO_TACIT]: 'Gas relay fees earned by Tacit\'s relay wallets as the order submitter.',
  },
  SupplySideRevenue: {
    [LABEL.RELAY_TO_OTHERS]: 'Relay fees earned by independent relayers that settle other users\' proofs or relay on the Tacit EVM pools.',
    [LABEL.TIPS_TO_OTHERS]: 'Tips paid to relays that are not Tacit\'s.',
    [LABEL.PROVING_TO_OTHERS]: 'ProofMarket payments to provers that are not Tacit\'s.',
    [LABEL.GAS_RELAY_TO_OTHERS]: 'Gas relay fees earned by independent order submitters.',
    [LABEL.SWAP_TO_LPS]: 'Swap fees kept in the pool reserves for liquidity providers.',
    [LABEL.SWAP_TO_CREATORS]: 'The protocol-fee cut of swap fees paid to the creator of a protocol-fee pool.',
  },
}

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  adapter: chainConfig,
  methodology,
  breakdownMethodology,
}

export default adapter
