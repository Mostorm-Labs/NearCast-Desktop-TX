# NearCast Desktop TX

当前反控使用 AXTP typed-input R2 开发快照；实现、依赖指纹、恢复步骤和验证限制见 [TI-3 handoff](docs/superpowers/handoffs/2026-11-06-tx-typed-input-ti3.md)。早期 TouchBatch/BIND 联调记录仅供历史追溯。

支持 Windows 10/11 和 macOS 13 及以上版本。Windows 使用 WebView2；Windows 安装包会在安装时下载并静默安装 WebView2 Bootstrapper。macOS 首次分享屏幕前，需要在“系统设置 → 隐私与安全性 → 屏幕录制”允许 NearCast Desktop TX。

NearCast Desktop TX 是基于 Tauri 的 WebCast 发送端，复用 Launcher 的发送流程：配对码加入房间、WebSocket 信令、WebRTC `RTCPeerConnection` 和 DataChannel 控制通道。

## 本地运行

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"
$env:HTTPS_PROXY="http://127.0.0.1:7897"
$env:CARGO_HTTP_PROXY="http://127.0.0.1:7897"

# 验证 JavaScript 协议和发送端流程
npm test

# 检查 Tauri Rust 后端
cargo check --manifest-path src-tauri/Cargo.toml

# 构建并启动 Release 发送端（已内置页面）
cargo build --release --manifest-path src-tauri/Cargo.toml
.\src-tauri\target\release\nearcast_desktop_tx.exe
```

macOS 本地调试请构建并打开 `.app`：

```sh
npm run build:macos
open "src-tauri/target/debug/bundle/macos/NearCast Desktop TX.app"
```

`build:macos` 优先选择钥匙串中唯一的 Apple Development 证书（没有开发证书时选择 Developer ID Application），也可通过 `APPLE_SIGNING_IDENTITY` 明确指定。脚本拒绝使用 ad-hoc 签名进行权限联调，并在应用仍运行时拒绝覆盖 `.app`。配置中的 `signingIdentity: "-"` 仅供无证书的 CI 生成构建产物；ad-hoc 代码身份随构建变化，不能保证保留旧版本的录屏与辅助功能授权。正式权限联调使用稳定的 Apple 签名身份。参见 [Apple 代码身份说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。首次启动请允许本地网络访问；可在“系统设置 → 隐私与安全 → 本地网络”检查 NearCast Desktop TX。

从旧 ad-hoc 包切换到稳定签名后，旧授权可能仍绑定原来的代码哈希，单纯关闭再开启系统开关不会更新该身份。本机系统日志会报告 `Failed to match existing code requirement`。仅重置当前应用对应的 `Accessibility` / `ScreenCapture` 授权，再由用户重新确认；不要清空其他应用的授权或修改 TCC 数据库。

WKWebView 需要至少一个媒体用途声明才暴露 `navigator.mediaDevices`。`Info.plist` 包含 `NSMicrophoneUsageDescription` 以启用此接口；屏幕分享仍传入 `audio:false`，不申请或采集麦克风音频。

macOS 界面顶部提供“本地网络”“录屏与系统录音”“辅助功能”三个权限开关入口。点击任一入口会打开对应的系统设置页面，由用户确认授权或关闭；回到应用后自动重新检测，也可点击“刷新状态”。录屏和辅助功能读取系统授权状态；本地网络显示实际组播访问检测结果“网络可用”，检测失败显示“待确认”，不把离线或网络异常误判为用户拒绝。修改本地网络权限后返回配对页会重新扫描。首次配置录屏或辅助功能时会触发对应系统授权提示，授权后如系统要求重启，请重新打开 `.app`。Windows 隐藏此面板。

部分 macOS 版本的本地网络链接会打开“隐私与安全”总页，此时再选择“本地网络”；新版系统可能将“辅助功能”权限显示为“设备控制和数据访问”。

启动后输入接收端显示的 4 位配对码，点击“连接”，待接收端确认后点击“开始分享屏幕”。Windows 原生采集可用时，会弹出发送端的屏幕/窗口选择器；其他平台沿用系统选择器。点击“停止分享”会停止媒体轨道但保留连接，点击“断开连接”会关闭 WebRTC/WebSocket 并清理 Touchback 状态。

连接后可以在“Video quality”面板选择采集分辨率、动态码率或固定目标码率。默认使用 1920×1080、固定 12 Mbps，适合先观察桌面文字清晰度。可选分辨率为 Auto、1280×720、1920×1080、2560×1440 和 3840×2160；可选目标码率为 2、4、8、12 和 20 Mbps。配置在下一次开始分享时生效，两种模式都会把选择的数值作为 `maxBitrate` 上限；动态模式允许 WebRTC 根据网络和编码器自适应降码率，固定模式尽量维持选择的目标。屏幕轨道会标记为 `contentHint=detail`，提示编码器优先保留文字和细节。目标码率受网络、接收端和浏览器 H.264 编码器能力影响，不代表每秒流量恒定。

发送端等待控制 DataChannel 建立后才启用分享按钮。初始 Offer 使用 WebSocket，携带 Launcher 的 roomId/userId/hostUserId/targetId；随后优先用 `webrtc-signal` DataChannel 消息协商 H.264/Opus，ICE 在 Answer 到达前排队。停止分享时清空 sender 的 track，重新选择时复用原 sender，避免出现重复视频轨道。取消或拒绝屏幕选择会保留连接并在分享页显示错误。

反控采用 `AXTP-TYPED-INPUT-V1` / `input-sample-v1`，固定开发合同为 `0.18.0-dev.feac6fa2a4b9`（尚未发布）。控制通道完成标准 CONTROL 与 Hello/Identify/Identified 握手后，接收端通过 `input.openStream` 请求输入类型集合，发送端按实际软件能力取交集。每包使用完整 Standard Frame、STREAM header、类型字节及 CRC16；不再接受旧 BIND、TouchBatch、wire epoch 或私有文本 RPC。普通输入无应用 ACK，查询和状态变更使用现有 `stream.getState` / `stream.stateChanged`。

发送端投屏页提供“允许接收端反控本机”，默认关闭；接收端也需启用。默认 Native 策略保持输入类型，不把 Touch 猜成鼠标手势。当前 Windows typed 通路支持原生 Touch（最多 10 点）；既有 Windows Mouse 后端保留，但尚未接入新版 typed Mouse。macOS 目前支持基本原生 Mouse，不支持原生 Touch，不暗转 Mouse；原有手势与滚动代码留作后续明确输出策略的实现材料。

Windows 原生采集支持多屏环境中选择任意一块屏幕，或一个可见的前台窗口。分享目标按实际 HMONITOR/HWND 建立本地采集租约；反控坐标映射到该目标的物理像素范围，支持副屏负坐标和按比例降低视频分辨率。红框表示正在分享，绿框表示输入流和对应的原生输入 owner 均已就绪；停止分享后移除边框。窗口移动、缩放、失去前台、最小化或关闭会取消已按住的触点并撤销旧绑定；TX 在来源重新有效后发布新绑定，接收端需关闭旧流并使用新绑定重新开流，媒体连接保持。窗口输入还会检查目标点的实际窗口命中，遮挡处不会注入到其他窗口。当前原生源最多 3840×2160 像素，不额外放大较小窗口；视频质量设置作为保持纵横比的输出上限。macOS/浏览器回退仍要求单一活动主屏幕、无旋转、完整屏幕且原始分辨率采集，不能据 Windows 测试宣称其已支持窗口反控。实现和验证范围见 [采集目标 handoff](docs/superpowers/handoffs/2026-11-06-capture-target-and-border.md)。原生清理失败会保留 owner 并阻止重新开流；点击“重试释放输入”确认释放后，再“重建反控连接”。若接收端已有 streamId，可以在接收端显式重试关闭。输入或控制通道失败不会关闭媒体连接。

展开“反控收包诊断”或调用 `globalThis.__nearcastTouchbackDiagnostics()`，可查看 `appReady`、`sourceReady`、`nativeReady`、软件输入类型、streamId、本地 generation、队列、清理状态和错误。`receiverEnabled` 为 null，接收端的 effectiveEnabled/lifecycleState 需在接收端查询；RPC 成功本身不证明原生输入生效。诊断不包含配对码或 native lease。详细模块边界与精确合同 SHA 见 [TI-3 handoff](docs/superpowers/handoffs/2026-11-06-tx-typed-input-ti3.md)。

WebSocket 地址默认为 `wss://cast.nearhub.us`，也可以通过 Tauri 页面 URL 的 `?ws=` 参数覆盖，例如 `?ws=wss%3A%2F%2Flocalhost%3A8888`。

已知联调限制：当前 RX 在活动输入流中收到来源几何变化或撤回时可能关闭反控通道，尺寸变化后尚不能保证自动恢复。暂时可在发送端点击“重建反控连接”，再在接收端重新开启反控；共享窗口仍须处于前台。此限制不代表应继续使用旧坐标注入，后续需补齐双方的关闭旧流、接收新绑定及重新开流流程，见 [窗口尺寸变化重绑定记录](docs/superpowers/handoffs/2026-11-06-window-resize-input-rebinding.md)。

Windows 的分享范围选择器使用“屏幕 / 窗口”页签和真实缩略图卡片，选中后点击“开始分享”。缩略图是本次打开选择器时的快照，只在本机按需读取；关闭后释放，重新打开会重新读取。预览不可用时仍可选择目标尝试分享。

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
