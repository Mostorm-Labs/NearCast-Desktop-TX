# NearHub Cast 版本与 Mosapi 更新发布契约

本文档定义 TX 的版本格式、Mosapi 后台信息、应用内更新策略和 GitHub Actions 发布边界。实现位于 `src-tauri/src/update.rs`、`src/update/`、`scripts/release.mjs` 和 `.github/workflows/release.yml`；代码与本地验证完成不等于已经发布线上更新。

产品显示名为 `NearHub Cast`，应用 identifier 为 `com.mostorm.nearhub.cast`。软件此前未安装，不迁移旧安装身份。安装包名称采用 `NearHub Cast Desktop Installer`，保留版本、平台和架构；NSIS 安装窗口标题与 MSI 包摘要使用该名称，安装后的应用、快捷方式和 macOS `.app` 使用较短的产品名。当前安装模板基于 Tauri CLI 2.12.4，升级 CLI 时需核对模板差异。Mosapi slug/product-id、updater 公钥及 `NearCast-Desktop-TX-<version>-<platform>-manifest.json` 清单名称保持后台契约值。

## 1. 版本格式

完整版本格式为：

```text
X.Y.Z.Build
```

`X.Y.Z` 是逻辑版本，遵循 Semantic Versioning：

| 分量 | 递增条件 |
| --- | --- |
| `X` | 引入不兼容 API、协议、数据格式或升级行为 |
| `Y` | 增加向下兼容的用户功能，或标记兼容的功能弃用 |
| `Z` | 向下兼容的 bug 修复、性能优化或安全修复 |

`Build` 是 CI 生成的十进制流水线构建号，从 1 开始递增。一次发布工作流为所有平台产物分配同一个 Build，保证例如 `0.2.0.37` 在 Windows 和 macOS 上代表同一份逻辑发布。重新生成并发布产物必须产生新的 Build；同一次 workflow 的重试不能覆盖已上传的版本记录，应创建新的 workflow run。

版本比较必须数字化：

```text
(X1, Y1, Z1, Build1) > (X2, Y2, Z2, Build2)
```

不能用字典序比较，例如 `0.1.101.2` 必须大于 `0.1.99.20`。兼容 `v0.2.0.37` 输入，但内部统一去掉 `v` 前缀。

仓库中的 Cargo/Tauri 基础版本保持三段 `X.Y.Z`；CI 生成临时 overlay，使用合法 SemVer `X.Y.Z+Build` 供 Tauri 生成 bundle 和签名。业务层独立比较四段数字，不能依赖 SemVer build metadata 的排序。四段完整版本必须同时写入：

- 构建环境和产物元数据；
- 安装包文件名；
- Mosapi update 的 `version`；
- 应用更新检查结果和界面显示。

推荐首个发布标识为 `0.1.0.1`，但正式采用哪个逻辑版本由发布负责人决定。

Build 来自专用 Release workflow 的 `github.run_number`，Windows/macOS 共用。失败后重新构建须创建新 run；workflow 禁止使用相同 run 的 rerun 发布，避免重复 Build。不要重命名或重建 workflow 导致计数重置。

MSI 只比较 ProductVersion 的前三段，因此其内部安装器版本使用 `1.0.Build`。例如对外 `0.2.0.37` 对应 MSI `1.0.37`；这不是软件逻辑版本。NSIS 的数字 build metadata 生成四段文件版本，更新模式允许同 SemVer 逻辑版本的新构建覆盖；macOS `CFBundleVersion` 使用 Build。发布脚本检查 Windows 原生字段上限 65535；超过时必须先调整映射，不能静默截断或归零。

## 2. 平台 slug

| 构建平台 | Mosapi product slug | product-id | 架构 |
| --- | --- | --- | --- |
| Windows | `nearcast-tx-windows` | `646` | 当前为 x64 |
| macOS | `nearcast-tx-macos` | `647` | 当前为 x86_64、aarch64 |

