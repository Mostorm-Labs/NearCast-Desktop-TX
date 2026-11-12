# NearHub Cast

版本和 Mosapi 更新发布契约见 [`AGENTS.md`](AGENTS.md) 与 [`docs/release/version-and-mosapi.md`](docs/release/version-and-mosapi.md)。完整版本使用 `X.Y.Z.Build`，TX 仅发布 Windows 和 macOS：`nearcast-tx-windows`（product-id `646`）与 `nearcast-tx-macos`（product-id `647`）。同一 GitHub Release 提供两平台更新包、签名和版本清单，并提供聚合 ZIP 单链接下载。

应用启动后后台检查正式更新并自动下载，顶部显示“发现新版本/更新已就绪”；每次启动发现更新时弹框，可选择“暂不更新”或在下载校验完成后“立即更新并重启”。安装前会结束投屏和反控。运行期间每 4 小时检查，网络失败不影响投屏；安装包及版本清单均需通过内置公钥验证。发布 workflow、签名 Secret 配置和平台验收限制见上述发布契约。

当前反控使用 AXTP typed-input R2 开发快照；实现、依赖指纹、恢复步骤和验证限制见 [TI-3 handoff](docs/superpowers/handoffs/2026-11-06-tx-typed-input-ti3.md)。早期 TouchBatch/BIND 联调记录仅供历史追溯。

支持 Windows 10/11 和 macOS 13 及以上版本。Windows 使用 WebView2；Windows 安装包会在安装时下载并静默安装 WebView2 Bootstrapper。macOS 首次分享屏幕前，需要在“系统设置 → 隐私与安全性 → 屏幕录制”允许 NearHub Cast。

