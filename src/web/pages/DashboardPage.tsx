// 仪表盘：渠道数 / key 数 / 今日失败数 三张统计卡
import { useEffect, useState } from 'react'
import { Card, Col, Row, Statistic } from 'antd'
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

/**
 * 仪表盘页组件
 */
export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    getStats().then(setStats).catch(() => setStats({ channels: 0, keys: 0, failures_today: 0 }))
  }, [])

  return (
    <Row gutter={16}>
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
  )
}
