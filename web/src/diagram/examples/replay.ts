// 示例框图：公开数据集片段回放到功率谱。框图里只写 data_id，路径由服务端解析（D-037）。

export const REPLAY_DIAGRAM = {
  "schema_version": "cuav-diagram/1",
  "diagram_id": "replay-dronerfb-psd",
  "name": "实测片段回放到功率谱",
  "nodes": [
    {
      "id": "replay",
      "type": "FileReplaySource",
      "params": {
        "data_id": "dronerfb_0_CH0_S4"
      }
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
        "node": "replay",
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
      "node": "replay",
      "port": "out",
      "products": [
        "spectrum",
        "envelope"
      ],
      "label": "S4 观测点"
    }
  ],
  "run": {
    "seed": 1,
    "duration_s": 0.05,
    "time_basis": "LogicalSim"
  }
} as const

export const REPLAY_TEXT = "{\n  \"schema_version\": \"cuav-diagram/1\",\n  \"diagram_id\": \"replay-dronerfb-psd\",\n  \"name\": \"实测片段回放到功率谱\",\n  \"nodes\": [\n    {\n      \"id\": \"replay\",\n      \"type\": \"FileReplaySource\",\n      \"params\": {\n        \"data_id\": \"dronerfb_0_CH0_S4\"\n      }\n    },\n    {\n      \"id\": \"psd\",\n      \"type\": \"SpectrumAnalyzer\",\n      \"params\": {\n        \"nfft\": 1024,\n        \"window\": \"hann\"\n      }\n    }\n  ],\n  \"edges\": [\n    {\n      \"id\": \"e1\",\n      \"from\": {\n        \"node\": \"replay\",\n        \"port\": \"out\"\n      },\n      \"to\": {\n        \"node\": \"psd\",\n        \"port\": \"in\"\n      }\n    }\n  ],\n  \"observation_points\": [\n    {\n      \"id\": \"s4\",\n      \"node\": \"replay\",\n      \"port\": \"out\",\n      \"products\": [\n        \"spectrum\",\n        \"envelope\"\n      ],\n      \"label\": \"S4 观测点\"\n    }\n  ],\n  \"run\": {\n    \"seed\": 1,\n    \"duration_s\": 0.05,\n    \"time_basis\": \"LogicalSim\"\n  }\n}\n"
