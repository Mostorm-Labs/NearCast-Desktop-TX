# 设置页与诊断反馈

当前可配置项、默认值和生效时机见 [TX 配置与默认值清单](configuration-defaults.md)。

首次运行的视频默认配置为 1920×1080、30 FPS 上限、动态自适应码率，上限 8 Mbps。分辨率、码率模式和码率控件默认隐藏；在设置页顶部“Cast Settings／投屏设置”标题连续点击 8 次显示，再点击 8 次隐藏。显隐状态仅保存在当前 WebView 内存中，重启或重新加载后恢复隐藏；关闭设置页会重置未完成的点击计数，不改变已经切换的显隐状态。隐藏时不清空或重置参数。常规设置修改时立即保存，下一次启动恢复已保存的选择；默认值调整不覆盖已有的固定或动态模式。

首页设置入口为设备列表下方的 Casting Settings，输码及连接后可使用右上角设置图标，与配对和投屏页面共享同一个 WebView。打开设置只切换可见视图，不刷新页面，不释放 MediaStream、WebRTC 或输入会话。返回时按当前连接状态恢复配对或投屏界面。

首页采用 [NearRooms 设备发现布局](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1872-11107)。每次启动均先展示设备列表，包括已保存云端模式的情况；连接方式偏好仍保留。列表下方保留直接输码入口，点击设备后显示所选名称并进入配对；不使用弹窗。扫描、空列表、不可选设备及超长列表均使用真实发现状态。应用品牌、版本、能力和设备名继续使用运行时数据，设计图中的扩展桌面文案未作为现有功能呈现。选择设备时自动调用 `nearcast_trust_pair` 建立设备身份并请求放码，发送端不再展示指纹、确认、取消或撤销信任卡片。输码页右上角仅显示所选设备名；Back 和卡片下方“返回设备选择列表”均返回列表、取消待完成请求并清空本次设备关联和输入。打开 Settings 再返回保留当前设备和输入。两种输码方式共享受控单字符输入组件。四格使用 readonly 原生输入阻止 IME 临时编辑缓冲，由键盘与 paste 事件写入每格一个 A–Z 或 0–9，小写自动转大写；组合输入、候选提交和多字符填充均不能在格内展开。完整配对码可显式粘贴并逐格分配，退格、删除和方向键可修改。不修改系统全局输入法。

设备列表固定保留四行空间，0–3 个设备时也不收缩；超过四个在列表内滚动，小窗口通过页面滚动访问其余按钮。输码页采用 [1876:11511](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1876-11511) 的插图、四格输入和 Back 布局，保留所选设备名、自动身份绑定、显示码请求及错误。输入接受字母和数字，因此说明使用 4-character，内容仍显示真实输入值。

macOS 点击扫描后重新检查本地网络访问。列表内的权限提示由 `discovery-permissions-ui.mjs` 管理：确认系统拒绝时显示明确的访问受阻说明；仅结果为空、检查失败或状态未知时显示网络、接收端和权限的排查提示，不推断未授权。提示提供“打开系统设置”，仅在用户点击后尝试打开“隐私与安全性 → 本地网络”。macOS 未支持该子页锚点时会打开“隐私与安全性”主页，需按提示再选择“本地网络”；不申请辅助功能来自动操作系统设置。打开页面不更改授权状态；返回应用后重新检查并扫描，发现设备后隐藏空列表提示。首次自动扫描复用启动检查，从设置返回的扫描复用刚完成的检查，避免重复探测。Windows 不显示 macOS 权限提示。

