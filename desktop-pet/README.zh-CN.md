# Blob Pet 资讯桌宠

一只**透明、始终置顶、可拖动**的 Windows 桌面桌宠，兼任你的**资讯筛子**：

> 定时翻你指定的几个网页 → 只留下你关心的（竞赛 / 招聘 / AI…）→ 抓正文、摘成两句话、标出截止日期 → 一条条摊在桌面上，点一下就在浏览器里打开原文。

不需要任何 API key，不需要登录，不联网上报。默认盯的是中国农业大学校内四站。

![桌宠与摘要面板](docs/showcase.png)

*左：摘要面板（一屏卡片，点一下直达原文）；右：桌宠。图为合成示意图，不是桌面截图；实际运行时面板在你点桌宠时唤出。*

[English](README.md) | 中文

---

## 它做什么

| | |
| --- | --- |
| 🐳 **桌宠本体** | 浮在桌面最上层，左键拖动到任意位置并记住；透明处点击穿透；不抢焦点（`WS_EX_NOACTIVATE`）。 |
| 🔔 **角标** | 右上角红点显示未读条数。 |
| 💬 **气泡** | 抓到新内容时，从桌宠肩头冒出一句话告诉你有几条、最新那条是什么。 |
| 🗂 **摘要面板** | 点桌宠（或右键 → 查看摘要）从侧面滑出，一屏卡片：主题标签、标题、摘要、截止日期、来源、日期、原文链接。 |
| 🕐 **定时抓取** | 默认每 60 分钟看一次；也能随时 F5 / 点 ⟳ 手动刷。 |
| 📋 **粘贴即抓** | 面板顶部输入框贴任意网址 → 立刻抓那一页、摘要、置顶显示。这就是"我指定网页，你筛选总结"的那条路。 |
| 🎨 **换皮肤** | 内置 2 款（奶蛙 / 鲸鱼娘·白米饭），也能把**任意图片**拖进面板当桌宠——自动去背景、裁到主体。 |
| ⚙️ **全部可改** | 站点、主题关键词、额外关键词、刷新间隔都在设置里，存在你自己的机器上。 |

## 30 秒上手

**方式一：直接双击 exe（要发给别人就用这个）**

`dist\BlobPet-2.0.0-portable.exe` —— 免安装，双击即可。首次启动会自解包到 `%TEMP%`，桌宠会晚几秒出现。

**方式二：从源码跑（改代码时用）**

```bash
npm install          # 只有第一次
npm start
```

Windows 上也可以**双击 `start-pet.cmd`**：它绕开 npm 直接起 Electron，不留控制台窗口。

**第一次启动后**：右下角会出现桌宠，约 5 秒后开始首轮抓取（4 个站，约 30 秒），抓到就冒气泡、角标变数字。点一下桌宠看摘要。

退出：**右键桌宠 → 退出桌宠**。

## 交互速查

| 操作 | 结果 |
| --- | --- |
| 左键拖动桌宠 | 移动，松手记住位置 |
| 左键**点**桌宠（不拖） | 开/关摘要面板 |
| 右键桌宠 | 查看摘要 / **换皮肤** / 立即刷新 / 退出 |
| 面板里点卡片 | 浏览器打开原文，并标记已读 |
| 卡片右上角 ✕ | 从列表移除（原文仍在） |
| 面板 `⟳` / `F5` | 立即刷新 |
| 面板 `⚙` → 桌宠皮肤 | 点缩略图即刻换肤；`导入图片…` 或直接把图拖进面板 |
| `Esc` | 收起设置 / 收起面板 |
| 面板底部「全部已读」 | 清零角标 |

## 换皮肤

**内置 2 款**（奶蛙、鲸鱼娘·白米饭），面板 → `⚙` → 桌宠皮肤，点一下立刻换（窗口会按新立绘的宽高比重算，点击穿透的掩码同时重建，不需要重启）。

**用你自己的图**：

