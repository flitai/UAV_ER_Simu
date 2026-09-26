// 覆盖场的后台线程（D-079）。20 × 20 km、100 m 网格、3 个站在开发机上约 1.3 s（原型阶段验证值），
// 放主线程会冻住地图，所以在这里算。
//
// 建筑几何**自己取一份**：主线程那份 LocalSceneAdapter 传不过来（类实例不能结构化克隆），
// 按同一个地址再取一次、同一个解析函数、同一个原点——铁律 11 要的是同一份**数据**，
// 浏览器 HTTP 缓存命中时不再走网络（D-076 ⑥ 记过同一个取舍）。取一次后常驻，换场景才重取。
//
// 消息协议：主线程发 {kind: 'compute', seq, ...}，本线程回 progress / done / error，全带 seq。
// **计算是同步的**：算着的时候本线程收不到新消息，新请求排在后面，所以 aborted 钩子只在
// 「加载建筑几何」那个 await 之后起作用（加载期间来了新请求，旧的那次就不算了）；
// 一次全量最多一秒多，不值得为中途打断把计算拆成分片。过时的结果由主线程按 seq 丢弃。

import { LocalSceneAdapter } from '../occlusion/adapter.js'
import { SceneFrame } from '../occlusion/frame.js'
import { parseBuildings } from '../occlusion/geojson.js'
import { computeField, type FieldInput } from './field.js'

export interface ComputeMsg {
  kind: 'compute'
  seq: number
  buildingsUrl: string
  origin: [number, number]
  input: FieldInput
}

export type WorkerReply =
  | { kind: 'progress'; seq: number; done: number }
  | {
    kind: 'done'; seq: number
    nx: number; ny: number; bbox: [number, number, number, number]
    perSite: Record<string, Float32Array>; combined: Float32Array
    detector: Record<string, { m_bins: number; eta: number; noise_bw_Hz: number }>
    outOfBand: Record<string, boolean>; blocked: Record<string, number>; ms: number; buildingsMs: number
  }
  | { kind: 'error'; seq: number; message: string }

let latest = 0
let scene: { key: string; map: LocalSceneAdapter; frame: SceneFrame } | null = null

async function sceneFor(url: string, origin: [number, number]): Promise<{ map: LocalSceneAdapter; frame: SceneFrame; ms: number }> {
  const key = `${url}|${origin[0]}|${origin[1]}`
  if (scene && scene.key === key) return { map: scene.map, frame: scene.frame, ms: 0 }
  const t0 = Date.now()
  const r = await fetch(url)
  if (!r.ok) throw new Error(`建筑几何 HTTP ${r.status}`)
  const frame = new SceneFrame(origin[0], origin[1])
  const { buildings } = parseBuildings(await r.json(), frame)
  const map = new LocalSceneAdapter()
  map.setBuildings(buildings)
  scene = { key, map, frame }
  return { map, frame, ms: Date.now() - t0 }
}

const post = (m: WorkerReply, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(m, transfer)

self.onmessage = async (ev: MessageEvent<ComputeMsg>) => {
  const msg = ev.data
  if (!msg || msg.kind !== 'compute') return
  latest = msg.seq
  try {
    const sc = await sceneFor(msg.buildingsUrl, msg.origin)
    if (msg.seq !== latest) return
    let lastSent = 0
    const r = computeField(msg.input, { map: sc.map, frame: sc.frame }, {
      aborted: () => msg.seq !== latest,
      onProgress: (d) => {
        // 行回报太密，按 5% 一档发
        if (d - lastSent >= 0.05 || d === 1) { lastSent = d; post({ kind: 'progress', seq: msg.seq, done: d }) }
      },
    })
    if (!r || msg.seq !== latest) return
    const transfer: Transferable[] = [r.combined.buffer, ...Object.values(r.perSite).map((a) => a.buffer)]
    post({
      kind: 'done', seq: msg.seq, nx: r.grid.nx, ny: r.grid.ny, bbox: r.grid.bbox,
      perSite: r.perSite, combined: r.combined, detector: r.detector, outOfBand: r.outOfBand, blocked: r.blocked, ms: r.ms, buildingsMs: sc.ms,
    }, transfer)
  } catch (e) {
    post({ kind: 'error', seq: msg.seq, message: e instanceof Error ? e.message : String(e) })
  }
}
