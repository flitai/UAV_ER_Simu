"""评测数据集的生成件（试样集，D-092；14 号报告 §8.3）。

  cells.py      读格子文件（tests/regression/eval-dataset/<集合>.json，`cuav-eval-cells/1`）并校验
  seeds.py      每格的种子与载频偏差，由集合种子确定性派生
  scenario.py   按格子写场景与链路规格（链路规格交 web/src/chain/examples/_gen.ts eval 编译成框图）
  frontend.py   接收机 IQ 不平衡与直流：在 DroneRFb 训练部分的背景片段上量（M 档）
  resolve.py    编写步骤：用 cuav_run --field 解算每个平台的位置，结果冻结回格子文件

入口是 scripts/gen_eval_dataset.py。
"""
