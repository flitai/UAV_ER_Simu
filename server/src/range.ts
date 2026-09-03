// 支持 HTTP Range 的文件服务。**尚未实现。**
//
// 为什么必须实现：PMTiles 通过 Range 请求按需读取瓦片。若服务端对 Range 请求返回整个
// 文件，底图会失效或极慢。这是继承自既有项目的已知坑——Python 标准库的
// `http.server` 对 Range 就是返回整文件。
//
// 参考实现：/Users/zhiyu/CC/Airports/serve.py
//
// 实现时必须覆盖的情形：
//   - 单区间请求 `Range: bytes=start-end`，返回 206 与 Content-Range
//   - 开区间 `bytes=start-` 与后缀区间 `bytes=-suffixLength`
//   - 越界区间返回 416
//   - 不带 Range 的普通请求返回 200 与完整内容
//   - 必须返回 `Accept-Ranges: bytes`
//
// 依据：04 §8.6；决策 D-003；docs/api-versions.md 第 2 节。

export function notImplemented(): never {
  throw new Error('Range 文件服务尚未实现，见 docs/api-versions.md')
}
