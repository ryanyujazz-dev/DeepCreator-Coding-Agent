import { Session } from "../../shared/contracts/runtime";

export type InteractionMode = "direct" | "agent" | "recovery";

const DIRECT_GREETING = /^(?:你?好|hello|hi|hey|哈喽|嗨|在吗|谢谢|thanks)[呀啊嘛吗！!。.s]*$/i;
const RECOVERY_INTENT = /^(?:请)?(?:继续|接着|重试|恢复|继续工作|接着做|继续做|还是不行|再试一次)(?:\s|[，,。.!！]|$)/i;
const CODE_INTENT = /代码|项目|仓库|文件|目录|git|diff|构建|运行|报错|测试|修复|实现|新增|修改|删除|读取|检查|验证|搜索|执行|安装|启动|部署|优化|重构|npm|pnpm|yarn|react|typescript|runtime|agent|\.\w{1,8}\b|\/[^\s]+/i;
const FOLLOW_UP = /^(?:不对|还是|这个|上面|刚才|继续|接着|开始|下一步|修一下|改一下|再优化|再看看|为什么|怎么办)/i;
const KNOWLEDGE_INTENT = /^(?:什么是|解释一下|介绍一下|讲讲|科普一下|翻译|计算一下|写一段)/i;
const DIRECT_CONVERSATION = /^(?:讲个笑话|聊聊天|陪我聊|你是谁|你会什么|辛苦了|晚安|早安|再见)(?:[呀啊嘛吗呢！!。.\s]*)$/i;
const WORKSPACE_ACTION = /(?:帮我|请|开始|继续|进行|直接|现在)?.{0,12}(?:做|制作|开发|创建|搭建|实现|新增|修改|删除|修复|优化|重构|安装|启动|运行|构建|测试|部署|配置|写入|保存)(?:一下|一个|这个|项目|功能|文件|代码|应用|软件|游戏|网站|服务|工程|环境)?/i;

function sessionHasAgentEvidence(session: Session): boolean {
  return session.runs.some((run) =>
    run.activities.some((activity) => activity.tool) ||
    run.changes.fileCount > 0 ||
    run.tasks.length > 0
  );
}

export function classifyInteraction(prompt: string, session: Session): InteractionMode {
  const normalized = prompt.trim();
  if (DIRECT_GREETING.test(normalized)) return "direct";
  if (DIRECT_CONVERSATION.test(normalized)) return "direct";
  if (RECOVERY_INTENT.test(normalized) && session.runs.length > 0) return "recovery";
  if (CODE_INTENT.test(normalized)) return "agent";
  if (KNOWLEDGE_INTENT.test(normalized)) return "direct";
  if (FOLLOW_UP.test(normalized) && sessionHasAgentEvidence(session)) return "agent";
  if (normalized.length <= 240 && sessionHasAgentEvidence(session)) return "agent";
  return "agent";
}

export function requiresWorkspaceAction(prompt: string): boolean {
  return WORKSPACE_ACTION.test(prompt.trim());
}
