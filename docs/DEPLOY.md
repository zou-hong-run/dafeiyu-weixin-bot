# Linux 部署

Windows 上跑和 Linux 上跑，代码是同一份，但**安全能力不一样**——Linux 上有内核级沙箱和文件权限，Windows 上这两样都没有。这篇讲怎么部署，以及怎么确认那些机制真的生效了。

## 系统要求

| 项 | 要求 |
|---|---|
| 系统 | Ubuntu 22.04+ / Debian 12+ / 其他现代发行版 |
| Node | >= 22（原生 fetch 需要） |
| 内存 | 512MB 起步，1GB 更稳（工具服务是独立子进程） |
| 磁盘 | 1GB 空闲（日志、下载的文件）；下载视频多的留 5GB |

## 1. 装依赖

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm
sudo corepack enable
corepack prepare pnpm@latest --activate

# 沙箱：Linux 上 shell 工具靠它做隔离，装了才算真正隔离
sudo apt install -y bubblewrap

# 可选：视频解析和音频转码
sudo apt install -y ffmpeg
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
```

**bubblewrap 是重点。** 不装的话 shell 只能靠正则规则挡，装了之后写操作会被内核限制在 `tmp/` 里。

注意装了之后 **shell 里没有网络**（`--unshare-net`）：沙箱断网是故意的，防止命令把本地数据往外传。要在服务器上下载东西，让它用 `download` 工具（主进程发起的，有出网校验），别在 shell 里 `curl`。

## 2. 建用户和目录

别用 root 跑。给个专用账号，它看不见其他服务的东西：

```bash
sudo useradd -r -m -d /opt/wechatbot -s /usr/sbin/nologin wechatbot
sudo mkdir -p /etc/wechatbot
sudo chown wechatbot:wechatbot /etc/wechatbot
sudo chmod 700 /etc/wechatbot
```

## 3. 部署代码

```bash
sudo -u wechatbot git clone https://github.com/zou-hong-run/dafeiyu-weixin-bot.git /opt/wechatbot
cd /opt/wechatbot
sudo -u wechatbot pnpm install --prod
```

## 4. 密钥放项目外

项目目录可能被 nginx 静态托管误暴露，密钥别放里面：

```bash
sudo tee /etc/wechatbot/env >/dev/null <<'EOF'
DEEP_SEEK_API_KEY=你的key
DEEPSEEK_MODEL=deepseek-flash
TZ=Asia/Shanghai
EOF

