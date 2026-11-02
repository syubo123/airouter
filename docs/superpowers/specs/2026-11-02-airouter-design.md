# airouter 设计文档

日期：2026-11-02
状态：已与需求方逐条确认

## 一、意图与背景

需求方手上持有多个 AI 中转站的 key，其中一部分是 OpenAI 格式（`/v1/chat/completions`、`/v1/responses`），一部分是 Anthropic 格式（`/v1/messages`）。现状痛点：

- 客户端工具（ChatGPT-Next-Web、Cherry Studio、Claude Code、Codex 等）各自直连不同中转，地址和 key 分散；
- 某个中转站不稳定时需要手动换配置；
- 有些客户端只会说一种格式，而手头可用的渠道是另一种格式。

目标：做一个自用的 AI 网关（功能对标 new-api 的核心，去掉计费等商用功能），客户端统一用一个地址 + 一个自签发的 key 调用，网关负责按模型路由到上游渠道、失败自动切换、跨格式转换。通过 GitHub 仓库一键部署到 Cloudflare，免费额度内可跑。

## 二、目标

1. **统一入口**：一个域名同时提供网页管理后台和 API。
2. **三种对外 API 格式**：
   - OpenAI Chat Completions：`POST /v1/chat/completions`
   - OpenAI Responses：`POST /v1/responses`
   - Anthropic Messages：`POST /v1/messages`
   - 模型列表：`GET /v1/models`
3. **跨格式转换**：客户端格式与上游渠道格式不一致时自动转换，包括流式（SSE）实时转换。匹配时透传（见"转换与透传"）。
4. **Responses 能力开关**：每条 openai 渠道可标注是否支持 `/v1/responses` 端点（默认不支持）。不支持时，R 格式请求自动转换为 Chat 格式调用上游；支持时原样透传。
5. **Responses 有状态会话**：支持 `store` / `previous_response_id`——网关自管会话状态（存 D1），续接时展开为完整输入再发上游；响应 ID 由网关签发并改写。
6. **失败转移**：渠道报错/超时/限流时自动尝试下一个候选渠道。
7. **渠道管理**：网页后台增删改查渠道，含模型列表、优先级、启用开关、模型改名映射、连通性测试、Responses 能力开关。
8. **API key 管理**：自签发多个 key，可命名、启用/禁用、删除；所有 AI 调用必须带有效 key。
9. **管理员登录**：单管理员账号密码登录后台。
10. **失败日志**：仅记录失败的调用，自动限制保留条数。
11. **一键部署**：GitHub 仓库带 Deploy to Cloudflare 按钮，一键创建 Worker（含前端静态资源）+ D1 数据库。

## 三、非目标与反目标

**非目标**（明确不做）：

- 计费、额度、token 会计、价格管理
- 限流、配额
- 多用户注册与用户体系（只有一个管理员）
- 聊天界面 / playground
- 用量统计报表（成功调用不留痕）
- Responses 的 background 后台模式与 conversation 对象（仅支持 store / previous_response_id 会话续接）

**反目标**（做了就算失败）：

- 依赖 Cloudflare 付费功能或超出免费额度的设计
- 依赖 Node 原生模块、无法跑在 Workers 运行时上的库
- 部署流程超过"点一个按钮 + 填少量配置"
- 管理后台需要手工执行 SQL 或脚本才能初始化

## 四、约束

- **平台**：Cloudflare Workers（含静态资源托管 Static Assets）+ D1（SQLite）。免费计划：10ms CPU/请求、10 万请求/天；网关是 I/O 密集型（等待上游、转发流），CPU 占用小，SSE 转换的计算量也在额度内。
- **运行时**：Workers 运行时 = Web 标准 API（fetch、ReadableStream、Web Crypto、SubtleCrypto 等），不引入 Node 专属 API。
- **存储**：所有持久数据在 D1：管理员凭据、渠道、API key、失败日志。
- **语言**：全 TypeScript。
- **文档与注释**：中文优先；数据模型字段与导出方法必须有中文注释（项目全局规则）。

## 五、已确认的需求决定（需求方拍板）

