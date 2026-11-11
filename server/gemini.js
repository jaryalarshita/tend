// One way in to Gemini for the whole app: the queue review and typed grid commands both
// use generateJson(), which tries each model in turn until one answers.
import { GoogleGenAI } from '@google/genai';

// Gemini models hit "high demand" (503) spikes, so a busy model hands over to the next
// instead of failing. 2.5 Flash is a different family, in case the whole 3.x line is busy.
// gemini-3.8-flash is listed but timed out on every call (Nov 2026), so it is left out.
// GEMINI_MODEL, if set, goes first.
const FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
// Below this, there isn't time for another model to finish, so stop trying.
const MIN_ATTEMPT_MS = 5_000;

let client = null;
const getClient = () => {
  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    // v1beta is needed for JSON output on 2.5 Flash. No SDK retries: a busy model
    // is skipped for the next one, which is faster than retrying the same one.
    apiVersion: 'v1beta',
    httpOptions: { retryOptions: { attempts: 1 } },
  });
  return client;
};

export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

function describeFailure(err) {
  if (err.status === 503) return 'busy (high demand)';
  if (err.status === 429) return 'rate limit reached';
  if (err.status === 504 || err.name === 'AbortError' || /timed? ?out|deadline/i.test(err.message)) return 'timed out';
  // The SDK puts Google's JSON error body in the message; keep just the readable part.
  let message = String(err.message ?? err);
  try {
    message = JSON.parse(message).error?.message ?? message;
  } catch {
    // Not JSON, keep as is.
  }
  return message.slice(0, 120);
}

// Asks for JSON matching `schema`. Returns { data, model, failures } where failures lists
// the models that were busy first, or throws an error whose `failures` lists every model.
export async function generateJson({ systemInstruction, contents, schema, perModelMs, totalMs }) {
  if (!isConfigured()) {
    const err = new Error('GEMINI_API_KEY is not set');
    err.failures = ['GEMINI_API_KEY is not set'];
    throw err;
  }

  const models = [...new Set([process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
  const deadline = Date.now() + totalMs;
  const failures = [];

  for (const model of models) {
    const timeLeft = deadline - Date.now();
    if (timeLeft < MIN_ATTEMPT_MS) {
      failures.push(`${model} skipped (out of time)`);
      continue;
    }
    try {
      const response = await getClient().models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
          temperature: 0.2,
          httpOptions: { timeout: Math.min(perModelMs, timeLeft) },
          // Gemini 3 takes a thinking level; 2.5 takes a token budget.
          thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: 1024 } : { thinkingLevel: 'LOW' },
        },
      });
      return { data: JSON.parse(response.text), model, failures };
    } catch (err) {
      failures.push(`${model} ${describeFailure(err)}`);
      console.warn(`Gemini ${model} failed: ${err.message}`);
    }
  }

  const err = new Error(failures.join('; '));
  err.failures = failures;
  throw err;
}
