# 局域网／云端连接选择

“局域网投屏”默认开启，仅连接选中 RX 的本地 WSS；关闭后下次连接使用现有云端信令。
设置持久保存，不自动回退或迁移当前投屏。首次本地模式默认展示设备列表；纯四位码无法
确定局域网目标，必须先选设备。旧 RX 缺少本地能力时明确提示更新或手动关闭开关。

发现依旧使用 `_nearcast._tcp.local.`。新增 `signaling-select-v1,code-display-v2` 能力及
`runtime/status-rev/local-state/cloud-state` TXT；状态只作为提示，不作为 TLS 信任。
目的地来自原生 DNS-SD 的 SRV/A/AAAA。选择设备后，`nearcast_trust_pair` 自动观察 TLS 公钥；首次连接保存 SPKI pin，已有记录则验证相同公钥，取消或服务更换会废弃旧结果。发送端不展示指纹核对操作，随后使用已保存的 SPKI pin 验证实际接收端。

选定服务后，调用 v2 `/nearcast/code-display`，携带 `backend: local|cloud` 与
`runtimeInstanceId`。RX 现场显示对应服务的码，HTTP 只返回匹配的确认，不传回配对码。
TX 关联 requestId、deviceId、backend 和 runtimeInstanceId；切换设备／模式／RX 重启使
旧流程失效。云端模式遇到老 RX 仍可使用原 v1 请求。发现、信任和放码均不等于反控授权。

`src/webcast/local-signaling.mjs` 提供 WebSocket 形状的 IPC adapter。Rust
`local_signaling.rs` 拥有 WSS、TLS pin 校验、文本上限、发送队列、取消与退出清理；
撤销设备信任也关闭其原生连接。先订阅事件再打开，按 connectionId 丢弃其他/迟到事件，
发送调用有序。JS 不向原生传入任意远程 URL，不在本机启动代理监听器。

本地 WebRTC 显式 `iceServers: []`，RX local peer 也不配置公网 STUN/TURN。
采集、H.264/Opus、媒体和反控 DataChannel 不经过 Rust WSS。ICE/DTLS/SRTP 仍存在。
连接建立后保持本次模式，勾选变化仅影响下一连接；不会重新打开选屏或复制媒体 owner。

实现使用共享 Rust/JS，供 Windows 与 macOS 使用；macOS 的局域网权限、WKWebView
采集、签名构建和真实画音需在 macOS CI／真机验证，Windows 检查不代表 macOS 已验收。

验证：JS 默认/持久化/无回退/取消/顺序/过期回执；Rust 真实 pinned WSS 和错 pin 拒绝；
原生 TX fixture 连真实 C++ RX listener；Edge 实际 SDP/ICE/媒体经过本地 IPC adapter
fixture 时没有创建云端 WebSocket。现场网络、防火墙与持续画音仍需实机验证。