- 拖一张图到面板任意位置，或点「导入图片…」；
- 支持 PNG / JPG / WebP / GIF / BMP。**有透明背景的 PNG 直接用**；没有的话会自动判断背景类型再抠图：
  - 白底/摄影棚图 → 亮度泛洪抠白底；
  - 彩色场景（天空、云朵、爱心）→ 按颜色从边缘漫延（魔棒）；
  - 之后再去掉与主体不相连的碎装饰（星星、气泡、爱心）。
  全程在浏览器里用 canvas 完成，不依赖任何图像库；
- 导入的图存在 `%APPDATA%\Blob Pet\skins\` 下，悬停缩略图右上角 ✕ 可删。它和内置皮肤一样可以随时切回。

**做内置皮肤**（开发用）：皮肤就是 `assets/skins/<id>/pet.png` 加一个 `meta.json`（`{"name":"显示名"}`）。从一张立绘到干净的皮肤，这次新增了四个工具，串起来用：

```bash
# 场景背景（浅蓝/云朵/爱心）——按颜色从边缘漫延
node tools/wand.mjs src.png a.png --tol=12 --warm-guard=8
# 去掉和主体不相连的星星、爱心、气泡
node tools/despeckle.mjs a.png b.png --min-ratio=0.01
# 纯白摄影棚背景，用老工具更稳
node tools/matte.mjs src.png b.png
# 桌面宠只有 340 DIP 高，1900px 的图没必要留着
node tools/resize.mjs b.png assets/skins/<id>/pet.png --height=900
```

换色皮肤用 `node tools/recolor.mjs assets/pet.png out.png 205`（HSL 里换色相，保留全部明暗关系）。

每个工具都会顺手写一张 `-preview.png`（洋红底色 = 透明），方便肉眼确认抠图有没有漏。**注意**：`tools/mask.mjs` 和 `assets/sprite-mask.js` 已经不再需要了——掩码现在由渲染进程按当前皮肤实时算（见下）。

## 它在盯什么

默认开启（可在设置里取消勾选或删掉）：

| 站点 | 地址 |
| --- | --- |
| 校网通知公告 | `https://www.cau.edu.cn/tzgg/index.htm` |
| 校园新闻网 | `https://news.cau.edu.cn/` |
| 工学院 | `https://coe.cau.edu.cn/` |
| 本科生院 | `https://jwc.cau.edu.cn/` |

默认关闭、可一键勾上：赛氪（竞赛聚合）、Hacker News。

**加自己的站点**：设置 → 抓取站点 → 填名称和列表页地址 → ＋ → 保存。只要是"列表页上有指向详情页的链接"的普通网页就能用，不要求 RSS。

## 筛选规则（不需要 key 的部分）

1. **候选链接**：从列表页里挑出看起来像文章的链接（32 位十六进制文件名、`/art/2024/…`、`/ttzgnew/…` 等），排除导航、栏目页、PDF、图片。
2. **抓正文**：按页面结构猜正文容器（`div.article`、`TRS_Editor`、`vsb_content`…），用文本密度 + 链接密度打分选最像正文的一块，并剥掉面包屑、浏览量、责任编辑这类样板行。
3. **打分**：
   - 标题命中主题关键词 ×3，正文命中最多 +4；
   - 标题里有「截止 / 报名 / 申报 / 公示」这类可操作词 +2；
   - 正文里出现明确截止日期 +1；
   - 7 天内 +3、30 天内 +2（时效只加分，**不会**让一条零命中的内容进榜）；
   - 低于阈值（默认 3 分）或一个关键词都没命中的，直接丢掉。
4. **去重**：按 URL 归一化 + 标题指纹，同一件事从两个栏目/站点链过来只留一条。
5. **摘要**：纯抽取式——先取首句说明"是什么"，再挑最"可操作"的句子（含截止日期 > 报名条件 > 联系方式），拼成一段；**每一句都原文照抄**，所以永远不会编出假的时间或邮箱。同时单独抽出截止日期和联系方式做成标签。

## 接大模型（可选，默认关）

