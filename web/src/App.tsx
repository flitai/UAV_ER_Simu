// 三视图（场景 / 框图 / 结果）+ 数据中心页 + 顶栏与底部抽屉（04 §8.1；D-001；09 报告）。
//
// 初始框图是内置缺省典型链路（C-7，D-051）；bootstrap 若在服务端找到保存过的框图会顶掉它。
// 此前初始框图是切片 ① 的示例，那三份示例现在只在自由画布的「示例框图」下拉里。
import { AppShell } from './shell/AppShell.js'
import { StoreProvider } from './state/store.js'
import { DEFAULT_CHAIN_TEXT } from './chain/examples/default.js'
import { parseHash } from './shell/route.js'

// 开发者模式（?dev=1）：只有内部诊断才显示溯源、标定来源与高度来源分色（D-039、D-042b、D-047）
function devMode(): boolean {
  const v = new URLSearchParams(location.search).get('dev')
  return v !== null && v !== '0' && v !== 'false'
}

export default function App() {
  return (
    <StoreProvider devMode={devMode()} diagramText={DEFAULT_CHAIN_TEXT} route={parseHash(location.hash)}>
      <AppShell />
    </StoreProvider>
  )
}
