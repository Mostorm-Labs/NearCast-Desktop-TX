# Touch 清理待确认诊断与修正

现场为 e218836 后的 Windows TX：RX 由原生模式停止再启用手势控制后显示 Release pending。
TX 诊断保留 native owner=1、Touch ID 映射=1，最后的未知提交包含已活动触点 Move
与新第二点 Down。更换控制会话后新的 engine 是 closed，旧 engine 仍在 retiring，
顶层 lastError 却是 null。停止投屏时另显示 native_touch_uncertain_cleanup_failed:0x80070057。

0x80070057 是 HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER)，此处是清理取消帧失败，
不是最初注入的错误，也不证明权限不足。现场未保留最初 Win32 错误，根因不能仅凭截图确定。

## 已确认问题与修改

- 原生 Touch 一旦失败即把本帧全部 ID 放入 possible_touch，未区分 ERROR_NOT_READY。
  Windows 文档明确该错误不注入数据，应重试相同帧。现在最多调用五次，间隔 1ms，
  成功前不推进本机触点；耗尽后只保留已确认状态用于清理。
- 其他未知错误保留可能的新增 ID。清理先使用已确认触点的旧位置，再尝试未知帧位置，
  两种候选都包含可能触点；不通过遗漏未知触点、重置本机列表或重新初始化来假报释放成功。
- 原生调用保留 Win32 code、API 与错误文本。JS lastSubmission、lastCleanup 记录失败结果。
- retiring engine 的状态/streamId/错误以 retiredInputs 暴露，顶层在旧输入未释放时
  显示 NATIVE_CLEANUP_PENDING，并回填旧 engine 的 lastError；新 closed engine 不再掩盖故障。
- 指针实现从 lib.rs 抽到 pointer.rs，以便测试相同帧重试与候选取消帧，不改变 wire 合同。

## 证据与限制

- 单元测试验证 ERROR_NOT_READY 相同帧重试、重试耗尽不推进状态、其他错误不盲目重试、
  取消候选包含所有未知触点；JS 验证失败及旧 engine 清理信息完整保留。
- 在自有副屏窗口复现过“仅一个真实触点，但取消帧包含未注入的第二点”时错误 87。
  只清理已确认点可通过，但在成功回执丢失的相反场景不可靠，因此没有采用此通用兜底。
- 自有窗口测试增加双指添加/移动/同时抬起，并可故障注入耗尽的 ERROR_NOT_READY，
  验证生产 release 不再取消未注入的第二点。该路径已在本机通过，后续 Mouse 回归
  遇到前台焦点被切换/滚轮未送达而未完成；没有把整项测试报告为通过，也未继续桌面注入。
- JavaScript 205 项、Rust 51 项普通测试通过；cargo check、浏览器音视频/切换及更新回归通过。
- 没有重启用户正在运行的 TX；当前进程仍是旧版。候选 Debug 构建供后续复现，
  尚未以现场 RX 完成原生模式→停止→手势模式验收，不声明原现场最初故障已彻底修复。

已卡住的旧版可先在 TX 重试释放输入；仍失败则需结束并重新启动 TX，由进程退出回收其注入会话。
新版遇到未知清理失败仍会阻止新流，保留错误，不自动绕过 Release pending。

参考：[InjectTouchInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-injecttouchinput)。
