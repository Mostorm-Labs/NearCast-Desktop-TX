# NearCast Desktop TX

2026-11-05 协议修复后的真机 Touch 实测流程、已验证 EXE 指纹及诊断说明见 [Touch 注入验证 handoff](docs/superpowers/handoffs/2026-11-05-touch-injection-device-handoff.md)。协议生命周期已联调通过，物理触摸注入仍待现场验证。

支持 Windows 10/11 和 macOS 13 及以上版本。Windows 使用 WebView2；Windows 安装包会在安装时下载并静默安装 WebView2 Bootstrapper。macOS 首次分享屏幕前，需要在“系统设置 → 隐私与安全性 → 屏幕录制”允许 NearCast Desktop TX。

NearCast Desktop TX 是基于 Tauri 的 WebCast 发送端，复用 Launcher 的发送流程：配对码加入房间、WebSocket 信令、WebRTC `RTCPeerConnection` 和 DataChannel 控制通道。

## 本地运行

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"
$env:HTTPS_PROXY="http://127.0.0.1:7897"
$env:CARGO_HTTP_PROXY="http://127.0.0.1:7897"

# 验证 JavaScript 协议和发送端流程
node --test tests

# 检查 Tauri Rust 后端
cargo check --manifest-path src-tauri/Cargo.toml

# 构建并启动 Release 发送端（已内置页面）
cargo build --release --manifest-path src-tauri/Cargo.toml
.\src-tauri\target\release\nearcast_desktop_tx.exe
```

启动后输入接收端显示的 4 位配对码，点击“连接”，待接收端确认后点击“开始分享屏幕”。浏览器会弹出系统屏幕选择器；点击“停止分享”会停止媒体轨道但保留连接，点击“断开连接”会关闭 WebRTC/WebSocket 并清理 Touchback 状态。

连接后可以在“Video quality”面板选择采集分辨率、动态码率或固定目标码率。默认使用 1920×1080、固定 12 Mbps，适合先观察桌面文字清晰度。可选分辨率为 Auto、1280×720、1920×1080、2560×1440 和 3840×2160；可选目标码率为 2、4、8、12 和 20 Mbps。配置在下一次开始分享时生效，两种模式都会把选择的数值作为 `maxBitrate` 上限；动态模式允许 WebRTC 根据网络和编码器自适应降码率，固定模式尽量维持选择的目标。屏幕轨道会标记为 `contentHint=detail`，提示编码器优先保留文字和细节。目标码率受网络、接收端和浏览器 H.264 编码器能力影响，不代表每秒流量恒定。

发送端等待控制 DataChannel 建立后才启用分享按钮。初始 Offer 使用 WebSocket，携带 Launcher 的 roomId/userId/hostUserId/targetId；随后优先用 `webrtc-signal` DataChannel 消息协商 H.264/Opus，ICE 在 Answer 到达前排队。停止分享时清空 sender 的 track，重新选择时复用原 sender，避免出现重复视频轨道。取消或拒绝屏幕选择会保留连接并在分享页显示错误。

Touchback 使用 WebCast control DataChannel 上的 canonical AXTP STREAM：16-byte 大端 STREAM header、28-byte 大端 TouchBatch header、CRC、每 packet 一个 seqId，普通输入和 RESET 均不发送应用 ACK。BIND payload 的字符串长度和 generation 同样采用大端，uint64 generation 保留为十进制字符串，避免 JavaScript 精度丢失。输入通道不再通过旧 `{method,result}` 消息直接激活 stream，也不接受旧的无 STREAM header 二进制帧。

接收端拥有 `input.openStream` 请求。发送端先接受 BIND，再校验 request 的 runtimeInstanceId、完整 target generation 和 canvas/geometry token，根据 preferred/required 与本机能力选择模式，生成 acceptedMode、revision 和协商上限后回复同 id/method 的 result。相同 commandId/参数在 5 分钟缓存窗口内重放同一结果；冲突参数会被拒绝。切换/重开遵循 RESET（新 epoch）→ closeStream → openStream，close 保留 BIND，并拒绝旧 epoch 输入。

Windows 原生桥提供 Touch（最多 10 contacts）及 Mouse（单 contact）的独立输入路径，按实际初始化结果协商能力。Mouse 仅执行接收端生成的明确鼠标记录；发送端不把零按钮 Touch DOWN 猜成左键，不实现接收端手势策略。当前 RX 的 Mouse producer 和 AXTP 共享 Mouse 字段约定仍需补齐，原生输入测试通过不代表端到端 Mouse 已验证，详见 [Windows Mouse 适配说明](docs/superpowers/specs/2026-11-05-windows-native-mouse-adapter.md)。macOS 13+ 保留现有 CoreGraphics Mouse 路径，尚未实现独立键码/滚轮注入。反向控制时请分享主屏幕；窗口/副屏需要后续加入捕获区域映射。macOS 首次使用反向控制需要在“系统设置 → 隐私与安全性 → 辅助功能”允许 NearCast Desktop TX。AirPlay 仍仅展示，不授权 Touchback。

连接页先显示“本机输入已初始化，等待接收端开启反控”；BIND 只建立协议绑定，收到有效 receiver-owned input.openStream 请求并生成结果后才显示“反控已就绪”。接收端需开启 Touchback gate；手动配对和从发现列表选择接收端均可建立已认证的 WebCast 控制通道。

手动输入配对码时，已认证的 WebCast control channel 也会绑定 Touchback，不再要求先从扫描列表选择设备。接收端在发送端原生输入初始化完成前发出的 BIND/BATCH 会暂存并按顺序处理；AirPlay 或未打开的非 WebCast channel 仍不会授权反控。

真实联调时可在投屏页展开“反控收包诊断”，或执行 `globalThis.__nearcastTouchbackDiagnostics()`。`controlChannelReady`、`nativeReady`、`bindingReady` 分别表示通道、本机初始化、BIND 已完成；`control.streamState`、`control.stream` 显示协商状态和 stream/epoch/模式；`control.recentControl` 保留最近 32 条控制消息的允许字段及处理结果，二进制收帧单独计数；`injectionCount` / `lastInjectionStatus` / `lastInjectionFailure` 表示实际注入及错误。诊断不保留配对码或 bindingToken。`receiverEnabled` 仍为 null，接收端本地 gate 和 effectiveEnabled 应通过接收端状态查询核对。

WebSocket 地址默认为 `wss://cast.nearhub.us`，也可以通过 Tauri 页面 URL 的 `?ws=` 参数覆盖，例如 `?ws=wss%3A%2F%2Flocalhost%3A8888`。

