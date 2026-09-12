// 场景页右栏 = 「现在发生了什么」（13 报告 §13，D-062）：只放态势面板。
// 对象表单自 D-062 起在左栏（配置归左、观测归右），右栏不再被表单顶掉。

import { SituationPanel } from './cards/Cards.js'

export function RightColumn() {
  return <SituationPanel />
}
