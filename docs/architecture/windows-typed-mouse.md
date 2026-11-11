# Windows typed Mouse

本实现沿用 `AXTP-TYPED-INPUT-V1` / `input-sample-v1` 的现有合同，不恢复旧 TouchBatch/acceptedMode/epoch 协议。默认原生策略由 RX 提供明确 Touch/Mouse 语义；TX 原生后端只做事件校验、坐标映射和 SendInput。合并 `e32d966` 后保留显式可选的 OutputPolicyAdapter：用户主动选择时，已验证的输入可在 TX 转成另一种本机输出。此转换单独记录，默认不启用，不改写 wire 类型；后续可将纯手势判定迁移 RX。

## 能力与边界

Windows probe 动态声明 Touch（InitializeTouchInjection 成功时）和 Mouse。Mouse 不依赖 Touch 初始化成功；input.openStream 可协商 Touch、Mouse 或两者。Mouse-only 的 maxContacts 为 0，prepare 不调用 InitializeTouchInjection。权限仍由当前 TX 进程决定，高权限普通窗口和安全桌面问题不由此功能解决。

Mouse 能力：buttonsMask=31、modifierMask=15、allowChords=true、wheelUnits=[detent120,regionQ16_16]、continuousScroll=true。移动、五键快照变化、Shift/Ctrl/Alt/Meta、双轴滚轮、cancel、modifiers 均由当前合同解码。连续滚动校验 Began/Changed/Ended/Cancelled 和固定锚点，并保留小数增量。普通键盘按键没有入口。

## 本机执行

- 复用 nearcast_input_prepare/apply/release、随机 owner/lease、几何 revision、四角显示器绑定，不增加绕过授权的注入命令。
- 原生对各 eventKind 的字段形状、按键位、生命周期和物理坐标做二次校验。move/wheel 不得隐式改变 buttons；buttons 事件必须有显式变化。
- Mouse 物理点必须位于分享屏幕内；转换至整个虚拟桌面的 0..65535 坐标，SendInput 设置 ABSOLUTE|VIRTUALDESK，在物理像素中点取样，支持负坐标。
- wheelX 直接映射到 HWHEEL，wheelY 直接映射到 WHEEL，保持 signed detent120 值，不反转、缩放或推断手势。正纵轴为 Win32 向上，正横轴为向右；RX 应按合同产生对应事件。
- regionQ16_16 按分享区域尺寸换算，再采用每 40 个显示单位对应 120 滚轮单位的策略，与合入的 macOS 路由保持相同灵敏度。Ended/Cancelled 清除滚动余量，不产生惯性。
- 一次事件的所有输出先完整校验，再以单次 SendInput 批量提交。每个输出有状态检查点，仅提交成功的前缀更新本租约状态。部分/零提交都不能报成功，即使 lastWin32Error=0。
- cancel、流关闭、切屏/来源撤销和退出释放本租约注入的按钮/修饰键。已由本地按住的修饰键不取得所有权；本地正按住的鼠标键不接受远端重复 Down。无法完全区分同时发生的本地与注入输入，远端控制时避免混合本地手势。
- 清理失败保留状态并阻止下一 owner；Touch 清理失败仍尝试 Mouse 清理，反之亦然。
- Touch/Mouse 活动手势不交叠；Mouse 仅持有修饰键或连续滚动时同样禁止 Touch 穿入。转换设置应用前撤销来源并释放旧 owner，成功后重新发布绑定。

## 验证

Rust 规划测试覆盖五键、组合、拖拽、滚轮方向、无坐标 cancel/modifiers、越界/非法形状拒绝、部分提交和失败 reset。JS 原生适配测试覆盖全部 Mouse 字段无损传递；Edge 集成覆盖真实 DataChannel 上 Touch→Mouse→Touch、帧序列、独立视频连续和诊断。测试使用 fixture 的原生桥接，不替代真实 RX 验收。

显式原生测试（会短暂显示自有测试窗口，只向该窗口输入，结束恢复光标和前台）：

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml typed_native_touch_mouse_and_owned_cleanup_reach_our_window -- --ignored --nocapture --test-threads=1
```

该测试经过 production owner/lease、屏幕绑定、反序列化和原生 API，检查副屏物理像素落点、五键消息、Ctrl 拖拽、detent/连续双轴滚轮、活动输入重叠拒绝、cancel 和撤销时的完整释放。Windows 10、真实 RX 手势与高权限窗口需另行验收。
