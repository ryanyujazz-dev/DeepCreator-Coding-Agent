import {
  ArrowLeft,
  ArrowUp,
  ArrowRight,
  AtSign,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Clock3,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  HardDrive,
  ListChecks,
  Mic,
  Package,
  PanelLeft,
  PencilLine,
  Plus,
  Search,
  ShieldCheck,
  Square,
  TerminalSquare,
  Wrench
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AgentEvent, AgentRun, RunStreamMessage, mockAgentRun } from "./agentRun";

type RuntimeConfig = {
  defaultModel: string;
  hasApiKey: boolean;
};

type Thread = {
  title: string;
  age?: string;
  muted?: boolean;
};

type ProjectGroup = {
  name: string;
  threads: Thread[];
};

const pinnedItems: Thread[] = [
  { title: "DeepSeeker ...", muted: false },
  { title: "暂无对话", muted: true }
];

const projectGroups: ProjectGroup[] = [
  {
    name: "OpenHarmo...",
    threads: [
      { title: "JamMate", age: "3个月" },
      { title: "JamMate伴奏引...", age: "3个月" },
      { title: "检查 George buil...", age: "3个月" }
    ]
  },
  {
    name: "鸿蒙应用开发",
    threads: [{ title: "解压文件夹中jam...", age: "3个月" }]
  },
  {
    name: "InspirationH...",
    threads: [
      { title: "Spider_XHS-...", age: "3个月" },
      { title: "小红书半自动...", age: "3个月" },
      { title: "分析这个文件夹里...", age: "3个月" }
    ]
  },
  {
    name: "MyClaw",
    threads: [
      { title: "推荐团队所需MC...", age: "3个月" },
      { title: "部署最强大的ope...", age: "3个月" }
    ]
  },
  {
    name: "20260314ge...",
    threads: [
      { title: "整合 Gemini 前后...", age: "3个月" },
      { title: "双击放大的区域现...", age: "3个月" },
      { title: "Update only proj...", age: "3个月" },
      { title: "检查seedream生...", age: "3个月" }
    ]
  },
  {
    name: "mutiagents",
    threads: [{ title: "制定多agent项目...", age: "3个月" }]
  },
  {
    name: "YuClaw",
    threads: [
      { title: "Refuse deployme...", age: "3个月" },
      { title: "添加 OpenClaw T...", age: "3个月" },
      { title: "更新 OpenClaw ...", age: "3个月" }
    ]
  },
  {
    name: "20260305",
    threads: [
      { title: "创建 gemini UI 版...", age: "3个月" },
      { title: "Build React Next ...", age: "3个月" },
      { title: "总工", age: "3个月" },
      { title: "Review project c...", age: "4个月" },
      { title: "前端开发师", age: "4个月" }
    ]
  },
  {
    name: "ArchMotion",
    threads: [{ title: "创建网站一步做...", age: "4个月" }]
  }
];

