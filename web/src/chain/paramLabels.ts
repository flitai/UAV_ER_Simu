// 组件参数的中文短标签（右栏参数面板用）。
//
// 目录（`ParamSpec`）只带英文标识、单位与一段说明，直接铺在面板上又长又乱（2026-09-13 用户实测）。
// 面板改为：标签用这里的中文短名，英文标识、说明与取值范围收进悬停提示。
// 这张表不是第二份目录：它不声明类型、单位、范围与缺省，只给显示名；目录里有而这里没有的参数
// 退回英文标识显示，单测守着「目录里每个可见参数都有标签」，新组件上目录时补一行即可。

import type { ParamSpec } from '../api/catalog.js'

export const PARAM_LABELS: Readonly<Record<string, string>> = {
  // 源
  sample_rate_Hz: '采样率', total_samples: '总样点数', center_frequency_Hz: '中心频率',
  offset_Hz: '频偏', amplitude: '幅度', level_dBm: '功率', phase_rad: '初相',
  start_sample: '起始样点', stop_sample: '终止样点', block_samples: '块长',
  power: '噪声功率', power_dBm: '噪声功率',
  data_id: '录音', max_samples: '最多读取', emit_at_tx_power: '按发射功率出电平',
  report_entities: '上报实体', report_rate_Hz: '上报率', update_rate_Hz: '帧更新率',
  // 混合
  gain_a: 'a 路增益', gain_b: 'b 路增益', min_inputs: '最少输入路数',
  // 天线
  role: '端', pattern: '方向图', gain_dBi: '峰值增益',
  beamwidth_az_deg: '方位波束宽', beamwidth_el_deg: '俯仰波束宽', sidelobe_dB: '副瓣抑制',
  pointing: '指向', boresight_az_deg: '视轴方位', boresight_el_deg: '视轴俯仰',
  polarization: '极化', peer_polarization: '对端极化', feeder_loss_dB: '馈线损耗',
  aspect_az_deg: '固定来波方位', aspect_el_deg: '固定来波俯仰',
  // 信道
  gain_mode: '增益口径', delay_mode: '时延模式', apply_doppler: '施加多普勒', apply_gain: '施加增益',
  max_delay_samples: '时延缓冲上限', frequency_Hz: '载频', distance_m: '距离',
  tx_power_dBm: '发射功率', tx_gain_dBi: '发射天线增益', rx_gain_dBi: '接收天线增益',
  // 传播效应（声明在 ScenarioSource 上，配在传播信道卡片）
  prop_level: '精度档', prop_primary: '主模型', prop_shadow: '统计阴影', prop_weather: '大气与降雨',
  env_class: '环境类别', ground_type: '地面材质', ground_roughness_m: '地表粗糙度',
  coherence_rho: '相干因子', max_fade_depth_dB: '相消限幅', path_loss_exponent: '路损指数',
  ref_distance_m: '参考距离', urban_loss_mode: '城市经验口径', shadow_sigma_dB: '阴影 σ',
  shadow_corr_distance_m: '阴影相关距离', rain_rate_mmh: '降雨率',
  // 接收机前端与 ADC
  nf_dB: '噪声系数', gain_dB: '增益', lo_offset_Hz: '本振频偏', reference_temperature_K: '参考温度',
  iq_gain_imbalance_dB: 'IQ 幅度不平衡', iq_phase_imbalance_deg: 'IQ 相位不平衡', dc_offset_mW: '直流',
  noise_mode: '噪声估计', bits: '量化位数', full_scale_dBm: '满量程', rounding: '取整',
  degrade_clip_ratio: '削顶降级比例',
  // 频谱、观测点
  nfft: '帧长 nfft', window: '窗函数', overlap: '重叠', segments_per_frame: '平均段数',
  op_id: '观测点', spectrum: '写功率谱', envelope: '写包络', bucket_samples: '包络桶长',
  // 检测
  band_lo_Hz: '频段下限', band_hi_Hz: '频段上限', pfa: '虚警率', noise_frames: '探针帧数',
  noise_window_frames: '滑动窗长', merge_gap_frames: '突发合并空隙', band_power_dBm: '附 dBm 读数',
  // 测向
  method: '体制', min_snr_dB: '最低信噪比', bias_deg: '系统偏差',
  sigma_method_deg: 'σ 体制', sigma_snr_ref_deg: 'σ 信噪比项', snr_ref_dB: '参考信噪比',
  sigma_cal_deg: 'σ 标校', sigma_att_deg: 'σ 姿态', sigma_mp_los_deg: 'σ 多径视距',
  sigma_mp_nlos_deg: 'σ 多径非视距', sigma_mix_deg: 'σ 混叠', mixture_separation_dB: '混叠判据',
  q_thr1_deg: 'DF-Q1 上限', q_thr2_deg: 'DF-Q2 上限', q_thr3_deg: 'DF-Q3 上限', q_thr4_deg: 'DF-Q4 上限',
  // 到达时间与定位
  sigma_floor_ns: '时戳底噪', propagation_speed_mps: '传播速度', time_tolerance_s: '配对容差',
  min_crossing_angle_deg: '最小交会角', geometry_condition_threshold: 'GDOP 上限',
  reference_station_rule: '参考站', weighting: '加权口径', sync_quality_threshold: '时统剔除档',
  max_tdoa_feasibility_margin_m: '可行性余量', coord_version: '坐标版本',
}

/** 面板上的标签：有中文短名用短名，没有退回英文标识。 */
export function paramLabel(ps: Pick<ParamSpec, 'name'>): string {
  return PARAM_LABELS[ps.name] ?? ps.name
}

/** 悬停提示：英文标识、说明、取值范围各占一行。 */
export function paramTitle(ps: ParamSpec, rangeText: string): string {
  const lines = [ps.name]
  if (ps.description) lines.push(ps.description)
  if (rangeText) lines.push(`范围 ${rangeText}`)
  return lines.join('\n')
}
