export const config = { runtime: 'edge' };

/* ═══════════════════════════════════════════════════════════════════
   /api/comments — Per-build comment threads
   Methods:
     GET    /api/comments?key=<buildKey>            → { comments: [...] }
     POST   /api/comments?key=<buildKey>            → { comment }   (create)
     DELETE /api/comments?key=<buildKey>&id=<id>    → { ok: true }  (delete)

   Data model:
     {
       id:         string  (unique)
       name:       string  (anonymous display name, e.g. "Thh87")
       creatorId:  string  (per-browser id, used for "is this mine?")
       text:       string  (the comment body)
       parentId:   string|null  (null = top-level, otherwise id of parent)
       createdAt:  number  (ms since epoch)
     }

   Replies are stored flat in the same array (each has a parentId
   pointing at its parent). The client assembles them into a tree
   on render. This keeps the server simple and lets us add new
   reply depths without schema changes.

   Storage (auto-detected, same env vars as /api/issues):
   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
   2. KV_REST_API_URL + KV_REST_API_TOKEN
   3. In-memory Map fallback (per edge instance — NOT cross-user safe).
   ═══════════════════════════════════════════════════════════════════ */

function env(name){
  return (typeof process !== 'undefined' ? process.env?.[name] : undefined)
      ?? (typeof globalThis !== 'undefined' ? globalThis[name] : undefined);
}

const KV_URL   = env('UPSTASH_REDIS_REST_URL')   ?? env('KV_REST_API_URL');
const KV_TOKEN = env('UPSTASH_REDIS_REST_TOKEN') ?? env('KV_REST_API_TOKEN');
const KV_URL_NORM = KV_URL ? KV_URL.replace(/\/+$/, '') : null;
const USE_KV = !!(KV_URL_NORM && KV_TOKEN);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Comments-Storage': USE_KV ? 'upstash-redis' : 'memory-fallback'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

/* In-memory fallback store: { buildKey: [comment, ...] } */
const MEM = new Map();

function sanitizeKey(k){
  return String(k || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
}

async function loadAll(buildKey){
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/GET/${encodeURIComponent('cm:all:' + buildKey)}`, {
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      if(r.ok){
        const data = await r.json();
        if(data && typeof data.result === 'string'){
          const arr = JSON.parse(data.result);
          return Array.isArray(arr) ? arr : [];
        }
        if(data && typeof data.value === 'string'){
          const arr = JSON.parse(data.value);
          return Array.isArray(arr) ? arr : [];
        }
        return [];
      }
      return [];
    }catch(_){ return []; }
  }
  return MEM.get(buildKey) || [];
}

async function saveAll(buildKey, arr){
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/SET/${encodeURIComponent('cm:all:' + buildKey)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {})
        },
        body: JSON.stringify(arr)
      });
      return r.ok;
    }catch(_){ return false; }
  }
  MEM.set(buildKey, arr);
  return true;
}

function genId(){
  return 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeComment(input){
  const name = String(input.name || '').trim().slice(0, 32) || 'Anonymous';
  const text = String(input.text || '').trim().slice(0, 4000);
  const creatorId = input.creatorId ? String(input.creatorId).slice(0, 64) : null;
  // parentId must reference an existing comment in the same build (or be null)
  const parentId = input.parentId ? String(input.parentId).slice(0, 64) : null;
  return {
    id: genId(),
    name,
    creatorId,
    text,
    parentId,
    createdAt: Date.now()
  };
}

export default async function handler(req){
  if(req.method === 'OPTIONS'){
    return new Response(null, { status: 200, headers: CORS });
  }

  const url = new URL(req.url);

  // ── Diagnostic endpoint: /api/comments?diag=1 ──
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
      hint: USE_KV
        ? 'Upstash/KV is configured. Comments will persist across users.'
        : 'No KV env vars detected. Comments are in-memory only and will reset on cold start. Add Upstash env vars and redeploy.'
    });
  }

  const buildKey = sanitizeKey(url.searchParams.get('key'));
  if(!buildKey){
    return json({ error: 'Missing key parameter. Example: /api/comments?key=v1.1' }, 400);
  }

  // ── GET: list all comments for this build ──
  if(req.method === 'GET'){
    const arr = await loadAll(buildKey);
    return json({ comments: arr });
  }

  // ── POST: create a comment ──
  if(req.method === 'POST'){
    let body;
    try{ body = await req.json(); }catch(_){ return json({ error: 'Invalid body' }, 400); }
    if(!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);

    const text = String(body.text || '').trim();
    if(!text) return json({ error: 'Comment text is required' }, 400);
    if(text.length > 4000) return json({ error: 'Comment too long (max 4000 chars)' }, 400);

    const arr = await loadAll(buildKey);

    // If parentId is set, verify the parent exists in this build
    if(body.parentId){
      const parentExists = arr.some(c => c.id === body.parentId);
      if(!parentExists) return json({ error: 'Parent comment not found' }, 404);
    }

    const comment = sanitizeComment(body);
    arr.push(comment);
    await saveAll(buildKey, arr);
    return json({ comment }, 201);
  }

  // ── DELETE: remove a comment ──
  if(req.method === 'DELETE'){
    const id = url.searchParams.get('id');
    if(!id) return json({ error: 'Missing id parameter' }, 400);
    const arr = await loadAll(buildKey);
    const next = arr.filter(c => c.id !== id && c.id !== String(id));
    // Also remove any replies to the deleted comment (cascade)
    let changed = true;
    while(changed){
      changed = false;
      const ids = new Set(next.map(c => c.id));
      const filtered = next.filter(c => !c.parentId || ids.has(c.parentId));
      if(filtered.length !== next.length){
        next.length = 0;
        next.push(...filtered);
        changed = true;
      }
    }
    if(next.length === arr.length) return json({ error: 'Comment not found' }, 404);
    await saveAll(buildKey, next);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
