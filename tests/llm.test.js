// The failover walk: what happens when a model in the chain does not answer.
//
// Every case here is a way a free pool actually behaves — busy, slow, or
// answering 200 with an error in the body — and the point of the chain is that
// none of them reach the caller as long as somebody further down is alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, available, CHAINS, NoModelAnswered, imageMessage } from '../server/llm.js';

const withKeys = async (fn) => {
  const before = { or: process.env.OPENROUTER_API_KEY, oc: process.env.OPENCODE_API_KEY };
  process.env.OPENROUTER_API_KEY = 'test-or';
  process.env.OPENCODE_API_KEY = 'test-oc';
  try { return await fn(); } finally {
    before.or ? (process.env.OPENROUTER_API_KEY = before.or) : delete process.env.OPENROUTER_API_KEY;
    before.oc ? (process.env.OPENCODE_API_KEY = before.oc) : delete process.env.OPENCODE_API_KEY;
  }
};

const reply = (text) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
});

test('the first model that answers wins, and the walk stops there', () => withKeys(async () => {
  const calls = [];
  const r = await complete({
    chain: 'analytics',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body).model);
      return reply('Aug $935.29');
    },
  });
  assert.equal(r.text, 'Aug $935.29');
  assert.equal(calls.length, 1, 'nothing below the first answer was asked');
  assert.equal(r.model, CHAINS.analytics[0][1]);
}));

test('a 429 is stepped over, not fatal — the free pools are shared', () => withKeys(async () => {
  let n = 0;
  const r = await complete({
    chain: 'analytics',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => (++n <= 2 ? { ok: false, status: 429 } : reply('готово')),
  });
  assert.equal(r.text, 'готово');
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.tried.map((t) => t.status), [429, 429]);
}));

test('an empty answer counts as no answer', () => withKeys(async () => {
  // Several of these models spend their whole budget thinking and return ''.
  // Passing that up would read as "the model considered it and had nothing".
  let n = 0;
  const r = await complete({
    chain: 'analytics',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => (++n === 1 ? reply('   ') : reply('справжня відповідь')),
  });
  assert.equal(r.text, 'справжня відповідь');
  assert.match(r.tried[0].error, /порожня/);
}));

test('a 200 carrying an error in the body is a failure too', () => withKeys(async () => {
  let n = 0;
  const r = await complete({
    chain: 'analytics',
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => (++n === 1
      ? { ok: true, status: 200, json: async () => ({ error: { message: 'rate limited upstream' } }) }
      : reply('ок')),
  });
  assert.equal(r.text, 'ок');
  assert.match(r.tried[0].error, /rate limited/);
}));

test('when nobody answers the caller is told what was tried', () => withKeys(async () => {
  await assert.rejects(
    () => complete({ chain: 'vision', messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => ({ ok: false, status: 503 }) }),
    (e) => {
      assert.ok(e instanceof NoModelAnswered);
      assert.equal(e.tried.length, CHAINS.vision.length, 'the whole chain was walked');
      return true;
    });
}));

test('a model with no key for its provider is skipped without a request', async () => {
  const before = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-or';
  try {
    const asked = [];
    await complete({
      chain: 'analytics', messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async (url) => { asked.push(url); return { ok: false, status: 500 }; },
    }).catch(() => {});
    assert.ok(asked.every((u) => u.includes('openrouter')), 'opencode was never called');
    assert.ok(asked.length > 0);
  } finally {
    if (before) process.env.OPENCODE_API_KEY = before;
  }
});

test('the budget stops the walk before a serverless function is killed', () => withKeys(async () => {
  // Fourteen models at 25s each outlives any Vercel function. The walk must give
  // up on its own terms and say so, not be cut off mid-request with nothing.
  const r = await complete({
    chain: 'analytics', messages: [{ role: 'user', content: 'x' }], budgetMs: -1,
    fetchImpl: async () => reply('не має значення'),
  }).catch((e) => e);
  assert.ok(r instanceof NoModelAnswered);
  assert.equal(r.tried[0].skipped, 'budget');
  assert.equal(r.tried.length, 1, 'stopped at once rather than walking the chain');
}));

test('both chains are free-only and vision is OpenRouter-only', () => {
  // The standing rule for this project: a paid model looping over 6700 cards is
  // a bill nobody agreed to. And OpenCode Zen has no free multimodal endpoint —
  // an image request there answers 404 while text works, so anything opencode in
  // the vision chain would be a silent hole.
  for (const [name, chain] of Object.entries(CHAINS)) {
    assert.ok(chain.length > 0, name);
    for (const [provider, model] of chain) {
      assert.ok(['openrouter', 'opencode'].includes(provider), `${name}: ${provider}`);
      if (provider === 'openrouter' && model !== 'openrouter/free') {
        assert.match(model, /:free$/, `${name}: ${model} має бути безкоштовною`);
      }
      if (provider === 'opencode') assert.match(model, /-free$/, `${name}: ${model}`);
    }
  }
  assert.ok(CHAINS.vision.every(([p]) => p === 'openrouter'));
});

test('an image message is the shape every vision model expects', () => {
  const [m] = imageMessage('Brand?', 'AAAA', 'image/png');
  assert.equal(m.role, 'user');
  assert.equal(m.content[0].text, 'Brand?');
  assert.equal(m.content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('available() reports a chain dead when its providers have no key', async () => {
  const before = { or: process.env.OPENROUTER_API_KEY, oc: process.env.OPENCODE_API_KEY };
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    assert.deepEqual(available(), { vision: false, analytics: false });
    process.env.OPENCODE_API_KEY = 'x';
    // OpenCode alone cannot see: the vision chain stays dead, analytics revives.
    assert.deepEqual(available(), { vision: false, analytics: true });
  } finally {
    if (before.or) process.env.OPENROUTER_API_KEY = before.or;
    if (before.oc) process.env.OPENCODE_API_KEY = before.oc;
    else delete process.env.OPENCODE_API_KEY;
  }
});
