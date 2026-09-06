// 左栏「数据包」分组（09 §5.1）：默认折叠；开发者模式才显示高度来源占比（D-042b）。
// 保留 .scene-panel 与 h1：tests/e2e/scene-smoke.mjs 据此断言侧栏显示了区域名称。

import type { SceneSummaryLite } from '../state/types.js'

export function ScenePackagePanel({ scene, error, dev }: { scene: SceneSummaryLite | null; error: string | null; dev: boolean }) {
  return (
    <details className="scene-panel group" open>
      <summary>数据包{scene && <h1>{scene.name}</h1>}</summary>
      {error && <div className="scene-error">{error}</div>}
      {scene && (
        <>
          <div className="scene-sub">
            {scene.extentKm[0]} × {scene.extentKm[1]} km · 中心 {scene.center[0]}, {scene.center[1]}
          </div>
          <table className="scene-stats">
            <tbody>
              <tr><td>建筑</td><td>{scene.buildings.features.toLocaleString()} 栋</td></tr>
              <tr><td>高度中位</td><td>{scene.buildings.heightQ50 ?? '—'} m</td></tr>
              <tr><td>最高</td><td>{scene.buildings.heightMax ?? '—'} m</td></tr>
            </tbody>
          </table>
          {dev && (
            <div className="scene-src" data-dev="height-sources">
              {Object.entries(scene.buildings.srcPct).map(([k, v]) => (
                <span key={k}>{k} {v}%</span>
              ))}
            </div>
          )}
          {scene.osmSnapshot && <div className="scene-attrib">底图数据 {scene.osmSnapshot.slice(0, 10)}</div>}
          <div className="scene-attrib" dangerouslySetInnerHTML={{ __html: scene.attribution ?? '' }} />
        </>
      )}
    </details>
  )
}