| 决定 | 内容 |
|---|---|
| 单管理员 | 只有一个管理员账号，无注册功能 |
| key 鉴权 | AI 调用必须带自签发的 key，支持 `Authorization: Bearer` 和 `x-api-key` |
| 失败转移 | 渠道挂了自动切下一个，按优先级 |
| 双向格式转换 | OpenAI（Chat、Responses）↔ Anthropic，含流式 |
| 改名映射 | 每渠道可配"客户端模型名 → 上游模型名"映射 |
| OpenAI 双格式 | 对外同时暴露 `/v1/chat/completions` 和 `/v1/responses` |
| 失败日志 | 只记失败调用，保留最近若干条 |
| Responses 能力开关 | 渠道级开关，默认关；开则 R 请求透传上游 /v1/responses |
| Responses 有状态 | 网关自管 store / previous_response_id 会话状态（存 D1） |
| 超时策略 | 流式首字节 30s；非流式总时长 300s |

## 六、技术选型（我的判断，已告知需求方）

- **后端框架**：Hono（Workers 生态事实标准，路由 + 中间件轻量）。
- **前端**：React 18 + Vite + TypeScript + Ant Design 5（管理后台的表格/表单开箱即用）。构建产物作为 Worker 的静态资源，由同一域名分发。
- **密码存储**：PBKDF2（Web Crypto 实现，Workers 无 bcrypt 原生库），迭代 ≥ 100000，随机盐。
- **会话**：管理员登录后签发 JWT（HS256，Web Crypto 签名），HttpOnly Cookie 携带；密钥首次初始化时随机生成存 D1。
- **key 形态**：`sk-` + 43 位随机 base62，明文存 D1（便于后台随时复制；D1 本身是私有的，且渠道上游 key 也必然明文存储，不改变威胁模型）。
- **单仓库结构**：单根 `package.json`（不用 npm workspaces——Cloudflare Deploy 按钮对 monorepo 支持不完整，单包最稳），目录上分 `src/worker/`（网关与 API）与 `src/web/`（管理后台），根目录放 wrangler 配置与 Deploy 按钮。部署脚本按官方推荐内置 D1 迁移：`"deploy": "npm run db:migrations:apply && wrangler deploy"`。

## 七、架构

```
客户端（OpenAI / Anthropic 格式）
        │  统一地址 https://<worker域名>，带自签发 key
        ▼
┌─────────────────────────────────────────┐
│ Cloudflare Worker                        │
│  /v1/*        → 鉴权 → 路由 → 网关核心    │
│  /admin/api/* → 管理员鉴权 → 管理 API     │
│  其余路径      → 静态资源（React 后台）    │
│                                          │
│  网关核心：                               │
│   1. 按模型名筛选启用渠道 → 按优先级排序   │
│   2. 逐个尝试：格式相同→透传；不同→转换    │
│   3. 失败（网络/408/429/5xx/529）→ 下一个 │
│   4. 流式已开始（首字节已转发）→ 不再切换  │
│   5. 全部失败 → 按客户端格式返回错误       │
│                                          │
│  D1：管理员凭据 / 渠道 / API key / 失败日志│
└─────────────────────────────────────────┘
        │ 转换后的请求（格式适配各上游）
        ▼
多个上游中转渠道（OpenAI 格式 / Anthropic 格式）
```

### 转换与透传矩阵

三种格式家族：OpenAI Chat（C）、OpenAI Responses（R）、Anthropic Messages（A）。

- 客户端格式与上游端点一致（C→C、A→A，及 R→R 且渠道 Responses 开关开启）：**透传**，仅替换模型名（改名映射）、鉴权头和 base_url。保留原请求体其余字段不动（fidelity 最高）。
- **R 格式 + openai 渠道**：按渠道 `supports_responses` 开关——开：透传到上游 `/v1/responses`；关（默认）：转换为 Chat 格式调用上游 `/v1/chat/completions`。
- 跨格式：请求体转换 + 响应转换；流式时做 SSE 事件流转换。转换路径：C↔A、R↔A、C↔R。
- 不认识的字段：转换时丢弃或透传到上游能理解的扩展字段，不报错（尽力而为原则）。

