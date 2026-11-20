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

`Build` 来自仓库根目录 `build-version.json`，包含 `logicalVersion` 和最后分配的 `build`。每次应用构建先读取、加一、原子写回；失败也保留已分配次数。同一批 Windows/macOS 产物使用一次编号。检查和测试不递增。修改逻辑版本不重置 Build，不能覆盖已发布版本。

版本比较必须数字化：

```text
(X1, Y1, Z1, Build1) > (X2, Y2, Z2, Build2)
```

不能用字典序比较，例如 `0.1.101.2` 必须大于 `0.1.99.20`。兼容 `v0.2.0.37` 输入，但内部统一去掉 `v` 前缀。

Cargo/Tauri 基础版本保持三段 `X.Y.Z`；计数文件决定本次逻辑版本，统一构建入口生成 overlay，使用合法 SemVer `X.Y.Z+Build` 供 Tauri 生成 bundle 和签名。业务层独立比较四段数字，不能依赖 SemVer build metadata 的排序。四段完整版本必须同时写入：

- 构建环境和产物元数据；
- 安装包文件名；
- Mosapi update 的 `version`；
- 应用更新检查结果和界面显示。

推荐首个发布标识为 `0.1.0.1`，但正式采用哪个逻辑版本由发布负责人决定。

构建入口为 `node scripts/build.mjs <Tauri 参数>`（npm 别名为 `npm run build`）；Mac 权限联调继续用 `npm run build:macos`。Tauri hook 拒绝绕过统一入口的应用打包。build.rs 从文件读取同一版本，界面、文件资源和安装包使用一致的四段编号。文件缺失、损坏、越界或已分配版本不匹配时失败，不自动归零。

本地的计数文件随源码保存；不同机器／工作树各有一份，不能把独立本地计数视为全局分布式唯一编号。打包同一批平台时先分配一次，将该文件复制到各构建机，并设置 `NEARCAST_BUILD_VERSION=X.Y.Z.Build`，构建入口校验后复用，不再次加一。构建前同步计数，合并时保留较大次数。

可信 CI 在 `build-counter` 元数据分支保存同样的 JSON，以普通快进 push 原子预留编号，不修改源码分支或使用 GitHub run_number。并发任务推送冲突时重新读取并递增；预留成功后失败也不会回收。PR 检查只在临时 checkout 本地递增，不写远端计数；不可将这种产物直接作为正式版本发布。Release 平台矩阵下载同一份已预留文件并复用。发布仍要求新 workflow run，防止重传既有资产；本次修改不自动创建远端分支或发布。

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
| Windows `646` | 已做 Authenticode 签名的 NSIS `.exe`、MSI `.msi`、两种包各自对应的 `.sig`、Windows 版本清单及其 `.sig`，以及对应的 `.sha256` |
| macOS `647` | Intel 和 Apple Silicon 的 `.app.tar.gz` 更新包、对应的 `.sig`、macOS 版本清单及其 `.sig`，以及两个架构的已签名公证 DMG 和对应的 `.sha256` |

GitHub Release 和 Mosapi 都提供 Intel 和 Apple Silicon 的 `.dmg`，可打开磁盘映像并把应用拖到 Applications。签名的 macOS 版本清单列出 Tauri updater 使用的 `.app.tar.gz`，因此同一产品记录里的 DMG 只用于手工安装。

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
    Intel 和 Apple Silicon DMG + 各自的 SHA-256
    各架构 macOS 更新包 + 对应签名/校验文件 + macOS 版本清单
