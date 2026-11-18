/**
 * kie.ai GPT-5.4 API client
 * Endpoint: POST https://api.kie.ai/codex/v1/responses
 * Model: gpt-5-4
 */

const KIE_API_URL = "https://api.kie.ai/codex/v1/responses";

interface KieMessage {
  role: "user" | "assistant";
  content: string;
}

interface KieResponse {
  output: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text: string }>;
    status?: string;
  }>;
  usage?: { total_tokens: number; output_tokens: number; input_tokens: number };
  credits_consumed?: number;
  status: string;
}

export async function kieChat(
  systemPrompt: string,
  messages: KieMessage[],
  maxTokens: number = 2048
): Promise<string> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error("KIE_API_KEY not set");

  // Convert messages to kie.ai input format
  // System prompt goes as the first "system" role OR we prepend it to the first user message
  const input: any[] = [];

  // Add system prompt as a developer/system message
  input.push({
    role: "developer",
    content: [{ type: "input_text", text: systemPrompt }],
  });

  // Add conversation messages
  for (const msg of messages) {
    if (msg.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: msg.content }],
      });
    } else {
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: msg.content }],
      });
    }
  }

  const body = {
    model: process.env.KIE_MODEL || "gpt-5-4",
    stream: true,
    input,
    max_output_tokens: maxTokens,
    reasoning: { effort: "medium" },
  };

  try {
    require("fs").writeFileSync("/tmp/kie_payload.json", JSON.stringify(body, null, 2));
  } catch(e) {}

  const res = await fetch(KIE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // JSON must be acceptable alongside SSE. With "text/event-stream" alone
      // the API answers an error with a bare HTTP 406 and an EMPTY body, so the
      // actual message is destroyed before anyone can read it. That masked an
      // out-of-credits failure as an unexplained 406.
      "Accept": "text/event-stream, application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`kie.ai API error ${res.status}: ${errText}`);
  }

  const textRaw = await res.text();

  // kie.ai reports application-level failures as HTTP 200 carrying a JSON
  // envelope like {"code":402,"msg":"Credits insufficient ..."}. res.ok is true,
  // so without this check the SSE parser below simply finds no data lines and
  // returns an empty string — a silent failure that looks like a bad model.
  const trimmed = textRaw.trimStart();
  if (trimmed.startsWith("{")) {
    let envelope: { code?: number; msg?: string } | null = null;
    try {
      envelope = JSON.parse(trimmed);
    } catch {
      envelope = null; // Not an envelope after all; fall through to the parser.
    }
    if (envelope && typeof envelope.code === "number" && envelope.code !== 200) {
      throw new Error(`kie.ai ${envelope.code}: ${envelope.msg || "unknown error"}`);
    }
  }

  // The API streams SSE
  const lines = textRaw.split("\n");
  const textParts: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const dataStr = line.slice(6).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(dataStr);
        
        // 1. If it's a message_delta event
        if (parsed.type === "message_delta" && parsed.delta?.text) {
          textParts.push(parsed.delta.text);
        }
        
        // 2. If it's a response.completed event which has the full response object
        if (parsed.type === "response.completed" && parsed.response?.output) {
          // If we already collected deltas, don't duplicate from the completed event
          if (textParts.length === 0) {
            for (const item of parsed.response.output) {
              if (item.type === "message" && item.content) {
                for (const block of item.content) {
                  if (block.type === "output_text" && block.text) {
                    textParts.push(block.text);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        // ignore JSON parse errors on partial streams
      }
    }
  }

  // If streaming wasn't used and we just got a JSON object directly
  if (textParts.length === 0 && textRaw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(textRaw) as KieResponse;
      for (const item of parsed.output || []) {
        if (item.type === "message" && item.content) {
          for (const block of item.content) {
            if (block.type === "output_text" && block.text) {
              textParts.push(block.text);
            }
          }
        }
      }
    } catch {}
  }

  if (textParts.length === 0) {
    console.error("kie.ai raw response:", textRaw.slice(0, 500));
    throw new Error("kie.ai returned no text output");
  }

  return textParts.join("");
}
