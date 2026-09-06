import { SLICE1_TEXT } from './slice1.js'
import { REPLAY_TEXT } from './replay.js'

export interface Example { id: string; name: string; text: string }

export const EXAMPLES: Example[] = [
  { id: 'slice1', name: '单音加噪声到功率谱（合成链）', text: SLICE1_TEXT },
  { id: 'replay', name: '实测片段回放到功率谱（dronerfb_0_CH0_S4）', text: REPLAY_TEXT },
]
