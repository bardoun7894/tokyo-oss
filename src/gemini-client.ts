import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";

const GEMINI_ENABLED = process.env.GEMINI_ENABLED === "true";

const gemini = new GoogleGenAI({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.GEMINI_API_KEY || "",
  httpOptions: { baseUrl: "http://localhost:8317" },
});

const claudeFallback = new Anthropic({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
});

export interface GeminiResult {
  text: string;
  usedFallback: boolean;
  reason?: string;
  provider: "gemini" | "claude";
  model: string;
}

export async function geminiChat(
  systemPrompt: string,
  messages: { role: "user" | "assistant"; content: string }[],
  maxTokens: number = 1024,
  model: string = "gemini-2.5-flash",
): Promise<GeminiResult> {
  if (!GEMINI_ENABLED) {
    return claudeFallbackCall(systemPrompt, messages, maxTokens, "gemini_disabled");
  }

  try {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const response = await gemini.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
      },
    });

    const text = response.text ?? "";
    if (!text) {
      return claudeFallbackCall(systemPrompt, messages, maxTokens, "gemini_empty_response");
    }
    return { text, usedFallback: false, provider: "gemini", model };
  } catch (err: any) {
    const reason =
      err?.status === 401 || err?.status === 403
        ? "no_gemini_auth"
        : err?.message?.includes("not found")
        ? "no_gemini_model"
        : `gemini_error:${err?.status || err?.message || "unknown"}`;
    return claudeFallbackCall(systemPrompt, messages, maxTokens, reason);
  }
}

async function claudeFallbackCall(
  systemPrompt: string,
  messages: { role: "user" | "assistant"; content: string }[],
  maxTokens: number,
  reason: string,
): Promise<GeminiResult> {
  const model = "claude-haiku-4-5-20251001";
  const response = await claudeFallback.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return { text, usedFallback: true, reason, provider: "claude", model };
}
