import { ChainApi } from '@defillama/sdk'
import { ZeroAddress, keccak256, zeroPadValue } from 'ethers'
import { FetchOptions } from '../../adapters/types'
import {
  AMM_DEFAULT_FEE_BPS, Asset, BPS, EVENTS, LABEL, MAX_POOL_FEE_BPS, Out, POOL, POOLS_ABI, POOL_DEPLOY_BLOCK, PUBLIC_AMM, Settle,
  TACIT_TOKENS, TAC_BUYBACK, TRANSFER_TOPIC, addAsset, blockOf, coder, hashOf, loadAssets, logIndexOf,
} from './config'

const MAX_CANDIDATE_BLOCKS = 5_000
const MAX_UNITS_PER_BLOCK = 256 // settles plus public legs replayed in one block
const MAX_SEARCH_STEPS = 4_000 // interpretation branches tried per block before falling back to the net change
const MAX_DISCOVERY_TOKENS = 3 // each token scans about 22k pool ids

type PoolState = { a: bigint, b: bigint, s: bigint }
type PoolInfo = { assetA: string, assetB: string, feeBps: bigint }
type Leg = { tx: string, block: number, logIndex: number, assetId: string, dir: 'in' | 'out', amount: bigint }
type Hop = { pool: string, inIsA: boolean, vIn: bigint, vOut: bigint, tx: string }
type Checkpoint = { pool: string, pre: PoolState, post: PoolState, withShares: boolean }
type Unit = { logIndex: number, checkpoints?: Checkpoint[], tx?: string, legs?: Leg[] }
type States = Record<string, PoolState>
type Ctx = { info: Record<string, PoolInfo>, assets: Record<string, Asset>, ethAsset: string, pairs: Map<string, string[]> }

const ZERO: PoolState = { a: 0n, b: 0n, s: 0n }
const add3 = (x: PoolState, y: PoolState): PoolState => ({ a: x.a + y.a, b: x.b + y.b, s: x.s + y.s })
const sub3 = (x: PoolState, y: PoolState): PoolState => ({ a: x.a - y.a, b: x.b - y.b, s: x.s - y.s })
const eq3 = (x: PoolState, y: PoolState) => x.a === y.a && x.b === y.b && x.s === y.s
const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)
const poolIdOf = (x: string, y: string, fee: bigint) => keccak256(coder.encode(['bytes32', 'bytes32', 'uint32'], x < y ? [x, y, fee] : [y, x, fee]))

// TacitPublicAmm._ammOut: floor(rOut * vIn * (1 - f) / (rIn + vIn * (1 - f))), zero or full drain reverts
function ammOut(rIn: bigint, rOut: bigint, vIn: bigint, fee: bigint): bigint | null {
  if (vIn <= 0n) return null
  const g = vIn * (BPS - fee)
  const out = (rOut * g) / (rIn * BPS + g)
  return out === 0n || out >= rOut ? null : out
}

// smallest input that yields exactly vOut, null when no input does
function ammIn(rIn: bigint, rOut: bigint, vOut: bigint, fee: bigint): bigint | null {
  if (vOut <= 0n || vOut >= rOut) return null
  const num = vOut * rIn * BPS
  const den = (BPS - fee) * (rOut - vOut)
  const vIn = (num + den - 1n) / den
  return ammOut(rIn, rOut, vIn, fee) === vOut ? vIn : null
}

async function readStates(chain: string, block: number, ids: string[]): Promise<States> {
  if (block < POOL_DEPLOY_BLOCK) return Object.fromEntries(ids.map((id) => [id, ZERO]))
  const rows = await new ChainApi({ chain, block }).multiCall({ abi: POOLS_ABI, target: POOL, calls: ids })
  return Object.fromEntries(ids.map((id, i) => [id, { a: BigInt(rows[i].reserveA), b: BigInt(rows[i].reserveB), s: BigInt(rows[i].totalShares) }]))
}

async function initializedPools(options: FetchOptions, candidates: string[]): Promise<Record<string, PoolInfo>> {
  const rows = candidates.length ? await options.toApi.multiCall({ abi: POOLS_ABI, target: POOL, calls: candidates }) : []
  const info: Record<string, PoolInfo> = {}
  candidates.forEach((id, i) => {
    if (rows[i].init) info[id] = { assetA: String(rows[i].assetA).toLowerCase(), assetB: String(rows[i].assetB).toLowerCase(), feeBps: BigInt(rows[i].feeBps) }
  })
  return info
}

