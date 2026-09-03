# IQ 摸底报告（04 §10.6 八项质检）

工具：`tools/iq_survey.py 0.1.0`　生成于 2026-09-03T15:47:38Z

| 数据产物 | 总状态 | length_forma | iq_order_end | dc_swap_imba | clip_dropout | spectrum_noi | multichannel | metadata_req | hash_duplica |
|---|---|---|---|---|---|---|---|---|---|
| `dronerfa_T0000_D00_S0111_RF0_S4` | **degraded** | valid | valid | degraded | valid | valid | not_applicable | degraded | valid |
| `dronerfa_T0010_D00_S0101_RF0_S4` | **degraded** | valid | valid | degraded | valid | valid | not_applicable | degraded | valid |
| `dronerfa_T10010_S0000_RF1_S4` | **degraded** | valid | valid | degraded | valid | valid | not_applicable | degraded | valid |

## 每个产物的结论与实测统计

### `dronerfa_T0000_D00_S0111_RF0_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 140000000 |
| 峰值 dBFS | -36.9 |
| 有效值 dBFS | -51.35 |
| 直流占均方根 | 0.001648 |
| I/Q 标准差比（整片，参考） | 0.7335 |
| I/Q 标准差比（安静帧，判据） | 0.7388 |
| I/Q 标准差比（强帧） | 0.8582 |
| I/Q 互相关 | -2.117e-05 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 65.92 |
| 峰-底噪 dB | 39.9 |
| 占用跨度 Hz | 9.999e+07 |
| 突发帧占比 | 0.01486 |
| 帧功率跨度 dB | 7.238 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 安静帧 I/Q 标准差比 0.7388，偏离 1 超过判据 5.00%（整片 0.7335；整片值随信噪比变化，不作判据）
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

### `dronerfa_T0010_D00_S0101_RF0_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 150000000 |
| 峰值 dBFS | -22.87 |
| 有效值 dBFS | -40 |
| 直流占均方根 | 0.0008 |
| I/Q 标准差比（整片，参考） | 0.9732 |
| I/Q 标准差比（安静帧，判据） | 0.6861 |
| I/Q 标准差比（强帧） | 0.9809 |
| I/Q 互相关 | 4.057e-05 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 66.03 |
| 峰-底噪 dB | 41.17 |
| 占用跨度 Hz | 9.999e+07 |
| 突发帧占比 | 0.002561 |
| 帧功率跨度 dB | 21.92 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 安静帧 I/Q 标准差比 0.6861，偏离 1 超过判据 5.00%（整片 0.9732；整片值随信噪比变化，不作判据）
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

### `dronerfa_T10010_S0000_RF1_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 160000000 |
| 峰值 dBFS | -18.06 |
| 有效值 dBFS | -32.7 |
| 直流占均方根 | 0.000361 |
| I/Q 标准差比（整片，参考） | 0.9981 |
| I/Q 标准差比（安静帧，判据） | 0.903 |
| I/Q 标准差比（强帧） | 0.9998 |
| I/Q 互相关 | -5.352e-05 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 65.59 |
| 峰-底噪 dB | 51.63 |
| 占用跨度 Hz | 9.999e+07 |
| 突发帧占比 | 0.4242 |
| 帧功率跨度 dB | 30.57 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 安静帧 I/Q 标准差比 0.9030，偏离 1 超过判据 5.00%（整片 0.9981；整片值随信噪比变化，不作判据）
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

