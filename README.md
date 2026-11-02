# airouter
把多个 OpenAI / Anthropic 格式的中转站聚合成一个统一地址：客户端只需配一个 base_url + 一个自签发的 key，网关负责按模型路由、失败自动切换、跨格式转换（含流式）。功能对标 new-api 的核心，去掉计费等商用功能，跑在 Cloudflare 免费额度内
