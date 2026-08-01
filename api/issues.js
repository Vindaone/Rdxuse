export const config = { runtime: 'edge' };

/* ═══════════════════════════════════════════════════════════════════
   /api/issues — Rexus bug tracker endpoint
   Methods:
     GET    /api/issues            → list all issues (newest first)
     POST   /api/issues            → create new issue
     PUT    /api/issues?id=<id>    → update issue (status, ownerResponse, addComment, ...)
     DELETE /api/issues?id=<id>    → delete issue

   Storage strategy (auto-detected):
   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (Upstash native)
   2. KV_REST_API_URL + KV_REST_API_TOKEN                (Vercel KV / Upstash Vercel integration legacy names)
   3. In-memory Map fallback (per edge instance — NOT cross-user safe).

   When you install the Upstash Vercel integration
   (https://vercel.com/integrations/upstash) BOTH naming conventions are
   injected automatically as env vars on your project — no code changes
   required. See README.md for the step-by-step Vercel walkthrough.
   ═══════════════════════════════════════════════════════════════════ */

function env(name){
  return (typeof process !== 'undefined' ? process.env?.[name] : undefined)
      ?? (typeof globalThis !== 'undefined' ? globalThis[name] : undefined);
}

const KV_URL   = env('UPSTASH_REDIS_REST_URL')   ?? env('KV_REST_API_URL');
const KV_TOKEN = env('UPSTASH_REDIS_REST_TOKEN') ?? env('KV_REST_API_TOKEN');
// Strip trailing slash so we don't end up with `//GET/key` (double slash)
const KV_URL_NORM = KV_URL ? KV_URL.replace(/\/+$/, '') : null;
const USE_KV = !!(KV_URL_NORM && KV_TOKEN);

const KV_KEY = 'rexus_issues:all:v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  // Helps you verify in DevTools which backend is actually in use.
  'X-Issues-Storage': USE_KV ? 'upstash-redis' : 'memory-fallback'
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: CORS });

/* In-memory fallback store (per edge instance) */
const MEM = new Map();

