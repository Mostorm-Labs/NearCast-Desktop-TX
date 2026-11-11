# 浏览器视频采集与独立音频

当前默认路径为浏览器视频、Windows 系统混音、仅可证明的整屏反控。原生 WGC 像素采集、窗口缩略图及原生边框已移除。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `dist/app.mjs` | 组装依赖、UI、用户分享/停止意图和生命周期协调 |
| `BrowserCaptureMediaDevices` | 用户手势中立即调用系统选择器，返回原始 MediaStream/视频轨道，组合音频并持有清理责任 |
| `createSystemAudioTrack` | 随机音频 owner、WASAPI PCM IPC、AudioWorklet、MediaStreamDestination 音频轨道 |
| `LauncherWebCastClient` | 配对、信令、单一音视频 sender、H.264/Opus、码率/分辨率、重协商 |
| `proveCaptureGeometry` | 检查整屏来源和本地显示布局，决定是否可以反控；不负责采集视频 |
| `calibrateDisplayBinding` / Rust `display_binding` | 短暂显示四角随机标记，仅本地识别所选屏幕；Rust 持有布局与来源绑定及释放责任 |
| `WebCastTouchbackSender` / InputEngine | AXTP 会话、输入流、坐标映射、按住状态和释放 |
| Rust `native_audio` | 独立音频会话及有界 PCM 队列，全部 COM 音频接口由专属线程拥有 |
| Rust `input_geometry/input_native` / `windows_mouse_model/windows_mouse` | 当前物理屏幕几何、Windows Touch/Mouse 与 macOS Mouse 注入、租约校验及状态释放 |

默认媒体路径：

```text
getDisplayMedia -> 原始 VideoTrack ──────────┐
                                           ├-> WebRTC H.264 / Opus -> RX
WASAPI -> PCM IPC -> AudioWorklet -> AudioTrack ┘
```

浏览器视频不经过 `nearcast_capture_start/frame`、GPU 回读、BGRA 像素 IPC、Canvas 或本地缩略图任务。音频 PCM IPC 与视频轨道独立；不使用 getUserMedia、不采集麦克风。macOS 沿用系统选择器返回的 display audio；缺少音频时视频继续。

采集 provider 的公共边界为 `getDisplayMedia(options)`、`stop()` 和 `diagnostics()`。WebRTC 层接收轨道，不依赖视频采集实现。将来如需重新接入 WGC，应通过该边界明确选择并独立验收，不在浏览器失败时静默回退到另一套采集来源。

## 来源和反控范围

浏览器不可靠地暴露 HMONITOR/HWND。Windows 在系统选择器完成、视频尚未加入 WebRTC 时执行一次有界校准：

1. 仅对 `displaySurface=monitor` 开始校准。Rust 枚举物理显示器，保存布局 revision，为每块屏幕生成独立随机 token。
2. 独立 GDI 线程在每块屏幕的四角各显示 96×96 物理像素标记；不激活窗口、不接受输入，不是 WGC 像素采集。
3. 浏览器用原视频轨道的临时 video 读取四角小块像素，核对随机 token 和四个不同的角编号。最多识别 5 秒，不保存或上传像素；原生标记另有 6 秒强制消失期限。
4. 四角完整命中唯一屏幕后，Rust 重新核对布局、来源、挑战有效期、画面比例，移除标记并生成随机 bindingId 和本地 nativeId。
5. 等待短暂的清屏间隔后，把同一条原始 VideoTrack 交给预览和 WebRTC；校准结束后不再执行视频像素读取。

绑定同时包含 browser sourceId、bindingId、layoutRevision 和物理 region，主屏/副屏、相同尺寸显示器和负坐标使用同一路径。输入开流核对绑定和当前布局；原生 prepare/apply 也校验绑定未撤销，坐标不能超出目标物理矩形。校准失败时多屏不猜测目标，视频继续；只有原有的单一主屏、原始尺寸完全吻合路径可保留反控。窗口仍仅投屏，旋转屏幕暂不支持。

provider 在 WebRTC 应用输出分辨率前保留原始来源事实，不伪造浏览器的实际输出尺寸。输出允许保持比例缩小；Touch 映射到原始桌面物理像素。macOS 沿用原有单主屏来源证明，不使用 Windows 校准窗口。

停止、系统结束分享、重选、轨道 mute 或显示布局变化会撤销旧来源。已有输入清理完成后才能重新绑定；旧来源的迟到输入不能交给新桌面。

浏览器请求 `surfaceSwitching=exclude`，不在同一轨道上主动切换来源；切换屏幕通过停止后重选。此参数是浏览器提示，浏览器不提供可验证的持续 monitorId；若未来允许原地切换，必须为其增加重新校准流程。屏幕拔插、布局/分辨率变化需停止后重新分享。识别机制信任应用内前端，与现有 Tauri 本机 IPC 属于同一信任边界，不能证明已被篡改的前端提交的像素观察真实。

WGC 原生反控绑定和桌面提示层已经移除；整屏 Touch 不依赖任何原生视频采集租约。

Windows Mouse 复用整屏绑定，将物理坐标在 PMv2 DPI 上下文中映射至虚拟桌面，使用 ABSOLUTE|VIRTUALDESK 并定位至物理像素中点。支持五键及组合、修饰键、detent120 和 regionQ16_16 双轴滚动；每个输出都有状态检查点，部分提交和失败清理保留 owner。Touch/Mouse 共用串行执行链并拒绝活动手势重叠。详情见 [Windows typed Mouse](windows-typed-mouse.md)。默认策略保持类型，显式转换由 OutputPolicyAdapter 在已认证和映射后的本机边界执行，原生后端不推断手势。

## 生命周期

1. 分享按钮的同步调用栈内调用浏览器 getDisplayMedia，保留用户激活状态。
2. 选择成功后捕获原始来源事实；Windows 整屏先完成或超时退出四角校准，再启动独立音频 owner。
3. 音频不可用时报告诊断并继续视频；只组合一个音频轨道。
4. 原视频轨道同时用于预览和 WebRTC；停止重选复用原音视频 sender。
5. `stop()` 取消校准并停止视频，等待校准退出，再撤销本次屏幕绑定及释放原生触点，随后释放独立音频。任一清理失败均阻止下一次复用，但仍尝试其他资源清理。
6. generation fencing 取消迟到选屏结果；旧 track.stop 不能停止新会话。
7. 应用关闭、退出及软件更新时 Rust 额外清理原生输入、屏幕绑定/标记及独立音频。

## 验证

单元测试覆盖原轨道身份、同步选择器调用、音频失败保视频、取消/迟到/停止、清理失败、平台音频策略及降分辨率坐标映射。

`tests/webcast-browser.integration.mjs` 用 Edge 的真实 SDP/ICE/DTLS/SCTP/RTP，通过合成视频代替系统选择器、合成 PCM 代替 WASAPI。真实浏览器 video/canvas 上运行生产标记识别，原生 IPC 使用 fixture；覆盖原视频轨道直送、Opus 有能量、同分辨率副屏识别、负坐标 Touch、主副屏停止重选、布局变化禁用输入而媒体继续，以及无绑定多屏/窗口拒绝反控。Rust 显式忽略测试可在本机短暂显示实际标记并采样标记中心，检查物理定位、绑定及撤销。上述测试不代表真实 Windows 选择器到 WebView2 的校准、硬件性能、听感和物理触控已验收。

实机对比应在同一分辨率、码率、内容、网络和 RX 版本下比较浏览器路径与先前原生路径，查看诊断 `capture.backend=browser`、`media.video.framesPerSecond`、编码数和 `qualityLimitationReason`，并观察 RX 呈现帧率。
