# TX 输入分支集成

## 提交关系

当前工作树为 `NearCast-Desktop-TX-latest`，分支为 `codex/touchback-input-diagnostics`。
本会话独立 Windows Mouse 实现先提交并推送为 `8bf52a4`；指定目标 `e32d966`
位于 main，父链包含 `5d17fcc`、`610c303`、`60dae33`，共同祖先为 `6e9e022`。
提交当前改动后两条历史分叉，不能直接 fast-forward。本次使用普通 merge，
保留两个父提交，不重置或强制推送，也不修改另一个工作树中的 main。

## 选择与整合

- 采用 e32d966 的共享 OutputPolicyAdapter、显式转换配置、手势判定、连续滚动、
  macOS 缩放/辅助功能及光圈实现。默认 Touch/Mouse 均保持原生，不自动启用转换。
- Windows 统一采用 windows_mouse_model + windows_mouse 的规划/执行模块，
  移除分叉的重复后端。保留本会话已验证的五键、组合按键、像素中点映射、
  当前物理鼠标键冲突拒绝和严格 eventKind 字段校验。
- Mouse 能力合并为 buttonsMask=31、modifierMask=15、allowChords=true、
  wheelUnits=[detent120,regionQ16_16]、continuousScroll=true。
- 保留共享路由和原生边界的跨类型活动输入隔离；取消/断流清理独立 owner。
  Touch/Mouse 任一清理失败时，仍尝试清理另一类，全部确认后才允许复用。
- 保留浏览器原始视频、独立系统音频、四角屏幕绑定、NearCast-only 发现和更新。
  没有恢复 WGC 像素采集、窗口反控、AirPlay 或新增权限提升。
- macOS 原生代码和手势源码保持指定目标内容，Windows 的五键能力不扩展到 macOS。

## 验证证据

- JavaScript 203 项通过，包括 src/dist 对应资源、默认路由、显式转换、配置变化、
  手势状态机、跨类型修饰键隔离、清理失败和 Mouse 字段透传。
- cargo check --locked 通过；Rust 49 项通过、4 项显式设备测试默认忽略。
- 显式 Windows 自有副屏窗口测试通过：准确物理像素落点、五键、Ctrl 拖拽、
  detent/连续双轴滚轮、重叠 Touch 拒绝、cancel、Mouse owner 释放以及屏幕撤销 Touch 释放。
  测试结束恢复光标及前台窗口。
- Edge 集成通过真实 SDP/ICE/DTLS/SCTP/RTP，覆盖 H.264/Opus、多屏绑定、
  停止重选、Touch→Mouse→Touch 及投屏持续；采集和原生 IPC 使用 fixture。
- 更新浏览器集成通过启动弹窗、后台下载、暂不更新、重开、安装清理和错误显示。
- git diff --check 通过。
- Windows Release 构建通过，裸 EXE 为 13,827,072 B，SHA-256 为
  `462361456F37B57DF23FEF6D77276C2553BC42BAC735645A6B8B4F69FE1305FD`。
  未启动该合并版本，未构建或发布安装包。

这些证据不替代真实 RX 手势生产者、Windows 10、多 DPI 和长时间现场验收。
本机为 Windows，没有新的 macOS 设备验收结论；目标分支历史验收记录保持为历史证据。
SendInput 和 InjectTouchInput 的 UIPI/安全桌面限制保持原状。
