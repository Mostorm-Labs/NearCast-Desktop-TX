# Windows Touchback 提权 Agent 设计

## 状态

规划中的待实现功能。本规格只冻结设计边界，不新增 Agent、IPC、manifest、签名或运行时代码；当前 sender 继续使用已有 Windows Pointer Injection 路径。

## 背景与问题

Windows 发送端在普通完整性级别运行时，可以向普通桌面窗口注入 Touchback 输入，但不能稳定地把输入交给以更高完整性级别运行的窗口。管理员模式测试表明，接收端 Touchback 授权、WebRTC DataChannel 和现有 AXTP/Touchback wire protocol 均可正常工作，失败点位于发送端本机的 Windows 权限边界。

因此，不能通过修改 receiver、改变 Touchback 帧格式或让 WebRTC 层承担权限职责来解决问题。发送端需要一个受控的本机输入边界，使普通 Tauri/WebView 主进程保持普通权限，同时在确有反控授权时使用一个权限范围更小的输入进程。

## 目标

- 普通 sender 保持普通权限，WebView、网络、配对和 WebRTC 不因反控而整体提权。
- 仅在收到有效 Touchback BIND 且用户已开启反控后，按需启动 `nearcast-touchback-agent.exe`。
- Agent 只处理已验证的 Touchback 输入记录，提供 `initialize`、`inject_batch`、`reset`、`shutdown` 四类本机操作。
- Touchback 断开、receiver 关闭、sender 退出、会话 fence 或输入桌面变更时，先 reset，再结束 Agent。
- 对高权限普通窗口提供长期可用的反控能力；对 UAC 安全桌面、锁屏和登录界面明确拒绝。
- 保持现有 Touchback/AXTP/WebRTC wire protocol 不变。
- 记录足以区分权限、桌面、坐标/DPI、焦点和 native 注入错误的诊断信息。

## 非目标

- 不把整个 Tauri sender 永久设置为管理员。
- 不让 Agent 接收任意窗口句柄、命令行、网络请求、脚本或文件操作。
- 不修改 receiver 授权逻辑、Touchback 帧头、序列号、BIND、RESET 或 DataChannel 信令。
- 不在第一阶段实现 UIAccess、代码签名或无提示的长期管理员授权。
- 不尝试控制 UAC 安全桌面、`Winlogon`、锁屏或登录界面。
- 不使用 Windows 服务作为输入进程；服务运行在 Session 0，不能直接代表当前交互式用户操作桌面。

## 方案比较与选择

| 方案 | 结果 | 结论 |
| --- | --- | --- |
| 整个 sender 使用 `requireAdministrator` | 实现简单，但每次启动可能触发 UAC，WebView、网络和所有业务功能都处于高权限 | 不采用 |
| 整个 sender 使用 `uiAccess=true` | 可访问高权限普通窗口，但需要签名、受保护安装目录和特殊 manifest，主 WebView 获得更大的 UI 权限 | 不作为默认架构 |
| 独立 Touchback Agent | sender 保持普通权限，只将输入注入边界放入按需启动的受控进程 | 采用；后续可在 Agent 上增加 UIAccess |

## 架构与模块归属

### 普通 sender

Tauri 主进程和 WebView 继续拥有配对、WebSocket/WebRTC、receiver 授权、Touchback 解码、会话 fence/reset、UI 和诊断的所有权。sender 在 Touchback 会话层验证 BIND、epoch、序列和记录限制后，才把记录交给本机输入适配器。

sender 不把 WebRTC 或 receiver 提供的任何字段直接转成 Agent 命令。Agent 只接收由 sender 按本地版本和最大记录数重新编码的 IPC 消息。

### Touchback 输入适配器

Windows 输入适配器负责：

