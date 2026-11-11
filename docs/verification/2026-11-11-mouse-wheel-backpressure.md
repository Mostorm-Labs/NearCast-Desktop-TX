# RX 手势控制滚轮积压

用户运行 Debug 候选 TX，用 RX 手势控制后反控断开。现场证据：

- INPUT_SESSION_FAULT / TIMEOUT: Input queue age。
- receivedSamples=104、validatedSamples=103、submittedSamples=77、queuePeak=27。
- lastQueueWaitMs=257.3，超过既有 maxQueueAgeMs=250。
- coalescedSamples=0、lastNativeMs=20.5；lastNativeExecutionMs=0 是共享路由未透传计时。
- 最后提交为 Mouse eventKind=2 / SendInput，状态 submitted；lastCleanup=released、owners=0、cleanupPending=false。
- RX 最后开流 inputTypes=[mouse]；TX outputPolicy 仍为 native/native。
  因此手势已在 RX 转成 Mouse，TX 没有在本机执行 Touch 手势判定。
- capture 仍 live，独立 WASAPI 音频和 WebRTC 视频继续。

## 结论与改动

控制通道因 TX 队列超时主动关闭，不是权限、触点清理卡死或选屏身份失效。
既有队列只合并 Touch 和 Mouse 位置快照，不合并增量 wheel，持续滚动会逐包等待 IPC/native 执行。

1. 对已验证、尚未提交的相邻兼容 wheel 累加双轴增量，保留开始/结束/取消、
   方向反转、锚点、键和单位边界。保留每包序列和状态校验，拒绝溢出；不修改 wire 协议。
2. 合并不更新最老增量的入队时间，保持 250ms 超时和队列预算，不以放宽时限掩盖过载。
3. OutputPolicyAdapter 透传并累加 nativeDurationMs，区分 native 执行和 IPC/队列耗时。
4. UI 完整诊断 JSON 的序列化与 DOM 写入限制为约 150ms 一次，状态判断和输入执行不等待它。
5. lastReceivedInput 展示 wheelUnit/phase/X/Y 和按钮/修饰键，便于后续区分滚动和移动。

## 验证

- 210 项 JavaScript 测试通过，包括 80 包 Changed 累加、双轴总量、零轴、方向/修饰键边界、
  int32 溢出、锚点/Cancel、序列缺口、最老增量超时和计时透传。
- Edge 真实 DataChannel 集成：原生 fixture 每次延迟 20ms，约 4ms 一包输入连续滚动，
  122 个帧覆盖 Began、120 个 Changed、Ended；控制保持 active，滚动状态正常结束，
  原生总位移等于所有输入总和，本机调用减少；视频帧持续且 Touch→Mouse→Touch 仍正常。
- 更新界面回归通过。该轮 Rust 实现沿用上一轮清理修正（51 项普通测试通过），未改变原生 Mouse API。
- 当前 Debug 故障现场未重启，Release 候选构建供之后实测。压力测试替代采集和 native IPC，
  尚不能证明真实 RX、网络或设备的所有积压模式均消失。

如果方向反转、按键或生命周期事件本身过密而无法合并，仍会正常触发旧超时和安全清理；
后续应按实测 native/IPC 耗时选择批量本机调用策略，不能无条件丢弃滚轮或抬起事件。
