import type { AgentRun } from "../shared/agentTypes";

export type {
  AgentEvent,
  AgentRun,
  AgentTask,
  DiffSummary,
  FilePatch,
  RunHUDState,
  RunStreamMessage
} from "../shared/agentTypes";

const runId = "run_ui_reference_001";

export const mockAgentRun: AgentRun = {
  id: runId,
  status: "completed",
  title: "我们要做一个对标 codex 的编程桌面端平台",
  model: "DeepSeek V3",
  elapsed: "6m 43s",
  prompt:
    "我们要做一个对标codex的编程桌面端平台。大模型默认采用deepseek。先拆解一下这个参考界面UI.我们一步一步开始搭建",
  turns: [
    {
      id: "turn_1",
      reasoningSummary:
        "先确认参考界面的信息架构，再读取本地工作区，避免直接凭截图搭一个脱离工程上下文的壳。",
      content:
        "我先把参考界面拆成可实现的几个区域，同时看一下这个工作区里已经有什么项目结构。",
      toolCalls: [
        {
          id: "tool_1",
          name: "filesystem.inspect",
          label: "读取工作区结构",
          status: "completed",
          argumentsSummary: "pwd, ls, rg --files, git status"
        }
      ]
    },
    {
      id: "turn_2",
      reasoningSummary:
        "工作区为空，适合先建纯前端骨架，把 Electron/Tauri 与 DeepSeek API 留到下一步接入。",
      content:
        "工作区目前是空的，截图里的信息量主要集中在左侧会话/项目导航、中间空状态、底部浮动式 prompt composer。",
      toolCalls: [
        {
          id: "tool_2",
          name: "file.patch",
          label: "创建 React/Vite 首屏文件",
          status: "completed",
          argumentsSummary: "package.json, index.html, src/App.tsx, src/styles.css"
        },
        {
          id: "tool_3",
          name: "shell.exec",
          label: "安装依赖",
          status: "completed",
          argumentsSummary: "npm install"
        }
      ]
    },
    {
      id: "turn_3",
      reasoningSummary:
        "构建暴露了 lucide 图标命名差异，依赖审计也提示 Vite 版本风险，需要在同一轮里收敛掉。",
      content:
        "构建发现一个 lucide 图标名不匹配，我会换成当前版本里存在的侧边栏图标，同时升级 Vite 插件链。",
      toolCalls: [
        {
          id: "tool_4",
          name: "file.patch",
          label: "修复图标与 favicon",
          status: "completed",
          argumentsSummary: "PanelLeft 替换 LayoutSidebar，补充内联 favicon"
        },
        {
          id: "tool_5",
          name: "shell.exec",
          label: "构建与审计",
          status: "completed",
          argumentsSummary: "npm run build, npm audit --audit-level=moderate"
        }
      ]
    },
    {
      id: "turn_4",
      reasoningSummary:
        "用真实浏览器检查桌面和窄屏布局，确认固定侧栏、主画布留白、composer 在不同宽度下都能成立。",
      content:
        "我把开发服务器跑起来，用 Playwright 保存桌面和移动端截图，检查比例、间距和截断状态。",
      toolCalls: [
        {
          id: "tool_6",
          name: "browser.screenshot",
          label: "视觉验证",
          status: "completed",
          argumentsSummary: "desktop 1280x720, mobile 390x844"
        }
      ]
    }
  ],
  tasks: [
    {
      agentStatus: "claimed_done",
      displayStatus: "已验证",
      evidenceRefs: ["event_5"],
      id: "task_ui",
      runtimeStatus: "verified",
      title: "搭建首屏 UI"
    },
    {
      agentStatus: "claimed_done",
      displayStatus: "已验证",
      evidenceRefs: ["event_7"],
      id: "task_build",
      runtimeStatus: "verified",
      title: "构建与审计验证"
    }
  ],
  hud: {
    additions: 720,
    changedFiles: 5,
    currentStep: 1,
    currentStepTitle: "已完成首屏搭建",
    deletions: 0,
    status: "completed",
    totalSteps: 1
  },
  diffSummary: {
    additions: 720,
    changedFiles: 5,
    deletions: 0,
    files: [
      { path: ".gitignore", additions: 5, deletions: 0 },
      { path: "index.html", additions: 16, deletions: 0 },
      { path: "package.json", additions: 23, deletions: 0 },
      { path: "src/App.tsx", additions: 279, deletions: 0 },
      { path: "src/styles.css", additions: 397, deletions: 0 }
    ]
  },
  evidence: [
    {
      detail: "npm run build 通过",
      id: "evidence_build",
      kind: "command",
      status: "completed",
      timestamp: "18:20:20",
      title: "生产构建"
    }
  ],
  events: [
    {
      id: "event_1",
      type: "run.started",
      runId,
      sequence: 1,
      timestamp: "18:11:45",
      visibility: "user",
      title: "已开始处理请求",
      body: "创建新的 agent run，并记录用户原始请求。",
      status: "completed"
    },
    {
      id: "event_2",
      type: "model.reasoning.delta",
      runId,
      turnId: "turn_1",
      sequence: 2,
      timestamp: "18:12:04",
      visibility: "user",
      title: "形成界面拆解策略",
      body: "先确认参考图中的功能区，再检查本地工作区是否已有项目结构。",
      status: "completed",
      meta: { tokenSource: "reasoning_content" }
    },
    {
      id: "event_3",
      type: "tool.execution.completed",
      runId,
      turnId: "turn_1",
      sequence: 3,
      timestamp: "18:12:17",
      visibility: "user",
      title: "已列出文件并读取项目状态",
      body: "工作区为空，只存在 git、venv 与缓存目录，适合从前端骨架开始。",
      status: "completed",
      meta: { commandCount: 5, tokenSource: "tool_calls", toolName: "filesystem.inspect" }
    },
    {
      id: "event_4",
      type: "model.content.delta",
      runId,
      turnId: "turn_1",
      sequence: 4,
      timestamp: "18:12:28",
      visibility: "user",
      title: "确定首版范围",
      body: "首版控制在桌面端产品壳：自定义标题栏、固定左侧导航、居中空会话态和底部 composer。",
      status: "completed",
      meta: { tokenSource: "content" }
    },
    {
      id: "event_5",
      type: "file.patch.applied",
      runId,
      turnId: "turn_2",
      sequence: 5,
      timestamp: "18:14:09",
      visibility: "user",
      title: "已创建 7 个项目文件",
      body: "写入 Vite、TypeScript、React 入口、首屏组件和样式文件。",
      status: "completed",
      meta: { fileCount: 7, tokenSource: "tool_calls" }
    },
    {
      id: "event_6",
      type: "tool.execution.completed",
      runId,
      turnId: "turn_2",
      sequence: 6,
      timestamp: "18:16:31",
      visibility: "user",
      title: "已运行 npm install",
      body: "依赖安装完成，发现 Vite 相关安全告警，进入版本修复分支。",
      status: "completed",
      meta: { commandCount: 1, tokenSource: "tool_calls", toolName: "shell.exec" }
    },
    {
      id: "event_7",
      type: "tool.execution.completed",
      runId,
      turnId: "turn_3",
      sequence: 7,
      timestamp: "18:18:22",
      visibility: "user",
      title: "已修复构建与安全审计",
      body: "替换不可用图标，升级 Vite 到无告警版本，并补充 favicon 清理控制台错误。",
      status: "completed",
      meta: { commandCount: 3, tokenSource: "tool_calls" }
    },
    {
      id: "event_8",
      type: "artifact.created",
      runId,
      turnId: "turn_4",
      sequence: 8,
      timestamp: "18:20:44",
      visibility: "user",
      title: "已生成桌面与移动端截图",
      body: "桌面端侧栏与中间 composer 比例成立，移动端隐藏侧栏并保留核心输入区域。",
      status: "completed",
      meta: { tokenSource: "tool_calls", toolName: "browser.screenshot" }
    },
    {
      id: "event_9",
      type: "run.completed",
      runId,
      sequence: 9,
      timestamp: "18:21:12",
      visibility: "user",
      title: "已处理完成",
      body: "首版 React/Vite UI 已可运行，下一步可接桌面壳和 DeepSeek API。",
      status: "completed",
      meta: { tokenSource: "content" }
    }
  ],
  artifacts: [
    {
      id: "artifact_1",
      kind: "url",
      title: "DeepSeeker CodeAgent",
      detail: "本地开发服务",
      href: "http://127.0.0.1:5173/"
    },
    {
      id: "artifact_2",
      kind: "build",
      title: "生产构建",
      detail: "npm run build 通过"
    },
    {
      id: "artifact_3",
      kind: "audit",
      title: "依赖审计",
      detail: "npm audit --audit-level=moderate 为 0 漏洞"
    }
  ],
  patches: [
    { path: ".gitignore", additions: 5, deletions: 0 },
    { path: "index.html", additions: 16, deletions: 0 },
    { path: "package.json", additions: 23, deletions: 0 },
    { path: "src/App.tsx", additions: 279, deletions: 0 },
    { path: "src/styles.css", additions: 397, deletions: 0 }
  ],
  finalAnswer: [
    "已经完成第一步：先拆 UI，再搭了一个可运行的首屏骨架。",
    "参考界面被拆成左侧导航、主工作区、Prompt Composer 和低饱和桌面端视觉风格四个核心层。",
    "项目目前是 React/Vite 首屏 UI，后面可以平滑接 Electron/Tauri、DeepSeek API、会话数据结构和本地项目选择流程。"
  ],
  verification: [
    "npm run build 通过",
    "npm audit --audit-level=moderate 为 0 漏洞",
    "Playwright 完成桌面和移动端截图检查"
  ]
};