1. 根据 `nativeReady`、有效 BIND 和用户反控开关决定是否请求 Agent。
2. 创建随机一次性管道名和连接 nonce。
3. 通过 `ShellExecuteEx(..., "runas")` 按需启动 Agent，并等待受限握手。
4. 将已验证的批量记录转成 IPC `inject_batch` 请求。
5. 串行化 `initialize`、注入、`reset` 和 `shutdown`，沿用现有 fence/reset 的顺序保证。
6. 将 Agent 返回的状态、Win32 错误和桌面信息映射为现有 sender 的输入诊断，不改变 Touchback 会话状态语义。

### `nearcast-touchback-agent.exe`

Agent 是独立 Windows GUI/console-less 可执行文件，仅拥有输入注入和本机 IPC 生命周期职责。Agent 不连接网络、不解析 WebRTC、不读取 receiver 身份、不保存配对码、不访问任意窗口句柄，也不自行决定 Touchback 授权。

第一阶段 Agent 使用现有 Windows Pointer Injection 能力，并在自己的进程完整性级别执行 `initialize`、批量注入、取消/释放和 reset。第二阶段在完成签名、安装和 manifest 验证后，Agent 可增加 `uiAccess`，主 sender 仍保持普通权限。

## 本机 IPC 契约

### 连接建立

- 每个 sender 会话生成不可预测的随机管道名和一次性 nonce；不使用固定全局管道。
- Agent 启动参数只携带管道名、协议版本和一次性启动凭据，不携带配对码、网络地址或任意命令。
- 管道 ACL 限制为当前用户和当前交互式登录会话；拒绝其他用户、服务账户和跨会话连接。
- 握手同时校验协议版本、nonce、客户端 PID/父进程关系和 sender 创建的会话标识。PID 只作为辅助校验，不能单独作为授权依据。
- sender 在握手成功前不发送触控记录；Agent 在一次握手后只接受同一连接，连接关闭即丢弃全部会话状态。

### 消息边界

所有消息使用有明确长度的版本化二进制或受限结构编码，不能把未验证的 JSON/命令字符串直接交给 Agent。每条消息包括版本、消息类型、会话 nonce、请求序号和长度；长度和字段在分配内存前校验。

初始消息类型为：

- `initialize`：声明输入能力、最大触点数、坐标空间和 sender 会话标识；Agent 返回完整性级别、Session ID、输入桌面和初始化错误。
- `inject_batch`：包含已验证的 Touchback 记录批次；Agent 只接受允许的 phase、buttons、坐标范围和最大记录数。
- `reset`：释放 Agent 记录的所有活动触点/按钮，并返回 reset 结果和最后一个 Win32 错误。
- `shutdown`：执行一次 reset，停止接受后续消息并退出。

Agent 返回明确的状态码和 Win32 错误码。至少区分：`accepted`、`not_initialized`、`invalid_message`、`invalid_state`、`not_supported`、`access_denied`、`secure_desktop`、`session_mismatch`、`pipe_closed` 和 `native_error`。

### 输入限制

- 最大消息长度、最大批次大小、最大触点数和坐标范围由 sender 与 Agent 的协议版本共同冻结。
- Agent 不接受窗口句柄、进程句柄、线程句柄、DLL 路径、命令行或网络请求。
- Agent 只允许当前 Touchback 适配器声明的坐标空间；DPI/虚拟屏幕换算继续由 sender 的现有输入路径负责，并在诊断中记录。
- 任何 epoch、序列、contact ID、phase 或按钮状态错误都在 sender 会话层拒绝；Agent 不替代 TouchbackSession 的协议校验。

## 生命周期与时序

### 启动

1. receiver 通过已认证的 WebRTC control channel 发送有效 BIND。
2. sender 完成 TouchbackSession 校验，并确认用户已开启反控。
3. Windows 输入适配器创建随机管道、nonce 和 Agent 会话上下文。
4. sender 通过 `runas` 启动 Agent；UAC 取消或启动失败时，反控进入明确的不可用状态，屏幕分享和 WebRTC 会话保持可用。
5. Agent 完成握手和 `initialize`，返回完整性级别、Session ID、输入桌面与能力。
6. sender 只有收到成功初始化结果后，才把 `nativeReady`/Agent 就绪状态暴露给 Touchback 注入路径。

