// Stability metrics on one node's cube. Everything here is about revisions: forecast at snapshot k minus forecast at k-1
// for the same target period, counted only while that period is still in the future.
import { inWindow, isLive, lagOf, nodeCube, type Dataset } from './cube.ts'

export interface Options {
  frozenDays: number
  zThreshold: number
  shareJumpPP: number // share move that counts as a jump, in fractions (0.05 = 5pp)
  parentFlatPct: number
  flipTolPct: number
  materialPct: number // revisions smaller than this are never a signal, however unusual
}
export const DEFAULTS: Options = { frozenDays: 30, zThreshold: 2.5, shareJumpPP: 0.05, parentFlatPct: 0.02, flipTolPct: 0.02, materialPct: 0.02 }

export type Verdict = 'signal' | 'noise' | 'thin'
export interface NoiseTest {
  verdict: Verdict
  z: number
  latestPct: number
  sigma: number
  priorSteps: number
  scope: 'horizon' | 'frozen'
  sustained: boolean
  percentile: number
}
export interface LagRow { lag: number; wape: number; bias: number; naiveWape: number; n: number; volume: number }
export interface Accuracy {
  byLag: LagRow[]
  wapeFirst: number
  wapeFinal: number
  wapeNaive: number
  fvaVsNaive: number // positive = forecast beats naive, in WAPE points
  fvaOfRevisions: number // positive = revising the forecast reduced error
  helpUnits: number
  hurtUnits: number
  verdict: 'helped' | 'hurt' | 'neutral' | 'none'
  periods: number
}
export interface Metrics {
  volume: number
  revWape: number
  stepWape: number[]
  stepSigned: number[]
  stepUnits: number[]
  stepNet: number[]
  cov: number
  frozenChurn: number
  frozenChurnLatest: number
  frozenUnitsLatest: number
  frozenVolumeLatest: number
  frozenSteps: number[]
  frozenSigned: number[]
  totalChurnUnits: number
  driftPct: number
  driftT: number
  sameSignShare: number
  flipCount: number
  flipRate: number
  flipUnits: number
  undoneShare: number
  nervousness: number
  noise: NoiseTest
  horizonTrend: number[]
}

const sat = (x: number, ref: number) => 1 - Math.exp(-x / ref)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// Robust spread of revisions, measured around zero rather than the median. Flip-flopping series are bimodal, and with an
// odd count the classic MAD collapses to nearly nothing, which would make a habitual flip-flopper look like an outlier.
export const spread = (xs: number[]) => 1.4826 * median(xs.map(Math.abs))

export const nervousBand = (n: number): 'calm' | 'watch' | 'nervous' => (n >= 45 ? 'nervous' : n >= 20 ? 'watch' : 'calm')

// Noise vs signal: is the latest revision outside this item's own history of revisions?
// A short history is shrunk toward the portfolio's spread so that 4 lucky-quiet steps do not make everything look like news.
export function testRevision(series: number[], poolSigma: number, opts: Options, scope: 'horizon' | 'frozen'): NoiseTest {
  const xs = series.filter((x) => Number.isFinite(x))
  const latest = xs.length ? xs[xs.length - 1] : 0
  const prior = xs.slice(0, -1)
  const n = prior.length
  const base: NoiseTest = { verdict: 'thin', z: 0, latestPct: latest, sigma: 0, priorSteps: n, scope, sustained: false, percentile: 0 }
  if (n < 3) return base
  const k = 4
  const own = spread(prior)
  const sigma = Math.max(0.005, Math.sqrt((n * own * own + k * poolSigma * poolSigma) / (n + k)))
  const center = (n / (n + k)) * median(prior)
  const z = (latest - center) / sigma
  const percentile = prior.filter((x) => Math.abs(x) <= Math.abs(latest)).length / n
  const last3 = xs.slice(-3)
  const sum3 = last3.reduce((a, b) => a + b, 0)
  const sameSign = last3.length === 3 && (last3.every((x) => x > 0) || last3.every((x) => x < 0))
  // The run being tested must not widen its own yardstick, so the spread comes from the steps before it.
  const before = xs.slice(0, -3)
  const runOwn = before.length >= 3 ? spread(before) : own
  const runN = before.length >= 3 ? before.length : n
  const runSigma = Math.max(0.005, Math.sqrt((runN * runOwn * runOwn + k * poolSigma * poolSigma) / (runN + k)))
  const sustainedZ = sameSign ? Math.abs(sum3) / (runSigma * Math.sqrt(3)) : 0
  const spike = Math.abs(z) >= opts.zThreshold && Math.abs(latest) >= opts.materialPct
  const sustained = !spike && sustainedZ >= opts.zThreshold && Math.abs(sum3) >= opts.materialPct * 1.5
  return { ...base, verdict: spike || sustained ? 'signal' : 'noise', z: sustained ? Math.sign(sum3) * sustainedZ : z, sigma, sustained, percentile }
}