async function loadAll(){
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/GET/${encodeURIComponent(KV_KEY)}`, {
        headers: KV_TOKEN ? { 'Authorization': `Bearer ${KV_TOKEN}` } : {}
      });
      if(r.ok){
        const data = await r.json();
        // Upstash returns { result: <string|null> }
        if(data && typeof data.result === 'string'){
          const arr = JSON.parse(data.result);
          return Array.isArray(arr) ? arr : [];
        }
        // Some KV REST variants return { value: ... } — handle both
        if(data && typeof data.value === 'string'){
          const arr = JSON.parse(data.value);
          return Array.isArray(arr) ? arr : [];
        }
        return [];
      }
      return [];
    }catch(_){ return []; }
  }
  return Array.from(MEM.values());
}

async function saveAll(arr){
  if(USE_KV){
    try{
      const r = await fetch(`${KV_URL_NORM}/SET/${encodeURIComponent(KV_KEY)}`, {
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
  MEM.clear();
  for(const it of arr) MEM.set(it.id, it);
  return true;
}

function genId(){
  return 'is_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Categories are Rexus-app-specific (not the source project's web/model split):
   - app         → App issues: crashes, freezes, install failures, update loops, signature conflicts, launcher bugs
   - game        → Game launch issues: game won't start after Rexus loads it, world won't load, in-game errors
   - suggestion  → Feature requests, UI/UX improvements, ideas to make Rexus better
   Add new keys here and the client will accept them automatically. */
const VALID_CATEGORIES = ['app', 'game', 'suggestion'];

function sanitizeIssue(input){
  const title = String(input.title || '').trim().slice(0, 200);
  const summary = String(input.summary || '').trim().slice(0, 500);
  const description = String(input.description || '').trim().slice(0, 8000);
  const reason = String(input.reason || '').trim().slice(0, 4000);
  const category = (VALID_CATEGORIES.includes(input.category) ? input.category : 'app');
  const stepsToReproduce = String(input.stepsToReproduce || '').trim().slice(0, 4000);
  const expectedBehavior = String(input.expectedBehavior || '').trim().slice(0, 2000);
  const actualBehavior = String(input.actualBehavior || '').trim().slice(0, 2000);
  const creatorId = input.creatorId ? String(input.creatorId).slice(0, 64) : null;
  return {
    id: genId(),
    title, summary, description, reason, category,
    stepsToReproduce, expectedBehavior, actualBehavior,
    status: 'open',
    ownerResponse: '',
    comments: [],
    creatorId,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function genCommentId(){
  return 'ic_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeComment(input){
  const author = input.author === 'owner' ? 'owner' : 'user';
  const text = String(input.text || '').trim().slice(0, 4000);
  const name = author === 'user' && input.name ? String(input.name).trim().slice(0, 16) : null;
  const creatorId = author === 'user' && input.creatorId ? String(input.creatorId).slice(0, 64) : null;
  return {
    id: genCommentId(),
    author,
    name,
    creatorId,
    text,
    createdAt: Date.now()
  };
}

function patchIssue(existing, patch){
  const allowed = ['status','ownerResponse','title','summary','description','reason','category','stepsToReproduce','expectedBehavior','actualBehavior'];
  const out = Object.assign({}, existing);
  if(!Array.isArray(out.comments)) out.comments = [];
  for(const k of allowed){
    if(patch[k] !== undefined){
      if(k === 'status'){
        const v = String(patch[k]);
        if(['open','fixed','closed'].includes(v)) out.status = v;
      } else if(k === 'category'){
        const v = String(patch[k]);
        if(VALID_CATEGORIES.includes(v)) out.category = v;
      } else {
        out[k] = String(patch[k]).slice(0, 8000);
      }
    }
  }
  // addComment: { author: 'owner'|'user', text: '...' }
  if(patch.addComment && typeof patch.addComment === 'object'){
    const text = String(patch.addComment.text || '').trim();
    if(text){
      const comment = sanitizeComment(patch.addComment);
      out.comments = out.comments.concat([comment]);
      // Keep legacy ownerResponse in sync so older clients still see the latest owner reply.
      if(comment.author === 'owner') out.ownerResponse = comment.text;
    }
  }
  // removeComment: '<commentId>'
  if(patch.removeComment){
    const cid = String(patch.removeComment);
    out.comments = out.comments.filter(c => c.id !== cid);
    // If the removed comment was the most recent owner reply, keep legacy
    // ownerResponse pointed at whatever the newest remaining owner reply is.
    const remainingOwner = out.comments.filter(c => c.author === 'owner');
    out.ownerResponse = remainingOwner.length ? remainingOwner[remainingOwner.length - 1].text : '';
  }
  out.updatedAt = Date.now();
  return out;
}

export default async function handler(req){
  if(req.method === 'OPTIONS'){
    return new Response(null, { status: 200, headers: CORS });
  }

  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');

  // ── GET: list all ──
  if(req.method === 'GET'){
    // Diagnostic endpoint: /api/issues?diag=1
    // Returns which env vars are present (names only, never values) so you
    // can verify the Edge Function actually sees your Vercel env vars.
    // If you added env vars in Vercel but issues still reset, hit this URL
    // in your browser to check.
    if(url.searchParams.get('diag') === '1'){
      return json({
        storage: USE_KV ? 'upstash-redis' : 'memory-fallback',
        kvConfigured: USE_KV,
        envVarsPresent: {
          UPSTASH_REDIS_REST_URL:    !!env('UPSTASH_REDIS_REST_URL'),
          UPSTASH_REDIS_REST_TOKEN:  !!env('UPSTASH_REDIS_REST_TOKEN'),
          KV_REST_API_URL:           !!env('KV_REST_API_URL'),
          KV_REST_API_TOKEN:         !!env('KV_REST_API_TOKEN'),
          KV_URL:                    !!env('KV_URL'),
          REDIS_URL:                 !!env('REDIS_URL')
        },
        kvUrlSample: KV_URL_NORM ? KV_URL_NORM.slice(0, 30) + '...' : null,
        kvTokenPresent: !!KV_TOKEN,
        kvKey: KV_KEY,
        validCategories: VALID_CATEGORIES,
        hint: USE_KV
          ? 'Upstash/KV is configured. Issues should persist. If they still reset, check that the URL + token are correct and that you REDEPLOYED after adding the env vars.'
          : 'No KV env vars detected by the Edge Function. If you added them in Vercel, you MUST redeploy for the Edge Function to see them. Env vars are baked in at deploy time.'
      });
    }

    const arr = await loadAll();
    arr.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    return json({ issues: arr });
  }

  // ── POST: create ──
  if(req.method === 'POST'){
    let body;
    try{ body = await req.json(); }catch(_){ return json({ error: 'Invalid body' }, 400); }
    if(!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);

    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    if(!title) return json({ error: 'Title is required' }, 400);
    if(!description) return json({ error: 'Description is required' }, 400);

    // Duplicate check
    const arr = await loadAll();
    const dup = arr.find(i => i.title === title && i.description === description);
    if(dup) return json({ error: 'An identical issue already exists' }, 409);

    const issue = sanitizeIssue(body);
    arr.push(issue);
    await saveAll(arr);
    return json({ issue }, 201);
  }

  // ── PUT: update ──
  if(req.method === 'PUT'){
    let body;
    try{ body = await req.json(); }catch(_){ return json({ error: 'Invalid body' }, 400); }
    const id = body?.id || idParam;
    const patch = body?.patch || {};
    if(!id) return json({ error: 'Issue id required' }, 400);

    const arr = await loadAll();
    const idx = arr.findIndex(i => i.id === id);
    if(idx < 0) return json({ error: 'Issue not found' }, 404);
    const updated = patchIssue(arr[idx], patch);
    arr[idx] = updated;
    await saveAll(arr);
    return json({ issue: updated });
  }

  // ── DELETE ──
  if(req.method === 'DELETE'){
    const id = idParam;
    if(!id) return json({ error: 'Issue id required' }, 400);
    const arr = await loadAll();
    const next = arr.filter(i => i.id !== id);
    if(next.length === arr.length) return json({ error: 'Issue not found' }, 404);
    await saveAll(next);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
