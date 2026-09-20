# dev-rules · Felix 项目开发规则

DSH（DeepSeek Harness）个人插件：把你自己的一套**项目开发规则**交给 DSH，让 agent 在开发项目时自动遵守。

- **面板**：Web GUI **右侧栏**新增「开发规则」页（与「Docker 容器」并列，走 DSH 原生 `sidebarRightTabs` + `sidebar.right.pane.tab` 契约），可视化维护规则（全局 + 按项目）。
- **自动注入**：每个会话组装系统提示时，按该会话的工作目录解析生效规则并注入，无需手工提醒。
- **对话内维护**：另带 `dev_rules` 模型工具，直接说「把这条记进开发规则」也能落库。
- **即时生效**：保存后正在运行的会话下一步就生效，不用重启 DSH。

## 功能

| 能力 | 说明 |
| --- | --- |
| 全局规则 | 对所有会话生效，是「凡项目都适用」的底线约定 |
| 项目规则 | 会话工作目录落在项目路径之下即命中；多个命中时取**路径最长**（最具体）的一个；工作目录走软链时自动用 realpath 再匹配一次 |
| 追加 / 覆盖 | 项目可「追加」（全局 + 本项目）或「覆盖」（只生效本项目规则）；覆盖模式下注入文本会写明被挡掉了多少条全局规则 |
| 分组 | 每条规则可填分组名；面板按分组筛选，注入文本里作为 `### 组` 小标题（不改动规则顺序） |
| 搜索 | 按标题 / 正文 / 分组过滤当前页签（筛选时禁用上移下移，避免顺序错乱） |
| 单条开关 | 每条规则可单独停用（保留内容、不注入）；总开关可整体关闭注入 |
| 删除保护 | 删除规则 / 项目条目需要**二次确认**（3 秒内不确认自动还原） |
| 保存冲突检测 | `/save` 带 `revision`；磁盘被别的会话或手工编辑改过时返回 **409**，面板提示「载入磁盘版本」或「用我的改动覆盖」，不会静默覆盖 |
| 外部改动同步 | 面板在后台按 revision 轮询：没有未保存改动就静默跟上，有改动就明确提示 |
| 备份 | 每次保存前把上一版写到 `dev-rules.json.bak` |
| 导入 / 导出 | 导出 JSON / Markdown；导入 Markdown / JSON（可**替换**或**合并**，按 id 与标题+正文去重） |
| 成本提示 | 注入预览显示字符数与估算 token，并列出最占预算的 5 条规则；每条规则卡片也标 token |
| 注入预览 | 输入任意目录，看该目录下**真正注入**的文本（含未保存修改、命中项目、是否被截断） |
| 上限保护 | 单次注入文本上限 12000 字符，超出在行边界截断并附提示，避免吃光提示预算 |
| `dev_rules` 工具 | action = `list` / `add` / `update` / `remove`，支持 global / project 归属与分组 |
| 接口硬化 | 所有接口校验 `Origin` / `Sec-Fetch-Site`（跨站 403），POST 要求 `Content-Type: application/json`（否则 415） |

没有生效规则时注入空串 —— 等于这个插件「隐身」。

## 安装

本插件是标准的 DSH profile bundle（双半体：宿主 + 浏览器）。在插件目录下：

```sh
# 1) 作为 link 依赖装进 profile（profile 名按实际填写，本机是 web）
dsh plugin --profile web add "link:$PWD"
#    或（pnpm store 不可写时）手工建软链：
#    ln -sfn "$PWD" "$DSH_HOME/profiles/web/node_modules/dev-rules"

# 2) 把 bundle 加进 profile 阵容：编辑 $DSH_HOME/profiles/web/package.json，
#    在 dsh.profile.bundles 数组末尾追加 "dev-rules"，
#    并在 dependencies 里写 "dev-rules": "link:<插件目录>"

# 3) 重启该 profile（右侧栏页面列表里会出现「开发规则」）
```

改动生效范围（**本部署实测**）：

| 改了什么 | 怎么生效 |
| --- | --- |
| 宿主半体 `lib/index.js`、`lib/rules.js` | **重启 profile**（侧边栏底部 ↻） |
| 浏览器半体 `lib/client.js` | 同样是**重启 profile** |

> 为什么客户端改动也要重启：DSH 的 `client-modules` 在**启动时**把每个插件的 client bundle 读进内存（`readFileSync` + 内容哈希当 `rev`），之后只按「已登记的 URL」出字节；文件内容变化要经 HMR watcher 的 `rebuilt(id)` 才会重新登记，而 watcher 只有在源码检出里跑着 `pnpm run dev:web` 时才装得上。本机是安装版部署、没有跑 dev watcher，所以**硬刷新页面拿不到新 bundle**，必须重启一次 profile。

