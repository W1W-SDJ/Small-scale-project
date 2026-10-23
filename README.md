# Small-scale-project

一些小而完整的项目合集。每个项目一个子目录，各自带 README，互不依赖。

| 项目 | 一句话 |
| --- | --- |
| [desktop-pet](desktop-pet/) | 桌面资讯筛选桌宠：透明置顶的桌宠形象 + 定时抓取你指定的网页 + 按主题筛选并生成带摘要的卡片，点一下在浏览器打开原文 |

---

## desktop-pet（资讯桌宠）

不是"又一个 RSS 阅读器"：它是一只**浮在桌面最上层的桌宠**，兼职帮你筛资讯。

- **定时抓取**你指定的几个网页（默认是中国农业大学校内四站：校网通知公告、新闻网、工学院、本科生院）；
- **只留你关心的**：按主题关键词打分（竞赛 / 实习招聘 / AI 技术 / 保研招生 / 校内通知），标题命中权重最高，零命中的直接丢弃；
- **摘要不用 API key**：本地规则抽取——先取首句说明"是什么"，再挑含截止日期、报名条件、联系方式的可操作句，**全部原句照抄**，不会编造时间或邮箱；同时也把截止日和联系方式单独抽成标签；
- **点卡片直达原文**：面板一屏卡片（主题标签 / 标题 / 摘要 / 截止日 / 来源 / 日期），点击即用系统浏览器打开；
- **换皮肤**：内置「奶蛙」「鲸鱼娘·白米饭」两款，也支持把任意图片拖进面板当桌宠（自动分辨白底/场景背景，去背景、去装饰、裁边）；
- **可选接大模型**：填任意 OpenAI 兼容接口的地址与 key 即可提升摘要质量；未填或调用失败时自动退回本地规则。

### 技术要点

| | |
| --- | --- |
| 运行时 | Electron 44（无运行时依赖，`npm install` 只装开发依赖） |
| 抓取引擎 | 纯 Node，零第三方依赖：手写 HTML 解析（文本密度挑正文）、GBK/GB18030 编码兜底、按站公平分配抓取预算、标题指纹去重 |
| 桌宠窗口 | 无边框透明置顶、`focusable: false` 不抢焦点、透明像素点击穿透（掩码由渲染进程按当前皮肤实时计算） |
| 打包 | electron-builder，产出免安装文件夹版 + 单文件 portable exe |

### 快速开始

**直接用（Windows）**：从 [Releases](https://github.com/W1W-SDJ/Small-scale-project/releases) 下载免安装包，解压后双击 `start-pet.cmd`。

> 程序未做代码签名。Windows 11 若开启 Smart App Control（强制模式），会静默拦截未签名的单文件 exe —— 所以分发以"文件夹版"为准（其中的 `electron.exe` 来自 Chromium 官方、带有效签名）。细节见 [desktop-pet/README.zh-CN.md](desktop-pet/README.zh-CN.md) 的「常见问题」。

**从源码跑**：

```bash
cd desktop-pet
npm install
npm start
```

### 文档

- 中文完整说明：[desktop-pet/README.zh-CN.md](desktop-pet/README.zh-CN.md)（站点/主题配置、筛选规则、摘要原理、皮肤制作、排错命令）
- English：[desktop-pet/README.md](desktop-pet/README.md)
- 工程笔记（DPI/GDI 坑、Smart App Control 取证、皮肤抠图算法）：[desktop-pet/docs/technical-notes.md](desktop-pet/docs/technical-notes.md)

---

## 仓库结构

```
Small-scale-project/
└── desktop-pet/            # 资讯筛选桌宠（v2.0）
    ├── main.js             # 主进程：桌宠窗口 + 摘要面板 + 定时调度
    ├── renderer.js         # 桌宠渲染：拖动、点击穿透、未读角标、新内容气泡
    ├── panel.js            # 摘要面板：卡片列表、粘贴抓取、设置、换皮肤
    ├── skinprep.js         # 皮肤预处理：抠图、去装饰、裁边、点击穿透掩码
    ├── core/               # 抓取与筛选引擎（纯 Node）
    ├── assets/             # 立绘与皮肤
    ├── tools/              # 抠图/换色/预览/抓取调试等脚本
    └── docs/               # 技术笔记
```

## 约定

- 每个项目一个子目录，自带说明文档；
- 仓库里**不放**依赖和构建产物（`node_modules/`、`dist/`、`*.zip` 已在 `.gitignore` 中排除），二进制请走 Releases；
- 个人运行时数据（`config.json`、`digest.json`、日志）不入库。

## License

各项目自带许可证；[desktop-pet](desktop-pet/) 为 [MIT](desktop-pet/LICENSE)。