export function stepSeries(ds: Dataset, q: Float64Array, frozenDays: number | null): number[] {
  const out: number[] = []
  const { S, P } = ds
  for (let s = 1; s < S; s++) {
    let prev = 0, delta = 0
    for (let p = 0; p < P; p++) {
      if (frozenDays === null ? !isLive(ds, s, p) : !inWindow(ds, s, p, frozenDays)) continue
      const a = q[(s - 1) * P + p], b = q[s * P + p]
      if (Number.isNaN(a) || Number.isNaN(b)) continue
      prev += a; delta += b - a
    }
    out.push(prev > 0 ? delta / prev : NaN)
  }
  return out
}

export function computeMetrics(ds: Dataset, node: number, opts: Options, pool: { horizon: number; frozen: number }): Metrics {
  const { S, P } = ds
  const { q } = nodeCube(ds, node)
  const stepWape: number[] = [], stepSigned: number[] = [], stepUnits: number[] = [], stepNet: number[] = [], frozenSteps: number[] = []
  let totAbs = 0, totPrev = 0, frozAbs = 0, frozPrev = 0, frozUnitsLatest = 0, frozPrevLatest = 0
  for (let s = 1; s < S; s++) {
    let abs = 0, prev = 0, net = 0, fa = 0, fp = 0
    for (let p = 0; p < P; p++) {
      if (!isLive(ds, s, p)) continue
      const x = q[(s - 1) * P + p], y = q[s * P + p]
      if (Number.isNaN(x) || Number.isNaN(y)) continue
      const d = y - x
      abs += Math.abs(d); prev += x; net += d
      if (inWindow(ds, s, p, opts.frozenDays)) { fa += Math.abs(d); fp += x }
    }
    stepWape.push(prev > 0 ? abs / prev : NaN)
    stepSigned.push(prev > 0 ? net / prev : NaN)
    stepUnits.push(abs)
    stepNet.push(net)
    frozenSteps.push(fp > 0 ? fa / fp : NaN)
    totAbs += abs; totPrev += prev; frozAbs += fa; frozPrev += fp
    if (s === S - 1) { frozUnitsLatest = fa; frozPrevLatest = fp }
  }

  // Change over versions: for each target period, how far the versions spread around their mean (std / mean), volume weighted.
  let covNum = 0, covDen = 0
  // Flip-flops: a meaningful revision followed by a meaningful one in the opposite direction.
  let flipCount = 0, flipPairs = 0, flipUnits = 0
  for (let p = 0; p < P; p++) {
    let n = 0, mean = 0, m2 = 0, lastD = 0
    let prev = NaN
    for (let s = 0; s < S; s++) {
      if (!isLive(ds, s, p)) continue
      const v = q[s * P + p]
      if (Number.isNaN(v)) continue
      n++
      const dm = v - mean
      mean += dm / n
      m2 += dm * (v - mean)
      if (!Number.isNaN(prev)) {
        const d = v - prev
        if (Math.abs(d) > Math.max(0.5, opts.flipTolPct * Math.abs(prev))) {
          if (lastD !== 0) {
            flipPairs++
            if (Math.sign(d) !== Math.sign(lastD)) { flipCount++; flipUnits += Math.min(Math.abs(d), Math.abs(lastD)) }
          }
          lastD = d
        }
      }
      prev = v
    }
    if (n >= 3 && mean > 0) { covNum += Math.sqrt(m2 / (n - 1)); covDen += mean }
  }

  const finite = stepSigned.filter(Number.isFinite)
  const driftMean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0
  const driftSd = finite.length > 1 ? Math.sqrt(finite.reduce((a, b) => a + (b - driftMean) ** 2, 0) / (finite.length - 1)) : 0
  const pos = finite.filter((x) => x > 0).length
  const horizonTrend: number[] = []
  for (let s = 0; s < S; s++) {
    let t = 0
    for (let p = 0; p < P; p++) if (isLive(ds, S - 1, p)) { const v = q[s * P + p]; if (!Number.isNaN(v)) t += v }
    horizonTrend.push(t)
  }
  const revWape = totPrev > 0 ? totAbs / totPrev : 0
  const frozenChurn = frozPrev > 0 ? frozAbs / frozPrev : 0
  const cov = covDen > 0 ? covNum / covDen : 0
  const undoneShare = totAbs > 0 ? Math.min(1, (2 * flipUnits) / totAbs) : 0
  const nervousness = 100 * (0.4 * sat(frozenChurn, 0.12) + 0.2 * sat(revWape, 0.1) + 0.15 * sat(cov, 0.15) + 0.25 * undoneShare * sat(revWape, 0.05))
  const nHor = testRevision(stepSeries(ds, q, null), pool.horizon, opts, 'horizon')
  const frozenSigned = stepSeries(ds, q, opts.frozenDays)
  const nFro = testRevision(frozenSigned, pool.frozen, opts, 'frozen')
  const noise = nFro.verdict === 'signal' && (nHor.verdict !== 'signal' || Math.abs(nFro.z) > Math.abs(nHor.z)) ? nFro : nHor
  return {
    volume: horizonTrend[S - 1] ?? 0,
    revWape, stepWape, stepSigned, stepUnits, stepNet, cov,
    frozenChurn,
    frozenChurnLatest: frozPrevLatest > 0 ? frozUnitsLatest / frozPrevLatest : 0,
    frozenUnitsLatest: frozUnitsLatest,
    frozenVolumeLatest: frozPrevLatest,
    frozenSteps,
    frozenSigned,
    totalChurnUnits: totAbs,
    driftPct: driftMean,
    driftT: driftSd > 0 ? driftMean / (driftSd / Math.sqrt(finite.length)) : 0,
    sameSignShare: finite.length ? Math.max(pos, finite.length - pos) / finite.length : 0,
    flipCount,
    flipRate: flipPairs ? flipCount / flipPairs : 0,
    flipUnits,
    undoneShare,
    nervousness,
    noise,
    horizonTrend,
  }
}

