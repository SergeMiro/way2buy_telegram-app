// ─────────────────────────────────────────────────────────────────────────
//  llm.js — one OpenAI-compatible call with automatic failover down a chain.
//
//  WHY THE CHAIN LIVES HERE AND NOT IN llm-failover-proxy. The proxy on the VPS
//  is the right tool and it holds the same two lists — but it listens on
//  127.0.0.1, and this app runs on Vercel. Pointing production at it would mean
//  publishing the proxy to the open internet and making the shop depend on one
//  VPS being up. So the app carries the chains itself and talks to the providers
//  directly; llmfp stays the place where the lists are curated and measured, and
//  CHAINS below is a copy of what it serves.
//
//  EVERY MODEL HERE IS FREE. That is the standing rule for this project, not an
//  accident of configuration: a paid model in a loop over 6700 catalogue cards
//  is a bill nobody agreed to. Adding a paid one is a decision, not a tweak.
//
//  ORDER IS STRENGTH, and a temporary 429 is not a reason to drop a model — the
//  free pools are shared and a model that is busy this minute answers the next.
//  The walk simply steps over it, which is the whole point of a chain.
// ─────────────────────────────────────────────────────────────────────────

const PROVIDERS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    key: () => process.env.OPENROUTER_API_KEY || '',
    // OpenRouter asks callers to identify themselves; it also unlocks the
    // free-tier pools that rank by app rather than by raw IP.
    headers: () => ({
      'HTTP-Referer': 'https://way2buy-ua.vercel.app',
      'X-Title': 'Way2Buy',
    }),
  },
  opencode: {
    baseUrl: 'https://opencode.ai/zen/v1',
    key: () => process.env.OPENCODE_API_KEY || '',
    headers: () => ({}),
  },
};

// Disables the model's own chain-of-thought where it would otherwise be printed
// into the answer — measured: nemotron-3.5-lightning without this returns
// "Here's a thinking process: 1. Understand User Input…" instead of the number.
const NO_REASONING = { reasoning: { enabled: false } };

export const CHAINS = {
  // ── READING A PHOTOGRAPH ────────────────────────────────────────────────
  //
  // OpenRouter only, and not by preference: OpenCode Zen's free tier has no
  // multimodal endpoint at all. An image request there answers 404 "No
  // endpoints found" while the same model answers a text question correctly, so
  // this is a missing capability rather than a rate limit. Until a second
  // provider with free vision exists (Gemini, when its key arrives), this chain
  // has one provider behind it — which is worth remembering when it goes quiet.
  //
  // Ranked by measurement on real catalogue photographs, not by parameter count.
  vision: [
    // 30.7B dense multimodal, the strongest free VLM in the pool. Shares Google
    // AI Studio's free pool, so it is often the one answering 429 — first
    // anyway, because when it is free it is the best answer available.
    ['openrouter', 'google/gemma-4-31b-it:free'],
    // Built as a perception sub-agent, which is exactly this job. Read both test
    // photographs correctly in 3s.
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'],
    // 25.2B MoE, 3.8B active — near-31B quality at a fraction of the latency.
    ['openrouter', 'google/gemma-4-26b-a4b-it:free'],
    // 12B, document intelligence. Correct in 1s: the fastest of the four.
    ['openrouter', 'nvidia/nemotron-nano-12b-v2-vl:free'],
    // Last resort: a router across whatever free model is currently up. Named
    // models are preferred because their answers are reproducible; this one is
    // here so a bad afternoon on the free pools is not a total outage.
    ['openrouter', 'openrouter/free'],
  ],

  // ── READING TEXT AND NUMBERS ────────────────────────────────────────────
  //
  // The monthly/quarterly/yearly narrative. Both providers, and the strongest
  // models appear twice on purpose — one provider's daily cap must not drop the
  // chain a whole tier in strength.
  //
  // Ranked by an arithmetic task over real sales figures, because that is what
  // this chain is for. A model that reasons beautifully and divides wrongly is
  // useless here: liquid/lfm-2.5-2.6b answered $934.41 where the answer is
  // $935.29 and is deliberately absent below. A wrong statistic is worse than
  // no statistic — it gets believed.
  analytics: [
    ['openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', NO_REASONING],
    ['opencode', 'nemotron-3-ultra-free'],
    ['openrouter', 'z-ai/glm-5.2:free'],
    ['opencode', 'deepseek-v4-flash-free'],
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', NO_REASONING],
    ['openrouter', 'google/gemma-4-31b-it:free'],
    // 1M context — the one to reach for when a year of data has to fit.
    ['openrouter', 'nvidia/nemotron-3.5-lightning:free', NO_REASONING],
    ['opencode', 'nemotron-3.5-lightning-free'],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free'],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free', NO_REASONING],
    ['opencode', 'hy3-free'],
    ['opencode', 'mimo-v2.5-free'],
    ['openrouter', 'openai/gpt-oss-20b:free'],
    ['opencode', 'laguna-s-2.1-free'],
  ],
};

