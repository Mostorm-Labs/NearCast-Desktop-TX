# macOS 重复投屏选屏超时定位

## 范围与结论

- 检查版本：`0.2.0.41`，合并提交 `18a739a`，macOS `27.2.1`，Apple Silicon。
- 原故障定位版本为 `0.2.0.41`；最终修复版为 `0.2.0.44`。以下现场时间线保留原始故障证据。
- 故障发生在 WKWebView 的系统选屏回调阶段，早于新视频轨道返回和 WebRTC 发送。
- 已确认的触发条件是本进程启用过原生 ScreenCaptureKit 系统音频。之后系统选屏结果回到了应用主进程，而不是正在等待选屏的 WebKit GPU 进程。
- 用户退出并重开应用，关闭“分享系统声音”后，连续两轮“开始分享 → 停止分享”均成功。该对照与日志中的跨进程回调冲突吻合。
- 系统内部为什么将回调改发给主进程，尚不能仅靠公开日志证明；“后注册的原生客户端改变选屏结果归属”是与时间线吻合的机制推断，不视为已确认的 Apple 内部实现。

## 现场证据

时间均为北京时间，2026-11-19。同一应用进程 PID `15653`；WebKit GPU PID `15655`；WebContent PID `15656`。

| 时间 | 进程 / 行为 | 结果 |
| --- | --- | --- |
| 14:48:51.913 | 系统将首次选屏结果发送给 GPU `15655` | WebKit 收到 filter 更新，随后创建视频流 |
| 14:48:52.038 | `replayd` 接受主进程 `15653` 的新连接 | 对应原生系统音频初始化 |
| 14:48:52.244 | 主进程启动另一条 `SCStream` | 浏览器视频和原生音频同时工作 |
| 16:06:18.139–.195 | GPU 与主进程停止两条流 | 两条 `SCStream` 都有销毁记录；不是流一直未 stop 的证据 |
| 16:13:25.898 | GPU 发起第二次选屏 | 系统选屏器正常出现 |
| 16:13:28.349–.350 | 系统收到屏幕选择并回调主进程 `15653` | GPU 没有收到选屏 filter 更新 |
| 16:14:25.900 | GPU 的选屏 watchdog 到期 | 满 60 秒后取消请求，最终以 permission denied 拒绝网页请求 |

16:21、16:22、16:23、16:25、16:28 的后续尝试，同样在选屏请求发起约 60 秒后由 WebKit 超时取消。用户实际已经选择屏幕，因此界面的“已取消屏幕选择，或未允许本次分享”不足以解释该故障。