面板 → 设置 → 摘要引擎：填 OpenAI 兼容的接口地址、模型名、API Key，勾"启用"，点「测试连接」可用后再保存。

- 填了就走模型摘要（`core/llm.js`，会提示"只写原文里的信息"）；**任何失败都自动退回本地规则摘要**，不会因为网络/key 挂了出现空卡片。
- 接口地址留空或 key 留空 = 完全不联网摘要，纯本地。
- Key 只存在 `%APPDATA%\Blob Pet\config.json`，渲染进程永远拿不到（只告诉它"有没有 key"）。

## 数据在哪

```
%APPDATA%\Blob Pet\
  config.json     站点 / 主题 / 间隔 / LLM 设置（每台机器独立）
  digest.json     摘要库（最多 300 条，先丢已读的旧条目）
  pet-state.json  桌宠位置
  pet-diag.log    运行日志：启动、窗口几何、每次抓取的增删与错误、渲染进程面包屑
```

删掉 `digest.json` 或点设置里的「清空摘要」即可重来；删 `pet-state.json` 让桌宠回到右下角。

## 分享给别人

有两种形态，**取决于对方电脑的 Smart App Control 设置**：

| 产物 | 形态 | 什么时候用 |
| --- | --- | --- |
| `dist\BlobPet-2.0.0-portable.exe` | 单文件，96 MB | 对方机器没有强制开启 Smart App Control：双击即用，最省事 |
| `dist\BlobPet-2.0.0-folder\` | 文件夹，369 MB，双击 `start-pet.cmd` | **对方开启了 Smart App Control（强制模式）时只能用它** |

**为什么会有这个区别**：Smart App Control 处于强制模式时，会拦截所有未签名且没有信誉记录的 exe —— 我们自己的 `Blob Pet.exe` 正是这种。但 Chromium/Electron 官方的 `electron.exe` 有有效签名和信誉，能放行。文件夹版就是"用签名版 electron.exe + 我们自己的 `resources\app.asar`"，所以能过。

两条都改的是对方自己机器上的 `%APPDATA%\Blob Pet\config.json`，跟你互不影响。想让别人一开箱就盯你想要的站：改 `core/config.js` 里的 `DEFAULT_SITES` / `DEFAULT_TOPICS` 再打包。

**关于签名**：产物未签名。单文件版可能被 SmartScreen 提示"Windows 已保护你的电脑"（*更多信息 → 仍要运行*）；若被 Smart App Control 直接拦下，就不会有任何提示，只是双击没反应——这就是文件夹版存在的理由。

## 已知限制

- 只对"列表页 → 详情页"结构的普通网页有效；纯 JS 渲染的站点（需要滚动加载才有链接）抓不到。
- 摘要质量是规则级，不是模型级：它擅长"把关键句抄出来"，不擅长"换个说法总结"。想要后者就接 key。
- 站点的 HTML 改版会让正文抽取变差（不会崩，只是变短或抽空）。`node tools/preview-feed.cjs` 可以随时验证。
- 首次打包的 exe 每次启动都要解包到 `%TEMP%`，桌宠会晚几秒出现。

## 换成你自己的立绘

桌宠就是一张 PNG。把 `assets/pet-src.png` 换成你的图，然后重新生成：

```bash
npm run sprite     # 先 tools/matte.mjs，再 tools/mask.mjs
npm start
```

`tools/matte.mjs` 负责抠白底：

1. **严格泛洪**：从画面边界出发，去掉"亮且不饱和"的像素。这样留在**画内部**的亮而不饱和区域（肚子高光、眼白）会保留 —— 因为它们与边界不连通。
2. **阴影专杀**：原图脚下烘焙的柔和阴影，内部很白但被一圈暖灰围住，严格阈值会把它当主体，留下一块不透明白斑。于是第二遍用更松的阈值，**只从画面下方出发**，这样同样偏灰的浅色肚皮不会被误伤。
3. 二值掩码做 1px 模糊重建抗锯齿边，边缘颜色按白底反预乘（去掉白边），最后裁到可见范围。

阈值可用环境变量覆盖：

```bash
MATTE_BRIGHT=210 MATTE_SAT=22 MATTE_SHADOW_SAT=45 npm run matte
```

`tools/mask.mjs` 再生成驱动点击穿透的打包掩码（`assets/sprite-mask.js`）。

## 参数微调

桌宠几何在 `main.js` 顶部：

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `PET_HEIGHT` | `340` | 桌宠高度（DIP），宽度按立绘比例算 |
| `BOB_ROOM` | `12` | 立绘上方透明余量，避免浮动动画切到头 |
| `BUBBLE_WIDTH` | `208` | 桌宠左侧留给气泡的透明条宽度 |
| `EDGE_KEEP` | `56` | 恢复位置时至少留多少像素在屏内 |
| `DRAG_INTERVAL_MS` | `8` | 拖动时重设窗口位置的间隔 |
| `SHOW_FALLBACK_MS` | `1500` | 首帧画不出来时的兜底显示时间 |
| `FIRST_REFRESH_DELAY_MS` | `5000` | 空库时首次抓取的延迟 |
| `BUBBLE_MS` | `9000` | 气泡停留时长 |

抓取与筛选在 `core/config.js`：`intervalMinutes`、`minScore`、`maxAgeDays`、`maxItemsPerSource`、`maxDetailFetches`。

## 实现要点

**桌宠窗口**

- **窗口就是立绘**：无边框透明窗口按立绘尺寸创建，屏幕上唯一可见的就是那张 PNG 加气泡。
- **拖动由主进程驱动**：每 8ms 采样 `screen.getCursorScreenPoint()` 并重设窗口位置，不靠渲染进程的位移增量 —— 窗口移到光标下面也不会跟丢。传给 `setPosition` 的必须是**整数** DIP。
- **点击穿透用实时计算的位掩码**：`file://` 页面把本地图片画进 canvas 会污染画布，`getImageData()` 会抛异常。所以主进程**以 data URL 传立绘**——data URL 不污染画布，渲染进程拿到像素后自己打包 1 bit/像素的掩码（`skinprep.js`），换皮肤时一并重建。`assets/sprite-mask.js` 与 `tools/mask.mjs` 因此退休了，任意图片也就能直接当皮肤。
- **窗口跟着立绘变**：`PET_HEIGHT` 固定为 340 DIP，宽度按立绘宽高比算（过宽则整体缩小），左边另留 `BUBBLE_WIDTH` 给气泡；换肤时以"右下角钉住"的方式改窗口尺寸，再把位置存回状态文件。
- **尺寸守卫**：150% 缩放下每次 `setPosition` 都会让 Windows 连窗口尺寸一起重新取整，越拖越大；`resize` 处理器按回设计尺寸，但在指针捕获期间**和换肤过程中**绝不改几何。

