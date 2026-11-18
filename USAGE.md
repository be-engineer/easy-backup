# easy backup 使用说明

## 配置

| 设置项 | 说明 |
|---|---|
| Server URL | WebDAV 地址，例如 `https://nc.home:9443/remote.php/dav/files/admin`（Nextcloud 不含最后的 vault 目录名） |
| Username / Password | WebDAV 账号密码（密码输入框隐藏显示） |
| Remote path | 服务器上的同步目录，默认 `/obsidian` |
| Sync on startup | 启动 Obsidian 时自动同步一次 |
| Sync strategy | 同步策略，见下文 |
| Test connection | 测试按钮：验证地址和账号是否可用（放在 Remote path 下面） |
| Sync Obsidian config | 是否同步 `.obsidian/`（插件、主题、快捷键等），见下文 |
| Include plugin settings | 是否连插件的 `data.json` 一起同步 |
| Config exclusions | 不参与配置同步的路径（相对 `.obsidian/` 的 glob，一行一个） |
| Sync now / Stop | 手动开始/停止同步（左侧 ribbon ☁ 按钮同样是开始/停止开关） |
| Last sync | 显示上次同步时间和上传/下载/删除/冲突数量 |

同步进行中，左侧 ribbon 图标会变成旋转的 ↻（转圈状态），点击即可停止。

## 同步策略（重点）

原理：插件在 `data.json` 里保存每个文件的快照（本地和远端各自的 `mtime` + `size`，即 `syncState`）。每次同步先用 `PROPFIND` 拉取远端列表，再和本地、上次快照做三方对比，只传输有变化的文件——**没有变化时几乎瞬间完成**。

### Upload（覆盖远端）

单向：本地 → 服务器，**本地永远赢**。

- 本地新增或修改的文件 → 上传到服务器
- 本地删除、且**之前同步过**的文件 → 服务器上的也删除（受 Mirror deletions 开关控制）
- 本地新建、从未同步过的文件不会被误删——想让服务器删掉它们？先 Upload 同步一次建立同步记录
- **服务器上被其他设备修改过的文件，也会被本地版本覆盖**（本地是唯一事实来源，因此新内容应只在这台设备上产生）
- 服务器上的任何变化**不会**下载到本地

### Download（覆盖本地）

单向：服务器 → 本地，**远端永远赢**。

- 远端新增或修改的文件 → 下载到本地
- 远端删除、且**之前同步过**的文件 → 本地也删除（受 Mirror deletions 开关控制）
- 本地新建、从未同步过的文件**不会**被删除
- **本地的任何修改都会被远端版本覆盖**（远端是唯一事实来源）
- 本地的修改不会上传

### Merge（双向合并，默认）

双向：本地 ⇄ 服务器，Joplin 式墓碑删除语义。

- 只有本地有 → 上传；只有远端有 → 下载
- 两边都有、只有一方变化 → 以变化方为准
- **两边都修改（冲突）** → 远端版本保存为 `文件名.conflict-<时间戳>.md`，本地版本覆盖上传。两个版本都保留，之后手动合并并删除 conflict 文件
  - 如果两边内容逐字节相同（只是 mtime 抖动被判成"两边都变了"），不会生成 conflict 文件
  - 文本文件会额外生成 `文件名.conflict-<时间戳>.diff.md`：本地版本 vs 远端版本的 unified diff，方便直接看出改了哪几行；二进制文件、或差异大到无法在合理时间内计算的，不生成 diff
- **删除双向传播**：通过墓碑记录（`.easy-sync-deleted.json`）显式同步，超过确认阈值会弹窗确认；详见下方"删除语义"

## Obsidian 配置同步（`.obsidian/`）

打开 **Sync Obsidian config (.obsidian)** 后，插件会像同步笔记一样同步配置目录，默认关闭：

- 服务器上的位置就是 `<Remote path>/.obsidian/...`，和笔记共用同一套快照、墓碑和冲突逻辑（因此同样受当前 Sync strategy 影响）
- 新设备第一次 Merge/Upload 同步后，会拿到同样的插件（`plugins/<id>/main.js`、`manifest.json`、`styles.css`）、已启用列表 `community-plugins.json`、主题、CSS 片段、快捷键等
- 有新插件文件写入时会提示 **reload Obsidian**——Obsidian 不会热加载磁盘上新增的插件，需要重载一次（Ctrl+R / 命令面板 "Reload app without saving"）才生效

**永远不同步**（硬编码，避免自毁/抖动）：