NearHub Cast 是基于 Tauri 的 WebCast 发送端，复用 Launcher 的发送流程：配对码加入房间、WebSocket 信令、WebRTC `RTCPeerConnection` 和 DataChannel 控制通道。

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
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle -- --locked
& ".\src-tauri\target\release\NearHub Cast.exe"
```

macOS 本地调试请构建并打开 `.app`：

```sh
npm run build:macos
open "src-tauri/target/debug/bundle/macos/NearHub Cast.app"
```

`build:macos` 优先选择钥匙串中唯一的 Apple Development 证书（没有开发证书时选择 Developer ID Application），也可通过 `APPLE_SIGNING_IDENTITY` 明确指定。脚本拒绝使用 ad-hoc 签名进行权限联调，并在应用仍运行时拒绝覆盖 `.app`。配置中的 `signingIdentity: "-"` 仅供无证书的 CI 生成构建产物；ad-hoc 代码身份随构建变化，不能保证保留旧版本的录屏与辅助功能授权。正式权限联调使用稳定的 Apple 签名身份。参见 [Apple 代码身份说明](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。首次启动请允许本地网络访问；可在“系统设置 → 隐私与安全 → 本地网络”检查 NearHub Cast。

从旧 ad-hoc 包切换到稳定签名后，旧授权可能仍绑定原来的代码哈希，单纯关闭再开启系统开关不会更新该身份。本机系统日志会报告 `Failed to match existing code requirement`。仅重置当前应用对应的 `Accessibility` / `ScreenCapture` 授权，再由用户重新确认；不要清空其他应用的授权或修改 TCC 数据库。

WKWebView 需要至少一个媒体用途声明才暴露 `navigator.mediaDevices`。`Info.plist` 包含媒体用途说明以启用此接口。Windows TX 使用 WASAPI `eRender` loopback 采集默认播放设备的系统混音，不打开第二次系统选屏窗口，也不申请或采集麦克风；音频经过受限 PCM IPC 和 AudioWorklet 后加入 WebRTC Opus sender。没有播放设备或设备切换时，视频和反控仍保持独立，诊断会显示 WASAPI 错误。

macOS 界面顶部提供“本地网络”“录屏与系统录音”“辅助功能”三个权限开关入口。点击任一入口会打开对应的系统设置页面，由用户确认授权或关闭；回到应用后自动重新检测，也可点击“刷新状态”。录屏和辅助功能读取系统授权状态；本地网络显示实际组播访问检测结果“网络可用”，检测失败显示“待确认”，不把离线或网络异常误判为用户拒绝。修改本地网络权限后返回配对页会重新扫描。首次配置录屏或辅助功能时会触发对应系统授权提示，授权后如系统要求重启，请重新打开 `.app`。Windows 隐藏此面板。

部分 macOS 版本的本地网络链接会打开“隐私与安全”总页，此时再选择“本地网络”；新版系统可能将“辅助功能”权限显示为“设备控制和数据访问”。

启动后输入接收端显示的 4 位配对码，点击“连接”，待接收端确认后点击“开始分享屏幕”。默认使用 WebView 系统选择器，展示屏幕/窗口预览。视频原始轨道直接交给 WebRTC，不经过 WGC 回读、像素 IPC 或 Canvas。点击“停止分享”会停止媒体轨道但保留连接，点击“断开连接”会关闭 WebRTC/WebSocket 并清理 Touchback 状态。

连接后可以在“Video quality”面板选择采集分辨率、动态码率或固定目标码率。默认使用 1920×1080、固定 12 Mbps，适合先观察桌面文字清晰度。可选分辨率为 Auto、1280×720、1920×1080、2560×1440 和 3840×2160；可选目标码率为 2、4、8、12 和 20 Mbps。配置在下一次开始分享时生效，两种模式都会把选择的数值作为 `maxBitrate` 上限；动态模式允许 WebRTC 根据网络和编码器自适应降码率，固定模式尽量维持选择的目标。屏幕轨道会标记为 `contentHint=detail`，提示编码器优先保留文字和细节。目标码率受网络、接收端和浏览器 H.264 编码器能力影响，不代表每秒流量恒定。

发送端等待控制 DataChannel 建立后才启用分享按钮。初始 Offer 使用 WebSocket，携带 Launcher 的 roomId/userId/hostUserId/targetId；随后优先用 `webrtc-signal` DataChannel 消息协商 H.264/Opus，ICE 在 Answer 到达前排队。Windows 只弹出一次系统选屏窗口；视频由浏览器采集，WASAPI 默认播放设备音频使用独立本机会话，不依赖视频采集目标。停止分享时清空音视频 sender 的 track，重新选择时复用原 sender，避免出现重复视频轨道。取消或拒绝屏幕选择会保留连接并在分享页显示错误。

反控采用 `AXTP-TYPED-INPUT-V1` / `input-sample-v1`，固定开发合同为 `0.18.0-dev.feac6fa2a4b9`（尚未发布）。控制通道完成标准 CONTROL 与 Hello/Identify/Identified 握手后，接收端通过 `input.openStream` 请求输入类型集合，发送端按实际软件能力取交集。每包使用完整 Standard Frame、STREAM header、类型字节及 CRC16；不再接受旧 BIND、TouchBatch、wire epoch 或私有文本 RPC。普通输入无应用 ACK，查询和状态变更使用现有 `stream.getState` / `stream.stateChanged`。

发送端投屏页提供“允许接收端反控本机”，默认关闭；接收端也需启用。“输入转换配置”分别选择收到 Touch/Mouse 后的本机输出，默认保持原生类型，不支持的组合会禁用。Windows 原生支持 Touch（最多 10 点）和 Mouse；macOS 原生支持 Mouse，不提供原生 Touch。两端均可将 Touch 配置为 Mouse 点击拖拽、轻点点击／滑动滚动或组合手势；Windows 另可将 Mouse 左键生命周期转换为单点 Touch，此转换不接收右键或滚轮。原生 Mouse 支持移动、拖拽、Shift/Ctrl/Alt/Meta、横纵滚轮和连续滚动；Windows 使用 SendInput，支持左/右/中/后退/前进五键及组合，macOS 使用 CGEventPost，保持单独左/右/中键。两端均拒绝共享同一输出域的重叠手势。Windows 保留已校准副屏的精确物理落点、严格消息字段校验及注入失败前缀状态；释放时同时尝试清理 Touch 和 Mouse，任一清理失败均阻止复用。设置只在本次运行期间保留，应用时先撤销输入来源、释放当前原生 owner，再以新绑定重新协商；清理失败不应用设置，投屏继续。独立键盘和触笔记录不在当前 typed Touch/Mouse 合同内，未新增提权/UIAccess。

Touch→Mouse 点击拖拽在 DOWN 时按下左键、MOVE 时拖动、UP/CANCEL 时释放。Touch→滚动在 DOWN 时只定位，移动超过 6 个本机坐标单位后发送连续滚动；尚未滚动就 UP 才点击，CANCEL 不点击；滚动锚点固定在起点，松手发送结束事件，无惯性，仅支持单点。类型转换位于已认证、校验、坐标映射后的串行原生执行链；线上的 typed input 数据不改写，接收端协商的 inputTypes 描述可接收类型，原生输出类型单独记录。转换后触点仍使用本机 owner、lease 和 ID 池，不恢复已移除的无 owner 注入命令。

“Mouse · 组合手势（滚动 / 拖拽 / 右键 / 缩放）”合并日常操作：单指轻点点击，直接滑动滚动，静止达到拖拽长按阈值后移动才按住左键拖拽，松手释放。拖拽长按默认 300ms，可在 UI 调为 150–1000ms。右键方式可选“单指长按后松手”（默认）或“双指轻点”：默认单指静止 700ms 后松手产生一次右键；右键等待可调，不能短于拖拽等待，UI 自动抬高最小值，策略层拒绝无效组合。达到右键时长后若移动，则进入拖拽而非右键；Cancel 不点击。选择双指方式时，单指静止不触发右键，双指在 350ms 内轻点松开产生一次右键。两种方式互斥；捏合、平移、取消或拖拽中加入第二指均不补右键。捏合按配置输出：Mac 网页缩放使用前台应用的 Command＋/− 快捷键，属于显式兼容策略，不是原生捏合；Ctrl＋滚轮选项适合支持此语义的 Windows 应用，在 Mac 可能触发系统辅助缩放，默认不选。也可关闭缩放。缩放按比例阈值产生有界步数，不做惯性。

合并手势协商最多 2 个 Touch 接触。纯状态机位于 `src/touchback/touch-mouse-gestures.mjs`，显式传入时间与区域，不包含传输或 OS 调用；后续迁移接收端可复用判定规则，再将输出 Mouse 动作编码发送。当前发送端试验版使用到达时钟；最终接收端应使用本地采集时钟并屏蔽重复的兼容鼠标事件。macOS 通过 click-through、不抢焦点的桌面光圈显示拖拽蓄力（青色）、可拖拽并等待右键（绿色外圈＋紫色进度）、松手可右键（紫色旋转圈）、拖拽（蓝色）、双指（紫色双环）、捏合（橙色）。正常松手显示 280ms 旋转淡出确认，右键松手使用紫色；Cancel 不播放点击确认。光圈可关闭，无重复文字提示；IPC 绑定原生 owner/lease，清理时隐藏，停止刷新后自动消失。Windows 已补齐 typed Mouse 和手势转换，捏合可显式选择 Ctrl＋滚轮；Windows 桌面光圈暂未实现。原生 Windows 自测使用自有副屏窗口验证左/右键、拖拽、Ctrl 点击、横纵滚轮及退出清理，真实接收端整链路仍需现场验收。

Windows 分享整个屏幕后，会短暂显示四角随机校验标记，用所选浏览器轨道识别对应的物理屏幕，成功后标记自动消失。主屏、副屏和负坐标均使用 Rust 持有的来源绑定；同分辨率屏幕也不靠尺寸猜测。识别失败时音视频继续，可停止后重新分享；窗口仍仅投屏。视频保持原浏览器轨道，校准只读少量角落像素，不恢复 WGC 视频采集。输出分辨率可等比缩小，输入映射到原始物理坐标。macOS 保留单主屏及辅助功能权限要求。停止、重新选择或显示布局变化时撤销旧输入绑定、释放触点，重新就绪后由接收端开流；拔插屏幕或调整布局后需重新分享。目前不支持旋转屏幕。原生 WGC、缩略图、持续窗口边框及其 IPC 命令已经删除。架构边界见 [浏览器采集架构](docs/architecture/browser-capture.md)。

展开“反控收包诊断”或调用 `globalThis.__nearcastTouchbackDiagnostics()`，可查看 `appReady`、`sourceReady`、`nativeReady`、软件输入类型、streamId、本地 generation、队列、清理状态和错误。`outputPolicy` 记录配置；`nativeInput.lastConversion` 记录收到的类型、输出类型及产生的动作数，`nativeInput.lastSubmission` 记录系统确认的输出类型/API。`receiverEnabled` 为 null，接收端的 effectiveEnabled/lifecycleState 需在接收端查询；RPC 成功本身不证明原生输入生效。诊断不包含配对码或 native lease。typed 合同见 [TI-3 handoff](docs/superpowers/handoffs/2026-11-06-tx-typed-input-ti3.md)，该历史交接中的“仅 native、无转换”限制已由上述显式配置扩展。

WebSocket 地址默认为 `wss://cast.nearhub.us`，也可以通过 Tauri 页面 URL 的 `?ws=` 参数覆盖，例如 `?ws=wss%3A%2F%2Flocalhost%3A8888`。

