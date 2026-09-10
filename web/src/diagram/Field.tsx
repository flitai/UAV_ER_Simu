// 参数控件：单个参数的输入控件与取值范围文字，由目录的 `ParamSpec` 生成（09 §6.6）。
//
// 三条约定：`internal` 参数不出现（D-037，由调用方过滤）；清空即回缺省、框图不写该键；
// 约束即时校验只是便利，提交时引擎再校验一次。
//
// 本文件原名 `ParamPanel.tsx`，装的是自由画布的整块参数面板。D-060 删掉自由画布之后
// 只剩这两件通用控件——典型链路的右栏用它们自己拼面板，互斥参数分组与观测点面板
// 随画布一起去掉了（组件目录里的互斥对只有噪声源那一处，典型链路的槽位表没有用到它）。

import { DataIdField } from '../data/DataIdField.js'
import type { ParamSpec } from '../api/catalog.js'
import { formatEng, parseEng } from './format.js'
import type { ParamValue } from './doc.js'

export function Field({ ps, value, onChange }: { ps: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue | undefined) => void }) {
  const isDefault = value === undefined
  const shown = value !== undefined ? value : (ps.default ?? '')
  // 实测数据的标识不是随便一个字符串：它必须是索引里真有的那一条。
  // 渲染成普通文本框等于要用户背标识（2026-09-09 用户实测），换成挑单（D-056）。
  // 放在 Field 里而不是各视图各写一份，典型链路的每处参数行因此拿到的是同一个控件。
  if (ps.name === 'data_id') {
    return <DataIdField value={typeof shown === 'string' ? shown : ''} onChange={onChange} />
  }
  if (ps.type === 'bool') {
    return (
      <select className={isDefault ? 'dim' : ''} data-field={ps.name} value={String(shown)}
        onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">是</option><option value="false">否</option>
      </select>
    )
  }
  if (ps.type === 'enum') {
    return (
      <select className={isDefault ? 'dim' : ''} data-field={ps.name} value={String(shown)}
        onChange={(e) => onChange(e.target.value)}>
        {(ps.enum ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (ps.type === 'number') {
    const bad = typeof value === 'number' && ((ps.min !== undefined && value < ps.min) || (ps.max !== undefined && value > ps.max))
    return (
      <input
        className={`${isDefault ? 'dim' : ''}${bad ? ' bad' : ''}`} data-field={ps.name}
        defaultValue={typeof shown === 'number' ? formatEng(shown).replace(' ', '') : String(shown)}
        onBlur={(e) => {
          const t = e.target.value.trim()
          if (t === '') return onChange(undefined)
          const v = parseEng(t)
          if (v === null) { e.target.classList.add('bad'); return }
          e.target.classList.remove('bad')
          onChange(v)
        }}
      />
    )
  }
  return (
    <input className={isDefault ? 'dim' : ''} data-field={ps.name} defaultValue={String(shown)}
      onBlur={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
  )
}

export function range(ps: ParamSpec): string {
  const lo = ps.min !== undefined ? formatEng(ps.min) : null
  const hi = ps.max !== undefined ? formatEng(ps.max) : null
  if (lo !== null && hi !== null) return `${lo} … ${hi}`
  if (lo !== null) return `≥ ${lo}`
  if (hi !== null) return `≤ ${hi}`
  return ''
}

