// 运行态与结果四态两个正交徽标（09 §13.1；D-037）。形状 + 文字 + 颜色，不只靠颜色。

import type { ResultState, RunState } from '../state/types.js'

export interface RunGlyph { glyph: string; label: string }
export interface ResultBadge { glyph: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'na'; hollow: boolean; suffix: string }

export function runStateGlyph(rs: RunState | null): RunGlyph {
  switch (rs) {
    case 'queued': return { glyph: '○', label: '排队' }
    case 'running': return { glyph: '▶', label: '运行中' }
    case 'finished': return { glyph: '■', label: '完成' }
    case 'failed': return { glyph: '✕', label: '失败' }
    case 'cancelled': return { glyph: '⊘', label: '取消' }
    default: return { glyph: '·', label: '无任务' }
  }
}

const BY_RESULT: Record<ResultState, Omit<ResultBadge, 'hollow' | 'suffix'>> = {
  valid: { glyph: '●', text: '有效', tone: 'ok' },
  degraded: { glyph: '▲', text: '降级', tone: 'warn' },
  invalid: { glyph: '✖', text: '无效', tone: 'bad' },
  not_applicable: { glyph: '—', text: '不适用', tone: 'na' },
}

export function resultBadge(rs: RunState | null, result: ResultState | null): ResultBadge {
  let r: ResultState | null = result
  if (rs === 'failed') r = 'invalid'
  else if (rs === 'cancelled') r = 'not_applicable'
  const live = rs === 'queued' || rs === 'running'
  const base = BY_RESULT[r ?? 'not_applicable']
  return { ...base, hollow: live, suffix: live ? '（暂定）' : '' }
}
