import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPT } from "./system-prompt";

interface LLMResult {
    command: string;
    explanation: string;
}

const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENAI_MODEL = "qwen3.5:9b";

/**
 * Parse a JSON response string, with a regex fallback for dirty output.
 */
function parseJSONResponse(text: string): LLMResult {
    try {
        return JSON.parse(text);
    } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return { command: "", explanation: "Failed to parse response" };
    }
}

/**
 * Send a prompt to the configured LLM and return a parsed edit command.
 * Supports Google GenAI (default) and any OpenAI-compatible API (e.g. Ollama).
 */
export async function generateEditCommand(
    env: Env,
    userPrompt: string
): Promise<LLMResult> {
    const provider = env.LLM_PROVIDER ?? "google";

    if (provider === "openai") {
        return generateViaOpenAI(env, userPrompt);
    }

    return generateViaGoogle(env, userPrompt);
}

// ── Google GenAI ────────────────────────────────────────────────────────

async function generateViaGoogle(
    env: Env,
    userPrompt: string
): Promise<LLMResult> {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const model = env.LLM_MODEL ?? DEFAULT_GOOGLE_MODEL;

    const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: "application/json",
        },
    });

    return parseJSONResponse(response.text || "{}");
}

// ── OpenAI-compatible (Ollama, etc.) ────────────────────────────────────

async function generateViaOpenAI(
    env: Env,
    userPrompt: string
): Promise<LLMResult> {
    const baseUrl = env.OPENAI_API_BASE_URL;
    if (!baseUrl) {
        throw new Error(
            "OPENAI_API_BASE_URL must be set when LLM_PROVIDER is 'openai'"
        );
    }

    const model = env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL;
    const apiKey = env.OPENAI_API_KEY ?? "";

    const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
        }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `OpenAI-compatible API error (${res.status}): ${body}`
        );
    }

    const data = (await res.json()) as {
        choices: { message: { content: string } }[];
    };

    const content = data.choices?.[0]?.message?.content ?? "{}";
    return parseJSONResponse(content);
}