当前默认浏览器采集不使用原生红绿边框或桌面触点提示层；分享状态由系统采集指示和发送端界面呈现。旧 WGC 选择器、窗口反控与边框相关源码已删除；旧文档仅作历史记录。

## 局域网发现与显示配对码

Tauri 原生仅浏览 `_nearcast._tcp.local.`，设备列表只展示 NearCast 接收端；不再搜索或展示 AirPlay/RAOP，旧 `_webcast._tcp` 不再使用。NearCast TXT 需要 `capability=webcast` 才可选择，`code-display-v1` / `touchback-v1` / `trust-display-v1` 分别声明显示码、触控和现场指纹显示能力。

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

左上角“设置”打开独立设置页，包含画质、码率、系统声音、反控与输入转换、检查更新及 Feedback。设置保存在本机；打开设置不会中断投屏。Feedback 在用户同意后打包诊断并向 Mosapi 提交，应用关联为 Windows `application.connect.id=39` / macOS `=40`，与更新的 product-id 区分。实现与验证边界见 [设置与反馈](docs/architecture/settings-and-feedback.md)，Windows CI 与在线更新验收见 [发布约定](docs/release/version-and-mosapi.md)。

Windows 仅构建 x64。日志写入 Tauri 应用日志目录，最多三个 1 MiB JSONL 文件轮转；每 30 秒采集一次数值性能指标及会话状态，不记录配对码、SDP/ICE 或音视频内容。底部“导出诊断”生成本机 JSON 报告，最多保留五份。系统声音仍为独立 WASAPI 采集，不采集麦克风；更新签名验证与 mDNS 发现保持。