### 正常输入

1. sender 从 DataChannel 收到 Touchback BATCH。
2. sender 按现有 TouchbackSession 验证 epoch、序列、contact 状态、批次长度和授权边界。
3. 输入适配器按顺序发送 `inject_batch`，不允许跨批次重排。
4. Agent 检查当前输入桌面和本地状态，调用 Pointer Injection，并返回结果、计数和错误字段。
5. sender 更新 `injectionCount`、`lastInjectionStatus` 和权限诊断；返回给 receiver 的 Touchback ACK/RESET 语义保持现状。

### reset、断开和退出

- receiver RESET、Touchback fence、control channel 关闭、peer 离开、用户关闭反控或 sender 退出时，sender 先停止发送新批次。
- 输入适配器发送 `reset`，等待 Agent 确认活动触点/按钮已经释放。
- reset 成功后发送 `shutdown` 并关闭管道；Agent 也必须在管道断开或父进程退出检测到后执行本地 reset。
- reset 失败时，sender 保留失败诊断并阻止新的输入，直到重新建立安全 Agent 会话；不得把未确认的活动触点交给新的 Agent。
- 新 BIND 必须使用新 nonce、 新管道和新 Agent 会话，禁止复用旧连接。

### 异常与恢复

- UAC 被取消：显示“需要允许 Touchback Agent 才能控制高权限窗口”，不影响屏幕分享。
- Agent 崩溃或管道断开：sender 立即 fence 输入、标记 Agent 不可用，并尝试一次受控 reset/回收；不得自动循环弹出 UAC。
- 当前桌面为 `Winlogon` 或安全桌面：拒绝输入并显示“不支持安全桌面输入”，直到回到普通交互桌面。
- 高权限普通窗口输入失败：保留 `access_denied`/Win32 错误和 Agent 完整性信息，供继续区分焦点、DPI、坐标和目标窗口状态。
- Session ID、用户、nonce、版本或父进程校验不一致：立即关闭管道并记录 `session_mismatch`，不尝试降级到未保护的输入路径。

## 安全桌面与权限边界

Agent 必须检测当前输入桌面，并把普通桌面与 `Winlogon`/UAC 安全桌面分开报告。安全桌面不属于支持范围，即使 Agent 具备管理员或 UIAccess 权限也不能声称可以控制它。

第一阶段的 `runas` 只在用户明确开启反控并收到有效 BIND 后触发。sender 不在启动时预先申请管理员权限，也不缓存或自动重放 UAC 凭据。Agent 的退出必须清理输入状态，避免权限窗口长期驻留。

第二阶段的 UIAccess 只应用于 Agent：安装位置必须是受保护目录（例如 `Program Files`），二进制必须使用 Authenticode 签名，安装包和更新流程必须保持签名链有效。候选 manifest 为：

```xml
<requestedExecutionLevel level="highestAvailable" uiAccess="true" />
```

实际发布前必须在 Windows 10/11 上验证 manifest、签名、安装目录和 UAC 行为；若验证发现 `uiAccess` 与执行级别组合不满足系统要求，应采用 Windows 验证通过的等价 manifest，而不改变本规格的权限边界。标准用户仍可能需要管理员授权；UIAccess 不扩大到安全桌面、锁屏或登录界面。

## 诊断与可观测性

sender 的 Touchback 诊断新增以下字段，并在会话、Agent 连接和最后一次注入发生变化时更新：

```text
senderIntegrityLevel
agentIntegrityLevel
sessionId
inputDesktop
lastWin32Error
secureDesktopDetected
```

