const id = { type: "string", minLength: 1 } as const;

export const sessionParamsSchema = {
  params: {
    type: "object",
    properties: { sessionId: id },
    required: ["sessionId"]
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
      prompt: id,
      accessMode: { type: "string", enum: ["request_approval", "smart_approval", "full_access"] },
      mode: { type: "string", enum: ["work", "plan"] },
      planEntry: { type: "string", enum: ["manual", "suggest", "auto"] },
      sessionId: id
    }
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
