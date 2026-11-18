# 设置页与诊断反馈

首页设置入口为设备列表下方的 Casting Settings，输码及连接后可使用右上角设置图标，与配对和投屏页面共享同一个 WebView。打开设置只切换可见视图，不刷新页面，不释放 MediaStream、WebRTC 或输入会话。返回时按当前连接状态恢复配对或投屏界面。

首页采用 [NearRooms 设备发现布局](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1872-11107)。每次启动均先展示设备列表，包括已保存云端模式的情况；连接方式偏好仍保留。列表下方保留直接输码入口，点击设备后显示所选名称并进入配对；不使用弹窗。扫描、空列表、不可选设备及超长列表均使用真实发现状态。应用品牌、版本、能力和设备名继续使用运行时数据，设计图中的扩展桌面文案未作为现有功能呈现。选择设备时自动调用 `nearcast_trust_pair` 建立设备身份并请求放码，发送端不再展示指纹、确认、取消或撤销信任卡片。输码页右上角仅显示所选设备名；Back 和卡片下方“返回设备选择列表”均返回列表、取消待完成请求并清空本次设备关联和输入。打开 Settings 再返回保留当前设备和输入。两种输码方式共享受控单字符输入组件。四格使用 readonly 原生输入阻止 IME 临时编辑缓冲，由键盘与 paste 事件写入每格一个 A–Z 或 0–9，小写自动转大写；组合输入、候选提交和多字符填充均不能在格内展开。完整配对码可显式粘贴并逐格分配，退格、删除和方向键可修改。不修改系统全局输入法。

设备列表固定保留四行空间，0–3 个设备时也不收缩；超过四个在列表内滚动，小窗口通过页面滚动访问其余按钮。输码页采用 [1876:11511](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1876-11511) 的插图、四格输入和 Back 布局，保留所选设备名、自动身份绑定、显示码请求及错误。输入接受字母和数字，因此说明使用 4-character，内容仍显示真实输入值。

连接准备与投屏中采用 [1889:11846](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1889-11846) 和 [1892:12020](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1892-12020) 的卡片布局。Allow Remote Control 与 General 中的反控偏好双向同步，继续使用原有立即生效及接收端确认流程。快捷开关通过已认证的 AXTP 通道查询 RX 的 `cast.getControlCapabilities` 和当前 target 的 `cast.getTouchbackState`，每秒刷新；仅在该通道宣告支持时查询 `cast.getTouchbackMaster`。能力不支持、RX 总开关关闭或状态未就绪时禁用快捷开关，并显示原因；RX 的 `RECEIVER_INPUT_DISABLED` 与普通未开启的路由状态分别处理，不以 `effectiveEnabled=false` 判断总开关。禁用不覆盖本机偏好，总开关恢复不自动发送开启请求；连接和 target 更换会丢弃旧查询结果。Share System Audio 在开始分享前修改同一音频偏好；选屏及分享中禁用该快捷开关，显示当前实际音频轨道状态。设置页仍可修改下次分享的偏好，不改变本次轨道。Start Sharing 等待真实连接就绪，Stop Sharing 只停止媒体。Leave receiver 或已接受会话结束时清理连接并返回设备列表，清空本次设备和配对码；不改变局域网／云端偏好，配对码被拒绝时仍留在输码页重试。设置页打开时连接结束，设置保持可见，返回后显示设备列表；断开原因在列表卡片内提示。卡片下方 Session Preview 只保留采集预览，默认折叠，未分享时提示开始分享，展开不创建新采集轨道。反控重连、输入释放、状态与收包诊断 UI 隐藏，底层诊断采集保留，General 页不再展示平台／WebView 诊断行和导出入口。新增布局位于 `dist/casting.css`。

