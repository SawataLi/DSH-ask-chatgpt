# DSH-ask-chatgpt

DSH 调用网页版 ChatGPT 插件：用 Playwright 驱动 Chromium 打开 chatgpt.com 的**网页版临时聊天**，
把外部 ChatGPT（默认模型 GPT-5.6 Sol，思考档位 Pro / Instant 可选）作为 DSH 中的一个辅助工具，
用于联网获取最新信息、生成详细计划或其他需要外部大模型协助的问答。

## 工作原理

- 每次 `ask` 调用都会打开一个**全新的临时聊天**（调用之间没有上下文），以有头（headed）Chromium 运行——
  Cloudflare 会拦截无头浏览器指纹，有头模式最稳。
- 使用**持久化浏览器 profile**（`profile/` 目录）保存登录态；登录一次后持久保持。
- 内置反自动化参数（`--disable-blink-features=AutomationControlled` 等），
  避免 Google OAuth 登录时出现 "This browser or app may not be secure"。
- 无 X server 的服务器上，若未设置 `$DISPLAY`，会在启动前自动拉起一个 Xvfb（`:99`）作为虚拟显示，
  使"可见"浏览器窗口有处可挂（见下文 Xvfb 一节）。

## 目录结构

```
chatgpt-bridge/
├── helper.mjs        # 桥接主体（login / serve / ask 三种模式）
├── package.json      # 仅依赖 playwright
├── profile/          # Chromium 持久化 profile（含登录 Cookie，勿提交、勿外传）
├── x11/              # 解包的 Xvfb（Ubuntu 24.04 arm64, xvfb 21.1.12），无显示器环境自动使用
├── dev/              # 开发调试脚本与探针输出
└── .logged-in        # 登录标记文件（由 login/ask 流程自动维护）
```

## 安装与登录

```bash
npm install
# Playwright 需要 Chromium：
npx playwright install chromium
```

首次使用需要在**有显示器的机器**上完成一次登录（会在屏幕上弹出一个 Chromium 窗口，
15 分钟内完成登录即可，登录态写入 profile 后长期有效）：

```bash
node helper.mjs login
# 成功输出 LOGIN_OK，失败（超时）输出 LOGIN_TIMEOUT
```

如果登录 Cookie 失效，`ask` 会返回 `code: "login-required"`，此时重新执行上面的登录流程即可。

## 使用方式

### 1. DSH 插件（推荐）

由 DSH 插件按工具调用自动拉起本桥接，操作员无需手动操作。
模型、思考档位（Pro / Instant）、代理与单次超时时间由
**DSH 设置 → 插件 → 插件配置 → ChatGPT 桥接** 决定，保存后在下一次调用生效。

### 2. 一次性 ask（stdin/stdout JSON）

从 stdin 读入一行 JSON 请求，执行一次问答，向 stdout 输出一行 JSON 结果：

```bash
echo '{"task":"深圳今天适合跑步吗？请给出建议","effort":"pro","timeoutMs":120000}' \
  | node helper.mjs ask
```

请求字段：

| 字段 | 说明 |
|---|---|
| `task` | 必填，完整自包含的任务/问题（临时聊天没有历史上下文） |
| `effort` | `"pro"`（默认）或 `"instant"` |
| `timeoutMs` | 等待回复的超时（毫秒），默认 1800000（30 分钟） |
| `temporary` | 默认 `true`（临时聊天）；设为 `false` 使用常规聊天（图片生成仅在常规聊天可用） |

成功结果字段：`ok`、`reply`（Markdown 文本）、`images`（回复中图片的本地保存路径列表）、
`model`、`effort`、`workedFor`（如 "Worked for 33s"）。

失败结果字段：`ok:false`、`error`、`code`。已知错误码：
`login-required`（需重新登录）、`cf-challenge`（Cloudflare 拦截）。

### 3. serve 模式（长驻 stdio JSON 桥）

```bash
node helper.mjs serve
```

通过 stdin/stdout 以换行分隔 JSON 长驻通信，浏览器上下文复用：

```json
{"id":1,"op":"ping"}            -> {"id":1,"ok":true,"result":{"pong":true,"pid":...}}
{"id":2,"op":"status"}          -> 登录/profile 状态
{"id":3,"op":"ask","task":"..."}-> 同一次性 ask 的 result
{"id":4,"op":"probe"}           -> 打开临时聊天探测可用性/模型选择器
{"id":5,"op":"close"}           -> 关闭并退出
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CHATGPT_BRIDGE_ROOT` | `~/.dsh/chatgpt-bridge` | 桥接根目录 |
| `CHATGPT_PROFILE` | `<ROOT>/profile` | Chromium profile 目录 |
| `CHATGPT_MARKER` | `<ROOT>/.logged-in` | 登录标记文件 |
| `CHATGPT_PROXY` | `http://192.168.50.10:7890` | 浏览器代理；设为空字符串表示直连 |
| `CHATGPT_HEADLESS` | 未设置（有头） | 设为 `1` 强制无头模式（Cloudflare 有拦截风险） |
| `CHATGPT_WORKSPACE` | `$HOME` | 工作区目录 |
| `CHATGPT_IMG_DIR` | `<WORKSPACE>/.chatgpt-images` | 回复中图片的保存目录 |
| `CHATGPT_X11_DIR` | `<ROOT>/x11` | Xvfb 解包目录 |
| `XVFB_BIN` | `<X11_DIR>/usr/bin/Xvfb` | Xvfb 可执行文件路径 |

## Xvfb（无显示器环境的配置）

### 工作机制

