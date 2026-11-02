// Node 侧全局 setup：读取 D1 迁移文件，通过 provide 传给 workerd 内的测试
import { readD1Migrations } from '@cloudflare/vitest-plugin'

/**
 * 读取 migrations 目录下的迁移，注入为 'migrations'（workerd 内用 inject 取出）
 * @param provide vitest 提供的跨环境传值函数
 */
export default async function globalSetup({ provide }: { provide: (key: string, value: unknown) => void }): Promise<void> {
  const migrations = await readD1Migrations('./migrations')
  provide('migrations', migrations)
}