卸载：从 `dsh.profile.bundles` 移除 `dev-rules`、删掉依赖与软链，重启。规则文件会留在 `$DSH_HOME/dev-rules.json`。

## 数据

规则存在 `$DSH_HOME/dev-rules.json`（默认 `~/.dsh/dev-rules.json`），原子写入（临时文件 + rename）；保存前上一版留在 `dev-rules.json.bak`。

> **这份文件属于使用者本人**，不在本仓、不受本仓许可约束（见 `NOTICE.md`）。插件只读写本机这一份文件，不联网、不上传。

```json
{
  "version": 1,
  "enabled": true,
  "global": [
    { "id": "g1", "title": "提交前跑测试", "content": "npm test 必须绿", "group": "提交", "enabled": true }
  ],
  "projects": [
    {
      "id": "p1",
      "path": "/home/felix/项目/foo",
      "label": "示例项目",
      "enabled": true,
      "mode": "append",
      "rules": [
        { "id": "r1", "title": "本项目用 pnpm", "content": "禁止 npm install", "group": "依赖", "enabled": true }
      ]
    }
  ]
}
```

- `mode`：`append`（默认）或 `override`。
- 路径支持 `~`；保存时统一规范化成绝对路径，尾部分隔符会被去掉；Windows 风格路径（`C:\…`）无论宿主平台都按 Windows 规则收敛。
- 目录为空的项目条目不会被保存 —— 面板保存前会提示补全或删除。
- 手工编辑该文件会被宿主自动重载（监听目录 + 15 秒轮询兜底）。

## 面板

位置：**右侧栏**的页面列表里点「开发规则」（与「文件 / 终端 / 浏览器 / Docker 容器」并列），内容在右列打开。

**打开就能用的三步**

1. 面板顶部吸顶条写明「这里是干什么的」+ 当前共几条规则；右侧永远只有一个主动作 **保存并生效**（有改动才可点，`Ctrl/Cmd + S` 同效）。
2. 一条规则都没有时，面板给出两步上手说明 + **「先插入 4 条虚构示例」**（同一目录风格一致 / 依赖升级单独提交 / 配置项集中管理 / 发布前核对版本号），插进来直接改成自己的。
3. 页签只有三个：**全局规则** / **项目规则** / **效果预览**，各自顶部一行说明什么时候该用它。

**日常操作**

- 规则卡片：标题（一句话）→ 正文（具体怎么做）→ 分组（可选）+ 「生效」开关 + 上移下移 + 二次确认删除；卡片只标「约 N 字」（这条规则给每轮对话增加的上下文量）。
- 「效果预览」：选一个目录点「查看」，用大白话告诉你：命中了哪个项目、用了几条规则、全局规则有没有被挡掉、一共多少字 / 约多少 token、是否被截断，下面给出实际注入的原文。
- 顶部「生效中 / 已停用」小胶囊就是总开关（点一下切换），不用去翻设置。
- 冲突与导入都弹**横幅**并给出明确选择：「载入磁盘版本（放弃我的修改）／用我的修改覆盖」、「替换现有规则／合并进来／算了」。
- **更多（折叠）**里是低频功能：导出备份（Markdown / JSON）、从备份导入、放弃修改并重新载入、文件位置、使用说明。
- 搜索与分组筛选只在规则较多（> 6 条）时才出现，避免一上来就堆控件。
- 面板渲染若抛错，会就地显示错误原文（错误边界），而不是整块空白。

## 注入形态

系统提示 section 名 `plugin:dev-rules`（order `100`，紧跟 persona 之后、工具说明之前），正文是**常量** `{{dev_rules_body}}`；真正的规则文本由同名**提示变量**提供。

> 为什么要绕一道变量：DSH 会对 section 正文做严格的 `{{变量}}` 插值，遇到未知 / 畸形引用会直接抛错，而这一步发生在插件回调之外——用户规则里的 `{{placeholder}}` 会把整个模型步打挂。变量值不会被二次扫描，所以用户写什么都不会破坏提示组装。

渲染形如：

```markdown
# 项目开发规则（Felix 项目开发规则）

以下是本机用户维护的开发规则……如有冲突，以后者为准。

适用项目：示例项目（/home/felix/项目/foo）
规则来源：全局规则 + 项目追加规则

## 全局规则
### 提交
1. **提交前跑测试**
   npm test 必须绿

## 项目规则
### 依赖
2. **本项目用 pnpm**
   禁止 npm install
```

