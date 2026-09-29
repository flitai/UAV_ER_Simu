// 机型预设表 v1 的规格在浏览器一侧的**副本**（Q-2，D-088）：场景编辑器的预设挑单、选预设即填占用带宽、
// 频率计划里「OFDM 波形的采样率在重采样档位里」那一条检查都读它。
//
// 真理源是 `models/radiator/presets-v1.json`（每项参数的出处档与引文在那里）。这里只抄编辑器要用的几项，
// 不抄数值结构、突发与帧排布——那些只在引擎与 geo/ 里用。`presets.test.ts` 直接读 JSON 与
// `models/radiator/fir_rsmp_v1.json` 逐项对拍：改了表却忘了改副本，当场红（同 firSpecs.ts 的办法，铁律 10）。

export type OfdmWaveformType = 'ofdm' | 'droneid'

/** 场景 emission.waveform.type 的全部取值（辐射源表单的波形下拉；与 docs/schemas/scenario.schema.json 同） */
export const WAVEFORM_TYPES = ['tone', 'noise', 'burst', 'ofdm', 'droneid'] as const

export interface RadiatorPresetSpec {
  id: string
  type: OfdmWaveformType
  /** 真值标签（signal_role 层）：video_link / rc_hopping / droneid */
  role: string
  name: string
  /** 原生采样率 = FFT 点数 × 15 kHz */
  fs_native_Hz: number
  /** (2K+1) × 15 kHz；场景 emission.bw_Hz 必须等于它 */
  occupied_bw_Hz: number
}

export const RADIATOR_PRESETS: readonly RadiatorPresetSpec[] = [
  { id: 'dji-video-10m', type: 'ofdm', role: 'video_link', name: 'DJI 图传 10 MHz', fs_native_Hz: 15360000, occupied_bw_Hz: 9015000 },
  { id: 'dji-video-20m-a', type: 'ofdm', role: 'video_link', name: 'DJI 图传 20 MHz（A/D/F/G 族）', fs_native_Hz: 30720000, occupied_bw_Hz: 18015000 },
  { id: 'dji-video-20m-c', type: 'ofdm', role: 'video_link', name: 'DJI 图传 20 MHz（C/E 族）', fs_native_Hz: 30720000, occupied_bw_Hz: 18015000 },
  { id: 'dji-video-40m', type: 'ofdm', role: 'video_link', name: 'DJI 图传 40 MHz（5.8 GHz）', fs_native_Hz: 61440000, occupied_bw_Hz: 36015000 },
  { id: 'dji-uplink-1m', type: 'ofdm', role: 'rc_hopping', name: 'DJI 遥控上行 1.1 MHz（C/E 族）', fs_native_Hz: 15360000, occupied_bw_Hz: 1125000 },
  { id: 'dji-uplink-2m', type: 'ofdm', role: 'rc_hopping', name: 'DJI 遥控上行 2.2 MHz（A/G 族）', fs_native_Hz: 15360000, occupied_bw_Hz: 2235000 },
  { id: 'dji-uplink-4m', type: 'ofdm', role: 'rc_hopping', name: 'DJI 遥控上行 4.4 MHz（D/F 族）', fs_native_Hz: 15360000, occupied_bw_Hz: 4425000 },
  { id: 'dji-droneid', type: 'droneid', role: 'droneid', name: 'DJI DroneID', fs_native_Hz: 15360000, occupied_bw_Hz: 9015000 },
]

/** 有理重采样的档位（与冻结表 fir_rsmp_v1.json 的 interp_L / decim_M_supported 相同）：只升采样 */
export const RSMP_INTERP = 125
export const RSMP_DECIM: readonly number[] = [24, 48, 96]

export function isOfdmFamily(type: unknown): type is OfdmWaveformType {
  return type === 'ofdm' || type === 'droneid'
}

export function presetById(id: unknown): RadiatorPresetSpec | undefined {
  return RADIATOR_PRESETS.find((p) => p.id === id)
}

export function presetsOfType(type: OfdmWaveformType): RadiatorPresetSpec[] {
  return RADIATOR_PRESETS.filter((p) => p.type === type)
}

/** 该预设可取的站点采样率，升序（与 geo::rsmp_allowed_fs_text 同一组数）。 */
export function rsmpAllowedFs(p: RadiatorPresetSpec): number[] {
  return RSMP_DECIM.map((m) => (p.fs_native_Hz * RSMP_INTERP) / m)
    .filter((fs) => fs >= p.fs_native_Hz)
    .sort((a, b) => a - b)
}

/** 站点采样率对应的抽取比；不在档返回 0（与 geo::rsmp_decim_for 同式，相对容差 1e-9）。 */
export function rsmpDecimFor(p: RadiatorPresetSpec, fs_Hz: number): number {
  for (const m of RSMP_DECIM) {
    const fs = (p.fs_native_Hz * RSMP_INTERP) / m
    if (fs < p.fs_native_Hz) continue
    if (Math.abs(fs_Hz - fs) <= 1e-9 * fs) return m
  }
  return 0
}
