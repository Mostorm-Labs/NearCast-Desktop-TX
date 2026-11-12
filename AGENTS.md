# NearHub Cast 发布约定

## 产品命名

Tauri 打包后的主程序使用 `mainBinaryName=NearHub Cast`，Windows 安装目录内为 `NearHub Cast.exe`，macOS 应用内为 `Contents/MacOS/NearHub Cast`。Cargo crate 名仅为内部构建标识；不可将裸 `cargo build` 的默认文件名当成最终安装文件名。

软件、窗口标题、已安装快捷方式和 macOS 应用包显示为 `NearHub Cast`。安装包及安装器标题采用 `NearHub Cast Desktop Installer`，文件名保留版本、平台和架构。尚未安装过旧产品，不保留旧产品名派生的安装身份。Mosapi slug/product-id、协议标识及更新清单名称属于后台契约，保持现有值。模板与打包后命名见 `src-tauri/installer/README.md` 和 `scripts/name-installers.mjs`。

## 采集架构

默认视频由系统 getDisplayMedia 返回的原始轨道直接交给 WebRTC；Windows 系统音频独立使用 WASAPI，不依赖 WGC 视频租约。Windows 整屏来源使用短暂的四角随机标记识别所选物理屏幕，由 Rust 持有来源绑定，允许主屏/副屏及负坐标；校验失败不猜测屏幕，视频继续。窗口仅投屏，macOS 保留原有单主屏限制。原生 WGC、窗口缩略图及持续边框流程已移除；四角标记仅用于分享开始时的有界本地校准，不参与视频传输。模块边界与验收范围见 [浏览器采集架构](docs/architecture/browser-capture.md)。

## 版本号

对外版本号固定为 `X.Y.Z.Build`：

- `X.Y.Z` 是遵循 SemVer 的逻辑版本。`X` 表示不兼容变更，`Y` 表示向下兼容的新功能，`Z` 表示向下兼容的修复、性能优化或安全修复。
- `Build` 是 CI 生成的十进制流水线构建号，从 1 开始递增。同一条发布流水线在 Windows 和 macOS 的产物使用同一个 Build。
- 版本比较必须按四个数字分量比较，不能按字符串排序；允许 API 返回带 `v` 前缀的版本。
- `Build` 不由开发者手工填写。重新生成并发布一组产物必须使用新的 CI 构建号；同一次 CI 重试不得覆盖已经发布的版本记录。

仓库中的 Cargo/Tauri 基础版本保持 `X.Y.Z`；CI overlay 使用合法 SemVer `X.Y.Z+Build` 生成 bundle，业务层仍按四段数字比较。完整的 `X.Y.Z.Build` 写入发布元数据、安装包文件名、Mosapi update `version` 和应用界面。MSI ProductVersion 映射为 `1.0.Build`，避免 Windows Installer 忽略第四段导致同逻辑版本无法更新；Build 全局递增且不得重置。Windows 原生字段上限由发布脚本检查，溢出时阻止发布，不回绕。

## Mosapi 产品标识

NearHub Cast 的更新查询按平台使用以下 product slug：

| 平台 | product slug | product-id |
| --- | --- | --- |
| Windows | `nearcast-tx-windows` | `646` |
| macOS | `nearcast-tx-macos` | `647` |

TX 的构建、发布和更新范围仅限 Windows 和 macOS。客户端不得用一个平台的 slug 查询另一个平台的包；同一平台内按架构筛选资产。

Feedback 使用独立的 application 关系：Windows `application.connect.id=39`，macOS `=40`；不得使用上述更新 product-id，也不发送 `product` 字段。诊断提交走公共 Mosapi，客户端不得内置 CI 管理 token。

## Mosapi 地址和凭据边界

- CI 上传端点：`https://mosapi-admin.auditoryworks.co/v1/upload`，使用 `Mostorm-Labs/mosapi-action`，凭据放在 GitHub Actions Secret `MOSAPI_TOKEN`。
- 客户端查询端点：`https://mosapi.auditoryworks.co/v1/updates/product/<product-slug>`。
- 客户端下载地址使用查询结果 `otaFiles` 中返回的 HTTPS URL，不拼接或猜测对象存储路径。
- `MOSAPI_TOKEN` 只允许出现在 CI 上传请求中；已发布软件查询更新和下载软件包不得内置该 token。
- Mosapi 查询和下载默认使用 `state=release`；内部测试可显式选择 `alpha` 或 `beta`，不能把测试渠道混入正式渠道。

Mosapi 上传 Action 除了 `product-slug` 还要求 `folder-id` 和 `product-id`。TX 的 Windows 和 macOS 都使用资产目录 `folder-id=546`；产品 ID 固定使用上表中的 Windows `646` 和 macOS `647`。`folder-id` 与 `product-id` 是不同标识，不能互相推导。

## 发布资产

每个平台的 update record 使用完整四段版本，并上传可安装包、完整性文件和 Tauri updater 所需签名文件。资产文件名必须包含平台和架构，使同一 product slug 下的多架构包可以安全筛选：

- Windows `otaFiles`：NSIS 更新安装包、MSI 更新安装包、两者对应的 updater 签名文件和 Windows 版本清单；SHA-256 文件可作为附加完整性资产。NSIS 为自动更新首选；MSI 用于企业部署。
- macOS `otaFiles`：各支持架构的 macOS 更新包、对应的 updater 签名文件和 macOS 版本清单；SHA-256 文件可作为附加完整性资产。Tauri 原地更新使用 `.app.tar.gz`；`.dmg` 可额外提供给手工安装。

每个完整版本统一发布到同一个 GitHub Release。其 assets 提供一个聚合 ZIP，将两个平台的更新包、签名文件和版本清单归档为一个下载链接；同时保留独立资产，供按平台下载和联调。Mosapi 的两个 product record 分别关联各自的平台资产，不用聚合 ZIP 替代 `otaFiles`。

平台版本清单本身也必须提供 `.sig`。内置公钥为 `src-tauri/update.pub`；私钥只能通过 `TAURI_SIGNING_PRIVATE_KEY` CI Secret 注入。客户端校验签名清单绑定的平台、架构、版本、包哈希和包签名，安装前重新验证缓存，不接受前端传入的任意 URL 或执行路径。

Mosapi update 的 `changelog` 保存面向用户的更新说明；`state` 保存发布渠道；`type` 使用 `optional` 或 `force` 表示普通更新或强制更新。正式客户端只接受与当前平台、架构和渠道匹配的资产。

## CI 流程

发布流水线的顺序固定为：

1. 计算 `X.Y.Z` 和新的 CI `Build`，生成完整版本 `X.Y.Z.Build`。
2. 运行 JavaScript、Rust 和平台构建测试。
3. 构建各平台安装包，生成 SHA-256、updater 签名文件和平台版本清单；汇总为同一 GitHub Release 的独立资产及一个聚合 ZIP。
4. 用 `Mostorm-Labs/mosapi-action` 将产物上传到对应平台 slug 的 Mosapi 产品；上传成功后才允许把该版本视为可更新。
5. 客户端通过公共查询端点读取 update record，按 `X → Y → Z → Build` 数字顺序选择最新且可用的版本，再下载并校验资产。

GitHub Release 可以作为审计和人工下载镜像，但不替代 Mosapi 的客户端查询入口。任何上传失败都必须阻止发布任务成功，避免出现查询到没有完整安装包或校验文件的半成品版本。

详细的端点、字段、资产命名和 CI Secret/Variable 清单见 [`docs/release/version-and-mosapi.md`](docs/release/version-and-mosapi.md)。
