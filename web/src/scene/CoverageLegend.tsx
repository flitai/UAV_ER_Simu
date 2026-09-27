// 探测范围的图例与两个控件（D-079）。开关打开才出现，贴在地图左下。
//
// 只摆事实（D-039）：色条、等值线代表的 Pd、目标是谁、按多高算、看的是哪几个站、算到几成。
// 不写解释句——「受建筑遮挡影响」「仅供参考」这类话一律不做，要诊断走 ?dev=1。
// 站与高度两个控件放这里而不是「图层」弹层：看图时要反复改，弹层每次都得点开。

import { useSyncExternalStore } from 'react'
import { buildLut } from '../signal/colormap.js'
import { COVERAGE_LEVEL, coverageStore } from './coverage/store.js'
import { TERM_LABEL, type LossTerm } from '../chain/effects.js'

const LUT = buildLut()
const GRADIENT = `linear-gradient(to right, ${[0, 64, 128, 191, 255].map((i) => `rgb(${LUT[i * 4]}, ${LUT[i * 4 + 1]}, ${LUT[i * 4 + 2]})`).join(', ')})`

export function CoverageLegend({ siteNames, dev, dirty }: { siteNames: Array<{ id: string; name: string }>; dev: boolean; dirty: boolean }) {
  const st = useSyncExternalStore(coverageStore.subscribe, coverageStore.get)
  if (!st.on) return null
  const r = st.result
  const oob = r ? r.sites.filter((x) => x.out_of_band).map((x) => x.id) : []
  const terms = r ? r.included_loss_terms.map((t) => TERM_LABEL[t as LossTerm] ?? t).join(' + ') : ''
  return (
    <div className="coverage-legend" data-coverage-legend data-status={st.status}>
      <div className="cov-row cov-head">
        <span className="cov-title">探测范围</span>
        {st.status === 'computing' && <span className="dim" data-coverage-progress>计算中</span>}
      </div>
      <div className="cov-bar" style={{ background: GRADIENT }} />
      <div className="cov-row cov-ticks"><span>Pd 0</span><span>0.5</span><span>1</span></div>
      <div className="cov-row"><span className="cov-contour-swatch" /> <span>Pd = {COVERAGE_LEVEL}</span></div>
      <label className="cov-row">
        <span className="dim">站</span>
        <select data-field="coverage-site" value={st.site} onChange={(e) => coverageStore.setSite(e.target.value)}>
          <option value="all">全部站合并</option>
          {siteNames.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </label>
      <label className="cov-row">
        <span className="dim">目标高度</span>
        <input data-field="coverage-height" type="number" min={0} step={10} className="cov-height"
               value={st.heightOverride ?? (r ? Math.round(r.height_agl_m) : '')}
               onChange={(e) => {
                 const v = Number(e.target.value)
                 if (e.target.value !== '' && Number.isFinite(v) && v >= 0) coverageStore.setHeight(v)
               }} />
        <span className="dim">m</span>
        {st.heightOverride !== null && (
          <button type="button" className="mini" data-act="coverage-height-follow" title="改回按焦点目标此刻的离地高度"
                  onClick={() => coverageStore.setHeight(null)}>跟随目标</button>
        )}
      </label>
      {r && <div className="cov-row dim" data-coverage-target>目标 {r.targetName} · {r.height_agl_m.toFixed(0)} m</div>}
      {/* 传播档位与计入的损耗项：与框图「传播信道」卡片同一套名字，只摆事实 */}
      {r && <div className="cov-row dim" data-coverage-terms>{r.prop_level} · {terms}</div>}
      {/* 引擎读的是已保存的场景：有未保存的改动时照实写一句事实 */}
      {r && dirty && <div className="cov-row dim" data-coverage-saved>按已保存的场景</div>}
      {oob.length > 0 && <div className="cov-row cov-warn" data-coverage-oob>频段外：{oob.join('、')}</div>}
      {st.status === 'error' && <div className="cov-row cov-warn" data-coverage-error>{st.error}</div>}
      {dev && r && (
        <div className="cov-row dim" data-dev="coverage-meta">
          {r.nx}×{r.ny} 格 · 引擎 {Math.round(r.ms)} ms · 往返 {r.wallMs} ms · M {r.sites.map((x) => x.m_bins).join('/')}
        </div>
      )}
    </div>
  )
}
