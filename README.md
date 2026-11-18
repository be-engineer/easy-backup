# easy backup

Obsidian 同步/备份插件，通过 WebDAV 把 vault 同步到自己的服务器（Nextcloud、坚果云、NAS 等），支持自签名证书，桌面端和移动端通用。

## 主要功能

- **三种同步策略**：Upload（本地覆盖远端）、Download（远端覆盖本地）、Merge（双向合并）
- **自签名证书支持**：桌面端可忽略证书校验，移动端支持 Tailscale 等可信证书方案
- **冲突处理**：自动生成 `.conflict-<时间戳>` 副本 + `.diff.md` unified diff 报告
- **Joplin 式墓碑删除**：删除双向传播，不静默复活已删除文件
- **Obsidian 配置同步**：可选同步 `.obsidian/`（插件、主题、快捷键等），含排除规则
- **423 锁自动解锁**：Nextcloud 文件锁冲突自动释放并重试
- **移动端友好**：并发控制、进度显示、状态栏反馈

## 安装

把 `main.js`、`manifest.json`（可选 `styles.css`）放入：

```
<vault>/.obsidian/plugins/easy-backup/
```

在 设置 → 第三方插件 中启用 easy backup。

## 配置

详见 [使用说明](USAGE.md)。

## 打赏

如果这个插件对你有帮助，欢迎打赏支持：

![打赏](wepay.png)