**资讯引擎**（`core/`，纯 Node，无第三方依赖，可单独跑）

- `net.js` 抓取：GBK/GB2312 页面按 header → `<meta>` → `gb18030` 兜底解码；同域名请求强制 900ms 间隔 + 20s 超时 + 一次重试，对院系小服务器友好。
- `html.js` 解析：不引 cheerio/jsdom —— 正则切块 + 文本密度/链接密度打分挑正文；日期优先 `<meta PubDate>`，其次「发布日期：」，最后才从正文找。
- `filter.js` 筛选：主题词命中、时效、可操作词打分；抽取式摘要；截止日期/联系方式抽取；标题指纹去重。
- `pipeline.js` 编排：列表页 → 候选排序 → 只抓没见过的详情页；**全局详情抓取预算按站公平分配**（否则一个候选多的首页会把后面的站饿死）。
- `store.js` 存储：临时文件 + 原子重命名，写到一半崩溃不会留下坏 JSON。
- 所有抓取都在主进程：渲染进程只拿到已经算好的 JSON，没有任何页面内容能在里面执行。

**诊断**

- 桌宠没有 devtools，也没有控制台，所以 `%APPDATA%\Blob Pet\pet-diag.log` 是事后复盘的唯一依据：窗口几何、屏幕缩放、拖动、每次抓取增删与错误、以及渲染进程通过 `pet.log()` 写进来的面包屑。
- 主进程注册了 `uncaughtException` / `unhandledRejection` → **只写日志、不弹框**。弹框会留下一个看不见却永远在跑的进程。

