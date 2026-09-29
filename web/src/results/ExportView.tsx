// 结果页「数据导出」页签（D-090）：把当前任务里另存了原始 IQ 的观测点导出成 SigMF，写到服务器本机目录。
//
// 只摆事实（D-039）：可导出的观测点、采样率、中心频率、时长、导出大小、导出目录、进度、每个文件的名字与大小、
// 四态徽标与「无损 / 重量化」。原始样点不进浏览器（铁律 7）：这一页只收摘要，文件留在服务器盘上
// （单机模式下就是这台机器），按页面给出的目录去找。
//
// 导出期间每 0.5 s 查一次进度；作业结束即停。换任务时整页按新任务重取。

import { useCallback, useEffect, useRef, useState } from 'react'
import { getTaskExport, postTaskExport, type TaskExport } from '../api/client.js'
import { stateBadge } from '../shell/badges.js'
import { fmtBytes, fmtDuration, fmtHz, fmtInstant, fmtInt } from '../shell/format.js'
import { useAppState } from '../state/store.js'

const POLL_MS = 500

function fmtRate(fs: number): string {
  return fmtHz(fs).replace(/Hz$/, 'S/s')
}

export function ExportView() {
  const s = useAppState()
  const taskId = s.task.id
  const [data, setData] = useState<TaskExport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [posting, setPosting] = useState(false)
  const loadedFor = useRef<string | null>(null)

  const load = useCallback(async (id: string) => {
    try {
      const r = await getTaskExport(id)
      if (loadedFor.current !== id) return             // 换任务了，丢掉陈旧的应答
      setData(r)
      setErr(r ? null : '任务不存在')
      return r
    } catch (e) {
      if (loadedFor.current === id) setErr((e as Error).message)
      return null
    }
  }, [])

  // 换任务（或任务跑完）时重取，缺省全选可导出的观测点
  useEffect(() => {
    loadedFor.current = taskId
    setData(null)
    setErr(null)
    if (!taskId) return
    void load(taskId).then((r) => {
      if (r) setSel(new Set(r.exportable.map((x) => x.op_id)))
    })
  }, [taskId, s.task.runState, load])

  // 作业在跑就轮询进度
  const running = data?.job?.state === 'running'
  useEffect(() => {
    if (!running || !taskId) return
    const h = window.setInterval(() => { void load(taskId) }, POLL_MS)
    return () => window.clearInterval(h)
  }, [running, taskId, load])

  const start = async () => {
    if (!taskId || !data) return
    setPosting(true)
    setErr(null)
    const ops = data.exportable.map((x) => x.op_id).filter((x) => sel.has(x))
    const r = await postTaskExport(taskId, ops)
    setPosting(false)
    if (!r.ok) setErr(r.message)
    await load(taskId)
  }

  if (!taskId) return <div className="task-panel muted det-empty" data-export="none">无任务</div>
  const job = data?.job ?? null
  const finished = (data?.run_state ?? s.task.runState) === 'finished'
  const selBytes = (data?.exportable ?? []).filter((x) => sel.has(x.op_id)).reduce((a, x) => a + x.bytes_export, 0)
  const pct = job && job.progress.total_bytes > 0 ? (100 * job.progress.done_bytes) / job.progress.total_bytes : 0

  return (
    <div className="task-panel export-panel" data-export={data ? 'ready' : 'loading'}>
      <div className="det-head">
        <span>格式 SigMF（复 int16，ci16_le）</span>
        <span className="spacer" />
        {data && <span>导出目录 <span className="mono" data-export-dir>{data.dir}</span></span>}
      </div>
      {err && <div className="bad" data-export-error>{err}</div>}
      {data && !finished && <div className="muted det-empty" data-export-empty="not-finished">任务结束后可导出</div>}
      {data && finished && data.exportable.length === 0 && (
        <div className="muted det-empty" data-export-empty="no-iq">
          本任务没有另存原始 IQ 的观测点。在框图页观测点旁勾「原始 IQ」后重新运行。
        </div>
      )}
      {data && data.exportable.length > 0 && (
        <>
          <div className="site-table-wrap">
            <table className="site-table" data-export-table>
              <thead>
                <tr><th /><th>观测点</th><th>采样率</th><th>中心频率</th><th>时长</th><th>样点数</th><th>导出大小</th></tr>
              </thead>
              <tbody>
                {data.exportable.map((x) => (
                  <tr key={x.op_id} data-export-op={x.op_id}>
                    <td>
                      <input type="checkbox" data-export-pick={x.op_id} checked={sel.has(x.op_id)} disabled={running}
                        onChange={(e) => {
                          const next = new Set(sel)
                          if (e.target.checked) next.add(x.op_id)
                          else next.delete(x.op_id)
                          setSel(next)
                        }} />
                    </td>
                    <td className="name">{x.label}</td>
                    <td className="num">{fmtRate(x.sample_rate_Hz)}</td>
                    <td className="num">{fmtHz(x.center_Hz)}</td>
                    <td className="num">{fmtDuration(x.duration_s)}</td>
                    <td className="num">{fmtInt(x.samples)}</td>
                    <td className="num">{fmtBytes(x.bytes_export)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="det-head">
            <button type="button" data-act="export-sigmf" disabled={!finished || running || posting || sel.size === 0}
              onClick={() => { void start() }}>导出 SigMF</button>
            <span className="muted">共 {fmtBytes(selBytes)}</span>
            {running && job && (
              <span data-export-state="running">
                <progress max={100} value={pct} /> {pct.toFixed(0)}%
              </span>
            )}
            {job?.state === 'failed' && <span className="bad" data-export-state="failed">{job.error}</span>}
          </div>
        </>
      )}
      {job?.state === 'done' && job.results && (
        <div data-export-state="done">
          <div className="det-head">
            <span data-export-when>上次导出 {fmtInstant(job.ended_utc)}</span>
          </div>
          <div className="site-table-wrap">
            <table className="site-table" data-export-results>
              <thead><tr><th>观测点</th><th>状态</th><th>量化</th><th>样点数</th><th>真值注记</th></tr></thead>
              <tbody>
                {job.results.map((r) => {
                  const b = stateBadge(r.state)
                  return (
                    <tr key={r.op_id} data-export-result={r.op_id}>
                      <td className="name">{r.point}（{r.op_id}）</td>
                      <td className="name"><span className={'badge result ' + b.tone} data-export-result-state={r.state}>{b.glyph} {b.text}</span></td>
                      <td className="name">{r.lossless ? '无损' : '重量化'}</td>
                      <td className="num">{fmtInt(r.samples)}</td>
                      <td className="num">{fmtInt(r.annotations)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {data && data.files.length > 0 && (
        <div className="site-table-wrap">
          <table className="site-table" data-export-files>
            <thead><tr><th>文件（{data.dir}）</th><th>大小</th></tr></thead>
            <tbody>
              {data.files.map((f) => (
                <tr key={f.name} data-export-file={f.name}>
                  <td className="name mono">{f.name}</td>
                  <td className="num">{fmtBytes(f.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
