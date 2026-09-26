// 等值线（D-079）：marching squares，在格心上取 Pd = level 的线段。
//
// 做法同 em-demo `models/coverage.ts` 的 buildDetectionEnvelope：四角按「≥ level」编 4 位码，
// 边上线性插值；鞍点（5 与 10 两种码）按四角均值决定连法，免得两段交叉。
// 格心坐标由 field.ts 的 cellCenter 给，本文件只认 (i, j) 与插值比例。

import { cellCenter, type GridGeom } from './field.js'

export type Segment = [[number, number], [number, number]]

export function contourSegments(g: GridGeom, v: ArrayLike<number>, level: number): Segment[] {
  const out: Segment[] = []
  const at = (i: number, j: number) => v[j * g.nx + i]!
  // 边上的插值点：(i0,j0)→(i1,j1) 两格心之间 v 穿过 level 的位置
  const lerp = (i0: number, j0: number, i1: number, j1: number): [number, number] => {
    const a = at(i0, j0), b = at(i1, j1)
    const t = a === b ? 0.5 : (level - a) / (b - a)
    const p = cellCenter(g, i0, j0), q = cellCenter(g, i1, j1)
    return [p.lon + t * (q.lon - p.lon), p.lat + t * (q.lat - p.lat)]
  }
  for (let j = 0; j + 1 < g.ny; j++) {
    for (let i = 0; i + 1 < g.nx; i++) {
      // 四角：tl (i,j)、tr (i+1,j)、br (i+1,j+1)、bl (i,j+1)；j 向南增
      const tl = at(i, j) >= level ? 8 : 0
      const tr = at(i + 1, j) >= level ? 4 : 0
      const br = at(i + 1, j + 1) >= level ? 2 : 0
      const bl = at(i, j + 1) >= level ? 1 : 0
      const code = tl | tr | br | bl
      if (code === 0 || code === 15) continue
      const top = () => lerp(i, j, i + 1, j)
      const right = () => lerp(i + 1, j, i + 1, j + 1)
      const bottom = () => lerp(i, j + 1, i + 1, j + 1)
      const left = () => lerp(i, j, i, j + 1)
      switch (code) {
        case 1: case 14: out.push([left(), bottom()]); break
        case 2: case 13: out.push([bottom(), right()]); break
        case 3: case 12: out.push([left(), right()]); break
        case 4: case 11: out.push([top(), right()]); break
        case 6: case 9: out.push([top(), bottom()]); break
        case 7: case 8: out.push([left(), top()]); break
        case 5: case 10: {
          // 鞍点：中心均值在 level 之上则高角相连（两段把低角各自包起来），否则反之
          const mid = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4
          const highTlBr = code === 10   // 10 = tl + br 高
          if ((mid >= level) === highTlBr) { out.push([left(), bottom()]); out.push([top(), right()]) }
          else { out.push([left(), top()]); out.push([bottom(), right()]) }
          break
        }
      }
    }
  }
  return out
}
