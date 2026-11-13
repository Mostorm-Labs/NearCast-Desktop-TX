# WebCast 发送端与采集来源声明

2026-11-13，NearHub Cast 产品协议 v1，不属于 AXTP 数字方法。

在已配对 WebRTC `control` DataChannel 发送：

```json
{"action":"nearcast-source","data":{"version":1,"roomId":"current-room","senderUserId":"current-sender","receiverUserId":"current-receiver","revision":"1","source":{"platform":"windows","clientKind":"desktop","product":"nearhub-cast","displaySurface":"monitor"}}}
```

`source` 固定四字段：

- `platform`：`windows|macos|linux|android|ios|unknown`。桌面使用原生平台信息，网页尽力识别。
- `clientKind`：`desktop|mobile|web|unknown`。Windows／macOS 的本软件是 desktop；后续 Android 原生软件是 mobile；网页是 web。
- `product`：桌面 `nearhub-cast`，网页 `webcast`；小写字母、数字、`.`、`-`，最长 64 字符。
- `displaySurface`：轨道 `getSettings()` 的 `monitor|window|browser`；未分享、已结束或无法确认是 `unknown`。

`data` 固定六字段。`revision` 是十进制 uint64 字符串，从 1 开始；值改变递增，
同一媒体 peer 重建通道时保持 revision 并重发。新媒体 peer 重置。消息独立于反控授权，
在控制通道打开、新分享和停止分享时发送；取消选源不撤销当前分享。

RX 校验该消息身份与当前 room/peer 一致，只接受更新的 revision。未知旧客户端仍能投屏，
不能开启反控。`desktop + nearhub-cast + windows|macos + monitor` 或
`mobile + nearhub-cast + android + monitor` 能进入反控检查；
网页整屏、窗口、标签页均不具备反控资格。NA20＋NT10 桌面采集走独立 HID 设备来源规则。
分类是自声明信息，不是官方软件认证或授权；原生能力、物理屏幕绑定、两端开关、
用户同意与成功 `input.openStream` 仍是必要条件。

Android 声明示例：`{"platform":"android","clientKind":"mobile","product":"nearhub-cast","displaySurface":"monitor"}`。
这是后续 Android 原生发送端的协议预留，不表示该仓库已实现 Android 打包、采集或系统输入注入。
Android 网页仍使用 `clientKind:web`，仅支持投屏；旋转／采集区域改变时需退役旧坐标绑定并释放输入。

现有 `nearcast-input-source` 的 `displaySurface` 保留兼容用途，RX 要求它如存在就与上述声明一致。
此消息不引入像素搬运、不影响浏览器视频直传或 WASAPI 音频、不修改 AXTP 帧格式。