Cast Settings 使用 [NearRooms 设置布局](https://www.figma.com/design/sF8kG3rz4jlhXBNKBXQmxN/NearRooms?node-id=1894-12086)：Permissions、General、Check for Updates、Feedback 四个标签页。卡片在标题栏下的可用区域垂直居中，短窗口改用顶部留白和卡片内滚动以容纳额外设置；标签支持方向键、Home/End 切换，切换及返回保留表单与投屏状态。样式为 `dist/settings.css`，静态图标保存在 `dist/assets/figma/`；开关 SVG 的圆角使用抗锯齿渲染，保留原有控件尺寸。

Permissions 展示真实平台语义。macOS 复用原生查询和跳转，点击开关只打开系统设置；打开此分类、从系统设置返回或点击 Refresh 均重新读取授权。本地网络的“可用”不等同于已查询到系统授权。权限内容仅在设置页内显示；当前产品使用 `com.mostorm.nearhub.cast` 身份，系统权限应配置给 NearHub Cast。Windows 显示系统管理、选屏时授权等说明，不模拟 macOS 授权开关。局域网连接方式是产品偏好，位于 General，与 OS 权限分开。

General 包含语言、分辨率、动态/固定码率、码率、系统声音、局域网投屏和反控开关。输入转换配置隐藏，启动时固定采用当前默认策略：Touch 与 Mouse 均保持原生类型，旧保存的自定义转换不自动启用；原生能力仍决定可协商类型。画质和声音在下次分享时生效；反控开关立即生效。设置保存于本机 WebView localStorage 的 `nearhub-cast-settings-v1`，升级不清除此键；首次运行默认关闭反控，保存后沿用用户的选择。损坏或无法读取的设置回退默认值。接收端仍需独立启用反控。

界面提供中文、English、日本語、Deutsch，默认跟随系统语言；不支持的系统语言回退英语。General 的语言选项即时应用并保存，不重载 WebView，不丢失配对码或投屏会话。跟随系统模式响应语言变化；手动选择不受系统语言变化影响。字典随应用本地打包，不修改设备名、配对码、版本、用户输入和服务返回的更新说明。默认窗口为 946 × 692 逻辑像素，与确认的截图尺寸一致；设置内容在卡片内滚动。

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
- `node tests/pairing-input-browser.integration.mjs`：真实浏览器 IME 组合缓冲拒绝、每格值约束、大写输入、整码粘贴、修改及清空。
- `node tests/i18n-browser.integration.mjs`：四种系统语言、即时切换和重启保存、跟随系统语言变化、配对码与连接方式保留、隐藏配置使用默认策略、946 × 692 与小窗口布局。
- `node tests/settings-browser.integration.mjs`：设置导航、页面返回、保存、Feedback 同意、确认编号及失败重试。
- `node tests/settings-page-browser.integration.mjs`：完整设置页的平台语义、macOS 权限刷新不伪造授权、控件保存及重启恢复、隐藏输入转换／移除诊断行、默认勾选反馈同意和 360px 小窗口。
- `node tests/webcast-browser.integration.mjs`：投屏卡片快捷开关与设置双向同步，开始/停止/取消选屏恢复、真实音频轨道开关、折叠预览与打开设置时 RTP 持续解码，以及反控、切屏、小窗口操作、主动断开／接收端结束后返回列表及配对失败重试。
- `node tests/update-browser.integration.mjs`：启动提示、后台下载、暂不更新、再次打开、安装前清理与失败提示。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：真实本地 HTTP mock 检查 multipart ZIP、附件 ID、平台 application 和 HTTP 401 中止，以及原有清单/包签名和缓存篡改拒绝。

Windows CI/Mosapi/安装重启的最终验收步骤见 [发布约定](../release/version-and-mosapi.md)。macOS 本机安装与更新仍需 macOS 主机验证。

真实 Mosapi 合成报告测试已经成功，Windows Feedback 返回编号 `2729`，请求关联 `application.connect.id=39`。该测试只上传显式构造的空事件报告，不读取本机日志。可显式设置 `NEARCAST_LIVE_FEEDBACK_TEST=1` 并单独执行 ignored 的 `live_mosapi_confirms_synthetic_windows_feedback` 重现；普通 CI 不创建反馈记录。