`helper.mjs` 在启动时检查 `$DISPLAY`：

- 已设置 → 直接使用现有 X server；
- 未设置 → 以 detached 方式自动启动
  `Xvfb :99 -screen 0 1440x900x24 -nolisten tcp`，并把进程内 `DISPLAY` 设为 `:99`，
  之后有头 Chromium 即可在该虚拟显示上运行。启动成功时 stderr 会输出
  `no $DISPLAY; spawned Xvfb on :99 (pid ...)`。

Xvfb 可执行文件的位置按以下顺序确定：

1. 环境变量 `XVFB_BIN`（完整路径）；
2. 否则 `<CHATGPT_X11_DIR 或 ~/.dsh/chatgpt-bridge/x11>/usr/bin/Xvfb`（即仓库默认布局）。

Xvfb 启动时其 `LD_LIBRARY_PATH` 会自动把 `x11/usr/lib` 前置，因此解包进来的
依赖库与系统库冲突时可以覆盖系统版本。

`x11/` 目录是二进制文件，**不随仓库提交**（见 `.gitignore`），
需要在目标机器上按下面任一方式自行准备。

### 方式一：用系统包管理器安装（有 root 权限，最简单）

```bash
# Ubuntu / Debian（amd64 与 arm64 包名相同）
sudo apt-get install -y xvfb

# 系统装好后，让 helper 指向系统二进制（因为默认路径是 <ROOT>/x11/usr/bin/Xvfb）：
export XVFB_BIN=/usr/bin/Xvfb
# 写入 ~/.bashrc 或 DSH 插件进程能读到的环境配置中以持久化
```

### 方式二：无 root 权限时手工解包（本仓库当前机器的做法）

适用于容器/受限环境（sudo 不可用、conda 装不了）的情况，
以 Ubuntu 24.04 为例：

```bash
cd ~/.dsh/chatgpt-bridge

# 1) 确认依赖库已由系统提供（缺失的需另行处理，见文末）
for p in xserver-common libgl1 libxau6 libxdmcp6 libxfont2 libpixman-1-0 \
         xauth x11-xkb-utils libgcrypt20 libselinux1 libsystemd0 libunwind8; do
  dpkg -s "$p" >/dev/null 2>&1 || echo "MISSING: $p"
done

# 2) 下载 xvfb 的 .deb 到当前目录
#    arm64 机器（Ubuntu ports 源）：
curl -O http://ports.ubuntu.com/ubuntu-ports/pool/universe/x/xorg-server/xvfb_21.1.12-1ubuntu1_arm64.deb
#    amd64 机器（archive.ubuntu.com 源）：
curl -O http://archive.ubuntu.com/ubuntu/pool/universe/x/xorg-server/xvfb_21.1.12-1ubuntu1_amd64.deb

# 3) 解包到 <ROOT>/x11（不需要 root，也不真正安装）
dpkg -x xvfb_*.deb x11/

# 4) 验证
ls x11/usr/bin        # 应看到 Xvfb 和 xvfb-run
XVFB_BIN=$PWD/x11/usr/bin/Xvfb
"$XVFB_BIN" :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 1
ls /tmp/.X99-lock     # 文件存在 = X server 启动成功
kill %1 && rm -f /tmp/.X99-lock
```

包名/版本可从对应发行版的包索引查询（`http://ports.ubuntu.com/ubuntu-ports/dists/`
或 `http://archive.ubuntu.com/ubuntu/dists/` 下的 `binary-*/Packages.gz`）。
CentOS/RHEL 系可以用同样思路解 RPM：`rpm2cpio xxx.rpm | cpio -idm --to-std` 后
把 `usr/bin/Xvfb` 布局到 `x11/usr/bin/` 即可。

### 如果依赖库也缺失（无 root 且系统没装 X 库）

对缺失的依赖包重复"下载 → `dpkg -x pkg.deb x11/`"即可，
所有解包内容都放在同一个 `x11/` 树下：`x11/usr/lib` 里的 .so 会通过
helper 自动设置的 `LD_LIBRARY_PATH` 优先加载。
依赖闭包可用包索引中的 `Depends:` 字段（或 `apt-cache showpkg`）逐个核对。

### 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| `Missing X server or $DISPLAY` 仍在报 | helper 未能拉起 Xvfb，看 stderr 的 `Xvfb bootstrap failed` 日志；确认 `XVFB_BIN`/默认路径存在且可执行 |
| Xvfb 启动报 `Unrecognized option: -display` | 显示号是**位置参数**：`Xvfb :99 ...`，不是 `Xvfb -display :99` |
| `Error: Cannot open display`（Chromium 侧） | 检查 `ls /tmp/.X99-lock` 是否存在、Xvfb 进程是否还活着 |
| 有真实显示器的机器上想看到窗口 | 不要设置 `DISPLAY` 指向 Xvfb，让 helper 使用宿主机的 X（或临时 `export DISPLAY=:1`） |

## 已知注意事项

- 网页版 UI 与文案可能随 ChatGPT 更新而变化，`helper.mjs` 中的选择器/正则
  （如 "Worked for Xs"、模型选择器逻辑）可能需要随之维护；`dev/` 下的探针脚本可用于排查。
- 无头模式（`CHATGPT_HEADLESS=1`）只有在 Cloudflare 放行 Cookie 恰好延续时才能工作，
  出现 `cf-challenge` 时建议回到有头模式并重新走一次登录。
- `profile/` 含有账号 Cookie，等同登录凭证，请妥善保管、不要提交到版本库或分享。

## License

ISC