TX 只构建、发布和更新 Windows 与 macOS。slug 用于选择平台产品；同一平台下还必须根据当前架构和安装格式选择匹配资产。macOS 两个架构使用同一 product-id `647`，由同一个平台发布任务汇总后创建一个 update record。

## 3. Mosapi 接口

### 3.1 CI 上传

使用 Mosapi 管理域名：

```text
POST https://mosapi-admin.auditoryworks.co/v1/upload
```

CI 使用 `Mostorm-Labs/mosapi-action@v1.0.0` 上传资产并创建 update record。以下为 Windows 配置示意；`${{ ... }}` 是 workflow 表达式，版本值来自统一版本任务的输出：

```yaml
- uses: Mostorm-Labs/mosapi-action@v1.0.0
  with:
    token: ${{ secrets.MOSAPI_TOKEN }}
    folder-id: '546'
    product-id: '646'
    product-slug: nearcast-tx-windows
    version: ${{ needs.version.outputs.display_version }}
    state: release
    type: optional
    project-name: NearHub Cast
    artifacts: |
      release/windows/*
```

macOS 对应使用 `folder-id: '546'`、`product-id: '647'`、`product-slug: nearcast-tx-macos`，资产路径为 `release/macos/*`。`changelog` 在正式 workflow 中读取本次版本的更新说明。

Action 还会返回 `uploaded-count`、`uploaded-files`、`update-id` 和 `update-slug`，发布任务应记录这些输出作为审计信息。

TX 的产品映射和资产目录已确认：Windows 使用 product-id `646`、macOS 使用 product-id `647`，两个平台都使用 folder-id `546`。folder-id 与 product-id 是不同标识。RX 的 product-id `626` 与 TX 的 product-id 不同。

GitHub Actions 建议配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Secret | `MOSAPI_TOKEN` | 上传授权，不进入构建产物 |
非敏感的 product-id `646/647`、对应 slug 和共享 folder-id `546` 在 workflow 中固定成对配置，不需要为这些值建立 Secret。上传 token 和签名私钥仍只通过 CI Secret 注入。

### 3.2 客户端查询

客户端不需要 token，使用公共 Mosapi 域名：

```text
GET https://mosapi.auditoryworks.co/v1/updates/product/nearcast-tx-windows
GET https://mosapi.auditoryworks.co/v1/updates/product/nearcast-tx-macos
```

生产客户端应至少筛选 `state=release`，并请求 update 的版本、状态、类型、说明和 `otaFiles.file`。当前 RX 使用的查询形态可作为 TX 的基线：

```text
?fields=version&fields=state&fields=type
&populate[otaFiles][populate][0]=file
&populate[descriptions][populate][0]=%2A
&populate[0]=otaFiles.file
&populate[1]=descriptions
&populate[otaFiles][populate]=%2A
&populate[descriptions][populate]=%2A
&filters[version][$gte]=v0.1.0
&limit=100
```

接口实际返回可能是 `{data:[...]}`、`{updates:[...]}` 或数组；客户端应兼容 Strapi 风格的 `attributes` 包装，并在本地按四段数字版本排序。不能信任服务端的字典序排序。

### 3.3 下载

客户端从查询结果的 `otaFiles` 中读取每个文件的 `url`/`downloadUrl`，通过 HTTPS 下载。下载后依次检查：

1. 文件名和当前平台/架构匹配；
2. SHA-256 与同版本 `.sha256` 资产匹配；
3. Tauri updater 签名与内置公钥匹配；
4. update 的版本和渠道仍满足当前策略。

下载地址是 Mosapi 返回的数据，不能由客户端拼接管理域名或对象存储路径。更新查询失败、下载失败或校验失败都不能替换当前安装。

## 4. otaFiles、版本清单与 GitHub Release 资产

### 4.1 Mosapi 按平台关联文件

