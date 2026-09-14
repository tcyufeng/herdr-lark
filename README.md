# herdr-lark

[![skills.sh](https://skills.sh/b/tcyufeng/herdr-lark)](https://skills.sh/tcyufeng/herdr-lark)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Reach the agent session **already running** in your [herdr](https://herdr.dev) pane — from Feishu/Lark on your phone. When it hits something only you can decide, it pushes a card with buttons; you tap one or type a sentence, and the answer lands back in that same session, with all its context. Images and voice notes you send go the other way, straight into the pane. No server, no public URL — the daemon dials out over Feishu's WebSocket. The app is created by scanning a QR code, **no workspace-admin approval needed**.

把**已经在 herdr 窗格里跑着**的 agent 会话接到飞书。它遇到要你拍板的事，推一张带按钮的卡片到你手机；你点一下或打一句话，答复回到**那个会话**里——而不是新开一个。你发的图片和语音会反向注入回窗格。不需要服务器和公网地址，扫码就能建应用，**不用企业管理员审核**。

```bash
npx skills add tcyufeng/herdr-lark
```

## Quick start · 三步跑起来

**1. 构建**（skills CLI 只拷文件、不构建，所以要自己来一次）

```bash
cd .agents/skills/herdr-lark && npm install && npm run build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/herdr-lark
```

**2. 扫码建应用**

```bash
herdr-lark setup
```

终端会画出一个二维码（扫不到就点它下面打印的链接）。用**飞书手机端扫**，确认页上会列出要授权的权限，点同意——应用当场就建好了，凭据自动存进系统钥匙串。个人版账号就行。

**3. 开启，自动建群**

```bash
cd <你的项目> && herdr-lark away on
```

这一条命令把整条通路备齐：起 daemon → **在飞书里给这个项目新建一个群**（已经有就复用）→ 打开开关。打开飞书就能看到那个群，以后这个项目的提问都发在里面。**一个项目一个群**，所以你在哪个群说话就是对哪个项目说，不会串。

## 让「我走了」直接生效

把规则拷进 agent 的常驻规则目录，之后你只要说话，不用记命令：

```bash
cp .agents/skills/herdr-lark/examples/remote-mode-rule.md ~/.claude/rules/
```

装好之后：

| 你说 | agent 做 |
|---|---|
| 「我走了」「有事发手机」 | `herdr-lark away on` |
| 「我回来了」 | `herdr-lark away off` |

远程模式开着时，它在终端说的每一句都会**逐字**同步到群里，要你拍板的事推成带按钮的卡片，卡在需要你确认的提示上时也会推。

也可以用斜杠命令：把 `examples/away.md` 和 `examples/back.md` 拷进 `~/.claude/commands/`，就有了 `/away` 和 `/back`。

## 手机通知不响？

飞书默认**电脑端在线时抑制手机推送**。手机飞书 → 设置 → 通知，关掉那个开关。

## 更多

- **完整文档**：[English](./docs/guide.md) · [中文](./docs/guide.zh-CN.md) —— 凭据解析顺序、环境变量、文件位置、已知边界
- **agent 读的那份**：[SKILL.md](./SKILL.md) —— 字段契约、退出码、写卡片的规矩
- **规则示例**：[examples/remote-mode-rule.md](./examples/remote-mode-rule.md)

只在 macOS 上完整跑过；Linux 和 Windows 的凭据存储按平台写了但没实测，欢迎 PR。

MIT
