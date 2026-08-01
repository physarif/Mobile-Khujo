// functions/api/visits.js — Cloudflare Pages Function (D1 ভার্সন)
// GET /api/visits          -> কাউন্ট বাড়িয়ে বর্তমান সংখ্যা রিটার্ন করে
// GET /api/visits?count=0  -> শুধু বর্তমান সংখ্যা রিটার্ন করে, বাড়ায় না
//
// প্রয়োজনীয় সেটআপ (Cloudflare dashboard):
// 1. Storage & databases > D1 > Create database (নাম: যেমন "pathokghar-db")
// 2. ঐ ডাটাবেসের Console-এ গিয়ে একবার এই SQL চালান:
//      CREATE TABLE IF NOT EXISTS visits (
//        key TEXT PRIMARY KEY,
//        count INTEGER NOT NULL DEFAULT 0
//      );
// 3. আপনার Pages প্রজেক্ট > Settings > Functions > D1 database bindings
//    Variable name: DB   ->   বানানো ডাটাবেস সিলেক্ট করুন
//    (Production ও Preview দুই environment-এই বাইন্ড করুন)

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.DB;

  if (!db) {
    return new Response(
      JSON.stringify({ error: 'DB binding পাওয়া যায়নি। Cloudflare Pages settings-এ D1 bind করুন।' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const url = new URL(request.url);
  const shouldCount = url.searchParams.get('count') !== '0';

  // বাংলাদেশ সময় অনুযায়ী আজকের তারিখ (YYYY-MM-DD)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const dailyKey = 'daily:' + today;

  if (shouldCount) {
    // key না থাকলে 1 দিয়ে তৈরি করবে, থাকলে +1 করবে (atomic upsert)
    await db.batch([
      db.prepare(
        `INSERT INTO visits (key, count) VALUES ('total', 1)
         ON CONFLICT(key) DO UPDATE SET count = count + 1`
      ),
      db.prepare(
        `INSERT INTO visits (key, count) VALUES (?, 1)
         ON CONFLICT(key) DO UPDATE SET count = count + 1`
      ).bind(dailyKey),
    ]);
  }

  const [totalRow, dailyRow] = await Promise.all([
    db.prepare('SELECT count FROM visits WHERE key = ?').bind('total').first(),
    db.prepare('SELECT count FROM visits WHERE key = ?').bind(dailyKey).first(),
  ]);

  return new Response(
    JSON.stringify({
      total: totalRow?.count || 0,
      today: dailyRow?.count || 0,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