构建过程中踩过的 DPI 与 GDI 坑，另见 [`docs/technical-notes.md`](docs/technical-notes.md)（英文）。

## 常见问题

**看不到桌宠，但 `electron.exe` 在跑。**
看 `%APPDATA%\Blob Pet\pet-diag.log`：请求尺寸 vs 实际尺寸、是否已显示、以及未捕获的异常都在里面。

**拖不动、点它没反应、右键"退出"也没用。**
桌宠窗口是**不可激活**的（`WS_EX_NOACTIVATE`，为了不抢你正在打字的焦点），所以它一旦某种状态卡住，就没有别的入口能救它。自带两条退路：

1. 面板 → `⚙` → 维护 → **退出桌宠**（面板是普通可聚焦窗口，桌宠卡了它还能用）；
2. 右键菜单现在 **20 秒后会自动收起**，不会一直挂在那儿挡住点击。

日志里 `pointerdown` / `ignore true|false` 记录了每一次按下和"点击穿透"翻转，复发时把 `pet-diag.log` 末尾几十行发出来就能定位。

**笔记本风扇转、电耗偏高。**
关掉「⚙ → 桌宠皮肤 → 待机浮动动画」。实测：开着时这个透明置顶窗口约占用 **18% 单核**（每帧重新合成 + 滤镜重绘），关掉后接近 0%。默认是关闭的。

顺带一提，精灵**内部的透明缝隙**（比如手臂和身体之间）现在算作可点击区域，所以点上去不会再穿透到桌面；真正外圈的透明区域仍然穿透。

**桌宠在，但摘要一直是空的。**
先点 ⟳ 手动刷一次，看面板顶部的状态条报什么：
- "列表页 HTTP 403/404" → 站点地址改版，去设置里换成新的列表页；
- "没有新内容" → 列表页上的链接都已经在库里了（正常）；
- 一条候选都没找到 → 该页可能是 JS 渲染的，需要换成静态列表页地址。

命令行排查更直接：

```bash
node tools/preview-feed.cjs --fresh     # 完整跑一遍，逐条打印摘要
node tools/preview-feed.cjs --url <链接> # 只抓这一页
```

**摘要内容太少 / 抓成了导航。**
说明该站正文容器没被识别。到 `core/html.js` 的 `ARTICLE_CONTAINER_RE` 里看是否要加一个 class/id；或者先用 `--url` 复现。

**粘贴中文链接后乱码。**
`core/net.js` 按 header → meta → gb18030 三级降级解码，理论上不会乱码；若遇到，请把该页地址和 `--url` 的输出留着，`charset` 会打印出来。

**双击 exe 没反应、也没有任何错误。**

大概率是 **Smart App Control** 拦了（它在强制模式下拦截未签名 exe，且不弹提示）。确认方法：

```powershell
Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' | Select VerifiedAndReputablePolicyState
# 1 = 强制拦截  2 = 仅评估  0 = 关闭
```

被拦时的系统事件：`Microsoft-Windows-CodeIntegrity/Operational` 里的 **3033 / 3077**，会写明是哪个 exe。三种绕过方式：

1. 用文件夹版 `dist\BlobPet-2.0.0-folder\start-pet.cmd`（复用签名版 electron.exe，不需要改任何安全设置）；
2. 从源码跑 `npm start`（同样不涉及未签名二进制）；
3. 关闭 Smart App Control（设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭）。这是系统级安全选择，关掉后重新开启需要重装系统，请自行权衡。

