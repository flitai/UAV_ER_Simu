// 识别混淆矩阵热表（C-9，10 报告 §5.7）。行 = 真值标签，列 = 识别结果，维度随 metrics.json 的 `labels` 走
// ——库外标签（例如清单派生的 noise）会让它从 5×5 变成 6×6，不得硬编码。
// 着色是单色透明度梯度（不用彩虹色图，D-061），对角线另加边框；数字照实写，0 就写 0。

import { labelText } from './labels.js'

export interface ConfusionProps {
  labels: string[]
  confusion: number[][]
  perClass: Array<{ label: string; support: number; precision: number | null; recall: number | null; f1: number | null }>
}

function ratio(v: number | null | undefined, digits = 3): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'
}

export function ConfusionMatrix({ labels, confusion, perClass }: ConfusionProps) {
  const n = labels.length
  const ok = n > 0 && confusion.length === n && confusion.every((r) => r.length === n)
  if (!ok) return <div className="muted" data-confusion-empty>—</div>
  const rowSum = confusion.map((r) => r.reduce((a, b) => a + b, 0))
  const total = rowSum.reduce((a, b) => a + b, 0)
  if (total === 0) return <div className="muted" data-confusion-empty>0 段进入矩阵</div>
  const byLabel = new Map(perClass.map((p) => [p.label, p]))
  return (
    <div className="cm-wrap">
      <table className="site-table cm" data-confusion data-confusion-n={n}>
        <thead>
          <tr>
            <th className="cm-corner">真值 \ 识别</th>
            {labels.map((l) => <th key={l} title={l}>{labelText(l) || l}</th>)}
            <th>合计</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((row, i) => (
            <tr key={row} data-cm-row={row}>
              <td className="name" title={row}>{labelText(row) || row}</td>
              {labels.map((col, j) => {
                const v = confusion[i][j]
                // 逐行归一：一行就是一个真值类的去向，跨行比大小没有意义
                const a = rowSum[i] > 0 ? v / rowSum[i] : 0
                return (
                  <td key={col} className={'num cm-cell' + (i === j ? ' cm-diag' : '') + (i === j && v > 0 ? ' cm-hit' : '')} data-cm-cell={`${row}|${col}`}
                      style={v > 0 ? { background: `rgba(47, 93, 124, ${(0.10 + 0.55 * a).toFixed(3)})` } : undefined}>
                    {v}
                  </td>
                )
              })}
              <td className="num">{rowSum[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="site-table cm-per-class" data-per-class>
        <thead>
          <tr><th>标签</th><th>真值段</th><th>查准</th><th>查全</th><th>F1</th></tr>
        </thead>
        <tbody>
          {/* per_class 比 labels 少一项（没有 unknown）——按 per_class 自己的表画，不按 labels 对下标 */}
          {labels.filter((l) => byLabel.has(l)).map((l) => {
            const p = byLabel.get(l)!
            return (
              <tr key={l} data-per-class-row={l}>
                <td className="name" title={l}>{labelText(l) || l}</td>
                <td className="num">{p.support}</td>
                <td className="num">{ratio(p.precision)}</td>
                <td className="num">{ratio(p.recall)}</td>
                <td className="num">{ratio(p.f1)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
