// Small CSV files whose answers can be worked out by hand. Every expected number in the specs comes from these tables.
//
// Family "Valves" has two items. Three snapshots, three target periods, and the split table compares the last two.
//
//                   snapshot 1      snapshot 2           snapshot 3
//   V1 (3 periods)  100 100 100     100 110 120  = 330   131 141 151 = 423
//   V2 (3 periods)  200 200 200     200 210 220  = 630   189 199 209 = 597
//   items together                  960                  1,020
//
// Between snapshots 2 and 3, V1 gained 93 and V2 lost 33, so 33 units changed hands and the parent grew by 60.
// V1's share went from 330 / 960 = 34.4% to 423 / 1,020 = 41.5%, which is 7.1 points.

export const SNAP = ['2026-01-05', '2026-02-02', '2026-03-02']
export const MONTHS = ['2026-03', '2026-04', '2026-05']
// ISO weeks 10, 11 and 12 of 2026 begin on 2 March, 9 March and 16 March.
export const SNAP_WEEKLY = ['2026-02-16', '2026-02-23', '2026-03-02']
export const WEEKS = ['2026-W10', '2026-W11', '2026-W12']

export const V1 = [[100, 100, 100], [100, 110, 120], [131, 141, 151]]
export const V2 = [[200, 200, 200], [200, 210, 220], [189, 199, 209]]

export const EXPECTED_SPLIT = {
  v1: { before: '330', after: '423', change: '+93', shareBefore: '34.4%', shareAfter: '41.5%', points: '7.1' },
  v2: { before: '630', after: '597', change: '-33', shareBefore: '65.6%', shareAfter: '58.5%', points: '-7.1' },
  flowLine: '33 units changed hands between children, while the parent grew 60.',
}

/** One row per snapshot, item and period, comma separated, ISO dates. */
export function longCsv(opts: { stated?: number[][] } = {}): string {
  const lines = ['snapshot_date,family,item,period,forecast_qty']
  SNAP.forEach((snap, s) => MONTHS.forEach((m, p) => {
    lines.push(`${snap},Valves,V1,${m},${V1[s][p]}`)
    lines.push(`${snap},Valves,V2,${m},${V2[s][p]}`)
    if (opts.stated) lines.push(`${snap},Valves,,${m},${opts.stated[s][p]}`)
  }))
  return lines.join('\n') + '\n'
}

/** One row per snapshot and item, one column per ISO week. */
export function wideCsv(): string {
  const lines = [`snapshot_date,family,item,${WEEKS.join(',')}`]
  SNAP_WEEKLY.forEach((snap, s) => {
    lines.push(`${snap},Valves,V1,${V1[s].join(',')}`)
    lines.push(`${snap},Valves,V2,${V2[s].join(',')}`)
  })
  return lines.join('\n') + '\n'
}

// The same shape with semicolons and decimal commas. Thousands use a dot, so 1.000,5 is one thousand and a half.
//   V1: snapshot 2 = 1000,5 + 1100,25 + 1200,25 = 3,301    snapshot 3 = 1300,5 + 1400,25 + 1500,25 = 4,201
//   V2: snapshot 2 = 2000 + 2100 + 2200 = 6,300             snapshot 3 = 1900 + 2000 + 2100 = 6,000
export const EXPECTED_DECIMAL_COMMA = {
  v1: { before: '3,301', after: '4,201', change: '+900' },
  v2: { before: '6,300', after: '6,000', change: '-300' },
}
export function decimalCommaCsv(): string {
  const v1 = [['100,5', '100,25', '100,25'], ['1.000,5', '1.100,25', '1.200,25'], ['1.300,5', '1.400,25', '1.500,25']]
  const v2 = [['200', '200', '200'], ['2.000', '2.100', '2.200'], ['1.900', '2.000', '2.100']]
  const lines = ['Snapshot;Family;Item;Period;Forecast']
  SNAP.forEach((snap, s) => MONTHS.forEach((m, p) => {
    lines.push(`${snap};Valves;V1;${m};${v1[s][p]}`)
    lines.push(`${snap};Valves;V2;${m};${v2[s][p]}`)
  }))
  return lines.join('\n') + '\n'
}

// Snapshot 3's stated totals are 335, 345 and 360 while its items add up to 320, 340 and 360.
//   period 1: 335 - (131 + 189) = +15   period 2: 345 - (141 + 199) = +5   period 3: 360 - (151 + 209) = 0
// The total is higher than the items by 20 units across 2 periods. Earlier snapshots state the exact sum.
export function statedFor(): number[][] {
  const sums = SNAP.map((_, s) => MONTHS.map((__, p) => V1[s][p] + V2[s][p]))
  sums[2] = [335, 345, 360]
  return sums
}
export const EXPECTED_MISMATCH = { units: '20', periods: '2 periods', direction: 'higher' }
