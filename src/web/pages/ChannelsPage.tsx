// 渠道管理：列表 + 新建/编辑抽屉 + 连通性测试
import { useEffect, useState } from 'react'
import { App, Button, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { Channel } from '../../worker/types'
import { createChannel, deleteChannel, listChannels, testChannel, updateChannel, type ChannelForm, type TestResult } from '../api'

/** 渠道表单值（model_mapping 用行数组编辑） */
interface ChannelFormValues {
  /** 渠道名 */
  name: string
  /** 上游类型 */
  type: 'openai' | 'anthropic'
  /** 上游地址 */
  base_url: string
  /** 上游密钥 */
  api_key: string
  /** 模型列表（tags 输入） */
  models: string[]
  /** 改名映射行 */
  mappings: Array<{ from: string; to: string }>
  /** 优先级 */
  priority: number
  /** 是否支持上游 /v1/responses */
  supports_responses: boolean
  /** 是否启用 */
  enabled: boolean
}

/**
 * 渠道页组件
 */
export default function ChannelsPage() {
  const { message, modal } = App.useApp()
  const [rows, setRows] = useState<Channel[]>([])
  const [loading, setLoading] = useState(false)
  /** 抽屉开关与编辑目标（null = 新建） */
  const [editing, setEditing] = useState<Channel | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [testing, setTesting] = useState<number | null>(null)
  const [form] = Form.useForm<ChannelFormValues>()
  const watchType = Form.useWatch('type', form)

  /** 刷新列表 */
  const refresh = async () => {
    setLoading(true)
    try {
      setRows(await listChannels())
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

  /** 打开新建抽屉 */
  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ type: 'openai', models: [], mappings: [], priority: 0, supports_responses: false, enabled: true })
    setDrawerOpen(true)
  }

  /** 打开编辑抽屉 */
  const openEdit = (ch: Channel) => {
    setEditing(ch)
    form.setFieldsValue({
      name: ch.name,
      type: ch.type,
      base_url: ch.base_url,
      api_key: ch.api_key,
      models: ch.models,
      mappings: Object.entries(ch.model_mapping).map(([from, to]) => ({ from, to })),
      priority: ch.priority,
      supports_responses: ch.supports_responses,
      enabled: ch.enabled,
    })
    setDrawerOpen(true)
  }

  /** 提交新建/编辑 */
  const onSubmit = async () => {
    const values = await form.validateFields()
    const model_mapping: Record<string, string> = {}
    for (const m of values.mappings ?? []) {
      if (m.from && m.to) model_mapping[m.from] = m.to
    }
    const payload: ChannelForm = {
      name: values.name,
      type: values.type,
      base_url: values.base_url,
      api_key: values.api_key,
      models: values.models,
      model_mapping,
      priority: values.priority ?? 0,
      supports_responses: values.type === 'openai' ? (values.supports_responses ?? false) : false,
      enabled: values.enabled ?? true,
    }
    try {
      if (editing) {
        await updateChannel(editing.id, payload)
        message.success('已保存')
      } else {
        await createChannel(payload)
        message.success('已创建')
      }
      setDrawerOpen(false)
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 连通性测试 */
  const onTest = async (ch: Channel) => {
    setTesting(ch.id)
    try {
      const r: TestResult = await testChannel(ch.id)
      if (r.ok) {
        message.success(`${ch.name}：连通正常（${r.elapsed_ms}ms）`)
      } else {
        modal.error({
          title: `${ch.name}：测试失败（HTTP ${r.status}，${r.elapsed_ms}ms）`,
          content: (
            <div>
              {(r as TestResult & { url?: string }).url && (
                <p style={{ marginBottom: 8 }}>
                  实际请求：<code>{(r as TestResult & { url?: string }).url}</code>
                </p>
              )}
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto' }}>{r.error ?? ''}</pre>
            </div>
          ),
        })
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setTesting(null)
    }
  }

  /** 删除渠道 */
  const onDelete = async (ch: Channel) => {
    try {
      await deleteChannel(ch.id)
      message.success('已删除')
      refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建渠道
        </Button>
      </div>
      <Table<Channel>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '类型',
            dataIndex: 'type',
            width: 110,
            render: (t: string) => <Tag color={t === 'openai' ? 'geekblue' : 'purple'}>{t}</Tag>,
          },
          { title: '地址', dataIndex: 'base_url', ellipsis: true },
          {
            title: 'Responses',
            dataIndex: 'supports_responses',
            width: 90,
            render: (v: boolean, row) => (row.type === 'openai' ? (v ? '透传' : '转 chat') : '—'),
          },
          { title: '优先级', dataIndex: 'priority', width: 80 },
          {
            title: '模型',
            dataIndex: 'models',
            render: (models: string[]) => (
              <>
                {models.map((m) => (
                  <Tag key={m}>{m}</Tag>
                ))}
              </>
            ),
          },
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 80,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '操作',
            width: 220,
            render: (_, row) => (
              <Space>
                <Button size="small" loading={testing === row.id} onClick={() => onTest(row)}>
                  测试
                </Button>
                <Button size="small" onClick={() => openEdit(row)}>
                  编辑
                </Button>
                <Popconfirm title={`删除渠道 ${row.name}？`} onConfirm={() => onDelete(row)}>
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        title={editing ? `编辑渠道：${editing.name}` : '新建渠道'}
        width={480}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Button type="primary" onClick={onSubmit}>
            保存
          </Button>
        }
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：某某中转" />
          </Form.Item>
          <Form.Item name="type" label="上游类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'openai', label: 'OpenAI 格式（/v1/chat/completions）' },
                { value: 'anthropic', label: 'Anthropic 格式（/v1/messages）' },
              ]}
            />
          </Form.Item>
          <Form.Item name="base_url" label="上游地址" rules={[{ required: true, message: '请输入地址' }]}>
            <Input placeholder="https://api.example.com" />
          </Form.Item>
          <Form.Item name="api_key" label="上游密钥" rules={[{ required: true, message: '请输入密钥' }]}>
            <Input.Password placeholder="上游 API key" />
          </Form.Item>
          <Form.Item name="models" label="支持的模型（回车添加，填客户端侧名称）" rules={[{ required: true, message: '至少一个模型' }]}>
            <Select mode="tags" placeholder="如 gpt-4o、claude-3-5-sonnet" open={false} />
          </Form.Item>
          <Form.Item label="模型改名映射（客户端名 → 上游名，可选）">
            <Form.List name="mappings">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} style={{ display: 'flex', marginBottom: 4 }} align="baseline">
                      <Form.Item name={[field.name, 'from']} noStyle>
                        <Input placeholder="客户端模型名" style={{ width: 160 }} />
                      </Form.Item>
                      <span>→</span>
                      <Form.Item name={[field.name, 'to']} noStyle>
                        <Input placeholder="上游模型名" style={{ width: 160 }} />
                      </Form.Item>
                      <Button type="link" size="small" onClick={() => remove(field.name)}>
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Button type="dashed" size="small" onClick={() => add({ from: '', to: '' })} block>
                    添加映射
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
          <Form.Item name="priority" label="优先级（数字越小越先尝试）" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          {watchType === 'openai' && (
            <Form.Item name="supports_responses" label="支持上游 /v1/responses（开启后 R 请求透传，否则转换为 chat 调用）" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}