**`npm install` 卡在 Electron 的 postinstall。**
那一步要下载约 150MB。卡住的话直接手动下载解包：

```bash
npm run fix-electron      # 先试 npmmirror 镜像，再试 GitHub
```

**Windows 弹安全警告说应用被阻止。**
二进制未签名。SmartScreen 选*更多信息 → 仍要运行*；用 `npm start` 从源码跑基本不会遇到。

**桌宠跑了但没联网，或者我压根不想让它联网。**
把设置里所有站点取消勾选、不填 LLM key，它就不再发起任何外部请求（粘贴链接除外）。

## 打包成独立 exe

```bash
npm run dist          # 产出 dist\BlobPet-2.0.0-portable.exe（单文件）
```

`npx` 会自动取回 electron-builder（不是本仓库依赖）。关于这个 exe：

- **首次启动会自解包**：portable 是自解压 NSIS 包装器，先解到 `%TEMP%`，桌宠晚几秒出现。
- 产物**未签名**：SmartScreen / Smart App Control 都可能提示或直接拦截（见"常见问题"里的文件夹版）。
- 已有本地 electron 想跳过下载：`--config.electronDist=node_modules/electron/dist`。
- 构建时要下载 NSIS 辅助包与 Electron 本体；网络受限时设镜像：

  ```
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  ```

**文件夹版（Smart App Control 强制模式下可用）** 的构造很直接：Electron 的签名二进制 + 我们的 asar。

```bash
npx electron-builder --win dir        # 产出 dist\win-unpacked
# 然后把 node_modules\electron\dist\* 复制到目标文件夹，
# 再把 dist\win-unpacked\resources\app.asar 放到该文件夹的 resources\ 下
```

本仓库里已经生成好一份：`dist\BlobPet-2.0.0-folder\`（内含 `start-pet.cmd`）。重新打包后更新它：

```powershell
Copy-Item dist\win-unpacked\resources\app.asar dist\BlobPet-2.0.0-folder\resources\app.asar -Force
```

## 开发工具

| 脚本 | 作用 |
| --- | --- |
| `npm run feed` | 不开界面、完整跑一遍抓取+筛选，逐条打印摘要（调关键词就用这个） |
| `node tools/preview-feed.cjs --fresh` | 同上，先清空预览库 |
| `node tools/preview-feed.cjs --url <链接>` | 只抓一页，验证正文抽取 |
| `node tools/preview-feed.cjs --json` | 输出原始 JSON |
| `npm run sprite` | 由 `assets/pet-src.png` 重新生成 `assets/pet.png`（白底抠图） |
| `tools/wand.mjs` | 场景背景（浅色/彩色）按颜色漫延抠图 |
| `tools/despeckle.mjs` | 删掉与主体不相连的碎块（星星、爱心、气泡、波浪线） |
| `tools/strip-lines.mjs` | 删掉贴着轮廓的细装饰线（只处理紧邻透明处、竖向厚度小的像素） |
| `tools/resize.mjs` | 盒式滤波缩小立绘 |
| `tools/recolor.mjs` | HSL 换色相，生成同款不同色的皮肤 |
| `npm run capture` | DPI 感知地截取桌宠窗口（`BitBlt` + `CAPTUREBLT`，截透明窗口的必要条件） |
| `npm run dragtest` | **干跑**：只报告窗口状态，一个像素都不动 |
| `npm run dragtest -- -Yes` | 注入一次真实鼠标拖动，校验位移精确且尺寸不变。**会接管你的鼠标** |

`.ps1` 都有 `.cmd` 包装器，便于在执行策略禁止脚本的机器上使用。

## 环境要求

| | |
| --- | --- |
| 系统 | Windows 10 / 11（开发与实测：Windows 11 26100，150% 缩放） |
| Node.js | 18 以上（只用于安装、开发与打包，运行时不需要） |
| 磁盘 | `node_modules` 约 400 MB |

macOS / Linux 未测试。

## 许可

[MIT](LICENSE)。