连接准备与投屏中采用 [1889:11846](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1889-11846) 和 [1892:12020](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1892-12020) 的卡片布局。Allow Remote Control 与 General 中的反控偏好双向同步，继续使用原有立即生效及接收端确认流程。快捷开关通过已认证的 AXTP 通道查询 RX 的 `cast.getControlCapabilities` 和当前 target 的 `cast.getTouchbackState`，每秒刷新；仅在该通道宣告支持时查询 `cast.getTouchbackMaster`。能力不支持、RX 总开关关闭或状态未就绪时禁用快捷开关，并显示原因；RX 的 `RECEIVER_INPUT_DISABLED` 与普通未开启的路由状态分别处理，不以 `effectiveEnabled=false` 判断总开关。禁用不覆盖本机偏好，总开关恢复不自动发送开启请求；连接和 target 更换会丢弃旧查询结果。反控仅支持整个屏幕，开关旁在选屏前说明此限制；窗口或浏览器标签页分享期间，投屏卡片中的开关显示关闭并禁用，General 中保留原勾选状态但禁用，两处同时提示停止分享后重新选择整个屏幕。该来源限制不改写本机默认值或保存的偏好；停止或重新选择整屏后恢复原设置。迟到的开启事件也须重新检查当前采集来源，不能绕过限制。Share System Audio 在开始分享前修改同一音频偏好；选屏及分享中禁用该快捷开关，显示当前实际音频轨道状态。设置页仍可修改下次分享的偏好，不改变本次轨道。Start Sharing 等待真实连接就绪，Stop Sharing 只停止媒体。Leave receiver 或已接受会话结束时清理连接并返回设备列表，清空本次设备和配对码；不改变局域网／云端偏好，配对码被拒绝时仍留在输码页重试。设置页打开时连接结束，设置保持可见，返回后显示设备列表；断开原因在列表卡片内提示。卡片下方 Session Preview 只保留采集预览，默认折叠，未分享时提示开始分享，展开不创建新采集轨道。反控重连、输入释放、状态与收包诊断 UI 隐藏，底层诊断采集保留，General 页不再展示平台／WebView 诊断行和导出入口。新增布局位于 `dist/casting.css`。

Cast Settings 使用 [NearRooms 设置布局](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1894-12086)：Permissions、General、Check for Updates、Feedback 四个标签页。卡片在标题栏下的可用区域垂直居中，短窗口改用顶部留白和卡片内滚动以容纳额外设置；标签支持方向键、Home/End 切换，切换及返回保留表单与投屏状态。样式为 `dist/settings.css`，静态图标保存在 `dist/assets/figma/`；开关 SVG 的圆角使用抗锯齿渲染，保留原有控件尺寸。

Permissions 展示真实平台语义。macOS 复用原生查询和跳转，点击开关只打开系统设置；打开此分类、从系统设置返回或点击 Refresh 均重新读取授权。本地网络采用有界的 Network.framework Bonjour 浏览检查已声明的 `_nearcast._tcp`：ready 表示浏览可用，DNS `kDNSServiceErr_PolicyDenied` 表示系统拒绝，超时及其他网络错误保留未知，不以 UDP 发送成功推断授权。检查在 Rust blocking worker 内执行，独立串行队列上的回调不阻塞 UI；它不是读取系统授权数据库的通用查询接口。权限详情位于设置页，设备列表及录屏失败另有上下文提示；当前产品使用 `com.mostorm.nearhub.cast` 身份，系统权限应配置给 NearHub Cast。Windows 显示系统管理、选屏时授权等说明，不模拟 macOS 授权开关。局域网连接方式是产品偏好，位于 General，与 OS 权限分开。

macOS 桌面端首次打开时，先显示 [首次授权引导](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1942-12897)。本地网络为发现设备的必需项；录屏是否必需由运行时采集能力决定：macOS 14+ 且存在系统 SCContentSharingPicker 时为可选，采用会话选屏授权，旧采集路径仍为必需；辅助功能始终为反控可选项。每项独立打开系统授权提示或对应设置页。每次启动都重新查询系统状态；即使之前完成或跳过引导，只要任一必需项未就绪、状态未知或查询失败，就再次显示引导。仅缺少可选的录屏或辅助功能不会触发重复引导。开始时只查询状态，不自动申请录屏或辅助功能。点击授权不提前显示成功，从系统设置返回、页面重新可见或点击 Refresh 后重新检测；本地网络继续使用“网络可用”语义。必需项就绪后可继续，也可选择“稍后设置”进入主页，再从 Permissions 配置；“稍后设置”仅跳过本次启动。完成或跳过只在本机保存 `nearhub-cast-macos-permissions-onboarding-v1=completed`，该标记不作为权限判断依据；保存失败不阻止本次使用。设备发现等到引导完成或跳过后启动，即使在首轮查询期间跳过也只启动一次。引导使用 `src/macos-permission-onboarding.mjs`，负责启动检查和界面，系统查询与跳转仍由 `MacOsPermissions` 和 Rust 原生接口负责。中文、英语、日语和德语均随应用打包，Windows 和浏览器页面不显示此引导。

