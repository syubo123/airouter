// 仪表盘：统计卡 + 各客户端接入本网关的说明（带一键复制）
import { useEffect, useState } from 'react'
import { Card, Col, Row, Statistic, Tabs, Typography } from 'antd'
import { AppstoreOutlined, DisconnectOutlined, KeyOutlined } from '@ant-design/icons'
import { getStats } from '../api'

/** 仪表盘统计数据 */
interface Stats {
  /** 渠道数 */
  channels: number
  /** key 数 */
  keys: number
  /** 今日失败数 */
  failures_today: number
}

/** 多行代码块（带一键复制） */
function CodeBlock({ code }: { code: string }) {
  return (
    <Typography.Paragraph
      code
      style={{ display: 'block', background: '#f6f6f6', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', marginBottom: 12 }}
      copyable={{ text: code, tooltips: ['点击复制', '已复制'] }}
    >
      {code}
    </Typography.Paragraph>
  )
}

/**
 * 仪表盘页组件：统计卡 + 客户端接入说明
 */
export default function DashboardPage() {
  // 仪表盘统计数据
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    getStats().then(setStats).catch(() => setStats({ channels: 0, keys: 0, failures_today: 0 }))
  }, [])

  // 网关地址：取当前页面来源（部署域名或本地开发地址）
  const origin = window.location.origin

  /** 通用接入说明（三步走） */
  const overview = (
    <div>
      <p style={{ marginBottom: 8 }}>
        任意客户端只需两样东西：<b>网关地址</b>（下面示例里的地址）＋ 在 <b>「密钥」页创建的 sk- 开头的 key</b>。
      </p>
      <p style={{ marginBottom: 4 }}>
        网关地址：<Typography.Text code copyable={{ tooltips: ['点击复制', '已复制'] }}>{origin}</Typography.Text>
      </p>
      <p style={{ marginBottom: 0 }}>
        鉴权方式：<code>Authorization: Bearer sk-xxx</code> 或 <code>x-api-key: sk-xxx</code>（两种都支持，key 在「密钥」页随时可建/停用）
      </p>
    </div>
  )

  /** OpenAI 兼容客户端 */
  const openaiTab = (
    <div>
      <p>适用于 ChatGPT-Next-Web、Cherry Studio、LobeChat、OpenAI SDK 等一切 OpenAI 格式客户端，把地址配置为：</p>
      <CodeBlock code={`BASE_URL = ${origin}/v1\nAPI_KEY  = sk-你的密钥`} />
      <p>OpenAI SDK（Python）示例：</p>
      <CodeBlock
        code={`from openai import OpenAI
client = OpenAI(base_url="${origin}/v1", api_key="sk-你的密钥")`}
      />
    </div>
  )

  /** Claude Code / Anthropic 客户端 */
  const claudeTab = (
    <div>
      <p>适用于 Claude Code、Anthropic SDK 等一切 Anthropic 格式客户端：</p>
      <CodeBlock code={`export ANTHROPIC_BASE_URL=${origin}\nexport ANTHROPIC_AUTH_TOKEN=sk-你的密钥`} />
      <p style={{ color: '#888', marginBottom: 0 }}>注意 ANTHROPIC_BASE_URL 填根地址（不带 /v1）。网关会自动把 Anthropic 请求转换/路由到对应渠道，含流式与工具调用。</p>
    </div>
  )

  /** Codex / Responses 客户端 */
  const codexTab = (
    <div>
      <p>适用于 Codex、Agents SDK 等 OpenAI Responses 格式客户端：</p>
      <CodeBlock code={`base_url = ${origin}/v1`} />
      <p style={{ color: '#888', marginBottom: 0 }}>支持有状态会话（store / previous_response_id，网关自管，保留最近 1000 条）；不支持 background 后台模式。</p>
    </div>
  )

  /** curl 快速验证 */
  const curlTab = (
    <div>
      <p>快速验证网关是否正常（把模型名换成你渠道里配置的模型）：</p>
      <CodeBlock
        code={`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer sk-你的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"模型名","messages":[{"role":"user","content":"你好"}]}'`}
      />
      <p style={{ marginBottom: 0 }}>三种格式端点：<code>/v1/chat/completions</code>（OpenAI Chat）、<code>/v1/responses</code>（OpenAI Responses）、<code>/v1/messages</code>（Anthropic）；模型列表见 <code>GET /v1/models</code>。</p>
    </div>
  )

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="渠道" value={stats?.channels ?? 0} prefix={<AppstoreOutlined />} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="API key" value={stats?.keys ?? 0} prefix={<KeyOutlined />} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="今日失败调用"
              value={stats?.failures_today ?? 0}
              prefix={<DisconnectOutlined />}
              valueStyle={stats && stats.failures_today > 0 ? { color: '#cf1322' } : undefined}
            />
          </Card>
        </Col>
      </Row>

      <Card title="客户端接入">
        {overview}
        <Tabs
          style={{ marginTop: 8 }}
          items={[
            { key: 'openai', label: 'OpenAI 兼容客户端', children: openaiTab },
            { key: 'claude', label: 'Claude Code / Anthropic', children: claudeTab },
            { key: 'codex', label: 'Codex / Responses', children: codexTab },
            { key: 'curl', label: 'curl 快速验证', children: curlTab },
          ]}
        />
      </Card>
    </div>
  )
}
