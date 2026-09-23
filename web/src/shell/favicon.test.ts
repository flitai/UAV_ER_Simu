// 标签页图标有两份：矢量的 favicon.svg 是主图标，favicon.png 是给不认 SVG 图标的旧内核的后备，
// 后者由 scripts/gen_favicon_png.py 按同一套几何参数光栅化出来。
// 两份分开存就有走散的风险——改了 SVG 忘了重跑脚本，图标会悄悄变成两个样子，
// 而这种事没人会在跑测试时发现（谁会盯着标签页图标看）。这份单测就是那道闸。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOT = join(WEB, '..')
const read = (rel: string) => readFileSync(join(WEB, rel), 'utf8')

test('index.html 引用的图标文件都真的在 public/ 下', () => {
  const html = read('index.html')
  const hrefs = [...html.matchAll(/<link\s+rel="(?:alternate )?icon"[^>]*href="([^"]+)"/g)]
    .map((m) => m[1])
  assert.deepEqual(hrefs, ['/favicon.svg', '/favicon.png'], '主图标在前、后备在后')
  for (const href of hrefs) {
    assert.ok(existsSync(join(WEB, 'public', href)), `缺文件 public${href}`)
    assert.ok(/^\/[\x20-\x7e]+$/.test(href), `文件名必须纯 ASCII（铁律 15）：${href}`)
    assert.ok(!/^https?:/.test(href), `图标必须随包，不得引外部地址（铁律 6）：${href}`)
  }
})

test('PNG 后备与 SVG 主图标的几何参数同源', () => {
  const svg = read('public/favicon.svg')
  const py = readFileSync(join(ROOT, 'scripts/gen_favicon_png.py'), 'utf8')

  // 波束：SVG 写在圆弧命令的半径上（`A <r> <r> ...`），脚本写在 BEAMS 表里
  const svgRadii = [...svg.matchAll(/A\s+([\d.]+)\s+\1\s/g)].map((m) => Number(m[1]))
  const block = py.match(/BEAMS = \[([\s\S]*?)\n\]/)
  assert.ok(block, '脚本里找不到 BEAMS 表')
  const pyBeams = [...block[1].matchAll(/\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/g)]
  assert.deepEqual(svgRadii, pyBeams.map((m) => Number(m[1])), '波束半径对不上，重跑 scripts/gen_favicon_png.py')

  // 线宽与不透明度：SVG 的 stroke-width 与 opacity（第一道没写 opacity，按 1 算）
  const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.deepEqual(widths, pyBeams.map((m) => Number(m[2])), '波束线宽对不上')
  const paths = svg.split('<path').slice(1)
  const opacities = paths.map((p) => Number(p.match(/opacity="([\d.]+)"/)?.[1] ?? 1))
  assert.deepEqual(opacities, pyBeams.map((m) => Number(m[3])), '波束不透明度对不上')

  // 站点、目标、圆角：SVG 的圆心与半径对脚本里的常量
  const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)]
    .map((m) => m.slice(1).map(Number))
  assert.equal(circles.length, 3, '三个圆：侦察站、目标白底、目标红心')
  const num = (name: string) => Number(py.match(new RegExp(`^${name} = ([\\d.]+)`, 'm'))?.[1])
  const tuple = (name: string) =>
    py.match(new RegExp(`^${name} = \\(([\\d.]+), ([\\d.]+)\\)`, 'm'))!.slice(1).map(Number)
  assert.deepEqual(circles[0].slice(0, 2), tuple('STATION'), '侦察站位置对不上')
  assert.deepEqual(circles[1].slice(0, 2), tuple('TARGET'), '目标位置对不上')
  assert.deepEqual(circles[2].slice(0, 2), tuple('TARGET'), '目标红心该和白底同心')
  assert.equal(Number(svg.match(/rx="([\d.]+)"/)![1]), num('RADIUS'), '圆角半径对不上')
  assert.equal(Number(svg.match(/viewBox="0 0 (\d+)/)![1]), num('SIZE'), '画布尺寸对不上')
})
