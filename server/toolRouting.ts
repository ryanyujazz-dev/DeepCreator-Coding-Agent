import { WorkspaceSessionView } from "../shared/runtimeTypes";

export type InteractionMode = "direct" | "agent" | "recovery";

const DIRECT_GREETING = /^(?:你?好|hello|hi|hey|哈喽|嗨|在吗|谢谢|thanks)[呀啊嘛吗！!。.s]*$/i;
const RECOVERY_INTENT = /^(?:请)?(?:继续|接着|重试|恢复|继续工作|接着做|继续做|还是不行|再试一次)(?:\s|[，,。.!！]|$)/i;
const CODE_INTENT = /代码|项目|仓库|文件|目录|git|diff|构建|运行|报错|测试|修复|实现|新增|修改|删除|读取|检查|验证|搜索|执行|安装|启动|部署|优化|重构|npm|pnpm|yarn|react|typescript|runtime|agent|\.\w{1,8}\b|\/[^\s]+/i;
const FOLLOW_UP = /^(?:不对|还是|这个|上面|刚才|继续|接着|开始|下一步|修一下|改一下|再优化|再看看|为什么|怎么办)/i;
const KNOWLEDGE_INTENT = /^(?:什么是|解释一下|介绍一下|讲讲|科普一下|翻译|计算一下|写一段)/i;
const DIRECT_CONVERSATION = /^(?:讲个笑话|聊聊天|陪我聊|你是谁|你会什么|辛苦了|晚安|早安|再见)(?:[呀啊嘛吗呢！!。.\s]*)$/i;

function sessionHasAgentEvidence(session: WorkspaceSessionView): boolean {
  return session.cycles.some((cycle) =>
    cycle.units.some((unit) => unit.tool) ||
    cycle.workspaceDelta.fileCount > 0 ||
    cycle.plan.length > 0
  );
}

export function classifyInteraction(prompt: string, session: WorkspaceSessionView): InteractionMode {
  const normalized = prompt.trim();
  if (DIRECT_GREETING.test(normalized)) return "direct";
  if (DIRECT_CONVERSATION.test(normalized)) return "direct";
  if (RECOVERY_INTENT.test(normalized) && session.cycles.length > 0) return "recovery";
  if (CODE_INTENT.test(normalized)) return "agent";
  if (KNOWLEDGE_INTENT.test(normalized)) return "direct";
  if (FOLLOW_UP.test(normalized) && sessionHasAgentEvidence(session)) return "agent";
  if (normalized.length <= 240 && sessionHasAgentEvidence(session)) return "agent";
  return "direct";
}
