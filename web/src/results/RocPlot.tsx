// ROC 曲线（C-9，10 报告 §5.7）：Canvas，横轴虚警率、纵轴检出率，工作点标出。
//
// 两个必须照实处理的情形（铁律 15，不画假曲线）：
//  ① 真值覆盖全程时 tn + fp = 0，`pfa` 整列是 null（golden-03 三站持续发射、回放清单的整片真值都是这样），
//     此时只画轴与一行事实，不把 null 当 0；
//  ② `roc.points` 为空（运行没到终态、或没有检测行）同样只画轴。
//
// `?dev=1` 叠解析曲线族（06 §9G C-9 的验收项）：按检测器的 M 与门限扫描，画一组常数带内信噪比下的
// 解析曲线（D-026 的**随机型**式，见 analytic.ts 里为什么不用确定型），实测曲线落在哪两档之间就读出
// 等效信噪比——这就是跨层一致性算例 ① 的图形版。不估信噪比、不新造数字。
//
// **横轴取对数**（1e-6 … 1）：本系统的目标虚警率是 1e-3，线性轴上整条曲线都贴在左缘，读不出东西。
// Pfa = 0 的点（门限扫到最高、一个虚警都没有）在对数轴上没有位置，贴到左缘并在图例写明轴的下限。

import { useEffect, useRef } from 'react'
import { analyticRocFamily, familySnrsDb } from './analytic.js'

export interface RocProps {
  points: Array<{ threshold: number; pd: number | null; pfa: number | null }>
  workingPoint: { threshold: number | null; pd: number | null; pfa: number | null }
  /** 频段内 bin 数 M（detections.index.json 的 m_bins）；没有就不画解析族，不猜 */
  mBins: number | null
  dev: boolean
}

const W = 360
const H = 300
const PAD = { l: 44, r: 20, t: 10, b: 30 }
/** 横轴下限：10^AX_MIN。低于它的（含 Pfa = 0）贴左缘 */
const AX_MIN = -6
const C = { ink: '#48423a', dim: '#7b7367', grid: '#ddd7cd', trace: '#2f5d7c', mark: '#a33333', fam: '#c3bcb2' }

export function RocPlot({ points, workingPoint, mBins, dev }: RocProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const usable = points.filter((p) => typeof p.pfa === 'number' && typeof p.pd === 'number') as Array<{ pfa: number; pd: number }>
  const note = points.length === 0 ? '无 ROC 点'
    : usable.length === 0 ? 'Pfa —（tn + fp = 0）'
    : ''

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    cv.width = Math.round(W * dpr)
    cv.height = Math.round(H * dpr)
    cv.style.width = `${W}px`
    cv.style.height = `${H}px`
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif'
    const x0 = PAD.l, y0 = PAD.t, pw = W - PAD.l - PAD.r, ph = H - PAD.t - PAD.b
    const X = (pfa: number) => {
      const e = pfa > 0 ? Math.log10(pfa) : AX_MIN
      return x0 + (Math.min(Math.max(e, AX_MIN), 0) - AX_MIN) / -AX_MIN * pw
    }
    const Y = (pd: number) => y0 + (1 - Math.min(Math.max(pd, 0), 1)) * ph

    // 网格与轴：横轴每十倍程一格，纵轴每 0.2 一格
    ctx.strokeStyle = C.grid
    ctx.fillStyle = C.dim
    ctx.lineWidth = 1
    for (let e = AX_MIN; e <= 0; e++) {
      const x = Math.round(X(10 ** e)) + 0.5
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); ctx.stroke()
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillText(e === 0 ? '1' : `1e${e}`, x, y0 + ph + 4)
    }
    for (let i = 0; i <= 5; i++) {
      const u = i / 5
      ctx.beginPath(); ctx.moveTo(x0, Math.round(Y(u)) + 0.5); ctx.lineTo(x0 + pw, Math.round(Y(u)) + 0.5); ctx.stroke()
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      ctx.fillText(u.toFixed(1), x0 - 5, Y(u))
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText(`虚警率 Pfa（对数，下限 1e${AX_MIN}）`, x0 + pw / 2, H - 2)
    ctx.save(); ctx.translate(11, y0 + ph / 2); ctx.rotate(-Math.PI / 2)
    ctx.textBaseline = 'top'; ctx.fillText('检出率 Pd', 0, 0); ctx.restore()

    // ?dev=1 的解析族
    if (dev && mBins && mBins >= 1) {
      ctx.strokeStyle = C.fam
      ctx.lineWidth = 1
      for (const c of analyticRocFamily(mBins, familySnrsDb(mBins), 48)) {
        ctx.beginPath()
        c.points.forEach((p, i) => { if (i === 0) ctx.moveTo(X(p.pfa), Y(p.pd)); else ctx.lineTo(X(p.pfa), Y(p.pd)) })
        ctx.stroke()
        // 标号放曲线过 Pd = 0.5 处：pfa = 1 那一端六条曲线都收敛到 Pd = 1，标号会叠成一坨（实测踩到）
        let at = c.points[0]
        for (const p of c.points) if (Math.abs(p.pd - 0.5) < Math.abs(at.pd - 0.5)) at = p
        ctx.fillStyle = C.fam
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.fillText(`${c.snr_dB}`, X(at.pfa), Y(at.pd) - 2)
      }
    }

    // 实测曲线
    if (usable.length > 0) {
      ctx.strokeStyle = C.trace
      ctx.lineWidth = 1.8
      ctx.beginPath()
      usable.forEach((p, i) => { if (i === 0) ctx.moveTo(X(p.pfa), Y(p.pd)); else ctx.lineTo(X(p.pfa), Y(p.pd)) })
      ctx.stroke()
      ctx.fillStyle = C.trace
      for (const p of usable) { ctx.beginPath(); ctx.arc(X(p.pfa), Y(p.pd), 1.6, 0, Math.PI * 2); ctx.fill() }
    }

    // 工作点
    const wp = workingPoint
    if (typeof wp.pfa === 'number' && typeof wp.pd === 'number') {
      const px = X(wp.pfa), py = Y(wp.pd)
      ctx.strokeStyle = C.mark
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(px - 7, py); ctx.lineTo(px + 7, py); ctx.moveTo(px, py - 7); ctx.lineTo(px, py + 7); ctx.stroke()
    }
    ctx.strokeStyle = C.ink
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, pw - 1, ph - 1)
  }, [points, workingPoint, mBins, dev, usable.length])

  return (
    <div className="roc" data-roc data-roc-points={usable.length} data-roc-family={dev && mBins ? String(mBins) : ''}>
      <canvas ref={ref} />
      <div className="roc-legend">
        <span className="muted">
          工作点 {typeof workingPoint.threshold === 'number' ? `η ${workingPoint.threshold.toFixed(3)}` : 'η —'}
          {' · '}Pd {typeof workingPoint.pd === 'number' ? workingPoint.pd.toFixed(3) : '—'}
          {' · '}Pfa {typeof workingPoint.pfa === 'number' ? workingPoint.pfa.toExponential(2) : '—'}
        </span>
        {note && <span className="muted" data-roc-note>{note}</span>}
        {dev && mBins ? <span className="muted" data-dev>解析族：随机型（D-026），M {mBins}，标号为带内信噪比 dB</span> : null}
      </div>
    </div>
  )
}
