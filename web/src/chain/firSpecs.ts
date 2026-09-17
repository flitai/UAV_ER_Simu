// 冻结抽头表的规格在浏览器一侧的副本（C-10）。
//
// **真理源是 `models/**/fir_*.json`**，那三份 JSON 由设计脚本冻结、引擎侧的 C++ 表由脚本生成
// 并由单测逐位核对。浏览器读不到仓库里的文件，所以这里留一份**规格**的副本 ——
// 只抄「档位取值」与「通带边缘怎么算」这两样，不抄任何一个系数。
//
// 它不是第二份真理源：`firSpecs.test.ts` 直接读那三份 JSON 逐项对拍，
// 改了表却忘了改这里（或反过来）当场红。这与 `engine/src/*_taps.cpp` 是同一套办法 ——
// 副本可以有，但必须有一道闸把它钉在真理源上（铁律 10）。
//
// 为什么不把它塞进组件目录：那要改 `docs/component-catalog.md` 冻结过的字段与黄金基准，
// 而这几个数是**设计脚本的输入**不是组件的参数，放进目录反而给人「可以改」的错觉。

export interface FirSpec {
  /** `fir_version` 这一档允许的取值（DDC 的 decim、信道化的 channels、接收滤波的 bw_rel） */
  grid: number[]
  /**
   * 通带边缘，相对**输出**采样率：`0.4` 即 ±0.4·fs_out。
   * 接收滤波不是这种形状（通带由 `bw_Hz` 自己定），故为 null。
   */
  passbandEdgeRelOut: number | null
  /** 阻带边缘，同上；接收滤波为 null */
  stopbandEdgeRelOut: number | null
  /** 接收滤波的过渡带，相对**输入**采样率；另两件为 null */
  transitionRelFs: number | null
}

export const FIR_SPECS: Readonly<Record<string, FirSpec>> = {
  // models/adc-ddc/fir_lp_v1.json —— DDC 的抗混叠低通（M-2，D-070）
  lp_v1: {
    grid: [1, 2, 4, 5, 8, 10, 16, 20],
    passbandEdgeRelOut: 0.4,
    stopbandEdgeRelOut: 0.5,
    transitionRelFs: null,
  },
  // models/channelizer/fir_pfb_v1.json —— 多相原型（M-3，D-071）
  pfb_v1: {
    grid: [2, 4, 8, 16, 32, 64],
    passbandEdgeRelOut: 0.4,
    stopbandEdgeRelOut: 0.5,
    transitionRelFs: null,
  },
  // models/receiver/fir_rx_v1.json —— 接收滤波（M-3，D-071）；key 是 bw_rel = bw_Hz / fs_in
  rx_v1: {
    grid: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    passbandEdgeRelOut: null,
    stopbandEdgeRelOut: null,
    transitionRelFs: 0.05,
  },
}

/** 查规格；版本不认识时返回 null——不拿缺省顶替（铁律 15）。 */
export function firSpec(version: string | undefined): FirSpec | null {
  return (version && FIR_SPECS[version]) || null
}

/**
 * 某一档的通带边缘（Hz，单边）。`fsOut` 是该环节的**输出**采样率。
 * 版本不认识或该版本不是这种形状时返回 null，调用方据此说「算不出」而不是编一个数。
 */
export function passbandEdgeHz(version: string | undefined, fsOut: number): number | null {
  const s = firSpec(version)
  if (!s || s.passbandEdgeRelOut === null || !(fsOut > 0)) return null
  return s.passbandEdgeRelOut * fsOut
}

/** 取值在不在这一档的档位表里。容差只吃十进制表示误差，不做「取最近一档」（铁律 15）。 */
export function onGrid(version: string | undefined, value: number): boolean {
  const s = firSpec(version)
  if (!s) return false
  return s.grid.some((g) => Math.abs(g - value) <= 1e-9 * Math.max(1, Math.abs(g)))
}

/** 档位表写成一行，给报错文案用。 */
export function gridText(version: string | undefined): string {
  const s = firSpec(version)
  return s ? s.grid.join(' / ') : '（未知抽头版本）'
}
