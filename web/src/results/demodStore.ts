// 解调页签的外部小 store（D-107，与 truthStore 同一范式）：可解调的突发清单 + 当前选中的突发与它的解调结果。
// 点集（Float32）不进主 store（09 附录 A.1），放在这里；探针只读这里，不触发取数。

import { getDemod, getDemodBursts, type DemodBurst, type DemodBursts, type DemodFrame } from '../api/client.js'

export type DemodStatus = 'idle' | 'loading' | 'ok' | 'error'

export interface DemodState {
  taskId: string | null
  opId: string | null
  list: DemodBursts | null
  listStatus: DemodStatus
  emitter: string | null
  selected: { emitter_id: string; t_s: number } | null
  frame: DemodFrame | null
  status: DemodStatus
  error: string | null
  fetches: number
}

const initial = (): DemodState => ({
  taskId: null, opId: null, list: null, listStatus: 'idle', emitter: null, selected: null,
  frame: null, status: 'idle', error: null, fetches: 0,
})

let state: DemodState = initial()
const subs = new Set<() => void>()
let inflight: AbortController | null = null

function patch(p: Partial<DemodState>): void {
  state = { ...state, ...p }
  for (const f of subs) f()
}

export const demodStore = {
  get: (): DemodState => state,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f) } },
}

/** 缺省辐射源：先取图传，没有再取第一个 OFDM，再没有取第一个 */
export function defaultEmitter(list: DemodBursts): string | null {
  const e = list.emitters
  return (e.find((x) => x.label === 'video_link') ?? e.find((x) => x.waveform === 'ofdm') ?? e[0])?.emitter_id ?? null
}

/** 缺省突发：该辐射源第一个不与别的辐射源同时同频、也不贴着文件起止的突发 */
export function defaultBurst(list: DemodBursts, emitter: string | null): DemodBurst | null {
  const xs = list.bursts.filter((b) => b.emitter_id === emitter)
  return xs.find((b) => !b.overlap.length && !b.edge) ?? xs[0] ?? null
}

export function burstsOf(list: DemodBursts | null, emitter: string | null): DemodBurst[] {
  return list ? list.bursts.filter((b) => b.emitter_id === emitter) : []
}

export async function loadDemodList(taskId: string, opId: string): Promise<void> {
  if (state.taskId === taskId && state.opId === opId && state.list) return
  inflight?.abort()
  inflight = null
  state = { ...initial(), taskId, opId, listStatus: 'loading' }
  for (const f of subs) f()
  try {
    const list = await getDemodBursts(taskId, opId)
    if (state.taskId !== taskId || state.opId !== opId) return
    if (!list) {
      patch({ listStatus: 'error', error: '该观测点没有保存原始 IQ' })
      return
    }
    const emitter = defaultEmitter(list)
    patch({ list, listStatus: 'ok', emitter })
    const b = defaultBurst(list, emitter)
    if (b) await selectBurst(b.emitter_id, b.t_s)
  } catch (e) {
    if (state.taskId === taskId && state.opId === opId) patch({ listStatus: 'error', error: (e as Error).message })
  }
}

export async function selectEmitter(emitter: string): Promise<void> {
  if (!state.list) return
  patch({ emitter })
  const b = defaultBurst(state.list, emitter)
  if (b) await selectBurst(b.emitter_id, b.t_s)
}

export async function selectBurst(emitter: string, t: number): Promise<void> {
  const { taskId, opId } = state
  if (!taskId || !opId) return
  inflight?.abort()
  const ac = new AbortController()
  inflight = ac
  patch({ selected: { emitter_id: emitter, t_s: t }, status: 'loading', error: null })
  try {
    const frame = await getDemod(taskId, opId, emitter, t, ac.signal)
    if (inflight !== ac) return
    patch({ frame, status: 'ok', fetches: state.fetches + 1 })
  } catch (e) {
    if (ac.signal.aborted) return
    patch({ status: 'error', error: (e as Error).message, frame: null })
  }
}

/** 在当前辐射源的突发里前后挪一个（↑ / ↓） */
export function stepBurst(delta: number): DemodBurst | null {
  const xs = burstsOf(state.list, state.emitter)
  if (!xs.length) return null
  const i = state.selected ? xs.findIndex((b) => b.emitter_id === state.selected!.emitter_id && b.t_s === state.selected!.t_s) : -1
  const j = Math.min(Math.max(i + delta, 0), xs.length - 1)
  return xs[j] ?? null
}

export function probeDemod(s: DemodState) {
  const h = s.frame?.header ?? null
  return {
    opId: s.opId, listStatus: s.listStatus, bursts: s.list?.bursts.length ?? 0, emitter: s.emitter,
    emitter_id: s.selected?.emitter_id ?? null, t_s: s.selected?.t_s ?? null, status: s.status,
    state: h?.state ?? null, kind: h?.kind ?? null,
    n_points: h?.kind === 'ofdm' ? (h.sections.find((x) => x.name === 'points')?.count ?? 0)
      : h?.kind === 'gfsk' ? (h.sections.find((x) => x.name === 'deviations')?.count ?? 0) : 0,
    evm_pct: h?.evm_rms !== undefined ? h.evm_rms * 100 : null, mer_dB: h?.mer_dB ?? null,
    cfo_Hz: h?.cfo_Hz ?? null, delay_us: h?.delay_s !== undefined ? h.delay_s * 1e6 : null,
    header_bits: h?.header_match ?? null, fetches: s.fetches, error: s.error,
  }
}