### Responses 有状态会话（网关自管）

- R 格式请求带 `previous_response_id` 时：从 D1 取出该响应存的完整会话 items，**展开为完整 input 后发上游**（发上游的请求不再带 previous_response_id，upstream `store` 置 false——会话状态由网关持有）；ID 不存在返回 404。展开发生在选渠道之前，因此失败转移天然兼容。
- 请求未显式 `store:false` 时：成功后生成网关自己的 `resp_` ID，**改写**响应（流式含各事件中的 response id）返回客户端，并把"展开后的 input + 本次 output"的 items 存入 D1。
- `GET /v1/responses/:id` 返回存储的响应对象（供 SDK retrieve）。
- 保留最近 1000 条会话状态，超出自动清理。

### 失败转移细则

判定为失败、可切下一渠道的情况：

- 网络错误（连不上、DNS、TLS）
- 上游响应 408、425、429
- 上游响应 5xx（含 Anthropic 529 overloaded）
- 等待响应超时：流式请求首字节 30s；非流式请求总时长 300s（非流式上游要等整个补全完成，推理型模型常见超 30s）

不可转移（直接把错误按客户端格式返回）：

- 400 / 401 / 403 / 404 / 422（参数或鉴权问题，换个渠道大概率也一样；但 401/403 视为渠道配置失效，**跳过该渠道继续尝试**——中转 key 失效是常见场景）
- 流式响应已经开始输出后上游中断

每个渠道尝试时记录失败原因；全部渠道失败时，聚合错误信息按客户端格式返回（OpenAI 错误 JSON 结构 / Anthropic 错误 JSON 结构）。

## 八、数据模型（D1 表）

所有字段带中文注释，此处列出字段与用途：

**settings（键值表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | 配置项名（如 session_secret、admin 用户名） |
| value | TEXT | 配置值 |

**channels（渠道表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 渠道 ID，自增 |
| name | TEXT | 渠道显示名称 |
| type | TEXT | 上游格式：`openai` 或 `anthropic` |
| base_url | TEXT | 上游地址（如 `https://api.example.com`） |
| api_key | TEXT | 上游 key |
| models | TEXT | 支持的模型名列表，JSON 数组（客户端侧名称） |
| model_mapping | TEXT | 改名映射，JSON 对象 `{客户端模型名: 上游模型名}` |
| priority | INTEGER | 优先级，数字越小越先尝试，默认 0 |
| supports_responses | INTEGER | 是否支持上游 /v1/responses 端点，1/0，默认 0 |
| enabled | INTEGER | 是否启用，1/0 |
| created_at / updated_at | TEXT | 创建/更新时间 |

**api_keys（API key 表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | key ID，自增 |
| name | TEXT | 备注名 |
| key | TEXT | 完整 key（`sk-` 前缀），唯一 |
| enabled | INTEGER | 是否启用，1/0 |
| last_used_at | TEXT | 最后使用时间 |
| created_at | TEXT | 创建时间 |

**failure_logs（失败日志表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 日志 ID，自增 |
| created_at | TEXT | 时间 |
| api_key_name | TEXT | 使用的 key 备注名 |
| channel_name | TEXT | 尝试的渠道名（多次失败时为聚合值） |
| model | TEXT | 请求的模型 |
| endpoint | TEXT | 客户端格式与路径（如 `openai /v1/chat/completions`） |
| status | INTEGER | 最后一次上游 HTTP 状态 |
| error | TEXT | 错误原因摘要 |

写入失败日志后异步清理：保留最近 500 条（`DELETE FROM failure_logs WHERE id < (SELECT MAX(id)-500 ...)` 的等效实现）。

**responses_state（Responses 有状态会话表）**

| 字段 | 类型 | 说明 |
|---|---|---|
| response_id | TEXT PK | 网关签发的响应 ID（`resp_` 前缀） |
| items | TEXT | 展开后的完整会话 items，JSON 数组（供续接） |
| response_json | TEXT | 完整响应对象（含改写后的 id，供 GET 查询） |
| created_at | TEXT | 创建时间 |