| 产品 | 必需的 `otaFiles` 内容 |
| --- | --- |
| Windows `646` | NSIS `.exe`、MSI `.msi`、两种包各自对应的 `.sig`、Windows 版本清单及其 `.sig`；另提供 `.sha256` |
| macOS `647` | 各支持架构的 `.app.tar.gz` 更新包、对应的 `.sig`、macOS 版本清单及其 `.sig`；另提供 `.sha256` |

macOS 的 `.dmg` 可作为额外的手工安装资产；Tauri updater 安装目标使用签名的 `.app.tar.gz`，不能将 `.dmg` 当成可直接原地更新的包。macOS 的 Intel 和 Apple Silicon 文件一并关联到产品 `647`。

每份平台版本清单包含 `schemaVersion=1`、`version`、`logicalVersion`、`build`、`platform`、`productSlug`、`channel`、`publishedAt`、`notes` 和 `assets`。每项资产记录 `platform/arch/format/name/url/size/sha256/signature`。Windows 清单同时描述 NSIS 与 MSI，macOS 清单描述两个架构。清单不包含任何上传凭据，并使用与包相同的更新密钥签名。

Mosapi 会重写存储 URL；客户端通过 `otaFiles` 同名资产解析实际下载 URL，其字节长度、哈希、包签名仍必须与签名清单一致。清单不可只信任未签名的 OTA 版本字符串。

平台清单属于 TX 的发布元数据；`X.Y.Z.Build` 不是 Tauri 标准 SemVer 响应。后续 updater 适配层必须按四段数字比较版本，并转换为插件可接受的下载/签名输入，不能依赖 SemVer build metadata 自动识别同一逻辑版本的较新 Build。

### 4.2 GitHub 一个链接下载发布集合

每个 `X.Y.Z.Build` 只创建一个 GitHub Release，Windows 和 macOS 的所有独立文件放在这个 Release 的 assets 下。同时提供一个完整发布集合：

```text
NearHub-Cast-X.Y.Z.Build-release-assets.zip
  windows/
    NSIS 更新包 + MSI 更新包 + 对应签名/校验文件 + Windows 版本清单
  macos/
    各架构 macOS 更新包 + 对应签名/校验文件 + macOS 版本清单
```

该 ZIP 的 GitHub Release asset URL 是“一个链接下载本次全部更新资源”的入口。ZIP 中的签名文件保持对原始更新包的签名；不得对更新包重新打包后仍沿用原签名。聚合 ZIP 自身另外提供 `.sha256`。

独立包、签名和清单也保留为同一个 Release 的独立 assets，方便单个平台取包。Mosapi 仍分别上传并关联 Windows/macOS 的独立资产；客户端按需下载匹配的包，不为自动更新下载整个聚合 ZIP。

### 4.3 文件名示例

完整版本写入每个资产名，推荐形式如下：

```text
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64-setup.exe
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64-setup.exe.sha256
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64-setup.exe.sig
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64.msi
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64.msi.sha256
NearHub Cast Desktop Installer-0.2.0.37-windows-x86_64.msi.sig
NearCast-Desktop-TX-0.2.0.37-windows-manifest.json
NearHub Cast Desktop Installer-0.2.0.37-macos-x86_64.app.tar.gz
NearHub Cast Desktop Installer-0.2.0.37-macos-x86_64.app.tar.gz.sig
NearHub Cast Desktop Installer-0.2.0.37-macos-x86_64.app.tar.gz.sha256
NearHub Cast Desktop Installer-0.2.0.37-macos-aarch64.app.tar.gz
NearHub Cast Desktop Installer-0.2.0.37-macos-aarch64.app.tar.gz.sig
NearHub Cast Desktop Installer-0.2.0.37-macos-aarch64.app.tar.gz.sha256
NearCast-Desktop-TX-0.2.0.37-macos-manifest.json
NearHub Cast Desktop Installer-0.2.0.37-macos-aarch64.dmg
NearHub Cast Desktop Installer-0.2.0.37-macos-aarch64.dmg.sha256
NearHub-Cast-0.2.0.37-release-assets.zip
NearHub-Cast-0.2.0.37-release-assets.zip.sha256
```

