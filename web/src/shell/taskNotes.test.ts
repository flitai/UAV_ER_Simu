// groupReasons 只做一件事：把引擎给的扁平 reasons 按 `节点名：说明` 的前缀分组。
// 它**有意不去判断哪条是降级判据**——引擎给的是扁平字符串，没有结构化标注，
// 靠关键词猜迟早猜错（实测 golden-01 缺省链七条里只有一条是判据，六条是信息性说明）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupReasons, splitNotes } from './taskNotes.js'

test('按节点分组，同一节点的连续几条并成一组，顺序不动', () => {
  // 这七条取自 golden-01 缺省链跑 20 s 的真实输出（2026-09-21，数字格式见 engine/src/numstr.cpp）
  const g = groupReasons([
    'rx_fe：等效输入噪声 -111.0103 dBm（噪声系数 6 dB，带宽 500000 Hz）',
    'adc：削波 609142 / 10000000 样点',
    'adc：削波比例超过 0.01，量化结果不足以支撑下游判决',
    'det：末尾 640 个样点不足一帧，已丢弃（不补零，补零会造出假信号）',
    'det：噪声估计陈旧 8044 帧：连续超过 256 帧没有未命中帧可纳入，估计停留在最近一次更新',
    'feat：末尾 640 个样点不足一帧，已丢弃（与检测器同律）',
    'op:s4：收尾丢弃不满一段的 640 个样点',
  ])
  assert.deepEqual(g.map((x) => x.node), ['rx_fe', 'adc', 'det', 'feat', 'op:s4'])
  assert.equal(g[1].lines.length, 2, 'adc 那两条并成一组')
  assert.equal(g[1].lines[1], '削波比例超过 0.01，量化结果不足以支撑下游判决')
  assert.equal(g[4].node, 'op:s4', '节点名自己带冒号时按第一个中文冒号切')
})

test('没有前缀的归「其他」；同一节点被别的节点隔开时不合并（顺序即事实）', () => {
  const g = groupReasons(['没有前缀的一句', 'a：一', 'b：二', 'a：三'])
  assert.deepEqual(g.map((x) => x.node), ['其他', 'a', 'b', 'a'])
  assert.deepEqual(g[0].lines, ['没有前缀的一句'])
})

test('空数组给空分组（界面据此整段不画）', () => {
  assert.deepEqual(groupReasons([]), [])
})

test('有逐节点状态时按状态分两段：只有非 valid 的节点进「要紧」', () => {
  // 取自 golden-01 缺省链的真实输出（2026-09-22）：11 个节点里只有 adc 是 degraded
  const { alerts, routine } = splitNotes([
    { name: 'rx_fe', state: 'valid', notes: ['等效输入噪声 -111.0103 dBm（噪声系数 6 dB，带宽 500000 Hz）'] },
    { name: 'adc', state: 'degraded', notes: ['削波 609142 / 10000000 样点', '削波比例超过 0.01，量化结果不足以支撑下游判决'] },
    { name: 'det', state: 'valid', notes: ['末尾 640 个样点不足一帧，已丢弃（不补零，补零会造出假信号）'] },
    { name: 'scn', state: 'valid', notes: [] },
  ], [])
  assert.deepEqual(alerts.map((g) => g.node), ['adc'], '只有 adc 降级')
  assert.equal(alerts[0]!.lines.length, 2)
  assert.deepEqual(routine.map((g) => g.node), ['rx_fe', 'det'], '没有说明的节点整条不出现')
})

test('旧任务没有逐节点状态时退回扁平分组，且不把例行说明标成问题', () => {
  const { alerts, routine } = splitNotes([], [
    'adc：削波 609142 / 10000000 样点',
    'det：末尾 640 个样点不足一帧，已丢弃',
  ])
  assert.deepEqual(alerts, [], '不知道哪条要紧时，一条都不标红')
  assert.deepEqual(routine.map((g) => g.node), ['adc', 'det'])
  assert.deepEqual(routine.map((g) => g.state), [null, null], '状态未知就写 null，不装作知道')
})
