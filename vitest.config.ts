// 测试配置：跑在 Cloudflare Workers 运行时（workerd）里，D1/绑定与 wrangler 配置一致
// 注：原 @cloudflare/vitest-pool-workers 已更名并重构为 @cloudflare/vitest-plugin（cloudflareTest 插件）
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'

export default defineConfig({
  // Cloudflare Workers 测试插件：读取 wrangler.jsonc（主模块、D1 绑定、cloudflare:test 模块映射）
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    // Node 环境的全局 setup：读取 D1 迁移文件并通过 provide 传给 workerd 内的测试
    globalSetup: ['./test/global-setup.ts'],
  },
})
