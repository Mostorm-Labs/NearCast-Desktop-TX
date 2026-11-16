# 视频卡顿诊断

TX 保持浏览器原始视频轨道直接发送。诊断读取不修改画质、码率、选屏约束、编码优先级或窗口生命周期。
`LauncherWebCastClient.refreshMediaDiagnostics()` 每秒读取 sender 的 WebRTC 统计；分享时每 5 秒保存到
本地轮转日志，滚轮变化与会话事件也会保存当前快照。导出包含进程 ID，比较时必须按进程和分享区间分组。

`video` 中的主要字段：

| 字段 | 解释 |
| --- | --- |
| `captureWidth/Height/FrameRate` | 视频轨道 getSettings 返回的设置，不等于实际到达帧率 |
| `sourceFramesPerSecond/sourceIntervalFps` | media-source 的浏览器报告帧率与相邻采样累计帧差 |
| `encodedIntervalFps/sentIntervalFps` | outbound-rtp 相邻累计编码帧／发送帧差除以采样秒数 |
| `encodeMsPerFrame` | 相邻 totalEncodeTime 增量除以编码帧增量，毫秒／帧 |
| `qualityLimitationReason` | 浏览器报告 none、cpu、bandwidth 或 other |
| `qualityCpuSeconds/qualityBandwidthSeconds` | 浏览器累计限制时间，比较时取差值 |
| `sendKbps/targetBitrate/availableOutgoingBitrate` | 实际发送速率 kbps、编码器目标 bps、选中网络通路估计可用 bps |
| `roundTripTimeMs/fractionLost/packetsLost` | 选中通路 RTT 与远端 RTP 接收反馈；累计丢包允许负数 |
| `captureTrackState/captureMuted` | 采集轨道状态 |
| `pageVisibility/windowMinimized/windowVisible` | 页面与原生窗口状态；windowSampledAt 是原生采样时间 |

缺失或不可用的字段不补零。第一条没有区间速率，更换 sender、track、SSRC 或 source 后重置基线；
计数回退不会产生负速率，关闭／替换会话后的异步结果不会进入新会话快照。IPC 单独验证数值范围和枚举，
不记录窗口标题、轨道标签、设备 ID、SDP、ICE 地址、候选标识、任意编码实现字符串或画面内容。

静态画面的低帧率本身不能证明异常，必须在持续动画／滚动期间比较。
若来源帧率正常而编码速率低，结合编码耗时和限制原因继续定位；若来源已低，继续检查采集与窗口状态。
浏览器的 CPU／带宽枚举是定位线索，不能独立证明根因。

2026-11-13 在线网页端公开脚本的对照：`useSender.BxMCGqLo.js` 调用 `msg.BDjMH73q.js` 的
`applySenderParameters`，后者设置 `degradationPreference: maintain-framerate`。当前桌面 TX 的固定码率
路径使用 `maintain-resolution`，并设置 video contentHint 为 detail；这会影响受限时的取舍，尚未作为修复改动。
本地页面来源仍按 `windows-local-origin.md` 加载内置资源，屏幕绑定校准完成后结束像素读取。

后续按用户要求，将采集与发送帧率上限从 60 调整为 30，并移除投屏自动最小化与停止后的自动还原；
用户已有分辨率和码率设置继续使用。此调整需实机复测，不能视为已确认修复黑屏或卡顿。

验证：`node --test`、Rust diagnostics 测试和 `tests/webcast-browser.integration.mjs`，后者确认真实
WebRTC 的来源／H.264 统计可以进入持久诊断。
