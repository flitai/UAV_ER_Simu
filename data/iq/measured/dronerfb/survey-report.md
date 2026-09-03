# IQ 摸底报告（04 §10.6 八项质检）

工具：`tools/iq_survey.py 0.1.0`　生成于 2026-09-03T15:47:39Z

| 数据产物 | 总状态 | length_forma | iq_order_end | dc_swap_imba | clip_dropout | spectrum_noi | multichannel | metadata_req | hash_duplica |
|---|---|---|---|---|---|---|---|---|---|
| `dronerfb_0_CH0_S4` | **degraded** | valid | valid | valid | valid | valid | not_applicable | degraded | valid |
| `dronerfb_A1_IN_S0_slice_1_CH0_S4` | **degraded** | valid | valid | valid | valid | valid | not_applicable | degraded | valid |
| `dronerfb_background_slice_1_CH0_S4` | **degraded** | valid | valid | valid | valid | valid | not_applicable | degraded | valid |

## 每个产物的结论与实测统计

### `dronerfb_0_CH0_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 4000000 |
| 峰值 dBFS | -19.43 |
| 有效值 dBFS | -35.79 |
| 直流占均方根 | 0.0009715 |
| I/Q 标准差比（整片，参考） | 1.001 |
| I/Q 标准差比（安静帧，判据） | 1.002 |
| I/Q 标准差比（强帧） | 0.9991 |
| I/Q 互相关 | 0.0005924 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 71.47 |
| 峰-底噪 dB | 29.14 |
| 占用跨度 Hz | 7.994e+07 |
| 突发帧占比 | 0.06045 |
| 帧功率跨度 dB | 27.32 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

### `dronerfb_A1_IN_S0_slice_1_CH0_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 4000000 |
| 峰值 dBFS | -18.06 |
| 有效值 dBFS | -38.73 |
| 直流占均方根 | 0.001581 |
| I/Q 标准差比（整片，参考） | 1 |
| I/Q 标准差比（安静帧，判据） | 1.002 |
| I/Q 标准差比（强帧） | 1.001 |
| I/Q 互相关 | -0.0002581 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 72.54 |
| 峰-底噪 dB | 26.19 |
| 占用跨度 Hz | 7.999e+07 |
| 突发帧占比 | 0.08965 |
| 帧功率跨度 dB | 26.4 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

### `dronerfb_background_slice_1_CH0_S4` — degraded

| 量 | 值 |
|---|---|
| 样点数 | 4000000 |
| 峰值 dBFS | -30.75 |
| 有效值 dBFS | -44.18 |
| 直流占均方根 | 0.003033 |
| I/Q 标准差比（整片，参考） | 0.9984 |
| I/Q 标准差比（安静帧，判据） | 0.9973 |
| I/Q 标准差比（强帧） | 0.9973 |
| I/Q 互相关 | 0.001246 |
| 削顶样点 | 0 |
| 全零段数 | 0 |
| 底噪 dB | 72 |
| 峰-底噪 dB | 21.73 |
| 占用跨度 Hz | 7.567e+07 |
| 突发帧占比 | 0.1306 |
| 帧功率跨度 dB | 16.73 |

- 10 个采集类字段不是设备记录（来源为 paper/absent/assumed）：channel.antenna, channel.station_id, frequency.center_frequency_Hz, frequency.effective_bandwidth_Hz, power.agc, power.gain_dB, power.scale, sampling.sample_rate_Hz, time.continuity.flag, time.start_time
- 单通道数据，多通道对齐项不适用（not_applicable，非 valid）