实际文件名可以按 Tauri bundle 约定调整，但必须保留完整版本、平台和架构字段，且一个 update record 内不得混入其它平台的安装包。

`state` 取 `alpha`、`beta` 或 `release`；普通本地构建默认只接受 `release`。CI 将所选渠道写入编译时 `NEARCAST_UPDATE_CHANNEL`，alpha/beta 包仅查询并接受同渠道的签名清单，设置页会标明测试渠道，正式包不能通过前端切到测试渠道。发布 workflow 的手动测试默认 `alpha`。自动发布使用 `type=optional`；当前策略始终由用户确认安装，不实施强制升级。

## 5. 发布工作流边界

GitHub Actions 应按以下顺序执行：

1. 从 tag 或受保护的发布输入得到 `X.Y.Z`；生成新的 `Build`，得到完整版本。
2. 将完整版本传入 Tauri bundle 元数据和文件命名，并运行全部测试。
3. 构建 Windows、macOS 产物，生成 SHA-256 和签名文件；汇总 macOS 两个架构。
4. 生成各平台版本清单，将所有包、签名和清单汇总到同一 GitHub Release，并额外生成上述聚合 ZIP 单链接资产。
5. 分别调用 Mosapi Action 上传到 Windows `646` 和 macOS `647`；任一必需包、签名或版本清单缺失、上传失败、`uploaded-count` 不符合预期时，workflow 失败。
6. 只有 Mosapi update record 创建成功后，才允许把该版本标为可更新，并输出 `update-id`、`update-slug`、各资产 URL 和 hash。

GitHub Release 是审计和人工下载镜像，Mosapi 是应用内更新的唯一查询入口。CI 日志不得打印 `MOSAPI_TOKEN`、签名私钥或未脱敏的授权请求头。

## 6. 应用内更新行为

- 启动后延迟约 2.5 秒初始化已签名缓存并检查 Mosapi；发现可用版本时本次启动弹出更新框。
- 运行期间每 4 小时检查，失败按 1、2、4 分钟等退避，最多 30 分钟重试。
- 发现正式更新后自动下载，显示进度；运行期间只在顶部显示“发现新版本/更新已就绪”，点击再展开。
- “暂不更新”仅对本次启动生效，下次启动仍提示；下载可继续在后台完成。
- 缓存位于 Tauri app cache 的 `updates-v1`，只保留一个待安装包。部分下载不作为可安装包，完成后原子替换。
- 启动恢复缓存和安装前均重新验证清单、平台/架构、SHA-256 与 Minisign 包签名；篡改缓存会被拒绝。
- 用户点击“立即更新并重启”后停止投屏、音频、反控并确认本机输入释放，随后调用 Tauri updater 安装。清理或安装失败显示错误并允许重试。
- Windows 按原安装格式选择 NSIS 或 MSI；裸 EXE 默认 NSIS。macOS 仅选择当前架构的 `.app.tar.gz`。

## 7. CI 配置与首次发布

GitHub Secrets：

| 名称 | 用途 |
| --- | --- |
| `MOSAPI_TOKEN` | Mosapi 上传授权 |
| `GH_RELEASE_TOKEN` | 可选专用 GitHub 发布凭据；默认 `github.token`。若组织返回 403，需要可访问本仓库的 Contents 读写权限；发布含 workflow 变更的提交可能还需 Workflows 写权限及组织批准 |
| `TAURI_SIGNING_PRIVATE_KEY` | 与仓库 `src-tauri/update.pub` 对应的更新签名私钥文件内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（未设置密码时为空） |
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Developer ID 的 base64 P12 及密码 |
| `APPLE_SIGNING_IDENTITY` | 稳定 Developer ID Application 身份 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple notarization 身份与应用专用密码 |

