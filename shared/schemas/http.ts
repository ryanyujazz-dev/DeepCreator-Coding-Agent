const id = { type: "string", minLength: 1 } as const;

export const sessionParamsSchema = {
  params: {
    type: "object",
    properties: { sessionId: id },
    required: ["sessionId"]
  }
} as const;

// POST /api/sessions/:sessionId/checkout —— 切换本地分支。params 取 sessionId,body 取目标分支名。
export const checkoutSchema = {
  params: {
    type: "object",
    properties: { sessionId: id },
    required: ["sessionId"]
  },
  body: {
    type: "object",
    additionalProperties: false,
    properties: { branch: id },
    required: ["branch"]
  }
} as const;

export const runParamsSchema = {
  params: {
    type: "object",
    properties: { runId: id },
    required: ["runId"]
  }
} as const;

export const commandParamsSchema = {
  params: {
    type: "object",
    properties: { commandId: id },
    required: ["commandId"]
  }
} as const;

export const runInputSchema = {
  ...sessionParamsSchema,
  body: {
    type: "object",
    properties: {
      model: id,
      projectRoot: id,
      workspaceKind: { type: "string", enum: ["project", "scratch"] },
      prompt: id,
      accessMode: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] },
      mode: { type: "string", enum: ["work", "plan"] },
      planEntry: { type: "string", enum: ["manual", "suggest", "auto"] },
      sessionId: id
    }
  }
} as const;

export const followUpInputSchema = {
  params: {
    type: "object",
    properties: { sessionId: id },
    required: ["sessionId"]
  },
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      model: id,
      prompt: id,
      accessMode: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] },
      mode: { type: "string", enum: ["work", "plan"] },
      planEntry: { type: "string", enum: ["manual", "suggest", "auto"] }
    },
    required: ["model", "prompt", "accessMode", "mode", "planEntry"]
  }
} as const;

export const followUpParamsSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    properties: { sessionId: id, followUpId: id },
    required: ["sessionId", "followUpId"]
  }
} as const;

export const modeInputSchema = {
  ...sessionParamsSchema,
  body: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["work", "plan"] },
      planEntry: { type: "string", enum: ["manual", "suggest", "auto"] }
    }
  }
} as const;

export const eventQuerySchema = {
  ...sessionParamsSchema,
  querystring: {
    type: "object",
    properties: { afterOffset: { type: "string", pattern: "^\\d+$" } }
  }
} as const;

export const accessInputSchema = {
  ...sessionParamsSchema,
  body: {
    type: "object",
    properties: {
      accessMode: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] }
    },
    required: ["accessMode"]
  }
} as const;

export const approvalInputSchema = {
  params: {
    type: "object",
    properties: { approvalId: id },
    required: ["approvalId"]
  },
  body: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["allow_once", "allow_run", "allow_session", "deny"] }
    },
    required: ["decision"]
  }
} as const;

export const sessionListQuerySchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } }
  }
} as const;

export const sidebarInputSchema = {
  ...sessionParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      archived: { type: "boolean" },
      pinned: { type: "boolean" }
    }
  }
} as const;

export const projectArchiveInputSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: { projectRoot: id },
    required: ["projectRoot"]
  }
} as const;

export const memoryInputSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string", enum: ["preference", "project_fact", "workflow", "known_issue"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      provenance: id,
      statement: id,
      visibility: { type: "string", enum: ["personal", "project"] },
      projectRoot: id,
      expiresAt: id
    },
    required: ["category", "confidence", "provenance", "statement", "visibility"]
  }
} as const;

export const memoryParamsSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    properties: { memoryId: id },
    required: ["memoryId"]
  }
} as const;

export const fileQuerySchema = {
  ...sessionParamsSchema,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { path: id },
    required: ["path"]
  }
} as const;

const planParams = {
  type: "object",
  additionalProperties: false,
  properties: { sessionId: id, planId: id, revision: { type: "string", pattern: "^\\d+$" } },
  required: ["sessionId", "planId", "revision"]
} as const;

export const planRevisionInputSchema = {
  params: planParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: { markdown: id, title: id },
    required: ["markdown", "title"]
  }
} as const;

export const planResolveInputSchema = {
  params: planParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      accessMode: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] },
      comments: { type: "string" },
      decision: { type: "string", enum: ["continue_planning", "start_work", "cancel"] }
    },
    required: ["decision"]
  }
} as const;

export const questionAnswerInputSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    properties: { sessionId: id, interactionId: id },
    required: ["sessionId", "interactionId"]
  },
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      answers: { type: "object", additionalProperties: { type: "string" } }
    },
    required: ["answers"]
  }
} as const;
