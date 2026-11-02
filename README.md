# airouter — 自用 AI 网关

把多个 OpenAI / Anthropic 格式的中转站聚合成一个统一地址：客户端只需配一个 base_url + 一个自签发的 key，网关负责按模型路由、失败自动切换、跨格式转换（含流式）。功能对标 new-api 的核心，去掉计费等商用功能，跑在 Cloudflare 免费额度内。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/syubo123/airouter)

## 功能

- **三种对外 API 格式**：OpenAI Chat（`/v1/chat/completions`）、OpenAI Responses（`/v1/responses`）、Anthropic Messages（`/v1/messages`），外加 `/v1/models`
- **跨格式双向转换**：客户端格式与上游渠道格式不一致时自动转换（含流式 SSE 实时转换）；端点一致时原样透传，保真度最高
- **失败转移**：渠道 5xx / 429 / 超时 / 连不上时自动切下一个候选渠道（按优先级）；渠道 key 失效（401/403）也会跳过该渠道
- **模型改名映射**：每渠道可配"客户端模型名 → 上游模型名"
- **Responses 能力开关**：默认把 `/v1/responses` 请求转换成 Chat 格式调上游（多数中转只有 `/v1/chat/completions`）；渠道确实支持 Responses 时打开开关走透传
- **Responses 有状态会话**：支持 `store` / `previous_response_id`（网关自管状态，存 D1，保留最近 1000 条）；不支持 background 模式与 conversation 对象
- **单管理员后台**：账号密码登录（首次访问初始化），管理渠道 / API key / 失败日志
- **API key 鉴权**：自签发多个 key（`sk-` 前缀），可命名、启停、删除；`Authorization: Bearer` 与 `x-api-key` 两种传法
- **失败日志**：只记录失败的调用（时间 / key / 渠道 / 模型 / 错误），自动保留最近 500 条，成功调用不留痕

**不做**：计费、额度、限流、多用户注册、聊天界面。

## 一键部署

1. 点上面的 **Deploy to Cloudflare** 按钮
2. 授权 Cloudflare 访问该 GitHub 仓库
3. Cloudflare 自动创建 Worker（含前端静态资源）与 D1 数据库（`wrangler.jsonc` 里的 `database_id` 占位值会被自动回填），并自动执行数据库迁移
4. 部署完成后打开 `https://<worker域名>` → 设置管理员用户名密码 → 添加渠道 → 签发 key

## 本地开发

```bash
npm install
npm run dev    # 应用本地 D1 迁移并启动 wrangler dev（http://localhost:8787）
npm test       # 全部测试（跑在 Workers 运行时里）
npm run deploy # 构建 → 远程迁移 → 部署
```

前端热更新开发：另开终端 `npx vite`（Vite 端口 5173，`/v1` 与 `/admin/api` 自动代理到 8787）。

## 客户端接入

设你的域名为 `https://airouter.example.workers.dev`，签发的 key 为 `sk-xxx`。

**OpenAI SDK / ChatGPT-Next-Web / Cherry Studio 等：**

```bash
base_url = https://airouter.example.workers.dev/v1
api_key  = sk-xxx
```

**Anthropic SDK：**

```bash
ANTHROPIC_BASE_URL = https://airouter.example.workers.dev
ANTHROPIC_AUTH_TOKEN = sk-xxx
```

**Claude Code：**

```bash
export ANTHROPIC_BASE_URL=https://airouter.example.workers.dev
export ANTHROPIC_AUTH_TOKEN=sk-xxx
```

**Codex / 其他 Responses 客户端：** base_url 指向 `https://airouter.example.workers.dev/v1`（有状态用法开箱即用）。

## 渠道与路由说明

| 概念 | 说明 |
|---|---|
| 渠道类型 | `openai`（上游为 `/v1/chat/completions`）或 `anthropic`（上游为 `/v1/messages`） |
| 模型路由 | 请求里的模型名匹配渠道的"模型列表"，命中即候选，按优先级从小到大尝试 |
| 改名映射 | 客户端请求 `gpt-4o` → 上游按 `gpt-4o-2024-08-06` 调用（每渠道一对多配置） |
| Responses 开关 | 仅 openai 渠道显示；开 = R 请求透传上游 `/v1/responses`，关 = 自动转成 chat 格式调用 |
| 透传 | 客户端格式与上游端点一致时，请求体除模型名与鉴权外原样转发，未知字段不丢 |
| 失败转移 | 408/425/429/5xx/超时/网络错误 → 换下一个渠道；401/403 → 跳过该渠道；400 等 → 直接返回（换个渠道也一样） |
| 流式中断 | 流式输出一旦开始不再切换渠道，上游中断时以客户端格式优雅收尾 |
| 超时 | 流式首字节 30s；非流式总时长 300s（推理型模型非流式响应慢，不误切） |

## 注意事项

- 全部数据存在 D1（免费额度：每天 500 万行读 / 10 万行写，个人使用绰绰有余）
- Worker 免费额度：每天 10 万请求；网关是 I/O 密集型，CPU 占用远低于限制
- **管理员登录的密码哈希（PBKDF2 10 万次迭代）是本项目里最吃 CPU 的操作**：免费计划单请求 CPU 上限 10ms，部署后请第一时间实测初始化与登录；若报 CPU 超限错误，把 `src/worker/auth/password.ts` 里的 `ITERATIONS` 调低（如 50000）重新部署即可（对应降低暴力破解成本，自用场景可接受）
- 失败日志保留 500 条、Responses 会话状态保留 1000 条，超量自动清理
- 管理后台仅一个管理员账号，没有多用户体系；请使用强密码
- 数据库表由 `migrations/0001_init.sql` 创建（settings / channels / api_keys / failure_logs / responses_state 五张表），部署与本地开发都会自动应用迁移，无需手工执行 SQL
- 长尾参数说明：转换时尽力而为，`tool_choice` 的个别形态、`stream_options.include_usage`（经 Anthropic 上游时 usage 为 0）、`response_format`、reasoning 参数、chat→Responses 方向的 `stop` 会被丢弃；核心消息、工具调用、多模态图片、usage 计量均正确转换

## 验收情况

以下在测试套件（81 个用例，跑在真实 Workers 运行时）中覆盖：

- 三种格式端点 + `/v1/models`（含并集、鉴权 401）
- 跨格式转换：请求 / 非流式响应 / 流式（工具调用、system、多模态图片、max_tokens 补默认、usage、finish_reason 映射）
- 失败转移：500 → 次选、401 跳过、400 直接返回、全失败 502 + 日志、日志自动清理 500 条
- Responses 开关两路、有状态续接展开、id 改写（含流式）、GET 查询、未知 404
- 流式上游中断优雅收尾且不重试；超时可注入配置验证
- SSE 解析边界（跨 chunk 断裂、中文多字节劈开、CRLF、多行 data）

待真实环境验收（需要真实上游 key）：部署按钮全流程、真实中转站的转换兼容性。
