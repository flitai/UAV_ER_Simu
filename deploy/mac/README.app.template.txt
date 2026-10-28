无人机电子信号侦察仿真系统 · 单机版（Mac，程序形式）
版本 {version}（提交 {commit}）

一、运行环境
  · 搭载 Apple 芯片（M1 及以后）的 Mac，macOS 13 或更新版本。
  · 不需要联网，不需要另装任何软件。程序自带浏览器内核与运行环境。
  · 系统盘要有约 1 GB 空闲空间（程序约 0.7 GB，首次运行另拷约 0.4 GB，见第四节）。

二、安装
  双击打开 DMG，把 CuavDemo 拖到旁边的「应用程序」文件夹。
  也可以不拖，直接在 DMG 里双击运行。

三、首次打开
  本程序没有经过 Apple 公证。第一次打开时系统会提示「无法验证开发者」或
  「已损坏」。任选一种办法放行（只需做一次）：
  办法 1：双击 CuavDemo，看到提示后点「完成」；打开「系统设置 → 隐私与安全性」，
          在页面下方点「仍要打开」，按提示确认。
  办法 2：打开「终端」，执行（已拖进「应用程序」时）：
            xattr -dr com.apple.quarantine /Applications/CuavDemo.app
          然后双击 CuavDemo。

四、首次运行
  第一次运行时，程序把自带的运行环境（服务、地图、建筑与实测数据，约 0.4 GB）
  拷到下面的目录，需要几十秒，之后再打开就不用等：
      ~/Library/Application Support/CuavDemo/runtime/{version}
  任务结果与导出的文件都写在这个目录里，所以程序本身可以放在只读的位置。

五、启动与停止
  启动：双击 CuavDemo。程序先显示「正在启动服务」，几秒后进入系统界面。
  停止：退出程序（Command+Q）或关闭窗口。运行中的任务会先正常结束，再退出。
  界面在窗口宽度不足 1920 像素时收起左右两栏，程序按屏幕宽度自动缩小页面；
  可以用菜单「视图」里的放大 / 缩小 / 实际大小调整。

六、端口
  程序使用本机端口 8080。8080 被其他程序占用时，程序自动改用 8081～8099 中
  第一个空闲的端口，不需要设置。

七、数据位置
  菜单「文件 → 打开数据目录」打开下面这些目录所在的位置：
  data/runs/      每次运行的结果。
  data/exports/   在「结果 → 数据导出」页签导出的 SigMF 文件。
  data/diagrams/  保存的框图。
  data/tmp/server.log  服务的运行日志。
  卸载时把 CuavDemo 从「应用程序」移到废纸篓，并删除
  ~/Library/Application Support/CuavDemo（其中有任务结果，删除前先确认不再需要）。

八、包内容
  package.manifest.json 列出包内每个文件的大小与 SHA-256。
  第三方软件与数据的许可见 CuavDemo.app/Contents/Resources/payload/THIRD-PARTY-NOTICES。
