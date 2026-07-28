// ─────────────────────────────────────────────────────────────────────────
//  ai.js — AI reports scaffold.
//
//  Step 1 (done here): turn the raw DB into a structured "signals" object —
//  new customers, revenue, top spenders, who's ONE step from a reward, whose
//  birthday is near, who's at churn risk, hot interests. This is the fuel.
//
//  Step 2 (done here): turn signals → a readable narrative. If GEMINI_API_KEY
//  is set we ask Gemini to write it (free tier is plenty); otherwise we render
//  a solid built-in template. Either way `sendReport()` DMs it to the admins.
//
//  This is the "prepare the ground for AI" layer: the moment a key is added,
//  the reports get smart — no restructuring needed.
// ─────────────────────────────────────────────────────────────────────────
import { db } from './db.js';
import { loyaltyFor } from './loyalty.js';
import { sendToUser } from './telegram.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

export function buildSignals(period = 'day') {
  const now = new Date('2026-07-21T20:00:00Z'); // fixed clock for a deterministic demo
  const sinceDays = period === 'week' ? 7 : 1;
  const since = new Date(now.getTime() - sinceDays * 86400000).toISOString();

  const newCustomers = db.prepare('SELECT COUNT(*) c FROM customers WHERE created_at>=?').get(since).c;
  const sales = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_usd),0) sum FROM purchases WHERE created_at>=? AND status='confirmed'").get(since);

  const top = db.prepare(`SELECT c.id,c.name, SUM(p.amount_usd) spent
      FROM customers c JOIN purchases p ON p.customer_id=c.id
      GROUP BY c.id ORDER BY spent DESC LIMIT 3`).all();

  // Customers within $400 of their next $100 reward → nudge them.
  const nearReward = db.prepare('SELECT id,name FROM customers').all()
    .map((c) => ({ ...c, l: loyaltyFor(c.id) }))
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
  const birthdays = db.prepare('SELECT name,birthday FROM customers WHERE birthday IS NOT NULL').all()
    .filter((c) => soon.includes(md(c.birthday)))
    .map((c) => ({ name: c.name, date: c.birthday }));

  // Churn risk: bought once, > 90 days ago.
  const churn = db.prepare(`SELECT c.name, COUNT(p.id) n, MAX(p.created_at) last
      FROM customers c JOIN purchases p ON p.customer_id=c.id
      GROUP BY c.id HAVING n<=1 AND last < ?`)
    .all(new Date(now.getTime() - 90 * 86400000).toISOString())
    .map((c) => ({ name: c.name, last: c.last.slice(0, 10) }));

  const hot = db.prepare(`SELECT p.title, COUNT(e.id) signals
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

async function renderWithGemini(signals) {
  const prompt = `Ти — асистент бутіка Way2Buy. На основі JSON даних напиши короткий, теплий, конкретний щоденний звіт для власниці українською (з emoji, без води, до 1500 символів). Дай 2-3 конкретні рекомендації дій.\n\nДані:\n${JSON.stringify(signals, null, 2)}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const j = await res.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('gemini: empty');
  return txt;
}

export async function buildReport(period = 'day') {
  const signals = buildSignals(period);
  let text;
  let engine = 'template';
  if (GEMINI_KEY) {
    try { text = await renderWithGemini(signals); engine = 'gemini-1.5-flash'; }
    catch { text = renderReportText(signals); }
  } else {
    text = renderReportText(signals);
  }
  return { engine, signals, text };
}

export async function sendReport(period = 'day') {
  const report = await buildReport(period);
  const admins = (process.env.ADMIN_TG_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const id of admins) results.push(await sendToUser(id, report.text));
  return { ...report, sentTo: admins.length, results };
}
