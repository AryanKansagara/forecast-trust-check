// Three SYNTHETIC datasets. Every name and number is invented; the defects are planted on purpose so the engine has something to find.
import type { CleanRow } from './engine/csv.ts'

export interface Sample { id: string; name: string; blurb: string; plants: string; rows: () => CleanRow[] }

function rng(seed: number) {
  let a = seed >>> 0
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { u, n: () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u()) }
}
const monthIso = (i: number) => new Date(Date.UTC(2024, 8 + i, 1)).toISOString().slice(0, 10)
const weekIso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * 7 * 864e5).toISOString().slice(0, 10)
const r3 = (x: number) => Math.round(x * 1000) / 1000

// Monthly top-down plan: a family/region total is forecast, then split to items by a share table.
function consumerGoods(): CleanRow[] {
  const R = rng(11)
  const SNAPS = 14, HIST = 12, HOR = 9
  const firstSnap = HIST
  const groups = [
    { family: 'Snacks', region: 'North America', base: 42000, items: [['SNK-CRISP-200G', 0.42, 0.32], ['SNK-NUT-150G', 0.18, 0.28], ['SNK-BAR-6PK', 0.25, 0.25], ['SNK-POP-90G', 0.15, 0.15]] },
    { family: 'Snacks', region: 'Europe', base: 26000, items: [['SNK-CRISP-175G', 0.45, 0.45], ['SNK-BAR-4PK', 0.33, 0.33], ['SNK-OAT-120G', 0.22, 0.22]] },
    { family: 'Beverages', region: 'North America', base: 58000, items: [['BEV-LEMON-330', 0.2, 0.2], ['BEV-COLA-330', 0.46, 0.46], ['BEV-ZERO-500', 0.22, 0.22], ['BEV-TONIC-200', 0.12, 0.12]] },
    { family: 'Beverages', region: 'Europe', base: 34000, items: [['BEV-COLA-500', 0.5, 0.54], ['BEV-ZERO-330', 0.34, 0.37], ['BEV-LEMON-1L', 0.08, 0.09], ['BEV-RETRO-1L-DELISTED', 0.08, 0.08]] },
    { family: 'Home Care', region: 'North America', base: 18000, items: [['HC-LIQ-1L', 0.52, 0.52], ['HC-LIQ-2L', 0.3, 0.3], ['HC-WIPES-40', 0.18, 0.18]] },
    { family: 'Home Care', region: 'Europe', base: 11000, items: [['HC-TABS-30', 0.62, 0.62], ['HC-SPRAY-750', 0.37, 0.37], ['HC-GIFT-PACK', 0.01, 0.01]] },
  ] as const
  const season = (p: number) => 1 + 0.12 * Math.sin((2 * Math.PI * (p + 2)) / 12)
  const rows: CleanRow[] = []
  const add = (r: Omit<CleanRow, 'customer'>) => rows.push({ ...r, customer: '' })
  groups.forEach((g, gi) => {
    const drift = new Map<number, number>()
    for (let s = 0; s < SNAPS; s++) {
      const snap = monthIso(firstSnap + s)
      for (let h = 0; h < HOR; h++) {
        const p = firstSnap + s + h
        const prior = drift.get(p) ?? R.n() * 0.012
        const eps = prior + R.n() * 0.004
        drift.set(p, eps)
        const parent = g.base * season(p) * (1 + eps)
        // PLANTED: Snacks / Europe stated total runs ahead of its items for the last 3 snapshots.
        const statedFactor = gi === 1 && s >= SNAPS - 3 ? 1.045 : 1
        add({ snapshot: snap, item: '', family: g.family, region: g.region, period: monthIso(p), qty: r3(parent * statedFactor), actual: null })
        let shares = g.items.map((it) => it[1] as number)
        // PLANTED: the new launch is carved out pro rata for the last 2 snapshots.
        const launch = gi === 1 && s >= SNAPS - 2
        if (launch) shares = shares.map((x) => x * 0.9)
        // PLANTED: Beverages / NA split jumps toward lemon in the latest snapshot with a flat parent.
        if (gi === 2 && s === SNAPS - 1) shares = [0.36, 0.34, 0.19, 0.11]
        g.items.forEach((it, ii) => {
          let v = parent * shares[ii]
          // PLANTED: Home Care / NA rounds down to full cases of 24.
          if (gi === 4) v = Math.floor(v / 24) * 24
          add({ snapshot: snap, item: it[0], family: g.family, region: g.region, period: monthIso(p), qty: gi === 4 ? v : r3(v), actual: null })
        })
        if (launch) add({ snapshot: snap, item: 'SNK-SEASALT-NEW', family: g.family, region: g.region, period: monthIso(p), qty: r3(parent * 0.1), actual: null })
      }
    }
    // Actuals for every completed month, using the true mix.
    for (let p = 0; p < firstSnap + SNAPS - 1; p++) {
      g.items.forEach((it, ii) => {
        let v = g.base * season(p) * (it[2] as number) * (1 + R.n() * 0.03)
        if (it[0] === 'BEV-RETRO-1L-DELISTED' && p >= firstSnap + SNAPS - 9) v = 0
        // PLANTED: real gift-pack demand arrives in lumps, about one month in three.
        if (it[0] === 'HC-GIFT-PACK') v = p % 3 === 0 ? g.base * 0.03 * (1 + R.n() * 0.1) : 0
        add({ snapshot: null, item: it[0], family: g.family, region: g.region, period: monthIso(p), qty: null, actual: gi === 4 ? Math.round(v) : r3(Math.max(0, v)) })
      })
    }
  })
  return rows
}

