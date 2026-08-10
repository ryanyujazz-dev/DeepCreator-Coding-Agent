import {
  Question,
  QuestionAnswer,
  QuestionOption,
  QuestionPrompt,
  QuestionType
} from "../contracts/runtime";

export type NormalizedQuestionPrompt = Omit<QuestionPrompt, "options" | "type"> & {
  options: QuestionOption[];
  type: QuestionType;
};

const questionIdPattern = /^[a-z][a-z0-9_-]{0,31}$/;

export function normalizeQuestionPrompt(prompt: QuestionPrompt): NormalizedQuestionPrompt {
  const legacyOptions = prompt.options?.every((option) => typeof option === "string")
    ? prompt.options as string[]
    : undefined;
  const options = legacyOptions
    ? legacyOptions.map((title, index) => ({ optionId: `option_${index + 1}`, title }))
    : (prompt.options ?? []) as QuestionOption[];
  return {
    ...prompt,
    options,
    placeholder: prompt.placeholder ?? prompt.label,
    type: prompt.type ?? (options.length > 0 ? "single_choice" : "text")
  };
}

export function normalizeQuestionAnswers(question: Question): Record<string, QuestionAnswer> | undefined {
  if (!question.answers) return undefined;
  return Object.fromEntries(question.prompts.map((rawPrompt) => {
    const prompt = normalizeQuestionPrompt(rawPrompt);
    const rawAnswer = question.answers?.[prompt.questionId];
    if (typeof rawAnswer !== "string") return [prompt.questionId, rawAnswer ?? { status: "skipped" }];
    const text = rawAnswer.trim();
    if (!text) return [prompt.questionId, { status: "skipped" }];
    if (prompt.type === "text") {
      return [prompt.questionId, { status: "answered", answer: { kind: "text", text } }];
    }
    const option = prompt.options.find((item) => item.title === text);
    return [prompt.questionId, {
      status: "answered",
      answer: {
        kind: "choice",
        optionIds: option ? [option.optionId] : [],
        ...(option ? {} : { customText: text })
      }
    }];
  }));
}

export function validateQuestionPrompt(prompt: NormalizedQuestionPrompt): string | undefined {
  if (!questionIdPattern.test(prompt.questionId)) return `问题 ID ${prompt.questionId} 格式无效。`;
  if (!prompt.prompt.trim() || prompt.prompt.trim().length > 120) return `问题 ${prompt.questionId} 的内容应为 1 至 120 个字符。`;
  if (prompt.type === "text") {
    if (prompt.options.length > 0 || prompt.minSelections !== undefined || prompt.maxSelections !== undefined) {
      return `文本问题 ${prompt.questionId} 不能声明选项或选择数量。`;
    }
    return undefined;
  }
  if (prompt.options.length < 2 || prompt.options.length > 4) return `问题 ${prompt.questionId} 需要二至四个选项。`;
  const ids = new Set<string>();
  for (const option of prompt.options) {
    if (!questionIdPattern.test(option.optionId) || option.optionId === "other") return `问题 ${prompt.questionId} 的选项 ID ${option.optionId} 格式无效。`;
    if (ids.has(option.optionId)) return `问题 ${prompt.questionId} 的选项 ID 不能重复。`;
    ids.add(option.optionId);
    if (!option.title.trim() || option.title.trim().length > 40) return `问题 ${prompt.questionId} 的选项标题应为 1 至 40 个字符。`;
    if (option.description && option.description.length > 120) return `问题 ${prompt.questionId} 的选项说明不能超过 120 个字符。`;
  }
  const recommended = prompt.options.filter((option) => option.recommended).length;
  if (prompt.type === "single_choice") {
    if (recommended > 1) return `单选问题 ${prompt.questionId} 最多推荐一个选项。`;
    if (prompt.minSelections !== undefined || prompt.maxSelections !== undefined) return `单选问题 ${prompt.questionId} 不能声明选择数量。`;
    return undefined;
  }
  const min = prompt.minSelections ?? 1;
  const max = prompt.maxSelections ?? prompt.options.length + 1;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > prompt.options.length + 1) {
    return `多选问题 ${prompt.questionId} 的选择数量无效。`;
  }
  if (recommended > max) return `多选问题 ${prompt.questionId} 的推荐数量超过最大选择数。`;
  return undefined;
}

export function validateQuestionAnswers(question: Question, answers: Record<string, QuestionAnswer>): string | undefined {
  for (const rawPrompt of question.prompts) {
    const prompt = normalizeQuestionPrompt(rawPrompt);
    const answer = answers[prompt.questionId];
    if (!answer) return `问题 ${prompt.questionId} 缺少答案。`;
    if (answer.status === "skipped") continue;
    if (prompt.type === "text") {
      if (answer.answer.kind !== "text" || !answer.answer.text.trim()) return `问题 ${prompt.questionId} 需要文本答案。`;
      continue;
    }
    if (answer.answer.kind !== "choice") return `问题 ${prompt.questionId} 需要选择答案。`;
    const optionIds = [...new Set(answer.answer.optionIds)];
    if (optionIds.some((optionId) => !prompt.options.some((option) => option.optionId === optionId))) {
      return `问题 ${prompt.questionId} 包含无效选项。`;
    }
    if (question.purpose === "plan_entry" && answer.answer.customText?.trim()) {
      return "进入计划模式确认不接受自定义答案。";
    }
    const customCount = answer.answer.customText?.trim() ? 1 : 0;
    const count = optionIds.length + customCount;
    if (prompt.type === "single_choice" && count !== 1) return `单选问题 ${prompt.questionId} 必须且只能选择一项。`;
    if (prompt.type === "multiple_choice") {
      const min = prompt.minSelections ?? 1;
      const max = prompt.maxSelections ?? prompt.options.length + 1;
      if (count < min || count > max) return `多选问题 ${prompt.questionId} 需要选择 ${min} 至 ${max} 项。`;
    }
  }
  return undefined;
}