```

该 ZIP 的 GitHub Release asset URL 是“一个链接下载本次全部更新资源”的入口。ZIP 中的签名文件保持对原始更新包的签名；不得对更新包重新打包后仍沿用原签名。聚合 ZIP 自身另外提供 `.sha256`。

独立包、签名和清单也保留为同一个 Release 的独立 assets，方便单个平台取包。Mosapi 仍分别上传并关联 Windows/macOS 的独立资产；客户端按需下载匹配的包，不为自动更新下载整个聚合 ZIP。

### 4.3 文件名示例

完整版本写入每个资产名。公开资产使用不含空格的连字符名称，避免 GitHub 上传时转换文件名而使签名清单中的镜像 URL 失效；应用名和安装器标题仍使用 `NearHub Cast` 和 `NearHub Cast Desktop Installer`。推荐形式如下：

```text
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64-setup.exe
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64-setup.exe.sha256
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64-setup.exe.sig
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64.msi
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64.msi.sha256
NearHub-Cast-Desktop-Installer-0.2.0.37-windows-x86_64.msi.sig
NearCast-Desktop-TX-0.2.0.37-windows-manifest.json
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.app.tar.gz
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.app.tar.gz.sig
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.app.tar.gz.sha256
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.app.tar.gz
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.app.tar.gz.sig
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.app.tar.gz.sha256
NearCast-Desktop-TX-0.2.0.37-macos-manifest.json
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.dmg
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-x86_64.dmg.sha256
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.dmg
NearHub-Cast-Desktop-Installer-0.2.0.37-macos-aarch64.dmg.sha256
NearHub-Cast-0.2.0.37-release-assets.zip
NearHub-Cast-0.2.0.37-release-assets.zip.sha256
```

实际文件名可以按 Tauri bundle 约定调整，但必须保留完整版本、平台和架构字段，且一个 update record 内不得混入其它平台的安装包。

`state` 取 `alpha`、`beta` 或 `release`；普通本地构建默认只接受 `release`。CI 将所选渠道写入编译时 `NEARCAST_UPDATE_CHANNEL`，alpha/beta 包仅查询并接受同渠道的签名清单，设置页会标明测试渠道，正式包不能通过前端切到测试渠道。发布 workflow 的手动测试默认 `alpha`。自动发布使用 `type=optional`；当前策略始终由用户确认安装，不实施强制升级。

## 5. 发布工作流边界

GitHub Actions 应按以下顺序执行：

1. 从 tag 或受保护的发布输入得到 `X.Y.Z`；生成新的 `Build`，得到完整版本。
2. 将完整版本传入 Tauri bundle 元数据和文件命名，并运行全部测试。
3. 在 Windows 签名 Runner 上构建主程序、NSIS 和 MSI 并做 Authenticode 签名，验签后生成 updater 签名和 SHA-256。macOS 分别构建 Intel 和 Apple Silicon，验证应用包，公证并验证 DMG 后再汇总。
4. 生成各平台版本清单，将所有包、签名和清单汇总到同一 GitHub Release，并额外生成上述聚合 ZIP 单链接资产。
5. 分别调用 Mosapi Action 上传到 Windows `646` 和 macOS `647`。任一必需包、签名或版本清单缺失、上传失败、`uploaded-count` 与 Windows 9 个和 macOS 13 个的预期不符时，workflow 失败。
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
| `APPLE_SIGNING_IDENTITY` | Developer ID Application 完整名称；优先读取仓库 Variable，兼容同名 Secret |
| `APPLE_TEAM_ID` | 与证书一致的 Team ID；优先读取仓库 Variable，兼容同名 Secret |
| `APPLE_ID` / `APPLE_PASSWORD` | 公证用 Apple ID 与应用专用密码，不能使用普通登录密码 |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8` | 可替代 Apple ID 的团队级 App Store Connect Key ID、Issuer ID 和 .p8 私钥文本 |

