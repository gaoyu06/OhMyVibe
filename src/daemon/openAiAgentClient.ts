import { AgentDetails, ProviderConfig } from "../shared/types.js";

interface AgentDecisionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentDecision {
  thought: string;
  action:
    | "noop"
    | "create_session"
    | "send_session_instruction"
    | "message_agent"
    | "notify_user"
    | "mark_project_complete";
  actionInput?: Record<string, unknown>;
  stopReason?: string;
  userFacingText?: string;
}

type AgentToolName = AgentDecision["action"];

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      function_call?: {
        name?: string;
        arguments?: string;
      };
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface ResponsesApiResponse {
  output?: Array<{
    id?: string;
    type?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
}

export class OpenAiAgentClient {
  constructor(private readonly config: ProviderConfig) {}

  async decide(agent: AgentDetails, messages: AgentDecisionMessage[]): Promise<AgentDecision> {
    if (this.config.apiFormat === "chat_completions") {
      return this.decideWithChatCompletions(agent, messages);
    }
    return this.decideWithResponses(agent, messages);
  }

  private async decideWithResponses(
    agent: AgentDetails,
    messages: AgentDecisionMessage[],
  ): Promise<AgentDecision> {
    const payload = await this.createResponsesRequest({
      model: this.config.model || agent.model,
      temperature: this.config.temperature ?? 0.2,
      max_output_tokens: this.config.maxOutputTokens ?? 4000,
      input: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      tool_choice: "required",
      tools: buildResponsesDecisionTools(),
    });

    const decision = parseDecisionFromResponsesOutput(payload);
    if (decision) {
      return decision;
    }

    throw new Error("OpenAI responses output did not include a tool call");
  }

  private async decideWithChatCompletions(
    agent: AgentDetails,
    messages: AgentDecisionMessage[],
  ): Promise<AgentDecision> {
    const toolPayload = await this.createChatCompletion({
      model: this.config.model || agent.model,
      temperature: this.config.temperature ?? 0.2,
      max_tokens: this.config.maxOutputTokens ?? 4000,
      messages,
      tool_choice: "required",
      tools: buildChatDecisionTools(),
    });

    const toolDecision = parseDecisionFromToolResponse(toolPayload);
    if (toolDecision) {
      return toolDecision;
    }

    const legacyPayload = await this.createChatCompletion({
      model: this.config.model || agent.model,
      temperature: this.config.temperature ?? 0.2,
      max_tokens: this.config.maxOutputTokens ?? 4000,
      messages,
      function_call: { name: "agent_decide" },
      functions: [buildLegacyDecisionFunction()],
    });

    const legacyDecision = parseDecisionFromLegacyFunctionResponse(legacyPayload);
    if (legacyDecision) {
      return legacyDecision;
    }

    throw new Error("OpenAI chat completions output did not include a tool/function call");
  }

  private async createResponsesRequest(body: Record<string, unknown>): Promise<ResponsesApiResponse> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI responses request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as ResponsesApiResponse;
  }

  private async createChatCompletion(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI chat completions request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  }
}

function isAgentToolName(value: string): value is AgentToolName {
  return (
    value === "noop" ||
    value === "create_session" ||
    value === "send_session_instruction" ||
    value === "message_agent" ||
    value === "notify_user" ||
    value === "mark_project_complete"
  );
}

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  return JSON.parse(value) as Record<string, unknown>;
}

function readMessageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .join("")
    .trim();
}

function readResponsesOutputText(payload: ResponsesApiResponse): string {
  const outputParts = Array.isArray(payload.output)
    ? payload.output
        .flatMap((item) =>
          Array.isArray(item.content)
            ? item.content.map((content) => (typeof content?.text === "string" ? content.text : ""))
            : [],
        )
        .filter(Boolean)
    : [];

  if (outputParts.length) {
    return outputParts.join("").trim();
  }

  return typeof payload.output_text === "string" ? payload.output_text.trim() : "";
}

function omitDecisionMeta(input: Record<string, unknown>): Record<string, unknown> {
  const {
    action: _action,
    thought: _thought,
    stopReason: _stopReason,
    userFacingText: _userFacingText,
    ...rest
  } = input;
  return rest;
}

function parseDecisionFromResponsesOutput(payload: ResponsesApiResponse): AgentDecision | null {
  const toolCall = payload.output?.find((item) => item?.type === "function_call" && typeof item?.name === "string");
  if (!toolCall?.name) {
    return null;
  }

  if (!isAgentToolName(toolCall.name)) {
    throw new Error(`Unsupported agent tool: ${toolCall.name}`);
  }

  const parsedArgs = parseToolArguments(toolCall.arguments);
  return buildDecision(toolCall.name, parsedArgs, readResponsesOutputText(payload));
}

function parseDecisionFromToolResponse(payload: ChatCompletionResponse): AgentDecision | null {
  const message = payload.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];
  if (!toolCall?.function?.name) {
    return null;
  }

  const action = toolCall.function.name as AgentToolName;
  if (!isAgentToolName(action)) {
    throw new Error(`Unsupported agent tool: ${toolCall.function.name}`);
  }

  const parsedArgs = parseToolArguments(toolCall.function.arguments);
  return buildDecision(action, parsedArgs, readMessageText(message?.content));
}

