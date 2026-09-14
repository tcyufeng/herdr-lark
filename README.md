# herdr-lark

把 herdr 窗格里**正在跑**的 agent 会话接到飞书。

和「在飞书里开一个新 agent 会话」的桥不同，这个是**旁路**：你在电脑前干活，人走开了，
会话继续跑；它遇到要你拍板的事，推一张带按钮的飞书卡片到你手机；你点一下或打一句话，
答复回到**那个已经跑了两小时、带着全部上下文的会话**里。

## 装

```bash
npm install && npm run build
ln -sf "$PWD/dist/cli.js" ~/.local/bin/herdr-lark
```

## 配

```bash
herdr-lark setup            # 终端出二维码，用飞书扫；应用当场建好，不用管理员审核
herdr-lark daemon --detach  # 常驻进程，独占飞书长连接
cd <你的项目> && herdr-lark bind   # 新建一个飞书群并绑到这个项目
herdr-lark away on          # 打开远程模式
```

`setup` 的确认页会列出要授权的权限：收发消息、以应用身份发消息、群内免 @ 收消息、建群、上传下载资源，
外加 `im.message.receive_v1` 事件和 `card.action.trigger` 回调。少了哪个可以 `herdr-lark setup --update` 补。

## 用

```bash
herdr-lark ask <<'JSON'      # 推一张提问卡，阻塞等答复，答复到 stdout
{"title": "...", "doing": "...", "description": "...", "blocker": "...",
 "options": [{"id":"a","label":"...","consequence":"..."},
             {"id":"b","label":"...","consequence":"..."}],
 "recommend": "a", "reasoning": "...", "question": "...", "lang": "zh"}
JSON

herdr-lark notify <<'JSON'   # 单向通知，不阻塞
{"title": "...", "body": "..."}
JSON

herdr-lark send-file shot.png --caption "现在的版式"
herdr-lark status
```

字段含义、退出码、写卡片的规矩：[SKILL.md](./SKILL.md)。

## 卡片长什么样

```bash
node scripts/preview.mjs && open card-preview.html
```

## 一个项目一个群

项目 = git toplevel（不在 git 里就是 cwd）。每个项目绑一个飞书群：
在哪个群说话，就是对哪个项目说，不会串。群里免 @，发什么都直接进那个项目的窗格。

## 东西放在哪

| 路径 | 内容 |
|---|---|
| macOS 钥匙串 `herdr-lark` | 应用凭据（`HERDR_LARK_STORE=file` 可改成 0600 文件） |
| `~/.herdr-lark/daemon.sock` | 本地 IPC |
| `~/.herdr-lark/bindings.json` | 项目 ↔ 群 ↔ 窗格 |
| `~/.herdr-lark/daemon.log` | 只记 id 和状态变化，**不记消息内容** |
| `~/.herdr-lark/media/` | 手机发来的图片/文件 |
| `<项目根>/.herdr-lark/state.json` | 远程模式开关、群 id、窗格 id（自带 `.gitignore`） |

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `HERDR_LARK_HOME` | `~/.herdr-lark` | 状态目录 |
| `HERDR_LARK_STORE` | macOS 用钥匙串 | 设成 `file` 则凭据存 0600 文件 |
| `HERDR_LARK_KEYCHAIN` | `herdr-lark` | 钥匙串 service 名 |

MIT