更新公钥已入仓库，私钥保存在当前机器仓库外 `C:\Users\Chado\.codex\update-key-tx\tx.key`，并已配置为 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`，签名验证与内置公钥一致。不要输出或提交私钥，需额外安全备份。更换密钥必须在首次发布前同步公钥；上线后轮换须保留旧版本升级通路。

在包含发布 workflow 的 `main` 提交上打 `vX.Y.Z` tag 会触发全平台正式发布。手动运行 `Release TX` 时选择 `main`、逻辑版本、渠道和 `platforms=windows|all`，默认 Windows/alpha。两种入口共享全局递增 Build。取消手动输入 `publish` 后，流程仍分配 Build 并在 Actions 保存已验签的产物，适合先验证签名和公证。

Windows 单独发布无需 Apple 凭据，向 Mosapi 上传 9 个资产。全平台另向 macOS 产品上传 13 个资产。聚合 ZIP 包含本次选中的平台。流程先创建 GitHub draft Release 并上传 assets，再创建所选产品的 Mosapi 更新记录，成功后公开 GitHub Release。两个平台的记录独立创建。如果部分上传失败，先核对已创建的 update-id，再用新的 Build 发布。

### Windows 签名 Runner

启用公开仓库访问签名主机前，先确认组织提供 `Selected workflows`。缺少该设置的组织需使用只对发布维护者开放的私有签名仓库隔离持证 Runner。[GitHub Enterprise Cloud 的 Runner group 文档](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access#changing-which-workflows-can-access-an-organization-runner-group)

1. 在组织的 Actions 设置中创建专用 Runner group `nearcast-windows-signing`，移入 `windows-signing-0`。Repository access 选择 `Mostorm-Labs/NearCast-Desktop-TX`，允许该公开仓库访问。Workflow access 选择 Selected workflows，仅允许 `Mostorm-Labs/NearCast-Desktop-TX/.github/workflows/release-windows.yml@refs/heads/main`。Runner 使用 `self-hosted`、`Windows`、`X64` 标签。
2. 保护 `main` 的写入及 `vX.Y.Z` 发布 tag 的创建。应允许发布凭据创建四段版本的 GitHub Release tag，并允许分配器写入 `build-counter`。普通 push 和 PR 的 `build.yml` 使用 GitHub 托管 Runner。
3. 确认 Runner 运行账号能访问 eToken、SafeNet CSP、`signingtool/AutoSign.bat`、`signingtool/signtool.exe`、`signingtool/cer.cer` 和时间戳服务。默认从 Runner 安装目录查找 `signingtool`，也可用仓库 Variable `WINDOWS_SIGNING_TOOL_DIR` 指定签名目录的绝对路径。CI 给每个签名文件创建仅 Runner 账号可访问的临时目录，验签后清理。原签名目录里的 PIN 和工具文件也需要本机访问权限保护。
4. 主机需装 Git、Visual Studio C++ x64 工具链和 Windows SDK，并能访问 GitHub Actions、npm、Rust、Tauri 打包工具和证书时间戳服务。流水线安装 Node.js 22 和 Rust stable。若以 Windows 服务运行，先用服务账号验证 eToken 和代理可用性。
5. 合并后先运行 `Release TX`，选择 `main`、`channel=alpha`、`platforms=all` 并取消 `publish`。在 Actions 产物内验证 Windows NSIS/MSI 的证书与时间戳，分别挂载两个 DMG 并验证安装。需要验证两个上传端点时，再用新的 Build 发布 alpha。

### macOS 签名与公证配置

公开的 macOS 安装包需要 Developer ID Application 代码签名和 Apple notarization，Tauri 更新签名不能替代这两项。Release TX 的 alpha、beta、release 都会分发公开资产，因此均要求完整的 Apple 配置；Windows-only 发布无需 Apple 构建凭据。

在仓库 Settings → Secrets and variables → Actions 中配置：

- Variables：`APPLE_SIGNING_IDENTITY` 和 `APPLE_TEAM_ID`。同名旧 Secrets 仍兼容。`APPLE_NOTARIZATION_METHOD` 可明确选择 `apple-id` 或 `api-key`；未指定时有 API 配置则使用 API，否则使用 Apple ID。
- Secrets：`APPLE_CERTIFICATE` 为含私钥的 Developer ID Application P12 的 base64，`APPLE_CERTIFICATE_PASSWORD` 为导出 P12 时设置的密码。只有 .cer 文件无法签名。
- Apple ID 方案：`APPLE_ID` 为属于该 Team 的 Apple 账号，`APPLE_PASSWORD` 为该账号生成的应用专用密码。
- API 方案：改用 `APPLE_API_KEY`（Key ID）、`APPLE_API_ISSUER`（Issuer UUID）和 `APPLE_API_KEY_P8`（下载的团队级 .p8 私钥完整文本）。Issuer ID 不能用 Team ID 替代。不混用两套凭据；显式选择 apple-id 时会清除子进程中的 API 字段，API 模式会清除 Apple ID/密码。

证书可在“钥匙串访问 → 我的证书”中选中含关联私钥的 Developer ID Application 证书项，导出为带密码的 P12。使用 `openssl base64 -A -in /path/to/DeveloperID.p12 -out /outside/repository/certificate-base64.txt` 转换，再将文件内容填入 APPLE_CERTIFICATE Secret。密码、P12、.p8 和 base64 内容不提交到仓库、不发送到聊天或日志中。

2026-11-18 本机检查到的正式证书名称为 `Developer ID Application: SUZHOU AUDITORYWORKS CO.,LTD (8C2WJTL66R)`，Team ID 为 `8C2WJTL66R`，有效至北京时间 2027-02-02。2026-11-19 已确认仓库级存在四项 Apple ID 方案 Secrets，以及签名身份、Team ID 和 `APPLE_NOTARIZATION_METHOD=apple-id` Variables。凭据名称存在不等于签名或公证已通过，仍须以真实发布流水线及产物检查结果为准。

`scripts/macos-signing.mjs check` 会在分配发布 Build 前校验配置，拒绝 ad-hoc、Apple Development、不匹配的 Team 和缺失的公证凭据。构建调用 `scripts/build.mjs`，以 `NEARCAST_REQUIRE_MACOS_SIGNING=1` 再次校验并强制 Hardened Runtime；Tauri CLI 负责导入 P12、Developer ID 签名、提交公证和 stapling。API 私钥仅在 RUNNER_TEMP 的私有临时文件中提供给 CLI，不把原始 .p8 内容转发到子进程，正常完成或失败后均清理。

构建完成后 `scripts/macos-signing.mjs verify <app>` 验证代码签名、签名身份和 Team、Hardened Runtime、stapled 票据及 Gatekeeper。准备发布资产时还会检查 Tauri 签名的 DMG，提交 Apple 公证，附加并验证票据，完成 Gatekeeper 检查后计算 SHA-256。`build.yml` 和本机开发构建供调试使用。

首次对外验证应在凭据配置后选择 `main`、逻辑版本、`platforms=all`、`channel=alpha` 并勾选 `publish`。检查两种架构的签名、公证、GitHub/Mosapi 上传和干净机器下载。此次运行会使用新的 CI Build 并公开 alpha 资产。

参考：[Tauri macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)、[Apple macOS 分发](https://developer.apple.com/macos/distribution)。

### Windows 两个 Build 的在线验收

1. 在仓库 Settings → Secrets and variables → Actions 配置 `MOSAPI_TOKEN`；签名 Secret 已配置。token 需要 folder `546` 上传及 product `646` 更新创建权限。
2. 将工作流合并到 `main` 并配置签名 Runner 后，在 Actions → Release TX 选择 `main`、逻辑版本、`channel=alpha`、`platforms=windows` 并勾选 `publish`，运行一次。检查已签名的安装包、非空 Mosapi update-id、`uploaded-count=9` 和 GitHub Release 链接。
3. 安装该 Build 的 NSIS 测试包作为基线；设置页应显示完整版本和 alpha 测试渠道，保存画质配置。
4. 新建一次 workflow run 生成更高 Build，不要 rerun 同一次发布。公共 `/updates/product/nearcast-tx-windows` 应查询到 alpha 记录，并有对应版本的安装包、清单和签名。
5. 启动基线包，确认自动提示、后台下载、暂不更新后可继续投屏，退出重启后仍提示已就绪。设置页与顶部更新入口显示一致。
6. 点击安装，确认投屏/声音停止、输入释放，安装并重启后版本升至新 Build，设置仍保留。
7. 在干净 Windows 测试机上重复 MSI→MSI；分别验证取消 UAC、离线、下载中断可重试。自动化本地测试覆盖清单/安装包签名不符和缓存篡改拒绝；不得以关闭验证的方式完成安装测试。

当前实现已通过本地浏览器与 Rust 校验、签名及安装包生成。早期两次 Windows alpha CI 在 GitHub 创建 Release 时返回 HTTP 403；配置专用发布凭据后，2026-11-16 的 [Release TX #43864899826](https://github.com/Mostorm-Labs/NearCast-Desktop-TX/actions/runs/43864899826) 已完成 Windows/macOS 构建、GitHub 与 Mosapi 发布。该次 macOS 构建的 Apple 凭据为空，不能视为 Developer ID 和公证验收。**跨 Build 安装和自动重启仍未验收。** 不将本地结果或 CI 构建成功视为安装验收成功。仅发布阶段失败且尚未创建 Mosapi 记录时可重试失败 job，沿用原有已签名产物；未取得托管 runner、尚未开始构建便被取消的 job，也可在同一 workflow run 内单独重试，复用该批预留计数及其他已完成平台产物。代码或产物需要修改、或任何资产已经公开或 Mosapi 记录已经创建时，需检查状态并分配新的 Build，不覆盖已发布版本。

2026-11-19 的 [Release TX #44510228292](https://github.com/Mostorm-Labs/NearCast-Desktop-TX/actions/runs/44510228292) 已完成 `0.2.0.50` Windows x64、macOS Intel / Apple Silicon 正式发布。两种 Mac 包均通过 Developer ID、Hardened Runtime、Apple 公证、stapled 票据及 Gatekeeper 检查；公开下载后再次验证通过。GitHub 20 个资产和两个 Mosapi release record 的 18 个文件已核验，详见 [本次发布记录](../verification/2026-11-19-tx-stable-release.md)。本机普通开发构建的基础配置仍允许 ad-hoc，不能用开发构建替代正式签名或权限保留验收。

## 8. 上线前确认

已确定产品映射、共享 `folder-id=546` 和真实 `otaFiles.file.data.attributes` JSON 结构。首次线上发布前仍需完成：

- 两个平台的发布审批规则；
- 配置上传 token 与更新签名私钥 Secret；
- Windows 实机跨两个 Build 的 NSIS/MSI 升级及取消授权验证；
- macOS Intel/Apple Silicon 的真实包更新、Apple 签名和权限保留验证；
- 首次 Mosapi 上传后的公共查询、签名清单和软件下载验收。

product-id、slug 和 folder-id 可按本契约配置；token 和签名私钥仅通过 CI Secret 注入。