sudo chown wechatbot:wechatbot /etc/wechatbot/env
sudo chmod 600 /etc/wechatbot/env
```

程序启动时按 `APP_ENV_FILE` → `/etc/wechatbot/env` → 项目内 `.env` 的顺序找。systemd 单元里已经设了 `APP_ENV_FILE`。

## 5. 首次登录（要扫二维码）

二维码要在终端里看。两种方式：

**方式 A：SSH 里直接扫（推荐）**

```bash
cd /opt/wechatbot
sudo -u wechatbot -i
node src/index.js
```

终端会画出二维码，用微信扫。登录成功后会打印 `登录成功，机器人身份 xxx`，然后 Ctrl+C 停掉。

如果终端画不出码（某些 SSH 客户端），二维码链接也会打出来，复制到浏览器打开。

**方式 B：本地登录后拷凭证**

在本机（Windows）先登录，然后把 `data/ilink/` 整个目录拷到服务器：

```bash
scp -r ./data/ilink user@server:/opt/wechatbot/data/
sudo chown -R wechatbot:wechatbot /opt/wechatbot/data
sudo chmod 700 /opt/wechatbot/data/ilink
sudo chmod 600 /opt/wechatbot/data/ilink/*.json
```

凭证里有能收发消息的 token，传的时候走 scp（加密），别用不安全的通道。

## 6. 起服务

```bash
sudo cp /opt/wechatbot/deploy/wechatbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wechatbot
sudo systemctl status wechatbot
```

看日志：

```bash
sudo journalctl -u wechatbot -f
```

## 7. 确认安全机制真的生效

这一步别跳过。**看启动日志里的三行**：

```bash
sudo journalctl -u wechatbot --since "5 minutes ago" | grep -E "平台|权限|收紧"
```

应该看到类似：

```
INFO  平台：linux｜ulimit 可用｜bwrap 沙箱已启用
INFO  权限：高危工具已禁用（shell / 写文件 / 清记忆等）...
INFO  已收紧文件权限：data 700 → 700，data/ilink/credentials.json 644 → 600
```

**`bwrap 沙箱已启用` 是关键。** 如果显示「未隔离（没装 bwrap）」，说明 shell 只有规则防护，没有内核隔离——回第 1 步装 bubblewrap。

再验一条：让它跑危险命令，应该在规则层就被拦住。

在微信里发：

```
用 shell 跑一下 cat /etc/shadow
```

预期：被拒。即使配了 `ADMIN_USER_IDS` 也一样——授权不等于放开所有命令。

## 8. 时区（定时任务依赖它）

定时任务用本地时间。「每天早上 8:30」在 UTC 服务器上会变成北京时间 16:30。

```bash
sudo timedatectl set-timezone Asia/Shanghai
timedatectl | grep "Time zone"
```

systemd 单元里也设了 `Environment=TZ=Asia/Shanghai`，两处都设更保险。

## 9. 权限配置

默认高危工具是关的。要开：

```bash
sudo -u wechatbot nano /etc/wechatbot/env
```

加一行（id 从微信里发 `/id` 拿）：

```
ADMIN_USER_IDS=你的id@im.wechat
```

```bash
sudo systemctl restart wechatbot
```

## 10. 运维

**看日志**

```bash
# 应用日志（含审计），保留 7 天
tail -f /opt/wechatbot/logs/bot-$(date +%F).log

# 审计单独看
grep '\[审计\]' /opt/wechatbot/logs/bot-*.log
```

**升级**

```bash
cd /opt/wechatbot
sudo -u wechatbot git pull
sudo -u wechatbot pnpm install --prod
sudo systemctl restart wechatbot
```

**备份**

至少要备这三样，丢了就找不回来：

```bash
sudo tar czf ~/wechatbot-backup-$(date +%F).tar.gz \
  -C /opt/wechatbot data \
  -C /etc/wechatbot env
```

`data/ilink/` 是登录凭证（丢了要重新扫码），`data/memory.json` 是记忆，`/etc/wechatbot/env` 是密钥。

**重启**

```bash
sudo systemctl restart wechatbot
```

注意：systemd 下 `restart_self` 工具用不了（它只认 pm2）。想让它自己重启，那个工具会返回明确报错，用上面的命令。

## 11. 排错

**服务起不来，日志说「已经有一个实例在跑」**

单实例锁生效了。同一个微信号只能一个进程轮询，两个一起跑会互相吞消息。

```bash
ps aux | grep "src/index.js"
```

确认旧进程真死了但锁还在，删掉锁文件：

```bash
sudo rm /opt/wechatbot/data/instance.lock
```

**二维码扫不了 / 登录超时**

二维码 2 分钟左右过期。SSH 里看到码就赶紧扫，过期会自己刷新（日志里有提示）。

**沙箱装了但显示未启用**

容器里常见：内核禁了 user namespace。

```bash
bwrap --unshare-pid --ro-bind / / --dev /dev --proc /proc -- /bin/true
```

跑一下，报错就是内核层面的限制，不是程序问题。这种情况只能退回规则防护。

**定时任务不推**

看日志里的门控报错：

```bash
grep "主动推送" /opt/wechatbot/logs/bot-*.log
```

超过 `PUSH_MAX_IDLE_MINUTES`（默认 30 分钟）没说话就不推——`context_token` 会失效。先发条消息刷新，或者调大这个值（`.env` 里加 `PUSH_MAX_IDLE_MINUTES=600`）。

**shell 报内存相关错误**

Linux 上 shell 会用 ulimit 限单进程内存（按机器内存自动算）。机器小的话跑重命令会被拦，看 `system_info` 的档位提示。

## Windows 和 Linux 的安全差异

| 能力 | Windows | Linux |
|---|---|---|
| 内核级沙箱 | ❌ 没有 | ✅ bwrap（装了才有） |
| 单进程内存限制 | ❌ 没有 | ✅ ulimit |
| 文件权限 | ❌ chmod 无效 | ✅ 700/600 生效 |
| 命令守卫（正则规则） | ✅ | ✅ |
| 路径黑名单 | ✅ | ✅ |
| 出网校验 | ✅ | ✅ |
| 审计日志 | ✅ | ✅ |

所以在 Linux 上，同样一份代码的安全边界比 Windows **强一层**——前提是装了 bubblewrap 且内核允许。
