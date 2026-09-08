import type { PrismaClient } from "@prisma/client";
import { chatOnce } from "./ollama.js";

export type PipelineResult =
  | { outcome: "PASS" }
  | { outcome: "BLOCK"; message: string; ruleName: string }
  | { outcome: "FLAG"; reason: string };

function matches(pattern: string, matchType: "KEYWORD" | "REGEX", content: string): boolean {
  if (matchType === "KEYWORD") {
    const needles = pattern
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const haystack = content.toLowerCase();
    return needles.some((n) => haystack.includes(n));
  }
  try {
    const re = new RegExp(pattern, "i");
    return re.test(content);
  } catch {
    // Invalid regex saved by an admin — never let it crash a chat request.
    return false;
  }
}

const DEFAULT_AI_MODERATION_MODEL = process.env.AI_MODERATION_MODEL || "llama3.2";

// Asks a local model a strict yes/no classification question — `pattern`
// is the admin's plain-language moderation instruction (e.g. "Flag spam,
// scam links, or phishing attempts"), `content` is the message being
// judged. Errs on the side of PASS (false) on any failure — a broken or
// slow model must never be able to block every message in the app; that's
// what the always-available KEYWORD/REGEX rules are for as a fallback.
async function matchesAi(pattern: string, model: string | null, content: string): Promise<boolean> {
  try {
    const result = await chatOnce({
      model: model || DEFAULT_AI_MODERATION_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a content moderation classifier. You will be given a rule and a message. " +
            'Reply with exactly one word: "YES" if the message violates the rule, "NO" if it does not. ' +
            "No explanation, no punctuation, nothing else.",
        },
        { role: "user", content: `Rule: ${pattern}\n\nMessage:\n"""\n${content}\n"""` },
      ],
      temperature: 0,
      num_predict: 5,
    });
    return /^\s*yes/i.test(result.content);
  } catch {
    return false;
  }
}

// Runs every enabled rule for the given stage, in `order`. Stops at the
// first BLOCK. Multiple FLAG matches are merged into one comma-joined
// reason so a message only needs one flagged=true pass.
export async function runPipelines(
  prisma: PrismaClient,
  stage: "PRE" | "POST",
  content: string
): Promise<PipelineResult> {
  const rules = await prisma.pipeline.findMany({
    where: { stage, enabled: true },
    orderBy: { order: "asc" },
  });

  const flaggedReasons: string[] = [];

  for (const rule of rules) {
    const hit =
      rule.matchType === "AI"
        ? await matchesAi(rule.pattern, rule.aiModel, content)
        : matches(rule.pattern, rule.matchType, content);
    if (!hit) continue;

    if (rule.action === "BLOCK") {
      return { outcome: "BLOCK", message: rule.message, ruleName: rule.name };
    }
    flaggedReasons.push(rule.name);
  }

  if (flaggedReasons.length > 0) {
    return { outcome: "FLAG", reason: `Matched pipeline rule(s): ${flaggedReasons.join(", ")}` };
  }
  return { outcome: "PASS" };
}