Release 使用速度优化等级 3、ThinLTO、单编译单元及符号裁剪。Windows updater 仅处理当前 NSIS/MSI 原始包，移除旧 ZIP 更新包兼容；macOS updater 仍保留 `.app.tar.gz` 支持。WGC、窗口缩略图和原生边框源码已删除；Windows Mouse 通过受 owner/lease 保护的 typed 原生输入层执行，旧无 owner 注入命令保持移除。

`src-tauri/tauri.conf.json` 已开启 `nsis`、`msi`、macOS `.app` 和 `.dmg` bundle；macOS 最低版本固定为 13.0。`.github/workflows/build.yml` 使用 Windows runner、macOS 15 Intel runner（部署目标 13.0）和 macOS 15 Apple Silicon runner 构建。当前开发机是 Windows，不能在本机编译或验收 macOS bundle，macOS 产物需要使用 GitHub Actions 或真实 macOS 主机。

跨电脑测试优先使用 `src-tauri/target/release/bundle/nsis/NearHub Cast Desktop Installer_0.1.0_x64-setup.exe`，安装包按当前用户安装并检查 WebView2；下载运行时需要联网。Tauri 构建后的裸 EXE 和安装目录内主程序均为 `NearHub Cast.exe`，目标电脑需要已有 WebView2 Runtime。应用的 WebView2 数据和设备信任保存在当前用户的应用数据目录。当前产物尚未代码签名。