同时保留现有字段：`controlChannelReady`、`nativeReady`、`bindingReady`、`injectionCount`、`lastInjectionStatus` 和 `receiverEnabled`。诊断中应明确标记字段来源（sender、Agent 或系统查询），避免把 Agent 初始化成功误报为 receiver 已开启反控。

建议的状态组合：

- `bindingReady=true`、`agentIntegrityLevel` 缺失：receiver 已授权，但 Agent 尚未启动或握手未完成。
- `agentIntegrityLevel` 高于 `senderIntegrityLevel`、`secureDesktopDetected=false`：具备控制高权限普通窗口的预期条件。
- `secureDesktopDetected=true`：明确拒绝输入，不能归类为普通权限失败。
- `lastWin32Error` 有值但桌面正常：继续按坐标、DPI、焦点或目标窗口状态排查。

## 平台实现边界

TouchbackSession、WebCastTouchbackSender、Launcher-compatible sender 和 receiver 协议保持平台无关。Windows 仅替换本机 input sink 的实现：现有普通权限 Pointer Injection 作为未启用 Agent 时的兼容路径，Agent sink 作为后续受控权限路径。macOS CoreGraphics 路径、Linux unsupported sink 和 WebRTC/信令模块不因本设计改变。

Agent 与 sender 之间的 IPC 是 Windows 本机实现细节，不暴露给 receiver，也不成为 Touchback wire protocol 的新能力 token。`touchback-v1` 继续表示 receiver/会话层能力；Agent 可用性属于 sender 本机运行时状态。

## 分阶段交付

### 第一阶段：提权助手验证

- 新增最小 `nearcast-touchback-agent.exe` 和受限命名管道协议。
- 使用 `runas` 按需启动，验证当前用户、Session、nonce、父进程和输入桌面。
- 复用现有 Pointer Injection 记录格式，先覆盖初始化、单批次注入、reset、shutdown 和断线清理。
- 增加 UAC 取消、Agent 崩溃、管道伪造、消息超长、重复序列和安全桌面的测试。
- 保持现有 sender 的普通权限和现有 Touchback wire protocol。

### 第二阶段：正式 UIAccess Agent

- 对 Agent 做 Authenticode 签名并安装到受保护目录。
- 增加经 Windows 验证的 `uiAccess` manifest，并在 Windows 10/11 上验证高权限普通窗口控制。
- 验证安装、更新、签名失效、卸载和回滚行为；签名或安装位置不满足要求时，明确退回第一阶段的管理员授权路径或禁用 Agent。
- UIAccess 仍不包含安全桌面、锁屏或登录界面。

## 验收证据

- `npm test`：现有 Touchback 会话、sender adapter、诊断和平台能力回归全部通过。
- `cargo check`/Windows 构建：Agent 与 sender 的 Rust/Windows 边界通过编译检查。
- IPC 安全测试：随机管道、ACL、nonce、Session、PID/父进程、版本和长度限制拒绝伪造连接。
- 生命周期测试：BIND 启动、批次顺序、RESET、fence、断线、sender 退出和重复 BIND 均能释放输入状态。
- Windows 10/11 手工测试：普通窗口、高权限普通窗口、UAC 安全桌面、锁屏/登录界面、不同 DPI 和多显示器坐标。
- 诊断测试：能分别报告 sender/Agent 完整性级别、Session、桌面、Win32 错误和安全桌面状态。
- 发布测试：第二阶段验证签名、Program Files 安装、manifest、UAC 和更新链；未签名或错误安装位置不得被当作 UIAccess 成功。

## 暂不实现的明确边界

在本设计落地前，代码继续使用现有 Windows Pointer Injection。不会添加管理员 manifest、不会创建 Agent、不会改变 Tauri capability、不会改动 Touchback wire protocol，也不会把当前普通权限失败伪装成已支持高权限窗口。后续实现必须以本规格为边界，先完成第一阶段 IPC 和生命周期验证，再评估第二阶段签名 UIAccess。
