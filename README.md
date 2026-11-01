# Antigravity Quota Monitor (`agy-quota-monitor`)

专为 Antigravity Desktop 2.0 打造的**模型实时额度监控与等额官方 API 消耗统计插件**（零第三方 npm 依赖）。

## 核心功能

1. **订阅自适应额度看板（Pro / Ultra 自动识别）**：
   - **⚡ Gemini 组**：实时展示 5 小时窗口限额（`gemini-5h`）与每周总额度池（`gemini-weekly`）剩余比例及重置倒计时。
   - **🤖 Claude & GPT 组**：实时展示第三方模型组 5 小时窗口（`3p-5h`）与每周总额度池（`3p-weekly`）剩余比例及重置倒计时。
   - **🎯 Gemini 4 Argon 独立限额自适应**：在 `Google AI Pro` 订阅下自动展示 `gemini-argon-wtu-weekly` 独立周限额卡片；在 `Google AI Ultra` 订阅下（服务端将 Argon 与常规 Gemini 合并计费）自动隐藏重复卡片并将调用量合并展示。
2. **基础模型合并 + 5h / 7d 精确 Token 与等额 API 美元折算**：
   - 直读本地 `~/.gemini/*/conversations/*.db` 的每次请求 Protobuf `gen_metadata`，自动将不同思考强度（`Low` / `Medium` / `High` / `Auto`）归并为基础模型，并自动隐藏近 7 天零调用的模型。
   - 严格区分**未缓存输入**、**Prompt 缓存命中读取**与**含思考输出**三类 Token，按官方 API 单价折算近 5 小时与近 7 天的真实等额 API 账单（美元）。

## 安装方法

将仓库克隆或软链接至 `~/.gemini/config/plugins/agy-quota-monitor`，然后重启一次 Antigravity Desktop 即可自动启用：

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/da-ai-xian-zun/agy-quota-monitor.git ~/.gemini/config/plugins/agy-quota-monitor
```

## 使用方式

- **Desktop 右侧常驻面板**：在右侧 `Overview -> Extensions` 中点击 **额度监控 (Quota)**（或在对话中点击 `sidecar://agy-quota-monitor/quota-pane/` 胶囊），每 10 秒自动刷新。
- **对话内联卡片**：在聊天输入框输入 `/quota-monitor` 直接生成内联额度卡片。
- **独立网页模式**：运行 `node sidecars/quota-pane/main.mjs --standalone 18910` 即可在浏览器访问 `http://127.0.0.1:18910`。