// Weekly build plan: the far horizon is calm, the next few weeks thrash.
function electronics(): CleanRow[] {
  const R = rng(27)
  const SNAPS = 16, HIST = 14, HOR = 16
  const items = [
    ['Phones', 'Americas', 'PH-X1-128', 5200, 'signal'], ['Phones', 'Americas', 'PH-X1-256', 3100, 'thrash'], ['Phones', 'Americas', 'PH-LITE-64', 2600, 'calm'],
    ['Phones', 'EMEA', 'PH-X1-128-EU', 3600, 'calm'], ['Phones', 'EMEA', 'PH-LITE-64-EU', 2100, 'thrash'], ['Phones', 'EMEA', 'PH-X1-256-EU', 1700, 'calm'],
    ['Laptops', 'Americas', 'NB-14-PRO', 4100, 'thrash'], ['Laptops', 'Americas', 'NB-13-AIR', 3300, 'thrash'], ['Laptops', 'Americas', 'NB-16-MAX', 1200, 'calm'],
    ['Laptops', 'EMEA', 'NB-14-PRO-EU', 2500, 'thrash'], ['Laptops', 'EMEA', 'NB-13-AIR-EU', 2200, 'calm'], ['Laptops', 'EMEA', 'NB-16-MAX-EU', 800, 'calm'],
    ['Accessories', 'Americas', 'AC-DOCK-G2', 1800, 'earned'], ['Accessories', 'Americas', 'AC-CABLE-C', 6400, 'calm'], ['Accessories', 'Americas', 'AC-CHARGER-65', 3900, 'calm'],
    ['Accessories', 'EMEA', 'AC-DOCK-G2-EU', 1100, 'calm'], ['Accessories', 'EMEA', 'AC-CABLE-C-EU', 4200, 'calm'], ['Accessories', 'EMEA', 'AC-CHARGER-65-EU', 2300, 'thrash'],
  ] as const
  const rows: CleanRow[] = []
  for (const [family, region, item, base, kind] of items) {
    const week = (p: number) => base * (1 + 0.06 * Math.sin(p / 4.5 + base))
    const trueDemand = (p: number) => week(p) * (kind === 'earned' ? (p >= HIST + 5 ? 1.32 : 1) : 1)
    const persist = new Map<number, number>()
    for (let s = 0; s < SNAPS; s++) {
      const snapP = HIST + s
      for (let h = 0; h < HOR; h++) {
        const p = snapP + h
        const eps = (persist.get(p) ?? R.n() * 0.01) + R.n() * 0.004
        persist.set(p, eps)
        let v = week(p) * (1 + eps)
        // PLANTED: near-term thrash that alternates direction each week and fades out past 5 weeks.
        if (kind === 'thrash' && h < 5) v *= 1 + (s % 2 ? 1 : -1) * (0.12 + 0.2 * R.u()) * (1 - h / 7)
        // PLANTED: a real step change only visible in the latest snapshot.
        if (kind === 'signal' && s === SNAPS - 1) v *= 1.28
        // PLANTED: revisions that track a real demand rise and so earn their keep.
        if (kind === 'earned') v = week(p) * (1 + eps) + Math.max(0, (trueDemand(p) - week(p)) * Math.min(1, Math.max(0, (s - 2) / 4)))
        rows.push({ snapshot: weekIso(snapP), item, family, region, customer: '', period: weekIso(p), qty: r3(v), actual: null })
      }
    }
    for (let p = 0; p < HIST + SNAPS - 1; p++) rows.push({ snapshot: null, item, family, region, customer: '', period: weekIso(p), qty: null, actual: r3(trueDemand(p) * (1 + R.n() * 0.035)) })
  }
  return rows
}

