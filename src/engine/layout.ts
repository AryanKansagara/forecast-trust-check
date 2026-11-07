// Squarified treemap (Bruls et al.) for values already known to be positive.
export interface Rect { x: number; y: number; w: number; h: number; i: number }

export function squarify(values: number[], W: number, H: number): Rect[] {
  const total = values.reduce((a, b) => a + Math.max(b, 0), 0)
  if (total <= 0 || W <= 0 || H <= 0) return []
  const scale = (W * H) / total
  const items = values.map((v, i) => ({ i, a: Math.max(v, 0) * scale })).filter((d) => d.a > 0).sort((a, b) => b.a - a.a)
  const out: Rect[] = []
  let x = 0, y = 0, w = W, h = H
  const worst = (row: { a: number }[], side: number) => {
    const s = row.reduce((t, r) => t + r.a, 0)
    let mx = 0, mn = Infinity
    for (const r of row) { mx = Math.max(mx, r.a); mn = Math.min(mn, r.a) }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn))
  }
  let row: typeof items = []
  const flush = () => {
    const s = row.reduce((t, r) => t + r.a, 0)
    if (w >= h) {
      const cw = s / h
      let cy = y
      for (const r of row) { const ch = r.a / cw; out.push({ x, y: cy, w: cw, h: ch, i: r.i }); cy += ch }
      x += cw; w -= cw
    } else {
      const ch = s / w
      let cx = x
      for (const r of row) { const cw = r.a / ch; out.push({ x: cx, y, w: cw, h: ch, i: r.i }); cx += cw }
      y += ch; h -= ch
    }
    row = []
  }
  for (const it of items) {
    const side = Math.min(w, h)
    if (row.length === 0 || worst([...row, it], side) <= worst(row, side)) row.push(it)
    else { flush(); row.push(it) }
  }
  if (row.length) flush()
  return out
}
