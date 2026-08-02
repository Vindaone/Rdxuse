export const config = { runtime: 'edge' };

/* ═══════════════════════════════════════════════════════════════════
   /api/download — Download counter for Rexus builds
   Methods:
     GET    /api/download?key=<buildKey>            → { key, count }
     POST   /api/download?key=<buildKey>            → { key, count, counted }

   Spam prevention:
   - Each (IP, buildKey) pair can only increment once per COOLDOWN_MS.
   - We store `dl:ip:<ip>:<key>` in Upstash with a TTL equal to the
     cooldown. If the key exists, the POST returns the current count
     without incrementing (counted: false).
   - The client ALSO keeps a localStorage mirror so most repeat clicks
     never even hit the server. The server-side check is the source of
     truth — clearing localStorage won't fake the count.

   Storage (auto-detected, same env vars as /api/issues):
   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
   2. KV_REST_API_URL + KV_REST_API_TOKEN
   3. In-memory Map fallback (per edge instance — NOT cross-user safe,
      and counts reset on cold start). Wire up Upstash for real use.
   ═══════════════════════════════════════════════════════════════════ */

function env(name){
  return (typeof process !== 'undefined' ? process.env?.[name] : undefined)
      ?? (typeof globalThis !== 'undefined' ? globalThis[name] : undefined);
}

const KV_URL   = env('UPSTASH_REDIS_REST_URL')   ?? env('KV_REST_API_URL');
const KV_TOKEN = env('UPSTASH_REDIS_REST_TOKEN') ?? env('KV_REST_API_TOKEN');
// Strip trailing slash so we don't end up with `//GET/key`
const KV_URL_NORM = KV_URL ? KV_URL.replace(/\/+$/, '') : null;
const USE_KV = !!(KV_URL_NORM && KV_TOKEN);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Password',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Download-Storage': USE_KV ? 'upstash-redis' : 'memory-fallback'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

// 5-minute cooldown per (IP, build). Tunable.
const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_SEC = Math.ceil(COOLDOWN_MS / 1000);

// Owner password for the admin +/- endpoint. MUST match the
// OWNER_PASSWORD in index.html. Used to gate /api/download?admin=1.
// Read from env (DL_OWNER_PASSWORD) first, fall back to the default.
const OWNER_PASSWORD = env('DL_OWNER_PASSWORD') || env('OWNER_PASSWORD') || 'Void';

/* In-memory fallback (per edge instance) */
const MEM_COUNTS = new Map();  // key -> count
const MEM_IPS = new Map();     // `ip:key` -> timestamp

