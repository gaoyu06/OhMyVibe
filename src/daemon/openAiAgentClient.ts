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

export class OpenAiAgentClient {
  constructor(private readonly config: ProviderConfig) {}

  async decide(agent: AgentDetails, messages: AgentDecisionMessage[]): Promise<AgentDecision> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || agent.model,
        temperature: this.config.temperature ?? 0.2,
        max_tokens: this.config.maxOutputTokens ?? 4000,
        response_format: { type: "json_object" },
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
        ? content
            .map((item) => (typeof item?.text === "string" ? item.text : ""))
            .join("")
            .trim()
        : "";

    if (!text) {
      throw new Error("OpenAI response content is empty");
    }

    return JSON.parse(text) as AgentDecision;
  }
}