// A well-run plan. If the tool shouts about this one, the tool is wrong.
function control(): CleanRow[] {
  const R = rng(5)
  const SNAPS = 12, HIST = 12, HOR = 8
  const groups = [
    { family: 'Valves', region: 'Plant A', base: 9000, items: [['VLV-100', 0.5], ['VLV-200', 0.3], ['VLV-300', 0.2]] },
    { family: 'Valves', region: 'Plant B', base: 6500, items: [['VLV-110', 0.55], ['VLV-210', 0.45]] },
    { family: 'Fittings', region: 'Plant A', base: 15000, items: [['FIT-10', 0.4], ['FIT-20', 0.35], ['FIT-30', 0.25]] },
    { family: 'Fittings', region: 'Plant B', base: 12000, items: [['FIT-11', 0.6], ['FIT-21', 0.4]] },
  ] as const
  const season = (p: number) => 1 + 0.05 * Math.sin((2 * Math.PI * p) / 12)
  const rows: CleanRow[] = []
  for (const g of groups) {
    const persist = new Map<number, number>()
    for (let s = 0; s < SNAPS; s++) {
      for (let h = 0; h < HOR; h++) {
        const p = HIST + s + h
        const eps = (persist.get(p) ?? R.n() * 0.008) + R.n() * 0.003
        persist.set(p, eps)
        const parent = g.base * season(p) * (1 + eps)
        let sum = 0
        for (const [item, share] of g.items) {
          const v = r3(parent * share * (1 + R.n() * 0.001))
          sum += v
          rows.push({ snapshot: monthIso(HIST + s), item, family: g.family, region: g.region, customer: '', period: monthIso(p), qty: v, actual: null })
        }
        rows.push({ snapshot: monthIso(HIST + s), item: '', family: g.family, region: g.region, customer: '', period: monthIso(p), qty: r3(sum), actual: null })
      }
    }
    for (let p = 0; p < HIST + SNAPS - 1; p++) for (const [item, share] of g.items) {
      rows.push({ snapshot: null, item, family: g.family, region: g.region, customer: '', period: monthIso(p), qty: null, actual: r3(g.base * season(p) * share * (1 + R.n() * 0.025)) })
    }
  }
  return rows
}

export const SAMPLES: Sample[] = [
  { id: 'cpg', name: 'Consumer goods', blurb: 'Monthly top-down plan, 6 family and region splits, 14 snapshots, actuals.', plants: 'A bad disaggregation: shares that jump, totals that do not add up, delisted items still fed.', rows: consumerGoods },
  { id: 'electronics', name: 'Electronics', blurb: 'Weekly build plan, 18 items, 16 snapshots, actuals, no stated totals.', plants: 'A nervous near-term window: the next 5 weeks flip-flop while the far horizon is calm.', rows: electronics },
  { id: 'control', name: 'Clean control', blurb: 'Monthly plan, 10 items, 12 snapshots, actuals, totals that reconcile.', plants: 'Nothing planted. A trust check should say so, and it does.', rows: control },
]

export function sampleCsv(rows: CleanRow[]): string {
  const head = 'snapshot_date,family,region,item,period,forecast_qty,actual_qty'
  return [head, ...rows.map((r) => [r.snapshot ?? '', r.family, r.region, r.item, r.period, r.qty ?? '', r.actual ?? ''].join(','))].join('\n') + '\n'
}