function getClientIp(req){
  // Vercel Edge Functions put the visitor IP in x-forwarded-for (first entry)
  // or x-real-ip. Fall back to 'unknown' if neither is set (rare).
  const xff = req.headers.get('x-forwarded-for');
  if(xff){
    const first = xff.split(',')[0].trim();
    if(first) return first;
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

function sanitizeKey(k){
  // Allow alphanumerics, dot, dash, underscore. Max 64 chars.
  return String(k || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}

async function getCount(key){
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/GET/${encodeURIComponent('dl:count:' + key)}`, {
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      if(r.ok){
        const data = await r.json();
        if(data && typeof data.result === 'string'){
          return parseInt(data.result, 10) || 0;
        }
        if(data && typeof data.value === 'string'){
          return parseInt(data.value, 10) || 0;
        }
      }
      return 0;
    }catch(_){ return 0; }
  }
  return MEM_COUNTS.get(key) || 0;
}

async function setCount(key, n){
  if(USE_KV){
    try{
      // Use the URL-path form: POST /SET/<key>/<value>
      // This stores the value as a plain string (no JSON quotes),
      // so subsequent INCR/DECR and parseInt() both work correctly.
      // The previous version used JSON.stringify(String(n)) as the body,
      // which stored the value WITH quotes (e.g. "5" became '"5"'),
      // breaking parseInt on read-back and causing the count to get
      // stuck at 1 after the first admin adjustment.
      const r = await fetch(`${KV_URL_NORM}/SET/${encodeURIComponent('dl:count:' + key)}/${encodeURIComponent(String(n))}`, {
        method: 'POST',
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      return r.ok;
    }catch(_){ return false; }
  }
  MEM_COUNTS.set(key, n);
  return true;
}

// Atomically increment using Upstash's INCR command. Falls back to
// GET-then-SET if INCR isn't available (it always is on Upstash, but
// we keep the fallback for safety).
async function incrCount(key){
  if(USE_KV){
    try{
      // Upstash REST: POST /incr/<key> → { result: <number> }
      const r = await fetch(`${KV_URL_NORM}/INCR/${encodeURIComponent('dl:count:' + key)}`, {
        method: 'POST',
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      if(r.ok){
        const data = await r.json();
        if(data && typeof data.result === 'number'){
          return data.result;
        }
        if(data && typeof data.result === 'string'){
          return parseInt(data.result, 10) || 0;
        }
      }
      // Fallback: GET then SET
      const cur = await getCount(key);
      const next = cur + 1;
      await setCount(key, next);
      return next;
    }catch(_){
      const cur = await getCount(key);
      const next = cur + 1;
      await setCount(key, next);
      return next;
    }
  }
  const next = (MEM_COUNTS.get(key) || 0) + 1;
  MEM_COUNTS.set(key, next);
  return next;
}

async function getLastClick(ip, key){
  const fieldKey = 'dl:ip:' + ip + ':' + key;
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/GET/${encodeURIComponent(fieldKey)}`, {
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      if(r.ok){
        const data = await r.json();
        if(data && typeof data.result === 'string'){
          return parseInt(data.result, 10) || 0;
        }
      }
      return 0;
    }catch(_){ return 0; }
  }
  return MEM_IPS.get(ip + ':' + key) || 0;
}

async function setLastClick(ip, key, ts){
  const fieldKey = 'dl:ip:' + ip + ':' + key;
  if(USE_KV){
    try{
      // Upstash: POST /set/<key>/<value>?EX=<ttl-seconds>
      // The TTL auto-expires the cooldown key, so old entries clean
      // themselves up instead of accumulating forever.
      const r = await fetch(`${KV_URL_NORM}/SET/${encodeURIComponent(fieldKey)}/${ts}?EX=${COOLDOWN_SEC}`, {
        method: 'POST',
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      return r.ok;
    }catch(_){ return false; }
  }
  MEM_IPS.set(ip + ':' + key, ts);
  return true;
}

export default async function handler(req){
  if(req.method === 'OPTIONS'){
    return new Response(null, { status: 200, headers: CORS });
  }

  const url = new URL(req.url);

  // ── Diagnostic endpoint: /api/download?diag=1 ──
  // Checked BEFORE the key requirement so you can hit it without a key.
  // Same shape as /api/issues?diag=1 so you can verify the Edge Function
  // sees your Upstash env vars.
  if(url.searchParams.get('diag') === '1'){
    return json({
      storage: USE_KV ? 'upstash-redis' : 'memory-fallback',
      kvConfigured: USE_KV,
      envVarsPresent: {
        UPSTASH_REDIS_REST_URL:    !!env('UPSTASH_REDIS_REST_URL'),
        UPSTASH_REDIS_REST_TOKEN:  !!env('UPSTASH_REDIS_REST_TOKEN'),
        KV_REST_API_URL:           !!env('KV_REST_API_URL'),
        KV_REST_API_TOKEN:         !!env('KV_REST_API_TOKEN')
      },
      cooldownMs: COOLDOWN_MS,
      cooldownSec: COOLDOWN_SEC,
      hint: USE_KV
        ? 'Upstash/KV is configured. Download counts will persist across users.'
        : 'No KV env vars detected. Counts are in-memory only and will reset on cold start. Add Upstash env vars and redeploy.'
    });
  }

  const key = sanitizeKey(url.searchParams.get('key'));

  if(!key){
    return json({ error: 'Missing key parameter. Example: /api/download?key=v1.1' }, 400);
  }

  // ── GET: return current count ──
  if(req.method === 'GET'){
    const count = await getCount(key);
    return json({ key, count });
  }

  // ── POST ──
  if(req.method === 'POST'){
    // ─── Admin path: /api/download?key=<key>&admin=1&delta=<int> ───
    // Used by the owner-mode +/- buttons on the downloads page.
    // Requires the owner password in the X-Owner-Password header.
    // Bypasses the IP cooldown (admins can adjust freely) and can
    // decrement as well as increment. Count is clamped to >= 0.
    if(url.searchParams.get('admin') === '1'){
      const sentPassword = req.headers.get('x-owner-password') || '';
      if(sentPassword !== OWNER_PASSWORD){
        return json({ error: 'Unauthorized' }, 401);
      }
      const deltaRaw = parseInt(url.searchParams.get('delta'), 10);
      // Accept any integer. NaN or 0 → default to +1 (the common case).
      const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;

      let newCount;
      if(USE_KV){
        // Use atomic INCRBY / DECRBY so concurrent admin taps can't
        // race and lose an increment. This also avoids the GET+SET
        // round-trip which was previously buggy.
        try{
          if(delta > 0){
            const r = await fetch(`${KV_URL_NORM}/INCRBY/${encodeURIComponent('dl:count:' + key)}/${delta}`, {
              method: 'POST',
              headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
            });
            if(r.ok){
              const data = await r.json();
              newCount = parseInt(data.result, 10) || 0;
            } else { newCount = await getCount(key); }
          } else {
            // DECRBY by abs(delta). Note: Redis DECRBY can go negative,
            // so we clamp afterwards if needed.
            const absDelta = Math.abs(delta);
            const r = await fetch(`${KV_URL_NORM}/DECRBY/${encodeURIComponent('dl:count:' + key)}/${absDelta}`, {
              method: 'POST',
              headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
            });
            if(r.ok){
              const data = await r.json();
              newCount = parseInt(data.result, 10) || 0;
            } else { newCount = await getCount(key); }
          }
        }catch(_){ newCount = await getCount(key); }

        // Clamp at 0 — if DECRBY went negative, reset to 0.
        if(newCount < 0){
          await setCount(key, 0);
          newCount = 0;
        }
      } else {
        // In-memory fallback (no KV)
        const current = await getCount(key);
        newCount = Math.max(0, current + delta);
        await setCount(key, newCount);
      }

      return json({ key, count: newCount, admin: true, delta });
    }

    // ─── Normal path: increment with spam check ───
    const ip = getClientIp(req);
    const now = Date.now();
    const last = await getLastClick(ip, key);

    if(last && (now - last) < COOLDOWN_MS){
      // Spam — don't count
      const count = await getCount(key);
      return json({ key, count, counted: false, reason: 'cooldown', retryAfterSec: Math.ceil((COOLDOWN_MS - (now - last)) / 1000) });
    }

    // Count it (atomically)
    const newCount = await incrCount(key);
    await setLastClick(ip, key, now);

    return json({ key, count: newCount, counted: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
