# 浏览器视频采集与独立音频

当前默认路径为浏览器视频、Windows 系统混音、仅可证明的整屏反控。原生 WGC 像素采集暂不继续扩展，保留为独立实验模块。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `dist/app.mjs` | 组装依赖、UI、用户分享/停止意图和生命周期协调 |
| `BrowserCaptureMediaDevices` | 用户手势中立即调用系统选择器，返回原始 MediaStream/视频轨道，组合音频并持有清理责任 |
| `createSystemAudioTrack` | 随机音频 owner、WASAPI PCM IPC、AudioWorklet、MediaStreamDestination 音频轨道 |
| `LauncherWebCastClient` | 配对、信令、单一音视频 sender、H.264/Opus、码率/分辨率、重协商 |
| `proveCaptureGeometry` | 检查整屏来源和本地显示布局，决定是否可以反控；不负责采集视频 |
| `WebCastTouchbackSender` / InputEngine | AXTP 会话、输入流、坐标映射、按住状态和释放 |
| Rust `native_audio` | 独立音频会话及有界 PCM 队列，全部 COM 音频接口由专属线程拥有 |
| Rust `input_geometry/input_native` | 当前物理屏幕几何、原生 Touch 注入与租约校验 |

默认媒体路径：

```text
getDisplayMedia -> 原始 VideoTrack ──────────┐
                                           ├-> WebRTC H.264 / Opus -> RX
WASAPI -> PCM IPC -> AudioWorklet -> AudioTrack ┘
```

浏览器视频不经过 `nearcast_capture_start/frame`、GPU 回读、BGRA 像素 IPC、Canvas 或本地缩略图任务。音频 PCM IPC 与视频轨道独立；不使用 getUserMedia、不采集麦克风。macOS 沿用系统选择器返回的 display audio；缺少音频时视频继续。

采集 provider 的公共边界为 `getDisplayMedia(options)`、`stop()` 和 `diagnostics()`。WebRTC 层接收轨道，不依赖视频采集实现。将来如需重新接入 WGC，应通过该边界明确选择并独立验收，不在浏览器失败时静默回退到另一套采集来源。

## 来源和反控范围

浏览器不可靠地暴露 HMONITOR/HWND，因此本阶段只在以下条件同时成立时允许反控：

- `displaySurface=monitor`；
- 原生只枚举到一个主显示器；
- 无旋转，物理坐标范围有效；
- 系统选择器返回的原始视频尺寸与显示器原始尺寸一致。

provider 在 WebRTC 应用输出分辨率前保留原始来源事实，不伪造浏览器的实际输出尺寸。输出允许保持比例缩小；Touch 映射到原始桌面物理像素。多屏不以分辨率、窗口标题或 track label 猜测选择的目标；窗口/多屏仍能音视频投屏，但不创建输入绑定。

停止、系统结束分享、重选、轨道 mute 或显示布局变化会撤销旧来源。已有输入清理完成后才能重新绑定；旧来源的迟到输入不能交给新桌面。

当前保留 WGC 原生反控代码作为实验材料，但默认浏览器分享不接入它的红绿框和触点提示层。

## 生命周期

1. 分享按钮的同步调用栈内调用浏览器 getDisplayMedia，保留用户激活状态。
2. 选择成功后捕获原始来源事实，再启动独立音频 owner。
3. 音频不可用时报告诊断并继续视频；只组合一个音频轨道。
4. 原视频轨道同时用于预览和 WebRTC；停止重选复用原音视频 sender。
5. `stop()` 先停止视频，等待正在启动的音频并释放，音频清理失败会阻止下一次复用。
6. generation fencing 取消迟到选屏结果；旧 track.stop 不能停止新会话。
7. 应用关闭、退出及软件更新时 Rust 额外清理独立音频。

## 验证

单元测试覆盖原轨道身份、同步选择器调用、音频失败保视频、取消/迟到/停止、清理失败、平台音频策略及降分辨率坐标映射。

`tests/webcast-browser.integration.mjs` 用 Edge 的真实 SDP/ICE/DTLS/SCTP/RTP，通过合成视频代替系统选择器、合成 PCM 代替 WASAPI，验证原视频轨道直送、Opus 有能量、单屏 Touch、窗口/多屏反控拒绝但媒体继续、停止重选和 sender 复用。此测试不代表真实 Windows 选择器、硬件性能、听感和物理触控已验收。

实机对比应在同一分辨率、码率、内容、网络和 RX 版本下比较浏览器路径与先前原生路径，查看诊断 `capture.backend=browser`、`media.video.framesPerSecond`、编码数和 `qualityLimitationReason`，并观察 RX 呈现帧率。
