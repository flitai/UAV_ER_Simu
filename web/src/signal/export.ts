// 导出（U-3，09 §7.2 导出行）：PNG 出当前频谱与瀑布图像（带轴与标注），CSV 出当前视窗的抽取数据。
// 文件名含 task_id、op_id、时间窗；纯函数部分可单测，DOM 合成与下载在页面里调。

import type { ProductIndex } from '../state/types.js'
import { envelopeToDb } from './envelopeMap.js'
import type { Extract } from './reduce.js'

function safe(s: string): string { return s.replace(/[^A-Za-z0-9._-]+/g, '_') }

export function exportFilename(kind: 'png' | 'csv', taskId: string, opId: string, t0: number, t1: number): string {
  return `${safe(taskId)}_${safe(opId)}_${t0.toFixed(3)}s-${t1.toFixed(3)}s.${kind}`
}

/**
 * CSV：首行列头 `t_s` + 各列中心绝对频率（Hz），每行一个时间格（行起始时刻，绝对秒）；
 * 包络（可选）另起一段：`t_s,min_dB,max_dB,rms_dB`。数值用 JavaScript 的最短往返表示。
 */
export function csvFromWindow(spec: Extract, env: Extract | null, index: Pick<ProductIndex, 'center_Hz' | 't0_s'>, unit: string, envDt: number | null = null): string {
  const lines: string[] = []
  const fa = spec.f0 ?? 0
  const fb = spec.f1 ?? 0
  const head = ['t_s']
  for (let k = 0; k < spec.cols; k++) head.push(String(index.center_Hz + fa + ((k + 0.5) / spec.cols) * (fb - fa)))
  lines.push(`# spectrum ${unit}; columns = centre frequency Hz`)
  lines.push(head.join(','))
  const dt = spec.rows > 0 ? (spec.t1 - spec.t0) / spec.rows : 0
  for (let i = 0; i < spec.rows; i++) {
    const row: string[] = [String(index.t0_s + spec.t0 + i * dt)]
    for (let k = 0; k < spec.cols; k++) row.push(String(spec.data[i * spec.cols + k]))
    lines.push(row.join(','))
  }
  if (env && env.rows > 0) {
    lines.push('')
    lines.push(`# envelope dB (20*log10 |x|), ${unit}`)
    lines.push('t_s,min_dB,max_dB,rms_dB')
    const edt = envDt !== null && env.rows > 0 ? (env.t1 - env.t0) / env.rows : 0
    for (let j = 0; j < env.rows; j++) {
      lines.push([String(index.t0_s + env.t0 + j * edt), envelopeToDb(env.data[j * 3]!), envelopeToDb(env.data[j * 3 + 1]!), envelopeToDb(env.data[j * 3 + 2]!)].join(','))
    }
  }
  return lines.join('\n') + '\n'
}

/** 浏览器下载（交付环境是本地服务，不是沙箱）。 */
export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a')
  const url = URL.createObjectURL(blob)
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 把频谱与瀑布两块画布竖向拼成一张 PNG，顶部写标题行。 */
export function composeExportPng(spec: HTMLCanvasElement, wf: HTMLCanvasElement, title: string, dpr: number): Promise<Blob | null> {
  const w = Math.max(spec.width, wf.width)
  const titleH = Math.round(24 * dpr)
  const out = document.createElement('canvas')
  out.width = w
  out.height = titleH + spec.height + wf.height
  const ctx = out.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.fillStyle = '#48423a'
  ctx.font = `${Math.round(12 * dpr)}px system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(title, Math.round(8 * dpr), titleH / 2)
  ctx.drawImage(spec, 0, titleH)
  ctx.drawImage(wf, 0, titleH + spec.height)
  return new Promise((res) => out.toBlob((b) => res(b), 'image/png'))
}
