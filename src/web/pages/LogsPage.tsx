// 失败日志：列表 + 刷新 + 清空
import { useEffect, useState } from 'react'
import { App, Button, Popconfirm, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ClearOutlined } from '@ant-design/icons'
import type { FailureLogRow } from '../../worker/types'
import { clearLogs, listLogs } from '../api'

/**
 * 失败日志页组件
 */
export default function LogsPage() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<FailureLogRow[]>([])
  const [loading, setLoading] = useState(false)

  /** 刷新列表 */
  const refresh = async () => {
    setLoading(true)
    try {
      setRows(await listLogs(200))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 清空日志 */
  const onClear = async () => {
    try {
      await clearLogs()
      message.success('已清空')
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          刷新
        </Button>
        <Popconfirm title="清空全部失败日志？" onConfirm={onClear}>
          <Button icon={<ClearOutlined />} danger>
            清空
          </Button>
        </Popconfirm>
        <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>
          仅记录失败调用，自动保留最近 500 条
        </Typography.Text>
      </div>
      <Table<FailureLogRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: '时间', dataIndex: 'created_at', width: 180 },
          { title: 'key', dataIndex: 'api_key_name', width: 140 },
          { title: '渠道', dataIndex: 'channel_name', width: 160 },
          { title: '模型', dataIndex: 'model', width: 160 },
          { title: '端点', dataIndex: 'endpoint', width: 200, ellipsis: true },
          {
            title: '状态',
            dataIndex: 'status',
            width: 80,
            render: (v: number) => (v === 0 ? <Tag>网络</Tag> : <Tag color={v >= 500 ? 'red' : 'orange'}>{v}</Tag>),
          },
          { title: '错误', dataIndex: 'error', ellipsis: { showTitle: true } },
        ]}
      />
    </div>
  )
}