// Accuracy is always measured at leaf grain and summed, so a calm parent cannot hide offsetting item errors.
export function computeAccuracy(ds: Dataset, node: number): Accuracy {
  const { S, P } = ds
  const leaves = ds.nodes[node].leaves
  const lags = new Map<number, { err: number; signed: number; act: number; naive: number; naiveAct: number; n: number }>()
  let errFirst = 0, errFinal = 0, actSum = 0, help = 0, hurt = 0, naiveErr = 0, naiveFcErr = 0, naiveVol = 0
  const periodsSeen = new Set<number>()
  for (const lf of leaves) {
    for (let p = 0; p < P; p++) {
      const act = ds.a[lf * P + p]
      if (Number.isNaN(act)) continue
      let first = NaN, last = NaN
      for (let s = 0; s < S; s++) {
        if (!isLive(ds, s, p)) continue
        const f = ds.q[(lf * S + s) * P + p]
        if (Number.isNaN(f)) continue
        const lag = lagOf(ds, s, p)
        if (lag < 0) continue
        // Naive benchmark: repeat the last completed actual known at this snapshot.
        let naive = NaN
        for (let b = p - 1; b >= 0; b--) {
          if (ds.perEnd[b] > ds.snapDay[s]) continue
          const v = ds.a[lf * P + b]
          if (!Number.isNaN(v)) { naive = v; break }
        }
        const r = lags.get(lag) ?? { err: 0, signed: 0, act: 0, naive: 0, naiveAct: 0, n: 0 }
        r.err += Math.abs(f - act); r.signed += f - act; r.act += act; r.n++
        if (!Number.isNaN(naive)) {
          r.naive += Math.abs(naive - act); r.naiveAct += act
          naiveErr += Math.abs(naive - act); naiveFcErr += Math.abs(f - act); naiveVol += act
        }
        lags.set(lag, r)
        if (Number.isNaN(first)) first = f
        else {
          const before = Math.abs(last - act), after = Math.abs(f - act)
          if (after < before) help += before - after
          else hurt += after - before
        }
        last = f
      }
      if (!Number.isNaN(first)) {
        errFirst += Math.abs(first - act); errFinal += Math.abs(last - act); actSum += act
        periodsSeen.add(p)
      }
    }
  }
  const byLag: LagRow[] = [...lags.entries()].sort((a, b) => a[0] - b[0]).map(([lag, r]) => ({
    lag, wape: r.act > 0 ? r.err / r.act : NaN, bias: r.act > 0 ? r.signed / r.act : NaN, naiveWape: r.naiveAct > 0 ? r.naive / r.naiveAct : NaN, n: r.n, volume: r.act,
  }))
  const wapeFirst = actSum > 0 ? errFirst / actSum : NaN
  const wapeFinal = actSum > 0 ? errFinal / actSum : NaN
  const wapeNaive = naiveVol > 0 ? naiveErr / naiveVol : NaN
  const fvaOfRevisions = actSum > 0 ? wapeFirst - wapeFinal : NaN
  const fvaVsNaive = naiveVol > 0 ? (naiveErr - naiveFcErr) / naiveVol : NaN
  let verdict: Accuracy['verdict'] = 'none'
  if (actSum > 0 && periodsSeen.size) {
    if (fvaOfRevisions > 0.01 && help > hurt) verdict = 'helped'
    else if (fvaOfRevisions < -0.01) verdict = 'hurt'
    else verdict = 'neutral'
  }
  return { byLag, wapeFirst, wapeFinal, wapeNaive, fvaVsNaive, fvaOfRevisions, helpUnits: help, hurtUnits: hurt, verdict, periods: periodsSeen.size }
}