## 局域网发现与显示配对码

Tauri 原生浏览 `_nearcast._tcp.local.`、`_airplay._tcp.local.` 和 `_raop._tcp.local.`；旧 `_webcast._tcp` 不再使用。NearCast TXT 需要 `capability=webcast` 才可选择，`code-display-v1` / `touchback-v1` / `trust-display-v1` 分别声明显示码、触控和现场指纹显示能力。AirPlay 仅展示，不提供这些能力。

原生 DNS-SD 缓存以 ServiceResolved/ServiceRemoved 跟踪在线状态，每 15 秒向界面发送完整快照，界面桥接租约为 45 秒；不会因为未变化的 TXT `ttl=60` 就移除仍在线的设备。请求目标来自 SRV 端口及该目标的 A/AAAA 地址，TXT endpoint 不决定连接主机或端口。

首次选择 NearCast 后，原生端只进行 TLS 握手观察公钥，不发送 HTTP；随后用该公钥的精确校验连接 POST 固定 `/nearcast/trust-display`。请求仅含 `type/version/deviceId/requestId`，不会携带配对码或 reason。接收端显示自己的完整指纹 60 秒；发送端同时显示四行共 64 位大写十六进制 SHA256(DER SubjectPublicKeyInfo)。现场用户逐组核对、勾选并点击“确认并信任设备”后，才按精确 deviceId 保存公钥。信任保存在应用数据目录 `trusted-devices-v1.json`，使用原子替换；不修改 Windows 证书库。界面支持撤销信任。