WebKit 的 `ScreenCaptureKitSharingSessionManager::promptForGetDisplayMedia` 源码包含 60 秒 watchdog，超时会进入取消路径，与系统日志吻合：[WebKit 源码](https://chromium.googlesource.com/external/github.com/WebKit/webkit/+/021ea0b98c3dca0b32a283eb87535e22458b739b/Source/WebCore/platform/mediastream/cocoa/ScreenCaptureKitSharingSessionManager.mm)。

## 原故障的代码路径（0.2.0.41）

1. `src/capture/browser-capture.mjs`：视频调用 `navigator.mediaDevices.getDisplayMedia`；macOS 未返回音轨时，另启原生音频。
2. `src/capture/native-audio.mjs`：通过 `nearcast_system_audio_start` 请求原生音频。
3. `src-tauri/src/native_audio_macos.rs` → `src-tauri/src/macos_system_audio.m`：在应用主进程枚举 `SCShareableContent`、创建并启动音频 `SCStream`。
4. 浏览器视频的选屏和视频流位于 WebKit GPU 进程。现场显示，主进程建立原生 ScreenCaptureKit 客户端后，后续选屏结果不再交回 GPU。
5. `src/platform-capabilities.mjs` 把 WebKit 返回的 `NotAllowedError` 归为选屏未获允许；网页异常本身无法区分用户拒绝与这次系统 watchdog 超时。持久诊断当前只记录分享状态，未记录选屏阶段及等待时长，所以必须结合统一系统日志定位。

此次合入的 `displaySurface: monitor` 提示只在 Windows 发送，macOS 请求没有这项变化。不能将此现象归因于该 Windows 参数。

## 修复实现与验证

- `0.2.0.43` 验证了仅隔离并回收 ScreenCaptureKit 工作进程不足以恢复选屏：17:32:26 音视频流已销毁、工作进程已退出，但 17:32:27 发起的下一次选屏仍在 17:33:27 超时。该方案没有作为最终修复结论。
- 最终 `0.2.0.44` 在 macOS 14.2 及以上使用 `macos_core_audio.m` 的 Core Audio Process Tap，不建立新的 ScreenCaptureKit/replayd 客户端。私有 tap/aggregate device 由会话拥有，正常停止时销毁，不修改系统默认音频设备；原生设备 PCM 经 AVAudioConverter 转为 48 kHz 双声道 Float32。
- `native_audio_macos.rs` 是工作进程控制器；采样及回调实现位于 `native_audio_macos_capture.rs`，仅工作进程调用。旧系统仍有 ScreenCaptureKit 兼容后端；现代系统的 Core Audio 出错时不回退到该后端，以免再次破坏选屏。
- 工作进程复用同一个已签名应用可执行文件，在 Tauri 初始化前进入音频模式，无第二个窗口、网络连接或选屏器。原生接口和最低 macOS 13 要求保持兼容。
- 管道帧限制为 20 KiB，主进程最多保留四个 PCM 包；丢包保留 sequence 缺口，继续由 AudioWorklet 重置。异常结束、启动失败和停止超时均回收进程；父管道关闭触发清理。
- 工作进程保留 main run loop，以便 ScreenCaptureKit 回调完成；退出请求与正常 PCM 循环使用停止标记区分正常停止和捕获错误。
- 工作进程入口验证父进程的可执行文件路径，拒绝外部直接调用。已对最终签名包执行检查：外部调用退出码为 2，无输出，不进入采集。
- `stopStream` 在恢复 UI 就绪之前等待来源清理；macOS 清理未完成时不调用下一个系统选屏器；来源匹配避免旧流的迟到停止关闭新流。
- 新增的三项 JS 生命周期检查在修复前分别失败，确认覆盖：停止提前完成、旧流误停新流、清理期间仍打开选屏器。完整 JS 测试 **307 项通过**，包括真实 AVAudioConverter 的 44.1/48/96 kHz、交错／平面布局、有能量双声道、异常格式和停止后回调检查。
- Rust 完整测试 **62 项通过，4 项忽略**。新增真实子进程/管道检查覆盖 PCM 传送、EOF 停止回收、启动错误、停止挂起时强制回收，以及协议预算和队列背压。
- 浏览器媒体集成检查通过，覆盖原始视频轨道、H.264/Opus、音频 RTP 能量、会话重复使用、窗口与整屏切换，以及音频故障时继续视频。这些检查使用原生音频 fixture，不能替代实际系统选屏回调验收。
- `0.2.0.44` bundle 签名校验通过。用户明确确认：同一个应用进程中开启系统声音，连续三轮选屏、投屏与接收端声音均正常。

## 最终实机证据

主进程 PID `48844`，WebKit GPU PID `48866`，未在这些分享之间重启应用。

| 轮次 | 选屏请求时间 | WebKit 收到选择时间 | 音频采样计数（会话中样本） |
| --- | --- | --- | --- |
| 1 | 17:45:13.416 | 17:45:15.005 | 36,864 |
| 2 | 17:45:26.359 | 17:45:28.388 | 49,152 |
| 3 | 17:45:32.409 | 17:45:33.417 | 4,096 |
| 4 | 17:45:37.058 | 17:45:38.689 | 40,960 |
| 5 | 17:45:42.491 | 17:45:43.954 | 持续增长至 1,234,432 |

系统日志实际记录到五次选择都返回同一个 WebKit GPU 进程，五次均随后创建浏览器视频流，没有选屏 watchdog 超时。新的 replayd 连接仅来自该 GPU，音频工作进程不再注册选屏服务。最后一轮视频编码计数增长至 981；测试结束后检查到零个存活音频工作进程。

测试末尾 17:46:11 出现信令连接关闭，UI 返回设备列表并提示连接关闭，音频进程已回收。本次没有进一步定位该连接关闭的网络／接收端原因；它发生在五次选屏成功之后，不将其作为选屏失败或连接稳定性验收结论。

本机已覆盖开启系统音频连续分享至少三轮，关闭声音的两轮对照在原定位阶段完成。系统分享栏停止、取消后重选、断开重连等更多组合，以及其他 macOS 版本尚未逐项完成实机验收。尤其 macOS 13–14.1 的旧音频后端未验证，可能仍受旧系统回调兼容性影响，不将本次修复验收外推到该范围。

原始系统日志仅保存在本机 `/tmp/nearcast-macos-first-share-system-log.jsonl`、`/tmp/nearcast-macos-reselection-system-log.jsonl`、`/tmp/nearcast-coreaudio-picker-verification.jsonl`，未提交原始日志、屏幕内容、地址或配对信息。