General 包含外观、语言、分辨率、动态/固定码率、码率、系统声音、局域网投屏和反控开关。外观支持深色、浅色和跟随系统，默认跟随系统；选择即时应用并保存在同一设置键的 `theme` 字段中。跟随系统时监听外观变化，手动选择不受系统变化影响；启动首帧先读取主题，原生标题栏及系统选择器同步调用 Tauri 的窗口主题接口。页面品牌显示 NearHub。应用界面使用黑白灰中性色及图标蓝 `#439BFC`，浅色主题以白色为背景；全部开关使用统一的主题控件。主题样式集中于 `dist/themes.css`。输入转换配置隐藏，启动时固定采用当前默认策略：Touch 与 Mouse 均保持原生类型，旧保存的自定义转换不自动启用；原生能力仍决定可协商类型。画质和声音在下次分享时生效；反控开关立即生效。设置保存于本机 WebView localStorage 的 `nearhub-cast-settings-v1`，升级不清除此键；首次运行默认关闭反控，保存后沿用用户的选择。损坏或无法读取的设置回退默认值。接收端仍需独立启用反控。

界面提供中文、English、日本語、Deutsch，默认跟随系统语言；不支持的系统语言回退英语。General 的语言选项即时应用并保存，不重载 WebView，不丢失配对码或投屏会话。跟随系统模式响应语言变化；手动选择不受系统语言变化影响。字典随应用本地打包，不修改设备名、配对码、版本、用户输入和服务返回的更新说明。默认窗口为 946 × 692 逻辑像素，与确认的截图尺寸一致；设置内容在卡片内滚动。

macOS 的系统声音与反控开关由 `FeaturePermissionGate` 检查本机权限，通用设置与投屏卡片共用同一入口。用户打开系统声音时重新查询录屏与系统录音，打开反控时重新查询辅助功能；检查期间开关保持关闭并禁用，只有明确授权后才应用偏好并启用对应能力。未知、查询失败和未授权均不启用，在对应开关旁显示原因及系统设置入口，打开设置不代表授权，授权后返回仍需再次打开功能。已保存的开关在启动时也须有相应授权才能恢复；确认权限撤销会关闭相关偏好，反控同时释放本机输入。接收端请求反控的同意流程同样先检查辅助功能，不能绕过本机权限；接收端能力和开关要求仍独立存在。纯画面投屏不在用户手势前插入权限查询，原生系统声音实际启动时仍由原生代码复查，声音失败保留视频并提供声音权限设置入口。

检查更新页复用原有后台更新管理器，显示真实当前/目标版本、构建渠道、更新说明、下载状态和错误。检查按钮在页内刷新，更新状态按钮打开可确认安装的弹窗；下载弹窗支持进度、关闭与后台下载。关闭弹窗不取消后台下载，不能标为“取消下载”。安装期间页面和弹窗关闭按钮不可操作。安装前停止音视频并释放输入，签名、版本和缓存校验仍由 Rust 执行。测试渠道固定于构建时，不通过前端 URL 或 IPC 选择。

## Feedback

实现参照 RX `scripts/Upload-NearCastLogs.ps1`：

1. 用户填写邮箱、问题描述，确认上传同意选项并主动点击提交；默认勾选不会触发自动上传。中文文案为“同意上传问题描述及诊断包至NearHub。日志不含配对码、音视频或设备信息密钥。”
2. Rust 从日志存储生成 `diagnostics.json`，打包为 ZIP（最多 4 MiB），不接受前端任意路径、URL 或产品编号。
3. 公共 Mosapi `/v1/upload` 接收 multipart：`files` 的 filename 为 `blob`，`fileInfo` 为 `{"name":"nearhub-cast-diagnostics.zip","folder":"diagnostic"}`。
4. 取得文件 ID 后 POST `/v1/feedbacks`，将附件 ID 关联到 `content.attachments`；只有返回有效反馈 ID 才显示成功。

