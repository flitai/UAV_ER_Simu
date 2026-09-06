// 切片 ① 示例框图：单音加噪声到功率谱。与 engine/tests/diagrams/slice1_tone_noise_psd.json 同文，
// 单测逐字段对拍；改任一处都要同步另一处。电平按引擎功率单位 mW 给（D-047）。

export const SLICE1_DIAGRAM = {
  "schema_version": "cuav-diagram/1",
  "diagram_id": "slice1-tone-noise-psd",
  "name": "单音加噪声到功率谱",
  "nodes": [
    {
      "id": "tone",
      "type": "ToneSource",
      "params": {
        "sample_rate_Hz": 1000000.0,
        "center_frequency_Hz": 2440000000.0,
        "offset_Hz": 100000.0,
        "level_dBm": -70
      }
    },
    {
      "id": "noise",
      "type": "NoiseSource",
      "params": {
        "sample_rate_Hz": 1000000.0,
        "center_frequency_Hz": 2440000000.0,
        "power_dBm": -104
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
        "nfft": 1024,
        "window": "hann"
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "from": {
        "node": "tone",
        "port": "out"
      },
      "to": {
        "node": "mix",
        "port": "a"
      }
    },
    {
      "id": "e2",
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
      "id": "e3",
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
      "label": "S4 观测点"
    }
  ],
  "run": {
    "seed": 20260904,
    "duration_s": 2.0,
    "time_basis": "LogicalSim"
  }
} as const

export const SLICE1_TEXT = "{\n  \"schema_version\": \"cuav-diagram/1\",\n  \"diagram_id\": \"slice1-tone-noise-psd\",\n  \"name\": \"单音加噪声到功率谱\",\n  \"nodes\": [\n    {\n      \"id\": \"tone\",\n      \"type\": \"ToneSource\",\n      \"params\": {\n        \"sample_rate_Hz\": 1000000.0,\n        \"center_frequency_Hz\": 2440000000.0,\n        \"offset_Hz\": 100000.0,\n        \"level_dBm\": -70\n      }\n    },\n    {\n      \"id\": \"noise\",\n      \"type\": \"NoiseSource\",\n      \"params\": {\n        \"sample_rate_Hz\": 1000000.0,\n        \"center_frequency_Hz\": 2440000000.0,\n        \"power_dBm\": -104\n      }\n    },\n    {\n      \"id\": \"mix\",\n      \"type\": \"AddMixer\",\n      \"params\": {}\n    },\n    {\n      \"id\": \"psd\",\n      \"type\": \"SpectrumAnalyzer\",\n      \"params\": {\n        \"nfft\": 1024,\n        \"window\": \"hann\"\n      }\n    }\n  ],\n  \"edges\": [\n    {\n      \"id\": \"e1\",\n      \"from\": {\n        \"node\": \"tone\",\n        \"port\": \"out\"\n      },\n      \"to\": {\n        \"node\": \"mix\",\n        \"port\": \"a\"\n      }\n    },\n    {\n      \"id\": \"e2\",\n      \"from\": {\n        \"node\": \"noise\",\n        \"port\": \"out\"\n      },\n      \"to\": {\n        \"node\": \"mix\",\n        \"port\": \"b\"\n      }\n    },\n    {\n      \"id\": \"e3\",\n      \"from\": {\n        \"node\": \"mix\",\n        \"port\": \"out\"\n      },\n      \"to\": {\n        \"node\": \"psd\",\n        \"port\": \"in\"\n      }\n    }\n  ],\n  \"observation_points\": [\n    {\n      \"id\": \"s4\",\n      \"node\": \"mix\",\n      \"port\": \"out\",\n      \"products\": [\n        \"spectrum\",\n        \"envelope\"\n      ],\n      \"label\": \"S4 观测点\"\n    }\n  ],\n  \"run\": {\n    \"seed\": 20260904,\n    \"duration_s\": 2.0,\n    \"time_basis\": \"LogicalSim\"\n  }\n}\n"
