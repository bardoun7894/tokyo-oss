import Anthropic from "@anthropic-ai/sdk";
import { askJev, jevEnabled, type JevQuestion } from "./jev";

const client = new Anthropic({
  apiKey: process.env.CLIPROXY_API_KEY || process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.CLIPROXY_API_KEY ? "http://localhost:8317" : undefined,
});

export type Layer = "sdk-quick" | "claude-code" | "tech-company";
export type Provider = "claude" | "gemini";

export interface Classification {
  layer: Layer;
  provider: Provider;
  model: string;
  reasoning: string;
}

export interface ClassifierInput {
  content: string;
  sender_name: string;
  project_name: string;
  project_location: "laptop" | "server";
  has_image: boolean;
  char_count: number;
}

const SYSTEM_PROMPT = `You classify inbound WhatsApp messages to pick the cheapest useful execution layer.

Output RAW JSON ONLY (no markdown, no fences):
{"layer":"sdk-quick"|"claude-code"|"tech-company","provider":"claude"|"gemini","model":"<model-id>","reasoning":"<<=15 words>"}

Rules:
- sdk-quick: short Q&A, greetings, status checks, thanks, factual questions. NO file changes implied.
- claude-code: dev verbs (add, fix, build, deploy, refactor, debug, update, change, implement, remove) OR clear task language.
- tech-company: user explicitly says "full team", "tech company", "like a company", "audit everything", OR scope spans multiple subsystems (frontend+backend+ops). Rare — bias toward claude-code.

Provider:
- claude (DEFAULT): text, all languages, Arabic, English, French.
- gemini: ONLY when has_image=true AND visual reasoning is required, OR char_count>30000.

Model selection:
- sdk-quick + claude: claude-haiku-4-5-20251001
- sdk-quick + gemini: gemini-2.5-flash
- claude-code / tech-company: wrapper chooses; return "claude-sonnet-5" as a placeholder.

Bias when ambiguous: choose claude-code. Safer than auto-replying to a client.`;

const FALLBACK: Classification = {
  layer: "claude-code",
  provider: "claude",
  model: "claude-sonnet-5",
  reasoning: "classifier-fallback",
};

// Jev confidence gates. Below LAYER_CONFIDENCE, Haiku decides instead.
// sdk-quick auto-replies to a client, so it needs more certainty than routing.
const LAYER_CONFIDENCE = 0.75;
const QUICK_CONFIDENCE = 0.85;

const LAYER_QUESTION: JevQuestion = {
  type: "choice",
  instructions: "Which execution layer should handle this inbound WhatsApp message from a client about their software project.",
  criteria: {
    "sdk-quick": "Short Q&A, greeting, thanks, status check, or factual question. No file or code change implied.",
    "claude-code": "Asks to add, fix, build, deploy, refactor, debug, update, change, implement, or remove something, or any clear task.",
    "tech-company": "Explicitly asks for the full team / a tech company / an audit of everything, or spans frontend + backend + ops at once.",
  },
};

// Short Darija/Arabic complaints ("ما اشتغل عندي") read as small talk to the
// layer question, so a separate check keeps them out of sdk-quick.
const PROBLEM_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "The sender reports that something is broken, not working, missing, or failing for them.",
};
const PROBLEM_THRESHOLD = 0.5;

const VISION_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "Answering the message requires looking at the attached image.",
};

// Returns null when Jev is unsure, so the caller falls back to Haiku.
export async function classifyWithJev(input: ClassifierInput): Promise<Classification | null> {
  const questions: Record<string, JevQuestion> = { layer: LAYER_QUESTION, reports_problem: PROBLEM_QUESTION };
  if (input.has_image) questions.needs_vision = VISION_QUESTION;

  const answers = await askJev(
    {
      message: input.content.slice(0, 4000),
      sender: input.sender_name,
      project: input.project_name,
      has_image: input.has_image,
    },
    questions,
  );

  const layerAnswer = answers.layer;
  const confidence = layerAnswer?.confidence ?? 0;
  const choice = layerAnswer?.choice;
  if (choice !== "sdk-quick" && choice !== "claude-code" && choice !== "tech-company") return null;
  if (confidence < LAYER_CONFIDENCE) return null;

  const problem = (answers.reports_problem?.noul ?? 0) > PROBLEM_THRESHOLD;
  const layer: Layer =
    choice === "sdk-quick" && (confidence < QUICK_CONFIDENCE || problem) ? "claude-code" : choice;
  const vision = input.has_image && (answers.needs_vision?.noul ?? 0) > 0.5;
  const provider: Provider = vision || input.char_count > 30000 ? "gemini" : "claude";
  const model =
    layer !== "sdk-quick"
      ? "claude-sonnet-5"
      : provider === "gemini"
      ? "gemini-2.5-flash"
      : "claude-haiku-4-5-20251001";
  const reasoning = `jev ${choice} ${confidence.toFixed(2)}${problem ? " +problem" : ""}`;
  return { layer, provider, model, reasoning };
}

export async function classifyWAMessage(
  input: ClassifierInput,
  timeoutMs = 5000,
): Promise<Classification> {
  if (jevEnabled()) {
    try {
      const jev = await classifyWithJev(input);
      if (jev) return jev;
    } catch (err: any) {
      console.warn("[classifier] jev failed, using haiku:", err?.message || err);
    }
  }

  const userMsg = [
    `sender: ${input.sender_name}`,
    `project: ${input.project_name} (${input.project_location})`,
    `has_image: ${input.has_image}`,
    `char_count: ${input.char_count}`,
    `content: ${input.content.slice(0, 1200)}`,
  ].join("\n");

  const call = client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 120,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  try {
    const response = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error("classifier_timeout")), timeoutMs)),
    ]) as Awaited<typeof call>;

    const raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    const parsed = extractJson(raw);
    if (!parsed) return FALLBACK;
    return normalize(parsed);
  } catch (err: any) {
    console.warn("[classifier] fallback:", err?.message || err);
    return FALLBACK;
  }
}

function extractJson(raw: string): any {
  const direct = tryParse(raw);
  if (direct) return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return tryParse(fenced[1]);
  const braced = raw.match(/\{[\s\S]*\}/);
  if (braced) return tryParse(braced[0]);
  return null;
}

function tryParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function normalize(p: any): Classification {
  const layer: Layer =
    p.layer === "sdk-quick" || p.layer === "claude-code" || p.layer === "tech-company"
      ? p.layer
      : "claude-code";
  const provider: Provider = p.provider === "gemini" ? "gemini" : "claude";
  const model: string =
    typeof p.model === "string" && p.model.length > 0
      ? p.model
      : layer === "sdk-quick"
      ? provider === "gemini"
        ? "gemini-2.5-flash"
        : "claude-haiku-4-5-20251001"
      : "claude-sonnet-5";
  const reasoning: string =
    typeof p.reasoning === "string" ? p.reasoning.slice(0, 200) : "";
  return { layer, provider, model, reasoning };
}
