// API key 管理：列表 + 新建（展示完整密钥可复制）+ 启停 + 删除
import { useEffect, useState } from 'react'
import { App, Button, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { ApiKeyRow } from '../../worker/types'
import { createKey, deleteKey, listKeys, toggleKey } from '../api'

/** 新建 key 弹窗表单值 */
interface CreateKeyValues {
  /** 备注名 */
  name: string
}

/**
 * 密钥页组件
 */
export default function KeysPage() {
  const { message } = App.useApp()
  const [rows, setRows] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  /** 新建成功后展示的完整密钥 */
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  /** 刷新列表 */
  const refresh = async () => {
    setLoading(true)
    try {
      setRows(await listKeys())
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

  /** 提交新建 */
  const onCreate = async () => {
    if (!newName.trim()) {
      message.warning('请输入备注名')
      return
    }
    setCreating(true)
    try {
      const row = await createKey(newName.trim())
      setCreateOpen(false)
      setNewName('')
      setCreatedKey(row.key)
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  /** 启停切换 */
  const onToggle = async (row: ApiKeyRow, enabled: boolean) => {
    try {
      await toggleKey(row.id, enabled)
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 删除 */
  const onDelete = async (row: ApiKeyRow) => {
    try {
      await deleteKey(row.id)
      message.success('已删除')
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建密钥
        </Button>
      </div>
      <Table<ApiKeyRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '备注名', dataIndex: 'name' },
          {
            title: '密钥',
            dataIndex: 'key',
            render: (k: string) => (
              <Space>
                <Typography.Text code copyable={{ text: k }}>
                  {k.slice(0, 8)}…{k.slice(-4)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 90,
            render: (v: boolean, row) => <Switch checked={v} onChange={(checked) => onToggle(row, checked)} />,
          },
          { title: '最后使用', dataIndex: 'last_used_at', width: 180, render: (v: string | null) => v ?? '从未使用' },
          { title: '创建时间', dataIndex: 'created_at', width: 180 },
          {
            title: '操作',
            width: 90,
            render: (_, row) => (
              <Popconfirm title={`删除密钥 ${row.name}？使用它的客户端将立即失效。`} onConfirm={() => onDelete(row)}>
                <Button size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />

      {/* 新建弹窗 */}
      <Modal
        title="新建 API key"
        open={createOpen}
        onOk={onCreate}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Input placeholder="备注名（如：我的 ChatGPT-Next-Web）" value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={onCreate} />
      </Modal>

      {/* 新建成功展示完整密钥 */}
      <Modal
        title="密钥已创建"
        open={createdKey !== null}
        onCancel={() => setCreatedKey(null)}
        onOk={() => setCreatedKey(null)}
        okText="我已保存"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <p>请立即复制保存（也可在列表中随时复制）：</p>
        <Typography.Paragraph code copyable={{ text: createdKey ?? '' }} style={{ wordBreak: 'break-all' }}>
          {createdKey}
        </Typography.Paragraph>
        <p>
          <Tag color="orange">注意</Tag>调用时放在 <code>Authorization: Bearer</code> 或 <code>x-api-key</code> 头里。
        </p>
      </Modal>
    </div>
  )
}