写入后自动清理，保留最近 1000 条。

**管理员凭据**存 settings：`admin_username`、`admin_password_hash`（含盐与算法标识，如 `pbkdf2:100000:salt:hash`）、`session_secret`。

## 九、管理后台（网页）

单页应用（React + Ant Design），页面：

1. **初始化页**：首次访问且未设置管理员时出现，设置管理员用户名 + 密码。
2. **登录页**：用户名密码登录。
3. **仪表盘**：渠道数、key 数、今日失败数（轻量，不做图表）。
4. **渠道管理**：表格 + 新增/编辑抽屉。字段即第八节渠道表字段（含 Responses 能力开关，仅 openai 类型渠道显示）；"测试"按钮对该渠道发一个最小请求（如 1 token 对话）显示成功/失败与耗时。
5. **API key 管理**：表格 + 新增（输入备注名生成 key）/启用禁用/删除，一键复制。
6. **失败日志**：表格，时间/key/渠道/模型/格式/状态/错误，支持清空。

管理 API 挂在 `/admin/api/*`，JWT 鉴权中间件保护；网关 API 挂在 `/v1/*`，key 鉴权中间件保护。两套鉴权完全独立。

## 十、部署（一键）

- 仓库根目录放 `wrangler.jsonc`：主模块 Worker + D1 绑定（deploy 按钮自动创建数据库）+ 静态资源目录（`web/dist`）+ `not_found_handling: "single-page-application"`。
- README 顶部放官方按钮徽章链接 `https://deploy.workers.cloudflare.com/?url=<仓库地址>`，并附中文部署说明。
- 部署后流程：打开域名 → 初始化管理员 → 添加渠道 → 签发 key → 客户端把 base_url 指向 `https://<域名>/v1`（或 `https://<域名>`，Anthropic 客户端注意 `ANTHROPIC_BASE_URL` 用根地址）。
- 本地开发：`wrangler dev` 一条命令起全套（API + 前端构建产物）；前端单独热更新用 `npm run dev -w web` + 代理。

## 十一、留给施工者的决定

以下细节设计不做强制，施工者按合理工程判断处理：

- 六条转换路径的实现方式（两两直接转换 vs 内部中间表示）；建议先做两两转换，C↔A 优先（最常用）。
- SSE 事件转换的具体解析实现（建议手写行缓冲解析器，不引重型依赖）。
- 转换时哪些"锦上添花"字段映射到对端（如 Anthropic 的 system 提示、OpenAI 的 response_format/json mode、Responses 的 reasoning 参数）——核心消息、工具调用、多模态图片必须转换正确，长尾参数尽力而为并在文档标注。
- 管理后台的具体布局与交互细节。
- 测试框架选型（建议 vitest，转换器必须有单元测试）。
- 超时时间的可配置方式（先硬编码 30s 即可）。

## 十二、验收标准

1. Deploy to Cloudflare 按钮从零部署成功，D1 自动创建，打开域名进入初始化页。
2. 添加一个 OpenAI 格式渠道和一个 Anthropic 格式渠道后：
   - 用 curl 以 OpenAI Chat 格式调 `/v1/chat/completions`（流式与非流式）成功；
   - 以 Anthropic 格式调 `/v1/messages`（流式与非流式）成功；
   - 以 Responses 格式调 `/v1/responses` 成功（渠道 Responses 开关关时自动转 Chat 调用上游，开时透传）；
   - 跨格式组合（如 Anthropic 客户端 → OpenAI 渠道）消息内容、工具调用正确；
   - 把首选渠道 base_url 改成无效地址后，请求自动落到次选渠道，客户端无感。
3. Responses 有状态：创建响应返回网关 `resp_` ID；带 `previous_response_id` 的后续请求能正确续接上下文（上游收到的是展开后的完整输入）；`GET /v1/responses/:id` 可取回；不存在的 ID 返回 404。
4. 无 key / 错 key / 禁用 key 返回 401。
5. 失败调用出现在日志页，成功调用不留痕。
6. 非流式长请求（>30s）不被误判失败切渠道。
7. 转换器单元测试通过。