诊断包含版本、平台、架构及最多三个 1 MiB 轮转日志中的白名单数值指标和状态；不包含音视频、配对码、SDP/ICE、设备密钥、窗口标题或任意文件。上传失败保留表单；单次超时 90 秒，同时只允许一次提交。附件成功但反馈记录失败时，不显示成功，重试会重新上传附件。

Feedback 的应用关系由 Rust 固定选择：Windows `application.connect.id=39`、macOS `=40`。不发送 `product` 字段；更新服务的 product-id `646/647` 与 Feedback application-id 不同。客户端不携带 CI 的 `MOSAPI_TOKEN`；若公共服务不允许匿名 Feedback，需要后台提供面向客户端的受限提交机制，不把管理 token 放入安装包。

首页图标随应用打包在 `dist/assets/figma/`，布局使用 `dist/home.css`，不依赖临时 Figma 地址。更新入口位于设置页；设置、配对、投屏在同一 WebView 内切换。导出诊断 UI 和事件绑定已移除，Feedback 仍可按需收集诊断。

## 验证

- `node --test tests/*.test.mjs`：设置保存、异常回退、发布矩阵和签名资产约束。
- `node tests/main-screen-browser.integration.mjs`：0/1/4/18 设备固定四行高度、列表内滚动、实际打包资源、选择与设置返回、输码页底部返回操作、键盘输码、云端偏好及小窗口长列表。
- `node tests/feature-permissions-browser.integration.mjs`：音频和反控在开启时刷新权限、缓存/未知/拒绝不启用、原生输入引擎门控、设置跳转与显式重试、撤销权限、可选权限不阻挡启动、窄窗口提示；原生查询使用 fixture。
- `node tests/discovery-permission-browser.integration.mjs`：扫描后的本地网络拒绝/空列表/未知区分、设置入口与失败重试、返回后重扫及恢复、多语言和窄列表、Windows 不展示；原生状态及设置调用使用 fixture，真实 macOS 隐私策略需另行实机验证。
- `node tests/pairing-input-browser.integration.mjs`：真实浏览器 IME 组合缓冲拒绝、每格值约束、大写输入、整码粘贴、修改及清空。
- `node tests/i18n-browser.integration.mjs`：四种系统语言、即时切换和重启保存、跟随系统语言变化、配对码与连接方式保留、隐藏配置使用默认策略、946 × 692 与小窗口布局。
- `node tests/settings-browser.integration.mjs`：设置导航、页面返回、保存、Feedback 同意、确认编号及失败重试。
- `node tests/settings-page-browser.integration.mjs`：完整设置页的平台语义、macOS 权限刷新不伪造授权、控件保存及重启恢复、隐藏输入转换／移除诊断行、默认勾选反馈同意和 360px 小窗口。
- `node tests/webcast-browser.integration.mjs`：投屏卡片快捷开关与设置双向同步，开始/停止/取消选屏恢复、真实音频轨道开关、折叠预览与打开设置时 RTP 持续解码，以及反控、切屏、小窗口操作、主动断开／接收端结束后返回列表及配对失败重试。
- `node tests/update-browser.integration.mjs`：启动提示、后台下载、暂不更新、再次打开、安装前清理与失败提示。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：真实本地 HTTP mock 检查 multipart ZIP、附件 ID、平台 application 和 HTTP 401 中止，以及原有清单/包签名和缓存篡改拒绝。

Windows CI/Mosapi/安装重启的最终验收步骤见 [发布约定](../release/version-and-mosapi.md)。macOS 本机安装与更新仍需 macOS 主机验证。

真实 Mosapi 合成报告测试已经成功，Windows Feedback 返回编号 `2729`，请求关联 `application.connect.id=39`。该测试只上传显式构造的空事件报告，不读取本机日志。可显式设置 `NEARCAST_LIVE_FEEDBACK_TEST=1` 并单独执行 ignored 的 `live_mosapi_confirms_synthetic_windows_feedback` 重现；普通 CI 不创建反馈记录。