const topNav = [
  { label: "新对话", icon: PencilLine },
  { label: "搜索", icon: Search },
  { label: "已安排", icon: CircleGauge },
  { label: "插件", icon: AtSign }
];

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <button className="icon-button" aria-label="切换侧边栏">
          <PanelLeft size={14} />
        </button>
        <div className="history-buttons">
          <button className="icon-button" aria-label="返回">
            <ArrowLeft size={14} />
          </button>
          <button className="icon-button faded" aria-label="前进">
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      <nav className="primary-nav" aria-label="主导航">
        {topNav.map((item) => (
          <button className="nav-row" key={item.label}>
            <item.icon size={16} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-content">
        <section className="sidebar-section">
          <h2>置顶</h2>
          <div className="project-title">
            <Bot size={15} />
            <span>{pinnedItems[0].title}</span>
          </div>
          <button className="thread-row muted">
            <span>{pinnedItems[1].title}</span>
          </button>
        </section>

        <section className="sidebar-section project-list">
          <h2>项目</h2>
          {projectGroups.map((group) => (
            <div className="project-group" key={group.name}>
              <div className="project-title">
                <Package size={15} />
                <span>{group.name}</span>
              </div>
              {group.threads.map((thread) => (
                <button className="thread-row" key={`${group.name}-${thread.title}`}>
                  <span>{thread.title}</span>
                  {thread.age && <time>{thread.age}</time>}
                </button>
              ))}
            </div>
          ))}
        </section>
      </div>

      <div className="account-strip">
        <div className="avatar">RG</div>
        <div>
          <strong>Ryan George</strong>
          <span>Plus</span>
        </div>
      </div>
    </aside>
  );
}

function WindowActions() {
  return (
    <div className="window-actions" aria-label="窗口操作">
      <button className="icon-button" aria-label="最小化">
        <Square size={12} />
      </button>
      <button className="icon-button" aria-label="最大化">
        <Square size={12} />
      </button>
    </div>
  );
}

function PromptComposer({
  disabled = false,
  isRunning = false,
  modelLabel = "DeepSeek V3",
  onCancel,
  onSubmit,
  placeholder = "随心输入"
}: {
  disabled?: boolean;
  isRunning?: boolean;
  modelLabel?: string;
  onCancel?: () => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || disabled || isRunning) return;
    onSubmit?.(value);
    setDraft("");
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        aria-label="输入任务"
        disabled={disabled || isRunning}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        value={draft}
      />
      <div className="composer-row">
        <div className="composer-left">
          <button className="plain-icon" type="button" aria-label="添加上下文">
            <Plus size={20} />
          </button>
          <button className="access-button" type="button">
            <ShieldCheck size={15} />
            <span>完全访问</span>
            <ChevronDown size={13} />
          </button>
        </div>
        <div className="composer-right">
          <button className="model-button" type="button">
            <span>{modelLabel}</span>
            <ChevronDown size={13} />
          </button>
          <button className="plain-icon" type="button" aria-label="语音输入">
            <Mic size={16} />
          </button>
          {isRunning ? (
            <button className="send-button stop-button" onClick={onCancel} type="button" aria-label="停止">
              <Square size={14} />
            </button>
          ) : (
            <button className="send-button" disabled={disabled} type="submit" aria-label="发送">
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="context-row">
        <button type="button">
          <FolderGit2 size={14} />
          <span>DeepSeeker CodeAgent</span>
        </button>
        <button type="button">
          <HardDrive size={14} />
          <span>本地模式</span>
          <ChevronDown size={12} />
        </button>
        <button type="button">
          <GitBranch size={14} />
          <span>main</span>
          <ChevronDown size={12} />
        </button>
      </div>
    </form>
  );
}

function EventIcon({ event }: { event: AgentEvent }) {
  if (event.type === "model.reasoning.delta") {
    return <Clock3 size={15} />;
  }

  if (event.type === "file.patch.applied") {
    return <FileCode2 size={15} />;
  }

  if (event.type === "artifact.created") {
    return <ExternalLink size={15} />;
  }

  if (event.type.includes("tool")) {
    return <Wrench size={15} />;
  }

  return <CheckCircle2 size={15} />;
}

function RunStatusPill({
  run,
  isLive,
  isExpanded,
  onToggle
}: {
  run: AgentRun;
  isLive: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      aria-expanded={isExpanded}
      className={`run-status-pill ${isLive ? "is-live" : ""} ${isExpanded ? "is-expanded" : ""}`}
      onClick={onToggle}
      type="button"
    >
      <span>{isLive ? "处理中" : "已处理"}</span>
      <span>{run.elapsed}</span>
      <ChevronDown size={13} />
    </button>
  );
}

function TimelineEvent({ event }: { event: AgentEvent }) {
  return (
    <article className={`timeline-event event-${event.type.replace(/\./g, "-")}`}>
      <div className="timeline-meta">
        <span className="timeline-icon">
          <EventIcon event={event} />
        </span>
        <span>{event.title}</span>
        {event.meta?.commandCount && <span>{event.meta.commandCount} 条命令</span>}
        {event.meta?.fileCount && <span>{event.meta.fileCount} 个文件</span>}
      </div>
      {event.body && <p>{event.body}</p>}
    </article>
  );
}

function ActiveRunView({ run }: { run: AgentRun }) {
  const visibleEvents = run.events.filter((event) => event.type !== "run.started");

  return (
    <div className="run-stream">
      <RunStatusPill run={run} isLive />
      <div className="reconnect-row">
        <span>正在重新连接</span>
        <strong>5/5</strong>
      </div>
      {visibleEvents.slice(1).map((event) => (
        <TimelineEvent event={event} key={event.id} />
      ))}
      <div className="live-thinking">
        <span />
        <p>
          DeepSeek 当前轮正在把 <code>reasoning_content</code> 收敛成用户可读摘要，
          并等待工具流返回后继续生成 <code>content</code>。
        </p>
      </div>
    </div>
  );
}

function PatchSummary({ run }: { run: AgentRun }) {
  const totalAdditions = run.patches.reduce((sum, patch) => sum + patch.additions, 0);
  const totalDeletions = run.patches.reduce((sum, patch) => sum + patch.deletions, 0);
  const visiblePatches = run.patches.slice(0, 4);
  const hiddenFileCount = Math.max(0, run.patches.length - visiblePatches.length);

  if (run.patches.length === 0) {
    return null;
  }

  return (
    <section className="patch-card">
      <header>
        <div>
          <ListChecks size={18} />
          <strong>已编辑 {run.patches.length} 个文件</strong>
          <span>
            +{totalAdditions} -{totalDeletions}
          </span>
        </div>
        <div className="patch-actions">
          <button type="button">撤销</button>
          <button type="button">审核</button>
        </div>
      </header>
      <div className="patch-list">
        {visiblePatches.map((patch) => (
          <div className="patch-row" key={patch.path}>
            <span>{patch.path}</span>
            <strong>
              +{patch.additions} -{patch.deletions}
            </strong>
          </div>
        ))}
      </div>
      {hiddenFileCount > 0 && (
        <button className="show-more-files" type="button">
          再显示 {hiddenFileCount} 个文件
          <ChevronDown size={13} />
        </button>
      )}
    </section>
  );
}

function ArtifactCards({ run }: { run: AgentRun }) {
  const primaryArtifacts = run.artifacts.filter((artifact) => artifact.kind === "url");

  if (primaryArtifacts.length === 0) {
    return null;
  }

  return (
    <div className="artifact-list">
      {primaryArtifacts.map((artifact) => (
        <article className="artifact-card" key={artifact.id}>
          <div className="artifact-icon">
            {artifact.kind === "url" ? <TerminalSquare size={18} /> : <CheckCircle2 size={18} />}
          </div>
          <div>
            <strong>{artifact.title}</strong>
            <span>{artifact.detail}</span>
          </div>
          {artifact.href && (
            <a href={artifact.href} target="_blank" rel="noreferrer">
              打开方式
              <ChevronDown size={13} />
            </a>
          )}
        </article>
      ))}
    </div>
  );
}

function CompletedRunView({ run }: { run: AgentRun }) {
  const [isTimelineOpen, setIsTimelineOpen] = useState(false);

  return (
    <div className="run-stream completed-stream">
      <div className="run-status-group">
        <RunStatusPill
          isExpanded={isTimelineOpen}
          isLive={false}
          onToggle={() => setIsTimelineOpen((open) => !open)}
          run={run}
        />
        {isTimelineOpen && (
          <section className="status-timeline" aria-label="完整处理过程">
            {run.events.slice(1).map((event) => (
              <TimelineEvent event={event} key={event.id} />
            ))}
          </section>
        )}
      </div>
      <section className="final-answer">
        {run.finalAnswer.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {run.verification.length > 0 && (
          <div className="final-list">
            <strong>已验证：</strong>
            <ul>
              {run.verification.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <ArtifactCards run={run} />
      <PatchSummary run={run} />
    </div>
  );
}

function UserTurn({ run }: { run: AgentRun }) {
  return (
    <section className="user-turn">
      <div className="image-placeholder">···</div>
      <p>{run.prompt}</p>
    </section>
  );
}

function ThreadHeader({
  run,
  mode,
  setMode
}: {
  run: AgentRun;
  mode: "running" | "completed";
  setMode: (mode: "running" | "completed") => void;
}) {
  return (
    <header className="thread-header">
      <div className="thread-title">
        <TerminalSquare size={16} />
        <span>{run.title}</span>
        <ChevronDown size={14} />
      </div>
      <div className="view-switcher" aria-label="运行状态视图">
        <button
          className={mode === "running" ? "active" : ""}
          type="button"
          onClick={() => setMode("running")}
        >
          运行中
        </button>
        <button
          className={mode === "completed" ? "active" : ""}
          type="button"
          onClick={() => setMode("completed")}
        >
          完成后
        </button>
      </div>
    </header>
  );
}

function ComposerRunHUD({ run }: { run: AgentRun }) {
  const showHUD = run.status === "running" || run.status === "completed" || run.status === "failed";

  if (!showHUD) {
    return null;
  }

  return (
    <div className={`composer-hud is-${run.hud.status}`}>
      <span>
        第 {run.hud.currentStep} / {run.hud.totalSteps} 步
      </span>
      <strong>{run.hud.currentStepTitle}</strong>
      <span>
        {run.hud.changedFiles} 个文件已更改
        <b> +{run.hud.additions}</b>
        <i> -{run.hud.deletions}</i>
      </span>
    </div>
  );
}

function RuntimeModeNotice({ config }: { config: RuntimeConfig | null }) {
  if (!config || config.hasApiKey) {
    return null;
  }

  return (
    <div className="composer-notice">
      未配置 DeepSeek Key，当前使用 <strong>mock-agent</strong> 离线成功链路
    </div>
  );
}

function ConversationWorkspace() {
  const [mode, setMode] = useState<"running" | "completed">("running");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<AgentRun | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fallbackRun = useMemo(() => mockAgentRun, []);
  const run = liveRun ?? fallbackRun;
  const selectedModel = runtimeConfig?.hasApiKey
    ? runtimeConfig.defaultModel
    : runtimeConfig
      ? "mock-agent"
      : "deepseek-chat";

  useEffect(() => {
    fetch("/api/config")
      .then((response) => {
        if (!response.ok) throw new Error("runtime config unavailable");
        return response.json() as Promise<RuntimeConfig>;
      })
      .then(setRuntimeConfig)
      .catch(() => {
        setRuntimeConfig({
          defaultModel: "deepseek-chat",
          hasApiKey: false
        });
      });
  }, []);

  useEffect(() => {
    if (!liveRunId) return;

    const eventSource = new EventSource(`/api/runs/${liveRunId}/events`);

    eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data) as RunStreamMessage;
      if (message.type === "snapshot") {
        setLiveRun(message.run);
        if (
          message.run.status === "completed" ||
          message.run.status === "failed" ||
          message.run.status === "cancelled"
        ) {
          setMode("completed");
        }
      }
    };

    eventSource.onerror = () => {
      setSubmitError("无法连接本地 Agent Runtime。请确认 npm run dev:runtime 已启动。");
      eventSource.close();
    };

    return () => eventSource.close();
  }, [liveRunId]);

  async function startRun(prompt: string) {
    setSubmitError(null);
    setMode("running");
    try {
      const response = await fetch("/api/runs", {
        body: JSON.stringify({
          model: selectedModel,
          prompt
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const payload = (await response.json()) as { run: AgentRun };
      setLiveRun(payload.run);
      setLiveRunId(payload.run.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelRun() {
    if (!liveRunId) return;
    try {
      await fetch(`/api/runs/${liveRunId}/cancel`, {
        method: "POST"
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="workspace conversation-workspace">
      <WindowActions />
      <ThreadHeader mode={mode} run={run} setMode={setMode} />
      <section className="conversation-scroll" aria-label="Agent 处理进程">
        <div className="conversation-column">
          <UserTurn run={run} />
          {mode === "running" ? <ActiveRunView run={run} /> : <CompletedRunView run={run} />}
        </div>
      </section>
      <div className="composer-dock">
        <ComposerRunHUD run={run} />
        <RuntimeModeNotice config={runtimeConfig} />
        {submitError && <div className="composer-error">{submitError}</div>}
        <PromptComposer
          disabled={false}
          isRunning={run.status === "running"}
          modelLabel={liveRun ? run.model : selectedModel}
          onCancel={cancelRun}
          onSubmit={startRun}
          placeholder={run.status === "running" ? "Agent 正在处理" : "要求后续变更"}
        />
      </div>
    </main>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <ConversationWorkspace />
    </div>
  );
}