项目命中时文本里写明「适用项目 / 规则来源」，未命中时明确写「当前目录未匹配到项目规则集」，覆盖模式写明被挡掉的全局规则条数 —— 避免 agent 误以为规则不存在。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dev-rules/state` | 读当前文档 + 元信息（文件、备份、revision、规模、错误） |
| GET | `/dev-rules/workspaces` | 项目路径下拉的数据源（工作区注册表 + 活动会话目录） |
| POST | `/dev-rules/save` | `{ doc, revision }` 保存；revision 过期 → **409** + 当前文档 |
| POST | `/dev-rules/reload` | 从磁盘重新读取 |
| POST | `/dev-rules/preview` | `{ doc?, path }` 渲染注入文本 + 字符 / token / 逐条体积 |
| POST | `/dev-rules/export` | `{ doc }` → Markdown 与 JSON 文本 |
| POST | `/dev-rules/import` | `{ text }` → 解析 Markdown 或 JSON 得到文档 |

排障示例：`curl -s 127.0.0.1:3080/dev-rules/state | head -c 400`

安全边界：以上接口只接受**同源**请求（跨站 `Origin` / `Sec-Fetch-Site` 直接 403），POST 必须 `Content-Type: application/json`。但同机的其它本地进程仍可无凭据访问（DSH 的 webServer 不对插件路由做登录鉴权）——规则内容会进模型提示，别把不能外发的东西写进去。

## 开发

```sh
node --test     # 24 个用例
npm run check   # 语法检查 + 全部测试
```

- `lib/rules.js` 纯逻辑（规范化 / 路径匹配 / 生效规则 / 渲染 / 分组 / token 估算 / Markdown 往返），宿主、面板与测试共用；路径匹配的 win32 分支通过 platform 参数可测。
- `lib/index.js` 宿主半体：存储、提示变量注入、`/dev-rules/*` 接口、`dev_rules` 工具。
- `lib/client.js` 浏览器半体：手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，只依赖 `react`，不需要打包器；纯函数内部件（token 估算 / 导入合并）通过 `exports.__internal` 暴露给测试。
- 测试：`test/rules.test.mjs`（逻辑）、`test/host.test.mjs`（接口 / 备份 / 409 / 403 / 415 / 软链回退 / 工具）、`test/client.test.mjs`（槽位接线 / 服务晚出现 / 内部件）。
- CI：`.github/workflows/ci.yml` 在 node 20 / 22 / 24 上跑语法检查 + 测试。

## 代码托管

本仓遵循「本地 Forgejo 开发 / GitHub 与 Gitee 对外并受理反馈」的三平台分工（规则第 13 条）：

| 平台 | 角色 | 状态 |
| --- | --- | --- |
| 本地 Forgejo（私有）<http://127.0.0.1:3000/Felix/dev-rules> | **开发主仓**，代码与历史以它为准 | 已建仓并推送（默认分支 `main`） |
| GitHub | 对外窗口 + 反馈受理 | **暂不做**（owner 2026-09-20：后续再说） |
| Gitee | 国内镜像 + 同样受理反馈 | **暂不做**（owner 2026-09-20：后续再说） |

推送走 `127.0.0.1`（回环），凭据由 `.git/git-credential-forgejo` 提供 —— 该 helper **校验 `host=`**，
只对 `127.0.0.1` / `localhost` 应答，其它 host 一律静默退出（防止把本机令牌回给别的平台）。

> **两个仓，一条边界。** 本项目分成两个仓：**本仓只装插件**（开源，MIT）；作者的规则内容、
> 以及廿一的开发约定清单 / 自检脚本 / 还原备份，都在私有仓 **`felix-dev-rules`**（**闭源**），
> 本地路径 `~/项目/felix-dev-rules/`。代码与内容在物理上分开，这条边界就不靠约定去守 —— 详见 [`NOTICE.md`](NOTICE.md)。

## 许可

**代码开源、规则内容闭源**：

| 范围 | 许可 |
| --- | --- |
| 本仓源代码（`lib/`、`test/` 等） | **MIT**（见 `LICENSE`） |
| 本仓内的示例规则 | 随代码 MIT —— **全部虚构**，不是作者的真实规则 |
| 作者本人的规则内容 | **不开源，也不在本仓**：只存在于作者本机的 `~/.dsh/dev-rules.json` |
| 使用者自己的规则内容 | 归使用者所有，与本项目许可无关 |

范围与边界见 [`NOTICE.md`](NOTICE.md)。
