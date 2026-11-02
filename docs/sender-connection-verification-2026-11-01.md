# 发送端连接与媒体回归

本次修复继续使用 Launcher 的初始 data-only Offer、control DataChannel 和 `webrtc-signal` 消息格式，未改变 WebCast / Touchback wire protocol。

## 用户故障与定位

用户在 Windows 10 报告输入配对码后、尚未点击分享就退回配对页。图片中的原因是 `kicked_by_host`。本机真实 Tauri 复现为 joined → 发出初始 Offer → peer_leave(kicked_by_host)，未收到 Answer、未调用屏幕采集。

接收端会话进一步用只发 join 的 Node 客户端复现，定位到旧构建的 GStreamer 运行时目录缺少 `gstwebrtc.dll` / `webrtcbin`，PeerOpened 初始化失败后被统一映射成踢人。切换完整 SDK 的接收端后连接成功。接收端的启动检查与诊断修复由其原会话负责。

## 发送端改动

- WebSocket Offer / ICE 携带 roomId、userId、hostUserId、targetId。
- 初次 WSS 协商后，按 Launcher 优先使用 control DataChannel 收发 `webrtc-signal`。
- 远端 ICE 在 Answer 生效前缓存，WebSocket / DataChannel 信令按序应用。
- joined 前不显示已连接；control open 后才启用选择画面。
- H.264 / Opus 编码偏好；停止分享用 replaceTrack(null)，重选复用 sender。
- 取消/拒绝屏幕选择保留会话；信令断开和接收端结束显示具体原因。
- 控制通道关闭时停止媒体、退出就绪状态并提示重新连接；仍在等待的选屏结果不能挂到已关闭的连接。
- Touchback 输入按原生调用串行化；reset/fence 期间拒绝新输入，重新 Bind 的首帧等待旧触点取消完成；Windows Cancel 使用 `CANCELED | UP` 并复用最后坐标。
- Release 使用 Windows GUI subsystem，不再附带控制台窗口。

## 验证证据

- Node：84/84 通过。
- Rust：20 通过，1 条需 66 秒真实 LAN 的测试未运行；cargo check 通过。
- Edge 完整页面集成：真实 SDP、ICE、DTLS、SCTP、RTP，canvas 代替屏幕采集；初始 Answer 延迟期间禁用分享，取消选屏不离开，视频收到帧，停止重选后继续收到帧且仅一个 video transceiver；关闭远端 control 通道后回到配对页并显示原因。
- 实际 Release Tauri/WebView2：secure context，getDisplayMedia 和 RTCPeerConnection 可用；显示 5 条 LAN 设备记录。
- 实际 Tauri → 云端信令 → 完整 SDK NearCast：Answer 成功，ICE/PC connected，control open，分享按钮可用，12 秒观察无退出。
- 实际 Tauri → NearCast 生成画面：首次 36 编码帧 / 98,032 bytes；停止重选后同一 outbound 视频累计 82 帧 / 207,949 bytes，PC 保持 connected，页面无错误。此测试临时将采集替换为 640×360 canvas，随后恢复原采集接口并停止测试画面。

尚未验收 Windows 10 系统选择器、另一台电脑的安装体验、真实桌面画面到屏幕的视觉效果、端到端 Touchback 和 macOS 真机。

## Windows 产物

- `src-tauri/target/release/nearcast_desktop_tx.exe`：11,176,448 bytes（约 10.66 MiB）；SHA256 `76CD3DE5C92DEBED90DA84852DAC4C2C4ADC0551E96DF63C1E5786F33062B46A`。
- `src-tauri/target/release/bundle/nsis/NearCast Desktop TX_0.1.0_x64-setup.exe`：2,850,228 bytes（约 2.72 MiB）；SHA256 `80638A2B1BBEB849E64590764B19A9D7F96C2EB5A25D12E69C97B0C84A166075`。

安装脚本为 currentUser / RequestExecutionLevel user，检查 WebView2，缺失时联网下载 bootstrapper。裸 EXE 需要目标机已有 WebView2。两个产物均未签名。