保存信任后才会通过 Rust rustls 桥接 POST `/nearcast/code-display`，reason 为 `sender-device-selected`；TLS 握手必须先通过已保存 SPKI 校验，才发送 HTTP。公钥变化会阻止显示码并要求重新现场核对，同一公钥续签或换 IP 不会丢失信任。只接收 `shown`、`unavailable`、`rate_limited`、`not_supported`，从不读取响应或 TXT 中的配对码。随后仍需现场读取并手动输入四位码；信任不会加入房间、授权媒体或 Touchback，也不会通过 WebSocket 回退请求。

TXT HTTPS endpoint 只用于显示码，选择设备不会覆盖 Launcher 配对信令地址。云端正常时继续使用 `wss://cast.nearhub.us`；要加入接收端的独立本地 fallback 房间，需要用 `?ws=` 明确指定该房间的 WSS endpoint，并输入该本地房间的码。

这两个固定 HTTPS 操作直接连接已发现地址，不使用代理、重定向、Cookie 或环境认证，限制请求为 1 KiB、响应为 4 KiB，并设置网络时限。mDNS 不能自动建立信任。指纹缺失、核对过期、信任文件损坏或保存失败时仍可现场输入配对码。已保存的设备信任只用于这两个原生 HTTPS 操作；本地 WSS 仍由 WebView2 验证证书，不能用此信任绕过它。

`src` 协议模块与 `dist` 运行模块需同步；`dist/tauri-device-discovery.mjs` 的导入必须指向 `./discovery-devices.mjs`。运行 `cargo build --manifest-path src-tauri/Cargo.toml` 会把当前 `dist` 打入 Debug EXE。

当前验证包含真实 TLS 自签名测试、66 秒以上真实 mDNS 广播/撤回测试和模拟原生边界的 Edge UI 测试；尚未完成现场用户指纹核对、真实屏幕选择器、发送端到接收端的 WebRTC / Touchback 整链路验收。

`node tests/webcast-browser.integration.mjs` 使用 Playwright 与 Edge，运行真实 SDP/ICE/DTLS/SCTP/RTP 和完整发送端页面；仅将屏幕采集替换为 canvas 视频轨道、将 WebSocket 服务替换为同页测试接收端。覆盖初次连接、取消选屏、接收视频帧、停止和重选。可用 `PLAYWRIGHT_MODULE` 指定已有 Playwright 模块路径，`BROWSER_CHANNEL` 默认 `msedge`。此测试不代替真实系统选择器和 NearCast GStreamer 接收端验收。

如果尚未点击分享就提示 `kicked_by_host`，该提示来自接收端结束会话，不能据此认定是 Windows 屏幕权限问题。初始控制连接失败、接收端原生 WebRTC 初始化失败等也会被旧接收端映射为这个原因；应结合接收端日志确认。

## 打包与跨平台验证

`src-tauri/tauri.conf.json` 已开启 `nsis`、`msi`、macOS `.app` 和 `.dmg` bundle；macOS 最低版本固定为 13.0。`.github/workflows/build.yml` 使用 Windows runner、macOS 15 Intel runner（部署目标 13.0）和 macOS 15 Apple Silicon runner 构建。当前开发机是 Windows，不能在本机编译或验收 macOS bundle，macOS 产物需要使用 GitHub Actions 或真实 macOS 主机。

跨电脑测试优先使用 `src-tauri/target/release/bundle/nsis/NearCast Desktop TX_0.1.0_x64-setup.exe`，安装包按当前用户安装并检查 WebView2；下载运行时需要联网。裸 EXE 为 `src-tauri/target/release/nearcast_desktop_tx.exe`，目标电脑需要已有 WebView2 Runtime。应用的 WebView2 数据和设备信任保存在当前用户的应用数据目录。当前产物尚未代码签名。