/** Which chains can actually run — i.e. have a key for at least one provider. */
export function available() {
  const out = {};
  for (const [name, chain] of Object.entries(CHAINS)) {
    out[name] = chain.some(([provider]) => Boolean(PROVIDERS[provider].key()));
  }
  return out;
}

export class NoModelAnswered extends Error {
  constructor(tried) {
    super(`жодна модель не відповіла (${tried.length} спроб)`);
    this.name = 'NoModelAnswered';
    this.tried = tried;
  }
}

/**
 * Walks a chain until one model answers, and returns the first real answer.
 *
 * `budgetMs` is not decoration. This runs inside a Vercel function with a hard
 * limit, and a fourteen-model chain of 20s attempts would blow through it long
 * before the chain ended — so the walk stops when the budget is spent and says
 * how far it got, rather than being killed halfway with nothing to show.
 *
 * An empty answer counts as a failure. Several of these models return `''` when
 * their whole token budget went into thinking, and an empty string that reaches
 * the caller looks like "the model considered it and had nothing to say".
 */
export async function complete({
  chain = 'analytics',
  messages,
  maxTokens = 800,
  temperature = 0,
  timeoutMs = Number(process.env.W2B_LLM_TIMEOUT_MS || 25_000),
  budgetMs = Number(process.env.W2B_LLM_BUDGET_MS || 60_000),
  fetchImpl = fetch,
} = {}) {
  const models = CHAINS[chain];
  if (!models) throw new Error(`невідомий ланцюг «${chain}»`);

  const startedAt = Date.now();
  const tried = [];

  for (const [providerName, model, params] of models) {
    if (Date.now() - startedAt > budgetMs) {
      tried.push({ model, skipped: 'budget' });
      break;
    }
    const provider = PROVIDERS[providerName];
    const key = provider.key();
    if (!key) { tried.push({ model, skipped: 'no key' }); continue; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          ...provider.headers(),
        },
        body: JSON.stringify({
          model, messages, temperature, max_tokens: maxTokens, ...(params || {}),
        }),
      });
      if (!res.ok) {
        tried.push({ model, provider: providerName, status: res.status });
        continue;
      }
      const json = await res.json();
      // Providers differ on where a refusal lands: some 200 with an `error` body.
      if (json?.error) {
        tried.push({ model, provider: providerName, error: String(json.error.message || json.error).slice(0, 120) });
        continue;
      }
      const text = String(json?.choices?.[0]?.message?.content || '').trim();
      if (!text) { tried.push({ model, provider: providerName, error: 'порожня відповідь' }); continue; }
      return { text, model, provider: providerName, attempts: tried.length + 1, tried };
    } catch (e) {
      tried.push({
        model,
        provider: providerName,
        error: e.name === 'AbortError' ? `таймаут ${timeoutMs}ms` : String(e.message || e).slice(0, 120),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  throw new NoModelAnswered(tried);
}

/** One image plus one question — the shape every model in the vision chain takes. */
export const imageMessage = (prompt, base64, mimeType = 'image/jpeg') => ([{
  role: 'user',
  content: [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
  ],
}]);