| 路径 | 原因 |
|---|---|
| `.obsidian/workspace.json`、`workspace-mobile.json` | 每个设备的窗格布局和最近文件，Obsidian 会频繁改写 |
| `.obsidian/cache/` | 本地缓存 |
| `.obsidian/.git/` | 如果把配置目录纳入 git 管理 |
| `.obsidian/plugins/easy-backup/` | 插件自身的代码和 `data.json`（含账号配置、同步快照），跨设备同步会互相覆盖、并把同步状态传给服务器 |

**Include plugin settings**（默认**关**）控制 `plugins/*/data.json`。默认关闭是因为插件设置里经常存放设备相关路径或凭据（本 vault 里的 `remotely-save/data.json` 就有 WebDAV 账号配置）。需要让其他设备连插件设置都一致时再打开；打开前建议先用 Config exclusions 排除敏感的插件：

```
plugins/remotely-save/
plugins/obsidian-git/
```

**Config exclusions** 支持简单 glob（相对 `.obsidian/`，一行一个）：

```
plugins/obsidian-git/
snippets/private.css
plugins/*/data.json      # 等同于关掉 Include plugin settings
themes/**
```

`*` 只匹配单层路径，`**` 可跨目录；以 `/` 结尾表示整个目录。

注意：

- 配置冲突走与笔记相同的规则：远端版本存成 `xxx.conflict-<时间戳>`（在 `.obsidian/` 里，不会生成 `.diff.md`，因为它在 Obsidian 里不是可读笔记）
- 同步配置时也可能触发批量删除确认（例如本地删掉一个插件目录），阈值与笔记共用
- 关闭该开关后，远端已有的 `.obsidian/` 文件会被忽略，不会被下载也不会被删除
- 第一次开启时，建议在「配置最全」的那台设备上先跑一次 Upload/Merge 把配置推上去；全新设备首次 Merge 时两边都没有历史快照，会按 mtime 各自择优，可能用服务器上的旧插件版本覆盖本地同名文件
- **easy backup 自身不会同步**（`plugins/easy-backup/` 被排除），新设备仍需手动安装一次本插件才能开始同步——这是先有鸡还是先有蛋的问题

## 删除语义（重点）

**Merge 模式采用 Joplin 式墓碑（tombstone）记录删除**：

- 删除会双向传播。删除被显式记录在服务器上的 `.easy-sync-deleted.json`（墓碑文件），不是靠"文件消失"去猜
- 另一台设备同步时读到墓碑 → 明确删除本地对应文件
- 删除后的同名新建文件（本地修改时间晚于墓碑时间）会被识别为"重新创建"，不会被误删
- 墓碑保留 30 天后自动过期，兼顾多设备同步窗口和文件体积
- **批量删除确认**：单次同步删除文件数超过阈值（默认 20，可调）时弹窗确认，防止误删污染备份；设为 0 每次删除都确认，设为极大值则从不确认

**Upload / Download 模式是镜像语义**，删除会传播（受 "Mirror deletions" 开关控制，默认 ON）：

- Upload + Mirror deletions ON：本地删除 → 服务器也删，随后自动清理服务器上因删除而变空的文件夹
- Download + Mirror deletions ON：服务器删除 → 本地也删，同样清理本地空文件夹
- 开关 OFF 时镜像模式也不删，缺失文件保留在缺失侧

Obsidian 删除文件默认进回收站（系统回收站或 vault 内 `.trash`），误删后可从这里找回。

## 并发传输

- **Concurrency 设置**（默认 3，范围 1–8）：并行传输文件数，首次全量同步可提速约 3–4 倍
- 目录创建始终串行先完成，避免竞态；差分计算和快照写入保持串行
- 无变化时的同步仍然秒级完成，不受并发设置影响

### ⏭ 跳过

路径中的目录名如果是纯百分号编码（如 `%E8%B7%AF%E7%94%B1%E5%99%A8`）会被判定为历史 bug 产生的垃圾副本，自动跳过，通知里的 ⏭ 数字就是跳过数量。这类文件夹可以安全删除。

## 注意事项

- 首次同步是全量合并，建议先手动备份 vault
- 默认不同步 `.obsidian` 配置目录和空目录；需要同步插件/主题时在设置里打开 **Sync Obsidian config**
- 快照保存在插件目录的 `data.json`（`syncState` 字段）；同步中途禁用插件会导致该次快照未保存，下次同步会重新对比
- 所有请求有 65 秒硬超时，不会无限挂起
- 同步进行中重复触发会提示 "Sync already in progress"

## 故障排查

1. 同步无反应/报错：Ctrl+Shift+I 打开控制台，所有日志带 `[easy-backup]` 前缀
2. 桌面端自签证书失败：确认 Allow self-signed 已开启
3. 服务器不支持 `PROPFIND Depth: infinity`（部分 NAS）：需要联系作者适配为逐层遍历
4. 构建开发：`npm install && npm run build`（或 `npm run dev` watch 模式）
