---
name: quota-monitor
description: 实时查看 Gemini 组、Claude/GPT 组及 Pro 账户 Gemini 4 Argon 独立限额（Ultra 自动合并隐藏），并按模型展示 5h 与 7d Token 消耗明细，支持内联卡片与右侧常驻监控面板。当用户输入 /quota-monitor 或询问模型剩余额度、Token 消耗时激活。
---

# Antigravity Quota Monitor (`/quota-monitor`)

当用户输入 `/quota-monitor` 或询问当前模型剩余额度（特别是 Gemini 4 Argon、Claude/GPT 或 Credits 点数）时，按以下步骤提供 **内联 Generative UI 卡片** 与 **右侧常驻监控面板入口**：

## Step 1: 生成实时额度卡片 HTML

从 `<user_information>` 获取当前会话 `Conversation ID` 与 `Artifact Directory Path`，运行插件自带的零依赖采集脚本直接写入当前会话的 Artifact 目录（如果通过 `write_file` 创建 Artifact，请确保带上 `ArtifactMetadata`）：

```bash
CONV_ID="<CURRENT_CONVERSATION_ID>"
SCRIPT_PATH="$HOME/.gemini/config/plugins/agy-quota-monitor/scripts/generate-widget.mjs"
node "$SCRIPT_PATH" --conversation "$CONV_ID" --out "<Artifact Directory Path>/scratch/quota-widget.html"
```

*（若插件安装在工作区 `.agents/plugins/` 或自定义路径下，请将 `SCRIPT_PATH` 替换为当前 `SKILL.md` 所在插件根目录下的 `scripts/generate-widget.mjs`。）*

## Step 2: 写入 Artifact 并内联展示 + 提供侧边栏胶囊链接

1. 读取 `<Artifact Directory Path>/scratch/quota-widget.html` 内容，使用 `write_file` 将其写入 `<Artifact Directory Path>/quota-widget.html`，并设置：
   - `ArtifactMetadata.UserFacing: true`
   - `ArtifactMetadata.RequestFeedback: false`
   - `ArtifactMetadata.Summary`: `"全模型额度与 Gemini 4 Argon 消耗实时快照"`

2. 在回复中内联嵌入卡片，并附上打开右侧常驻实时监控面板的 `sidecar://` 胶囊按钮（前提是插件已启用且重启生效）：

```markdown
<agent-embed src="file:///<Artifact Directory Path>/quota-widget.html"></agent-embed>

打开右侧常驻实时盯盘面板（每 10 秒自动刷新）：[额度监控 (Quota)](sidecar://agy-quota-monitor/quota-pane/)
```

> [!IMPORTANT]
> 侧边栏入口必须使用 `sidecar://agy-quota-monitor/quota-pane/` 协议链接，以便 Antigravity Desktop 渲染为原生一键切换侧边栏的胶囊按钮。
