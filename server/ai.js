// ─────────────────────────────────────────────────────────────────────────
//  ai.js — AI reports scaffold.
//
//  Step 1 (done here): turn the raw DB into a structured "signals" object —
//  new customers, revenue, top spenders, who's ONE step from a reward, whose
//  birthday is near, who's at churn risk, hot interests. This is the fuel.
//
//  Step 2 (done here): turn signals → a readable narrative. A free model writes
//  it — see llm.js for the chain and why it is ordered that way — and the
//  built-in template is the floor underneath, not a curiosity: if every model in
//  the chain is rate-limited, the owner still gets her numbers. Either way
//  `await sendReport()` DMs it to the supers.
//
//  The signals object is the contract between the two halves. Everything the
//  narrative may state comes from it, and the prompt says so — a report that
//  invents a name or a sum is worse than no report, because it is read to decide
//  what to buy.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { loyaltyFor } from './loyalty.js';
import { alertIds } from './roles.js';
import { sendToUser } from './telegram.js';
import { complete, available } from './llm.js';

/** «2026-04-02» from either a Date (Postgres) or an ISO string (SQLite/PGlite). */
const isoDay = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

export async function buildSignals(period = 'day', now = new Date()) {
  const sinceDays = period === 'week' ? 7 : 1;
  const since = new Date(now.getTime() - sinceDays * 86400000).toISOString();

  const newCustomers = (await db.prepare('SELECT COUNT(*) c FROM customers WHERE created_at>=?').get(since)).c;
  const sales = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_usd),0) sum FROM purchases WHERE created_at>=? AND status='confirmed'").get(since);

  const top = await db.prepare(`SELECT c.id,c.name, SUM(p.amount_usd) spent
      FROM customers c JOIN purchases p ON p.customer_id=c.id
      GROUP BY c.id ORDER BY spent DESC LIMIT 3`).all();

  // Customers within $400 of their next $100 reward → nudge them.
  // Promise.all before the filter: loyaltyFor is a database read, and filtering
  // an array of promises would test `.l` on the promise and keep everyone.
  const withLoyalty = await Promise.all(
    (await db.prepare('SELECT id,name FROM customers').all())
      .map(async (c) => ({ ...c, l: await loyaltyFor(c.id) }))
  );
  const nearReward = withLoyalty
    .filter((c) => c.l.toNextReward <= 400 && c.l.totalSpent > 0)
    .sort((a, b) => a.l.toNextReward - b.l.toNextReward)
    .slice(0, 5)
    .map((c) => ({ name: c.name, toGo: c.l.toNextReward, total: c.l.totalSpent }));

  // Birthdays in the next 10 days.
  const md = (d) => d.slice(5);
  const soon = [];
  for (let i = 0; i <= 10; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    soon.push(`${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  const birthdays = (await db.prepare('SELECT name,birthday FROM customers WHERE birthday IS NOT NULL').all())
    .filter((c) => soon.includes(md(c.birthday)))
    .map((c) => ({ name: c.name, date: c.birthday }));

  // Churn risk: bought once, > 90 days ago.
  //
  // The aggregates are repeated in HAVING rather than referred to by their
  // output names. SQLite accepts `HAVING n <= 1`; Postgres does not — HAVING is
  // evaluated before the select list exists, so the alias is simply an unknown
  // column and the whole report answered 500 in production.
  const churn = (await db.prepare(`SELECT c.name, COUNT(p.id) n, MAX(p.created_at) last
      FROM customers c JOIN purchases p ON p.customer_id=c.id
      GROUP BY c.id HAVING COUNT(p.id) <= 1 AND MAX(p.created_at) < ?`)
    .all(new Date(now.getTime() - 90 * 86400000).toISOString()))
    // `last` is a timestamptz, which node-postgres hands back as a Date and
    // SQLite handed back as a string. isoDay() takes either.
    .map((c) => ({ name: c.name, last: isoDay(c.last) }));

  const hot = await db.prepare(`SELECT p.title, COUNT(e.id) signals
      FROM events e JOIN posts p ON p.id=e.post_id
      WHERE e.type IN ('want','return') GROUP BY p.id ORDER BY signals DESC LIMIT 3`).all();

  return {
    period, since,
    newCustomers,
    salesCount: sales.n,
    salesSum: Math.round(sales.sum),
    topSpenders: top.map((t) => ({ name: t.name, spent: Math.round(t.spent) })),
    nearReward, birthdays, churn, hot,
  };
}

export function renderReportText(s) {
  const L = [];
  L.push(`📊 <b>Way2Buy — звіт за ${s.period === 'week' ? 'тиждень' : 'сьогодні'}</b>`);
  L.push('');
  L.push(`💵 Продажів: <b>${s.salesCount}</b> на <b>$${s.salesSum}</b>`);
  L.push(`🆕 Нових клієнтів: <b>${s.newCustomers}</b>`);
  if (s.topSpenders.length) {
    L.push('');
    L.push('🏆 <b>Топ клієнти:</b>');
    s.topSpenders.forEach((t, i) => L.push(`  ${i + 1}. ${t.name} — $${t.spent}`));
  }
  if (s.nearReward.length) {
    L.push('');
    L.push('🎯 <b>Близькі до кешбеку — варто підштовхнути:</b>');
    s.nearReward.forEach((c) => L.push(`  • ${c.name}: ще $${c.toGo} до наступних $100`));
  }
  if (s.birthdays.length) {
    L.push('');
    L.push('🎂 <b>Скоро день народження:</b>');
    s.birthdays.forEach((b) => L.push(`  • ${b.name} — ${b.date.slice(5)}`));
  }
  if (s.hot.length) {
    L.push('');
    L.push('🔥 <b>Гарячі товари (цікавляться):</b>');
    s.hot.forEach((h) => L.push(`  • ${h.title} — ${h.signals} сигнал(и)`));
  }
  if (s.churn.length) {
    L.push('');
    L.push('⚠️ <b>Ризик відтоку (купили раз, давно):</b>');
    s.churn.forEach((c) => L.push(`  • ${c.name} — остання покупка ${c.last}`));
  }
  L.push('');
  L.push('<i>Порада: відправте промокод тим, хто близький до кешбеку та іменинникам.</i>');
  return L.join('\n');
}

/**
 * The narrative, written by whichever free model answers first.
 *
 * The template below is not a fallback of last resort — it is the floor. If the
 * chain is dry, or a model returns something too short to be a report, the
 * owner still gets her numbers. A report that arrives in plain prose beats a
 * report that does not arrive.
 */
async function renderWithModel(signals) {
  const prompt = `Ти — асистент бутіка Way2Buy. На основі JSON даних напиши короткий, теплий, конкретний звіт для власниці українською (з emoji, без води, до 1500 символів). Дай 2-3 конкретні рекомендації дій.

Пиши лише про те, що є в даних. Не вигадуй імен, сум і товарів, яких тут немає — цей звіт читають, щоб приймати рішення про закупівлю.

Дані:
${JSON.stringify(signals, null, 2)}`;

  const answer = await complete({
    chain: 'analytics',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    temperature: 0.4,
  });
  // A model that answered with two words answered with nothing useful.
  if (answer.text.length < 120) throw new Error(`${answer.model}: завідомо коротка відповідь`);
  return answer;
}

export async function buildReport(period = 'day', now = new Date()) {
  const signals = await buildSignals(period, now);
  let text = renderReportText(signals);
  let engine = 'template';
  let fallbackReason = null;

  if (available().analytics) {
    try {
      const answer = await renderWithModel(signals);
      text = answer.text;
      engine = `${answer.provider}:${answer.model}`;
    } catch (e) {
      // Reported rather than swallowed: «the template again» is the symptom of
      // a dead key or an exhausted quota, and silence about it is how nobody
      // notices for a month.
      fallbackReason = String(e.message || e).slice(0, 300);
      console.warn('[report] model chain failed, template served:', fallbackReason);
    }
  }
  return { engine, signals, text, ...(fallbackReason ? { fallbackReason } : {}) };
}

export async function sendReport(period = 'day', now = new Date()) {
  const report = await buildReport(period, now);
  // The same recipients every other alert uses: the supers as the roles table
  // knows them, env-bootstrapped or added from the cabinet. Reading ADMIN_TG_IDS
  // here directly — which is what this did — meant a super Maryna appointed got
  // the abandoned-cart alerts but never the report.
  const admins = await alertIds();
  const results = [];
  for (const id of admins) results.push(await sendToUser(id, report.text));
  return { ...report, sentTo: admins.length, results };
}