function parseDecisionFromLegacyFunctionResponse(payload: ChatCompletionResponse): AgentDecision | null {
  const message = payload.choices?.[0]?.message;
  const functionCall = message?.function_call;
  if (!functionCall?.name) {
    return null;
  }

  if (functionCall.name === "agent_decide") {
    const parsedArgs = parseToolArguments(functionCall.arguments);
    const action = typeof parsedArgs.action === "string" ? parsedArgs.action : "";
    if (!isAgentToolName(action)) {
      throw new Error(`Unsupported legacy agent action: ${action || functionCall.name}`);
    }
    return buildDecision(action, parsedArgs, readMessageText(message?.content));
  }

  if (!isAgentToolName(functionCall.name)) {
    throw new Error(`Unsupported legacy function call: ${functionCall.name}`);
  }

  const parsedArgs = parseToolArguments(functionCall.arguments);
  return buildDecision(functionCall.name, parsedArgs, readMessageText(message?.content));
}

function buildDecision(
  action: AgentToolName,
  parsedArgs: Record<string, unknown>,
  contentText: string,
): AgentDecision {
  const thought =
    typeof parsedArgs.thought === "string" && parsedArgs.thought.trim()
      ? parsedArgs.thought.trim()
      : contentText;

  const actionInput = omitDecisionMeta(parsedArgs);

  return {
    thought,
    action,
    actionInput: Object.keys(actionInput).length ? actionInput : undefined,
    stopReason:
      typeof parsedArgs.stopReason === "string" && parsedArgs.stopReason.trim()
        ? parsedArgs.stopReason.trim()
        : undefined,
    userFacingText:
      typeof parsedArgs.userFacingText === "string" && parsedArgs.userFacingText.trim()
        ? parsedArgs.userFacingText.trim()
        : undefined,
  };
}

function buildResponsesDecisionTools() {
  return buildDecisionToolSpecs().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function buildChatDecisionTools() {
  return buildDecisionToolSpecs().map((tool) => ({
    type: "function",
    function: tool,
  }));
}

function buildDecisionToolSpecs() {
  return [
    {
      name: "noop",
      description: "Use when no external action should be taken right now.",
      parameters: {
        type: "object",
        properties: commonDecisionProperties(),
        additionalProperties: false,
      },
    },
    {
      name: "create_session",
      description: "Create a new session for the project, optionally with an initial instruction.",
      parameters: {
        type: "object",
        properties: {
          ...commonDecisionProperties(),
          cwd: { type: "string", description: "Working directory for the new session." },
          model: { type: "string", description: "Optional model override." },
          reasoningEffort: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
          },
          sandbox: {
            type: "string",
            enum: ["read-only", "workspace-write", "danger-full-access"],
          },
          approvalPolicy: {
            type: "string",
            enum: ["untrusted", "on-failure", "on-request", "never"],
          },
          instruction: {
            type: "string",
            description: "Optional first instruction to send to the new session immediately after creation.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "send_session_instruction",
      description: "Send an instruction to an existing session.",
      parameters: {
        type: "object",
        properties: {
          ...commonDecisionProperties(),
          sessionId: {
            type: "string",
            description: "Target session id. Optional if this agent already has a bound session.",
          },
          instruction: {
            type: "string",
            description: "Instruction text to send to the target session.",
          },
        },
        required: ["instruction"],
        additionalProperties: false,
      },
    },
    {
      name: "message_agent",
      description: "Send a message to another agent in the same project.",
      parameters: {
        type: "object",
        properties: {
          ...commonDecisionProperties(),
          targetAgentId: { type: "string", description: "Target agent id." },
          text: { type: "string", description: "Message content." },
        },
        required: ["targetAgentId", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "notify_user",
      description: "Create a notification for the user, optionally via email.",
      parameters: {
        type: "object",
        properties: {
          ...commonDecisionProperties(),
          severity: {
            type: "string",
            enum: ["info", "warning", "critical"],
          },
          channel: {
            type: "string",
            enum: ["inbox", "email"],
          },
          subject: { type: "string" },
          body: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "mark_project_complete",
      description: "Mark the project as completed.",
      parameters: {
        type: "object",
        properties: commonDecisionProperties(),
        additionalProperties: false,
      },
    },
  ];
}

function commonDecisionProperties() {
  return {
    thought: {
      type: "string",
      description: "Brief internal reasoning summary for the agent log.",
    },
    stopReason: {
      type: "string",
      description: "Why the agent is stopping or waiting after this action.",
    },
    userFacingText: {
      type: "string",
      description: "Optional concise text that can be surfaced to the user.",
    },
  };
}

function buildLegacyDecisionFunction() {
  return {
    name: "agent_decide",
    description: "Choose the next agent action and provide its arguments.",
    parameters: {
      type: "object",
      properties: {
        ...commonDecisionProperties(),
        action: {
          type: "string",
          enum: [
            "noop",
            "create_session",
            "send_session_instruction",
            "message_agent",
            "notify_user",
            "mark_project_complete",
          ],
        },
        cwd: { type: "string" },
        model: { type: "string" },
        reasoningEffort: {
          type: "string",
          enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
        },
        approvalPolicy: {
          type: "string",
          enum: ["untrusted", "on-failure", "on-request", "never"],
        },
        instruction: { type: "string" },
        sessionId: { type: "string" },
        text: { type: "string" },
        targetAgentId: { type: "string" },
        severity: {
          type: "string",
          enum: ["info", "warning", "critical"],
        },
        channel: {
          type: "string",
          enum: ["inbox", "email"],
        },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}
