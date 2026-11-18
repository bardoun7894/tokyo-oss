import * as db from "../db";
import { getModel } from "../ai";
import { askJev, jevEnabled, type JevQuestion } from "../jev";

const BATCH_SIZE = 50;
const JEV_CONCURRENCY = 8;
const SENTIMENT_QUESTION: JevQuestion = {
  type: "choice",
  instructions: "The sentiment of this WhatsApp message in its own context. It may be Arabic, Darija, French, English, or mixed.",
  criteria: {
    positive: "Happy, grateful, satisfied, friendly, or enthusiastic.",
    negative: "Angry, frustrated, complaining, disappointed, or sad.",
    neutral: "Informational, a plain question, logistics, or no clear feeling.",
  },
};
const PROXY_URL = "http://127.0.0.1:8317/v1/messages";

interface ClassificationResult {
  id: number;
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
}

let classificationInProgress = false;

export function isClassifying(): boolean {
  return classificationInProgress;
}

export async function classifyBatch(limit = 10000): Promise<{
  classified: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}> {
  const startTime = Date.now();
  const messages = db.getUnclassifiedMessages(limit);

  if (messages.length === 0) {
    return { classified: 0, skipped: 0, errors: 0, elapsedMs: Date.now() - startTime };
  }

  let classified = 0;
  let errors = 0;

  // Jev: one typed decision per message, ~$0.00002 each, with a real confidence.
  // Jev cannot batch different states, so fan out with a small worker pool.
  if (jevEnabled()) {
    let next = 0;
    const worker = async () => {
      while (next < messages.length) {
        const m = messages[next++];
        const text = (m.content || m.transcription || "").substring(0, 2000);
        if (!text.trim()) continue;
        try {
          const a = (await askJev({ message: text }, { sentiment: SENTIMENT_QUESTION })).sentiment;
          if (a?.choice === "positive" || a?.choice === "negative" || a?.choice === "neutral") {
            db.insertSentiment(m.id, a.choice, a.confidence ?? 0.5);
            classified++;
          } else errors++;
        } catch (err: any) {
          errors++;
          if (errors <= 3) console.error(`[analyzer] jev failed on message ${m.id}:`, err?.message || err);
        }
      }
    };
    await Promise.all(Array.from({ length: JEV_CONCURRENCY }, worker));
    return { classified, skipped: 0, errors, elapsedMs: Date.now() - startTime };
  }

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);

    const msgList = batch
      .map((m) => {
        const text = m.content || m.transcription || "";
        return `[${m.id}] ${text.substring(0, 300)}`;
      })
      .join("\n---\n");

    const prompt = `Classify the sentiment of each WhatsApp message below as "positive", "negative", or "neutral". Consider the message in its own context. Messages may be in Arabic, English, or mixed.

Return ONLY a JSON array with no additional text: [{"id": <message_id>, "sentiment": "positive"|"negative"|"neutral", "confidence": 0.0-1.0}]

Messages:
${msgList}`;

    try {
      const model = getModel();
      let responseText = "";

      if (model === "kieai") {
        const { GoogleGenAI } = require("@google/genai");
        const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
        const result = await genai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        });
        responseText = result.text || "";
      } else {
        const resp = await fetch(PROXY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": "proxy-key",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          throw new Error(`Proxy returned ${resp.status}: ${errText.slice(0, 200)}`);
        }

        const data = await resp.json() as any;
        responseText =
          data.content?.[0]?.text ||
          data.choices?.[0]?.message?.content ||
          "";
      }

      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const results: ClassificationResult[] = JSON.parse(jsonMatch[0]);
        for (const r of results) {
          if (
            r.id &&
            r.sentiment &&
            ["positive", "negative", "neutral"].includes(r.sentiment)
          ) {
            db.insertSentiment(r.id, r.sentiment, r.confidence || 0.5);
            classified++;
          }
        }
      } else {
        console.error(
          `No JSON array found in response for batch starting at message ${batch[0].id}. Response preview: ${responseText.slice(0, 200)}`
        );
        errors += batch.length;
      }
    } catch (err) {
      console.error(
        `Classification batch error (messages ${batch[0].id}-${batch[batch.length - 1].id}):`,
        err
      );
      errors += batch.length;
    }
  }

  return {
    classified,
    skipped: 0,
    errors,
    elapsedMs: Date.now() - startTime,
  };
}

export async function runClassification(limit = 10000): Promise<{
  classified: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}> {
  if (classificationInProgress) {
    throw new Error("Classification already in progress");
  }
  classificationInProgress = true;
  try {
    return await classifyBatch(limit);
  } finally {
    classificationInProgress = false;
  }
}
