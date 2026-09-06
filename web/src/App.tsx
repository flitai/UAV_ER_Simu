// 三视图（场景 / 框图 / 结果）+ 数据中心页 + 顶栏与底部抽屉（04 §8.1；D-001；09 报告）。
import { AppShell } from './shell/AppShell.js'
import { StoreProvider } from './state/store.js'
import { EXAMPLES } from './diagram/examples/index.js'
import { parseHash } from './shell/route.js'

// 开发者模式（?dev=1）：只有内部诊断才显示溯源、标定来源与高度来源分色（D-039、D-042b、D-047）
function devMode(): boolean {
  const v = new URLSearchParams(location.search).get('dev')
  return v !== null && v !== '0' && v !== 'false'
}

export default function App() {
  return (
    <StoreProvider devMode={devMode()} diagramText={EXAMPLES[0]!.text} route={parseHash(location.hash)}>
      <AppShell />
    </StoreProvider>
  )
}
