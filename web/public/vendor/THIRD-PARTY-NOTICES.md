# 随包第三方件

## vendor/glyphs.js

内嵌的带符号距离场（SDF）字形图集，由 **Noto Sans Regular** 生成（拉丁字符 0-255），
**SIL Open Font License 1.1**。

Copyright (c) The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic)

完整条款：https://openfontlicense.org/

该文件自 `/Users/zhiyu/CC/Airports/vendor/glyphs.js` 逐字节拷入（本方自有工程，其
`vendor/` 下第三方件的署名必须保留，CLAUDE.md 铁律 13）。中日韩字符不在图集内，
由浏览器按 `localIdeographFontFamily` 用系统字体渲染。

## 底图数据

底图瓦片来自 Protomaps 构建的 OpenStreetMap 数据，**ODbL**。署名必须随包保留，
样式里已写入 `attribution` 字段。

## 地形数据

山体阴影用的高程瓦片来自 AWS Terrain Tiles（Mapzen terrarium 编码）。
