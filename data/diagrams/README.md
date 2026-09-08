# 保存的框图

典型链路视图与自由画布保存的框图文件，一份一个 `<diagram_id>.diagram.json`。

- **规范序列化形式**：`JSON.stringify(doc, null, 2)` 加一个末尾换行，与场景文件同法（D-049 ⑧）。
  不改内容的保存是逐字节的空操作。
- **格式**：`docs/diagram-format.md`（`cuav-diagram/1`）。带 `template_ref` 的能回到典型链路视图，
  不带的只能在自由画布打开（10 报告 §5.5）。
- **端点**：`GET/PUT/DELETE /api/v1/diagrams[/{id}]`（`server/src/diagrams.ts`，C-6）。
  写入前服务端做最小结构检查与内部参数检查，语义交 `cuav_run --validate`；
  先落 `.tmp` 再原子改名，坏框图不会覆盖盘上的好框图。
- **入库**：小文件，随代码一起版本化（`.gitignore` 有对应放行）。校验用的 `.tmp` 与
  `.resolved.json` 不入库。

已提交过的任务在 `data/runs/<任务号>/diagram.json` 另有一份副本，那是任务的证据，不是这里的源。