更新公钥已入仓库，私钥保存在当前机器仓库外 `C:\Users\Chado\.codex\update-key-tx\tx.key`，并已配置为 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`，签名验证与内置公钥一致。不要输出或提交私钥，需额外安全备份。更换密钥必须在首次发布前同步公钥；上线后轮换须保留旧版本升级通路。

打 `vX.Y.Z` tag 触发全平台正式 release；手动可选择逻辑版本、渠道及 `platforms=windows|all`，默认 Windows/alpha，仍共享同一流水线全局递增 Build。Windows 单独发布无需 Apple 凭据，生成 NSIS、MSI、签名、清单，共 9 个 Mosapi 资产；全平台还包含 macOS 两架构及其 9 个资产。聚合 ZIP 仅包含本次选中的平台。创建同一个 GitHub draft Release，上传所有 assets，再创建所选产品的 Mosapi 更新记录，成功后公开 GitHub Release。平台记录独立创建，Mosapi 没有跨产品原子事务；部分失败需检查已创建的 update-id 并以新 Build 重试。

### Windows 两个 Build 的在线验收

1. 在仓库 Settings → Secrets and variables → Actions 配置 `MOSAPI_TOKEN`；签名 Secret 已配置。token 需要 folder `546` 上传及 product `646` 更新创建权限。
2. 将工作流及实现推送后，在 Actions → Release TX 选择目标分支、逻辑版本、`channel=alpha`、`platforms=windows`，运行一次。检查三个阶段成功，Mosapi update-id 非空、uploaded-count=9，保存 GitHub Release 链接。
3. 安装该 Build 的 NSIS 测试包作为基线；设置页应显示完整版本和 alpha 测试渠道，保存画质配置。
4. 新建一次 workflow run 生成更高 Build，不要 rerun 同一次发布。公共 `/updates/product/nearcast-tx-windows` 应查询到 alpha 记录，并有对应版本的安装包、清单和签名。
5. 启动基线包，确认自动提示、后台下载、暂不更新后可继续投屏，退出重启后仍提示已就绪。设置页与顶部更新入口显示一致。
6. 点击安装，确认投屏/声音停止、输入释放，安装并重启后版本升至新 Build，设置仍保留。
7. 在干净 Windows 测试机上重复 MSI→MSI；分别验证取消 UAC、离线、下载中断可重试。自动化本地测试覆盖清单/安装包签名不符和缓存篡改拒绝；不得以关闭验证的方式完成安装测试。

当前实现已通过本地浏览器与 Rust 校验、签名及安装包生成。两次 Windows alpha CI 的构建与签名成功，但 GitHub 创建 Release 返回 HTTP 403（日志已确认 `Contents: write`），尚未进入 Mosapi 上传；需要专用发布凭据或管理员解除组织限制。**Mosapi 上传、跨 Build 安装和自动重启仍未验收。** 不将本地结果或 CI 构建成功视为在线发布成功。仅发布阶段失败且尚未创建 Mosapi 记录时可重试失败 job，沿用原有已签名产物；若任何资产已公开或 Mosapi 记录已创建，需检查状态并分配新的 Build，不覆盖已发布版本。

macOS 正式分发仍需稳定 Apple Developer ID 签名与 notarization。当前基础配置为 ad-hoc，不能据本机 Windows 验证宣称已完成 macOS 正式签名和权限保留验收。

## 8. 上线前确认

已确定产品映射、共享 `folder-id=546` 和真实 `otaFiles.file.data.attributes` JSON 结构。首次线上发布前仍需完成：

- 两个平台的发布审批规则；
- 配置上传 token 与更新签名私钥 Secret；
- Windows 实机跨两个 Build 的 NSIS/MSI 升级及取消授权验证；
- macOS Intel/Apple Silicon 的真实包更新、Apple 签名和权限保留验证；
- 首次 Mosapi 上传后的公共查询、签名清单和软件下载验收。

product-id、slug 和 folder-id 可按本契约配置；token 和签名私钥仅通过 CI Secret 注入。
