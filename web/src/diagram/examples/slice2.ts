// 切片 ② 示例框图：场景绑定链路到功率谱。与 engine/tests/diagrams/slice2_scenario_link.json 同文，
// 单测逐字段对拍；改任一处都要同步另一处。
//
// scenario_ref.sha256 是场景文件**原始字节**的哈希：场景编辑器保存后由服务端回传（PUT 的响应），
// 前端据此更新这里；两端各自序列化再算哈希必然对不上（08 报告 §9）。

export const SLICE2_DIAGRAM = {
  "schema_version": "cuav-diagram/1",
  "diagram_id": "slice2-scenario-link",
  "name": "场景绑定链路到频谱",
  "scenario_ref": {
    "scenario_id": "golden-01",
    "sha256": "35a6e3cf9671cbb2493afcfb9cc54cae65575210280d235bc671761903daa0d4"
  },
  "nodes": [
    {
      "id": "scn",
      "type": "ScenarioSource",
      "scene_binding": {
        "scenario_id": "golden-01",
        "site_id": "site-1"
      },
      "params": {
        "sample_rate_Hz": 500000,
        "update_rate_Hz": 20,
        "report_rate_Hz": 10
      }
    },
    {
      "id": "uav",
      "type": "SceneEmitterSource",
      "scene_binding": {
        "scenario_id": "golden-01",
        "entity_id": "uav-1"
      },
      "params": {
        "sample_rate_Hz": 500000,
        "center_frequency_Hz": 2440500000
      }
    },
    {
      "id": "ch",
      "type": "SceneBoundChannel",
      "scene_binding": {
        "scenario_id": "golden-01",
        "entity_id": "uav-1"
      },
      "params": {}
    },
    {
      "id": "noise",
      "type": "NoiseSource",
      "params": {
        "sample_rate_Hz": 500000,
        "center_frequency_Hz": 2440500000,
        "power_dBm": -111
      }
    },
    {
      "id": "mix",
      "type": "AddMixer",
      "params": {}
    },
    {
      "id": "psd",
      "type": "SpectrumAnalyzer",
      "params": {
        "nfft": 4096,
        "window": "hann",
        "segments_per_frame": 16
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": {
        "node": "uav",
        "port": "out"
      },
      "to": {
        "node": "ch",
        "port": "in"
      }
    },
    {
      "id": "e2",
      "from": {
        "node": "scn",
        "port": "link:uav-1"
      },
      "to": {
        "node": "ch",
        "port": "scene"
      }
    },
    {
      "id": "e3",
      "from": {
        "node": "ch",
        "port": "out"
      },
      "to": {
        "node": "mix",
        "port": "a"
      }
    },
    {
      "id": "e4",
      "from": {
        "node": "noise",
        "port": "out"
      },
      "to": {
        "node": "mix",
        "port": "b"
      }
    },
    {
      "id": "e5",
      "from": {
        "node": "mix",
        "port": "out"
      },
      "to": {
        "node": "psd",
        "port": "in"
      }
    }
  ],
  "observation_points": [
    {
      "id": "s4",
      "node": "mix",
      "port": "out",
      "products": [
        "spectrum",
        "envelope"
      ],
      "label": "S4 观测点",
      "params": {
        "nfft": 4096,
        "window": "hann",
        "segments_per_frame": 16,
        "bucket_samples": 4096
      }
    }
  ],
  "run": {
    "seed": 20260906,
    "duration_s": 30,
    "block_size": 25000,
    "time_basis": "LogicalSim"
  }
} as const

export const SLICE2_TEXT = JSON.stringify(SLICE2_DIAGRAM, null, 2)
