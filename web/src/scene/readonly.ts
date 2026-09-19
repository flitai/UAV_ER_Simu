// 基准场景只读（用户 2026-09-19 拍板）。
//
// 三份示例场景 `golden-01/02/03` 的**字节**被一串东西钉着：三份航迹黄金基准、
// 六份回归夹具的 `scenario_ref.sha256`、界面缺省链的文本。在场景页随手改一下就会把它们弄不一致，
// 而自动保存（D-054 ⑥，去抖 800 ms）连问都不问——2026-09-19 用户就这么无意中改掉了一份。
//
// 判据是**标识以 `golden-` 开头**，与服务端 `isGoldenScenario` 同一条；
// 名字跟着文件走，不像另立一份名单那样会漏登记。
// 界面这一侧只是把话说明白并换掉按钮，**真闸在服务端**（PUT 直接 409）——界面拦不住手写的请求。

import type { AppState } from '../state/types.js'

export const GOLDEN_PREFIX = 'golden-'

export function isGoldenScenarioId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(GOLDEN_PREFIX)
}

/** 当前载入的场景是不是只读的。清单里的标记优先，没有清单条目时退到名字判据。 */
export function isReadonlyScenario(s: AppState): boolean {
  const id = s.scene.scenario.id
  if (!id) return false
  const row = s.scene.scenario.list.find((x) => x.scenario_id === id)
  return row?.readonly ?? isGoldenScenarioId(id)
}

/** 另存为时的新标识：合法且不得落回基准命名。返回 null 表示这个名字不能用。 */
export function checkSaveAsId(raw: string, taken: readonly string[]): { ok: true; id: string } | { ok: false; why: string } {
  const id = raw.trim()
  if (!id) return { ok: false, why: '标识不能为空' }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    return { ok: false, why: '标识只能用小写字母、数字、下划线与连字符，且以字母或数字开头' }
  }
  if (isGoldenScenarioId(id)) return { ok: false, why: `${GOLDEN_PREFIX} 开头是基准场景的命名，另存请换一个` }
  if (taken.includes(id)) return { ok: false, why: `${id} 已经有了，换一个` }
  return { ok: true, id }
}