// public pools use the canonical id of a registered pair, so scanning every tier of a token's pairs finds all of them
async function discoverPools(options: FetchOptions, tokens: string[], registered: string[], known: Set<string>) {
  if (tokens.length > MAX_DISCOVERY_TOKENS) throw new Error(`tacit: ${tokens.length} tokens need pool discovery, the bound is ${MAX_DISCOVERY_TOKENS}`)
  const candidates = new Set<string>()
  for (const x of tokens) for (const y of registered) {
    if (x === y) continue
    for (let fee = 1; fee <= MAX_POOL_FEE_BPS; fee++) {
      const id = poolIdOf(x, y, BigInt(fee))
      if (!known.has(id)) candidates.add(id)
    }
  }
  return initializedPools(options, [...candidates])
}

// pool-asset tokens moved by TacitPublicAmm into the pool (in) or paid out by the pool outside settles (out)
async function loadPublicLegs(options: FetchOptions, assets: Record<string, Asset>, registered: string[], settles: Settle[], undecodedTxs: Set<string>): Promise<Leg[]> {
  const byToken: Record<string, string> = {}
  for (const id of registered) if (assets[id].underlying !== ZeroAddress) byToken[assets[id].underlying] = id
  const tokens = Object.keys(byToken)
  const minted = tokens.filter((t) => assets[byToken[t]].poolMinted)
  const escrow = tokens.filter((t) => !assets[byToken[t]].poolMinted)
  const query = (targets: string[], topics: (string | null)[]) => targets.length
    ? options.getLogs({ targets, topics, eventAbi: EVENTS.transfer, entireLog: true, parseLog: false })
    : Promise.resolve([])
  const [fromAmm, mints, fromPool] = await Promise.all([
    query(tokens, [TRANSFER_TOPIC, zeroPadValue(PUBLIC_AMM, 32)]),
    query(minted, [TRANSFER_TOPIC, zeroPadValue(ZeroAddress, 32)]),
    query(escrow, [TRANSFER_TOPIC, zeroPadValue(POOL, 32)]),
  ])
  const ingestTo = new Set([zeroPadValue(POOL, 32).toLowerCase(), zeroPadValue(ZeroAddress, 32).toLowerCase()])
  const toLeg = (log: any, dir: 'in' | 'out'): Leg => ({
    tx: hashOf(log), block: blockOf(log), logIndex: logIndexOf(log), dir, amount: BigInt(log.data),
    assetId: byToken[String(log.address ?? log.source).toLowerCase()],
  })
  const legs = [
    ...fromAmm.filter((l: any) => ingestTo.has(String(l.topics[2]).toLowerCase())).map((l: any) => toLeg(l, 'in')),
    ...[...mints, ...fromPool].map((l: any) => toLeg(l, 'out')),
  ].filter((l) => !undecodedTxs.has(l.tx))
  // a decoded settle pays its withdrawals and fees itself, so those payouts are not public AMM legs
  const settleByHash = new Map(settles.map((s) => [s.hash, s]))
  const expected = new Map<string, bigint[]>()
  for (const s of settles) for (const p of [...s.pv.withdrawals, ...s.pv.fees]) {
    const asset = assets[String(p.assetId).toLowerCase()]
    if (asset.underlying === ZeroAddress) continue
    const key = `${s.hash}:${byToken[asset.underlying]}`
    expected.set(key, [...(expected.get(key) ?? []), BigInt(p.value) * asset.unitScale])
  }
  return legs.filter((l) => {
    if (l.dir !== 'out' || !settleByHash.has(l.tx)) return true
    const pending = expected.get(`${l.tx}:${l.assetId}`) ?? []
    const i = pending.indexOf(l.amount)
    if (i < 0) return true
    pending.splice(i, 1)
    return false
  }).sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

function swapStep(ctx: Ctx, states: States, pool: string, inAsset: string, vIn: bigint | null, vOut: bigint | null, tx: string): { states: States, hop: Hop } | null {
  const p = states[pool]
  const { assetA, feeBps } = ctx.info[pool]
  const inIsA = assetA === inAsset
  const [rIn, rOut] = inIsA ? [p.a, p.b] : [p.b, p.a]
  const vin = vIn ?? (vOut === null ? null : ammIn(rIn, rOut, vOut, feeBps))
  if (vin === null) return null
  const vout = ammOut(rIn, rOut, vin, feeBps)
  if (vout === null || (vOut !== null && vout !== vOut)) return null
  const next = inIsA ? { a: p.a + vin, b: p.b - vout, s: p.s } : { a: p.a - vout, b: p.b + vin, s: p.s }
  return { states: { ...states, [pool]: next }, hop: { pool, inIsA, vIn: vin, vOut: vout, tx } }
}

function legValue(ctx: Ctx, leg: Leg): bigint | null {
  const scale = ctx.assets[leg.assetId].unitScale
  return leg.amount % scale === 0n ? leg.amount / scale : null
}

// every way the next leg (or the next two) can be one or two swaps through known pools, ETH legs being implicit
function legOptions(ctx: Ctx, states: States, legs: Leg[], i: number, tx: string): { consumed: number, states: States, hops: Hop[] }[] {
  const leg = legs[i]
  const v = legValue(ctx, leg)
  if (v === null) return []
  const eth = ctx.ethAsset
  const pools = (x: string, y: string) => ctx.pairs.get(pairKey(x, y)) ?? []
  const options: { consumed: number, states: States, hops: Hop[] }[] = []
  if (leg.dir === 'out') {
    for (const pool of pools(eth, leg.assetId)) {
      const r = swapStep(ctx, states, pool, eth, null, v, tx)
      if (r) options.push({ consumed: 1, states: r.states, hops: [r.hop] })
    }
    return options
  }
  const next = legs[i + 1]
  const vNext = next && next.dir === 'out' && next.assetId !== leg.assetId ? legValue(ctx, next) : null
  if (vNext !== null) {
    for (const pool of pools(leg.assetId, next.assetId)) {
      const r = swapStep(ctx, states, pool, leg.assetId, v, vNext, tx)
      if (r) options.push({ consumed: 2, states: r.states, hops: [r.hop] })
    }
    for (const p1 of pools(leg.assetId, eth)) for (const p2 of pools(eth, next.assetId)) {
      const r1 = swapStep(ctx, states, p1, leg.assetId, v, null, tx)
      const r2 = r1 && swapStep(ctx, r1.states, p2, eth, r1.hop.vOut, vNext, tx)
      if (r1 && r2) options.push({ consumed: 2, states: r2.states, hops: [r1.hop, r2.hop] })
    }
  }
  for (const pool of pools(leg.assetId, eth)) {
    const r = swapStep(ctx, states, pool, leg.assetId, v, null, tx)
    if (r) options.push({ consumed: 1, states: r.states, hops: [r.hop] })
  }
  return options
}

// replay a block's settles and public legs in log order, accepting only an interpretation that lands exactly on the block's end state
function replayBlock(ctx: Ctx, units: Unit[], before: States, after: States, ids: string[]): Hop[] | null {
  const totalUnits = units.reduce((n, u) => n + (u.legs?.length ?? u.checkpoints!.length), 0)
  if (totalUnits > MAX_UNITS_PER_BLOCK) return null
  let steps = 0
  const solve = (u: number, l: number, states: States, depth: number): Hop[] | null => {
    if (depth > totalUnits + units.length) throw new Error('tacit: replay depth exceeded its bound')
    if (++steps > MAX_SEARCH_STEPS) return null
    if (u === units.length) return ids.every((id) => eq3(states[id], after[id])) ? [] : null
    const unit = units[u]
    if (unit.checkpoints) {
      let s = states
      for (const c of unit.checkpoints) {
        const cur = s[c.pool]
        if (cur.a !== c.pre.a || cur.b !== c.pre.b || (c.withShares && cur.s !== c.pre.s)) return null
        s = { ...s, [c.pool]: { a: c.post.a, b: c.post.b, s: c.withShares ? c.post.s : cur.s } }
      }
      return solve(u + 1, 0, s, depth + 1)
    }
    if (l === unit.legs!.length) return solve(u + 1, 0, states, depth + 1)
    for (const option of legOptions(ctx, states, unit.legs!, l, unit.tx!)) {
      const rest = solve(u, l + option.consumed, option.states, depth + 1)
      if (rest) return [...option.hops, ...rest]
    }
    return null
  }
  return solve(0, 0, before, 0)
}

// one side of a swap valued in its best-priced leg, and the pool fee expressed in that same leg
function addSwap(out: Out, ctx: Ctx, pool: string, inA: bigint, inB: bigint, cutIn: bigint) {
  const info = ctx.info[pool]
  const aIsInput = inA > 0n
  const [inId, outId, amountIn, amountOut] = aIsInput ? [info.assetA, info.assetB, inA, -inB] : [info.assetB, info.assetA, inB, -inA]
  const rank = (id: string) => (ctx.assets[id].underlying === ZeroAddress ? 0 : TACIT_TOKENS.has(ctx.assets[id].underlying) ? 2 : 1)
  const useInput = rank(inId) <= rank(outId)
  const leg = useInput ? ctx.assets[inId] : ctx.assets[outId]
  // Uniswap v2 math: fee = in * f, and out is worth in * (1 - f) at the trade's own execution price
  const fee = useInput ? (amountIn * info.feeBps) / BPS : (amountOut * info.feeBps) / (BPS - info.feeBps)
  const feeIn = (amountIn * info.feeBps) / BPS
  const cut = feeIn > 0n ? (fee * cutIn) / feeIn : 0n
  addAsset(out.dailyVolume, leg, (useInput ? amountIn : amountOut) * leg.unitScale)
  addAsset(out.dailyFees, leg, fee * leg.unitScale, LABEL.SWAP)
  addAsset(out.dailySupplySideRevenue, leg, (fee - cut) * leg.unitScale, LABEL.SWAP_TO_LPS)
  if (cut > 0n) addAsset(out.dailySupplySideRevenue, leg, cut * leg.unitScale, LABEL.SWAP_TO_CREATORS)
}

function checkpointsOf(s: Settle): Checkpoint[] {
  const swaps = s.pv.swaps.map((x: any) => ({ pool: String(x.poolId).toLowerCase(), withShares: false, pre: { a: BigInt(x.reserveAPre), b: BigInt(x.reserveBPre), s: 0n }, post: { a: BigInt(x.reserveAPost), b: BigInt(x.reserveBPost), s: 0n } }))
  const liquidity = s.pv.liquidity.map((x: any) => ({ pool: String(x.poolId).toLowerCase(), withShares: true, pre: { a: BigInt(x.reserveAPre), b: BigInt(x.reserveBPre), s: BigInt(x.sharesPre) }, post: { a: BigInt(x.reserveAPost), b: BigInt(x.reserveBPost), s: BigInt(x.sharesPost) } }))
  // ConfidentialPool._settle applies every swap settlement before every liquidity settlement
  return [...swaps, ...liquidity]
}

type Measured = { swaps: { pool: string, inA: bigint, inB: bigint, cut: bigint }[], unexplainedTokens: string[] }

async function measure(options: FetchOptions, ctx: Ctx, ids: string[], settles: Settle[], undecodedTxs: Map<string, number>, legs: Leg[], buyback: { txs: Set<string>, deltas: Map<string, PoolState> }): Promise<Measured> {
  const swaps: Measured['swaps'] = []
  for (const s of settles) for (const x of s.pv.swaps) {
    const inA = BigInt(x.reserveAPost) - BigInt(x.reserveAPre) + BigInt(x.cutA)
    const inB = BigInt(x.reserveBPost) - BigInt(x.reserveBPre) + BigInt(x.cutB)
    if (inA === 0n && inB === 0n) continue
    if ((inA > 0n) === (inB > 0n)) throw new Error(`tacit: swap settlement with same-sign reserve moves in ${s.hash}`)
    swaps.push({ pool: String(x.poolId).toLowerCase(), inA, inB, cut: inA > 0n ? BigInt(x.cutA) : BigInt(x.cutB) })
  }
  const settleDelta = new Map<string, PoolState>()
  const settleUnits = new Map<number, Unit[]>()
  for (const s of settles) {
    const cps = checkpointsOf(s)
    for (const c of cps) settleDelta.set(`${s.block}:${c.pool}`, add3(settleDelta.get(`${s.block}:${c.pool}`) ?? ZERO, { a: c.post.a - c.pre.a, b: c.post.b - c.pre.b, s: c.withShares ? c.post.s - c.pre.s : 0n }))
    if (cps.length) settleUnits.set(s.block, [...(settleUnits.get(s.block) ?? []), { logIndex: s.logIndex, checkpoints: cps }])
  }
  const legsByBlock = new Map<number, Leg[]>()
  for (const l of legs) legsByBlock.set(l.block, [...(legsByBlock.get(l.block) ?? []), l])
  const undecodedBlocks = new Set(undecodedTxs.values())
  const blocks = [...new Set([...legsByBlock.keys(), ...undecodedBlocks])].sort((x, y) => x - y)
  if (blocks.length > MAX_CANDIDATE_BLOCKS) throw new Error(`tacit: ${blocks.length} candidate blocks exceeds the bound ${MAX_CANDIDATE_BLOCKS}`)

  const memo = new Map<number, States>()
  const stateAt = async (b: number) => {
    if (!memo.has(b)) memo.set(b, await readStates(options.chain, b, ids))
    return memo.get(b)!
  }
  const explained: States = Object.fromEntries(ids.map((id) => [id, ZERO]))
  for (const [key, d] of settleDelta) {
    const id = key.split(':')[1]
    if (!explained[id]) throw new Error(`tacit: settle touched pool ${id} that is not initialized`)
    explained[id] = add3(explained[id], d)
  }
  const flowGap: Record<string, bigint> = {}
  for (const block of blocks) {
    const [before, after] = [await stateAt(block - 1), await stateAt(block)]
    const residual = Object.fromEntries(ids.map((id) => [id, sub3(sub3(after[id], before[id]), settleDelta.get(`${block}:${id}`) ?? ZERO)]))
    for (const id of ids) explained[id] = add3(explained[id], residual[id])
    const blockLegs = legsByBlock.get(block) ?? []
    if (!undecodedBlocks.has(block)) {
      // public token legs must match the public reserve change on known pools, else a pool is missing
      for (const l of blockLegs) flowGap[l.assetId] = (flowGap[l.assetId] ?? 0n) + (l.dir === 'in' ? l.amount : -l.amount)
      for (const id of ids) for (const [assetId, d] of [[ctx.info[id].assetA, residual[id].a], [ctx.info[id].assetB, residual[id].b]] as [string, bigint][]) {
        if (ctx.assets[assetId].underlying !== ZeroAddress) flowGap[assetId] = (flowGap[assetId] ?? 0n) - d * ctx.assets[assetId].unitScale
      }
      const units: Unit[] = [...(settleUnits.get(block) ?? [])]
      const byTx = new Map<string, Leg[]>()
      for (const l of blockLegs) byTx.set(l.tx, [...(byTx.get(l.tx) ?? []), l])
      for (const [tx, ls] of byTx) units.push({ logIndex: ls[0].logIndex, tx, legs: ls })
      units.sort((x, y) => x.logIndex - y.logIndex)
      const hops = blockLegs.length ? replayBlock(ctx, units, before, after, ids) : []
      if (hops) {
        for (const h of hops) if (!buyback.txs.has(h.tx)) swaps.push({ pool: h.pool, inA: h.inIsA ? h.vIn : -h.vOut, inB: h.inIsA ? -h.vOut : h.vIn, cut: 0n })
        continue
      }
    }
    // the block cannot be replayed exactly: count each pool's net public change when it is one clean swap
    for (const id of ids) {
      const r = residual[id]
      const bb = buyback.deltas.get(`${block}:${id}`) ?? ZERO
      const [dA, dB] = [r.a - bb.a, r.b - bb.b]
      if (r.s !== 0n || dA === 0n || dB === 0n || (dA > 0n) === (dB > 0n)) continue
      swaps.push({ pool: id, inA: dA, inB: dB, cut: 0n })
    }
  }
  const [start, end] = [await stateAt((await options.getFromBlock()) - 1), await stateAt(await options.getToBlock())]
  for (const id of ids) {
    if (!eq3(sub3(end[id], start[id]), explained[id])) throw new Error(`tacit: pool ${id} reserve change in the window is not explained by settles and public AMM activity`)
  }
  return { swaps, unexplainedTokens: Object.keys(flowGap).filter((t) => flowGap[t] !== 0n).sort() }
}

async function loadBuybacks(options: FetchOptions, ctx: Ctx): Promise<{ txs: Set<string>, deltas: Map<string, PoolState> }> {
  const buys = (await options.getLogs({ target: TAC_BUYBACK, eventAbi: EVENTS.bought, onlyArgs: false })).filter((l: any) => Number(l.args.venue) === 0)
  const txs = new Set<string>(buys.map(hashOf))
  const deltas = new Map<string, PoolState>()
  if (!buys.length) return { txs, deltas }
  const [poolId, ethAsset] = (await options.toApi.batchCall([{ target: TAC_BUYBACK, abi: 'bytes32:POOL_ID' }, { target: TAC_BUYBACK, abi: 'bytes32:ETH_ASSET' }])).map((x: string) => x.toLowerCase())
  const pool = ctx.info[poolId]
  if (!pool) throw new Error(`tacit: buyback pool ${poolId} not found`)
  const ethIsA = pool.assetA === ethAsset
  for (const l of buys) {
    const vIn = BigInt(l.args.ethIn) / ctx.assets[ethAsset].unitScale
    const vOut = BigInt(l.args.tacOut) / ctx.assets[ethIsA ? pool.assetB : pool.assetA].unitScale
    const key = `${blockOf(l)}:${poolId}`
    deltas.set(key, add3(deltas.get(key) ?? ZERO, ethIsA ? { a: vIn, b: -vOut, s: 0n } : { a: -vOut, b: vIn, s: 0n }))
  }
  return { txs, deltas }
}

export async function addAmmSwaps(options: FetchOptions, out: Out, settles: Settle[], undecodedTxs: Map<string, number>) {
  const registered = (await options.getLogs({ target: POOL, eventAbi: EVENTS.assetRegistered, fromBlock: POOL_DEPLOY_BLOCK, toBlock: await options.getToBlock(), cacheInCloud: true }))
    .map((r: any) => String(r.assetId).toLowerCase())
  const assetIds = [...new Set(registered)].sort()
  const candidates = new Set<string>()
  for (let i = 0; i < assetIds.length; i++) for (let j = i + 1; j < assetIds.length; j++) candidates.add(poolIdOf(assetIds[i], assetIds[j], AMM_DEFAULT_FEE_BPS))
  for (const s of settles) for (const x of [...s.pv.swaps, ...s.pv.liquidity]) candidates.add(String(x.poolId).toLowerCase())
  const info = await initializedPools(options, [...candidates])
  const settleAssets = settles.flatMap((s) => [...s.pv.withdrawals, ...s.pv.fees].map((p: any) => String(p.assetId)))
  const assets = await loadAssets(options, [...assetIds, ...settleAssets, ...Object.values(info).flatMap((p) => [p.assetA, p.assetB])])
  const ethAsset = assetIds.find((id) => assets[id].underlying === ZeroAddress)
  if (!ethAsset) throw new Error('tacit: native ETH asset is not registered')
  const legs = await loadPublicLegs(options, assets, assetIds, settles, new Set(undecodedTxs.keys()))
  const ctxOf = (pools: Record<string, PoolInfo>): Ctx => {
    const pairs = new Map<string, string[]>()
    for (const [id, p] of Object.entries(pools)) pairs.set(pairKey(p.assetA, p.assetB), [...(pairs.get(pairKey(p.assetA, p.assetB)) ?? []), id])
    return { info: pools, assets, ethAsset, pairs }
  }
  let ctx = ctxOf(info)
  const buyback = await loadBuybacks(options, ctx)
  let result = await measure(options, ctx, Object.keys(info), settles, undecodedTxs, legs, buyback)
  if (result.unexplainedTokens.length) {
    // public flows a known pool cannot explain: find the pool at another fee tier and measure again
    const found = await discoverPools(options, result.unexplainedTokens, assetIds, new Set(Object.keys(info)))
    if (Object.keys(found).length) {
      await loadAssets(options, Object.values(found).flatMap((p) => [p.assetA, p.assetB])).then((extra) => Object.assign(assets, extra))
      ctx = ctxOf({ ...info, ...found })
      result = await measure(options, ctx, Object.keys(ctx.info), settles, undecodedTxs, legs, buyback)
    }
  }
  for (const s of result.swaps) addSwap(out, ctx, s.pool, s.inA, s.inB, s.cut)
}
