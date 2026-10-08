// My stuff: "import-link"
// You share a TikTok link -> this reads the post (caption, hashtags, location tag, thumbnail),
// asks Claude which places it is about, finds them on the map and adds them to your Places.
// Anything it can't place goes to the Inbox in Places, so no link gets lost.
//
// Needs these Supabase secrets (Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY  your Claude API key (the AI part)
//   SHARE_KEY          (optional) a password for the iPhone Shortcut
// Supabase provides SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY by itself.

type Env = { get(name: string): string | undefined };
type Json = any;

const MAPTILER_KEY = 'Sj7uPgiD4robO84xYBok';
const MODEL = 'claude-haiku-4-5-20251001';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-share-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------------- small helpers ----------------
const fold = (s: unknown) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();   // keeps letters of any script (Chinese, Thai…)
function nameScore(want: string, got: string): number {
  const a = fold(want), b = fold(got);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if ((a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))) return 0.85;
  const ta = new Set(a.split(' ').filter((w) => w.length > 1)), tb = new Set(b.split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let common = 0; ta.forEach((w) => { if (tb.has(w)) common++; });
  return common / Math.max(ta.size, tb.size);
}
function metres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const k = Math.PI / 180, dx = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k), dy = (lat2 - lat1) * k;
  return Math.sqrt(dx * dx + dy * dy) * 6371000;
}
function newId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b).map((x) => abc[x % 62]).join('');
}
const EMOJI: [RegExp, string][] = [[/PIZZ/, '🍕'], [/SUSHI|JAPANESE/, '🍣'], [/RAMEN|NOODLE|ASIAN|CHINESE|VIETNAM|THAI|KOREAN/, '🍜'],
  [/BAKERY|PASTRY|DESSERT|ICE.?CREAM/, '🍰'], [/CAFE|COFFEE|TEA/, '☕'], [/PUB|BAR|BREWERY|BEER|WINE/, '🍺'],
  [/CLUB|CONCERT|MUSIC/, '🎵'], [/RESTAURANT|FOOD|BISTRO|GRILL|BURGER|STREET.?FOOD/, '🍽️'], [/HOTEL|HOSTEL|LODGING|APARTMENT|CAMPING/, '🏨'],
  [/MUSEUM|GALLERY/, '🏛️'], [/CHURCH|CATHEDRAL|TEMPLE|MONASTERY/, '⛪'], [/CASTLE|FORTRESS|PALACE/, '🏰'], [/PARK|GARDEN|FOREST|NATURE/, '🌳'],
  [/BEACH/, '🏖️'], [/MOUNTAIN|PEAK|HIKE|HIKING|LAKE|WATERFALL/, '⛰️'], [/THEAT|CINEMA|OPERA/, '🎭'], [/ZOO|AQUARIUM|AMUSEMENT/, '🎡'],
  [/STATION|AIRPORT/, '🚉'], [/SHOP|STORE|MARKET|MALL|BOUTIQUE|VINTAGE/, '🛍️'], [/VIEW|ATTRACTION|MONUMENT|LANDMARK|BRIDGE|SQUARE/, '📸']];
const emojiFor = (kind: string) => { const k = String(kind || '').toUpperCase(); for (const [re, e] of EMOJI) if (re.test(k)) return e; return '📍'; };

// ---------------- your Supabase (data + photos) ----------------
function sb(env: Env, fetchFn: typeof fetch) {
  const url = env.get('SUPABASE_URL')!, key = env.get('SUPABASE_SERVICE_ROLE_KEY') || env.get('SB_SECRET_KEY') || '';
  const headers = (extra: Record<string, string> = {}) =>
    ({ apikey: key, ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }), ...extra });
  return {
    url,
    async userFromToken(token: string) {
      const r = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: env.get('SUPABASE_ANON_KEY') || key, Authorization: `Bearer ${token}` } });
      return r.ok ? await r.json() : null;
    },
    async onlyUser() {               // the app has one user (sign-ups are off): the Shortcut adds to theirs
      const r = await fetchFn(`${url}/auth/v1/admin/users?per_page=2`, { headers: headers() });
      if (!r.ok) return null;
      const j = await r.json(), list = j.users || j;
      return Array.isArray(list) && list.length === 1 ? list[0] : null;
    },
    async find(uid: string, srcId: string, link: string) {
      const q = (f: string) => `${url}/rest/v1/docs?select=col,id,data&user_id=eq.${uid}&col=in.(places,inbox)&${f}`;
      for (const f of [srcId ? `data->>srcId=eq.${encodeURIComponent(srcId)}` : '', `data->>link=eq.${encodeURIComponent(link)}`, `data->>url=eq.${encodeURIComponent(link)}`]) {
        if (!f) continue;
        const r = await fetchFn(q(f), { headers: headers() });
        if (r.ok) { const rows = await r.json(); if (rows.length) return rows; }
      }
      return [];
    },
    async save(uid: string, col: string, id: string, data: Json) {
      const r = await fetchFn(`${url}/rest/v1/docs?on_conflict=user_id,col,id`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ user_id: uid, col, id, data, updated_at: new Date().toISOString() }]),
      });
      if (!r.ok) throw new Error('save failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    },
    async remove(uid: string, col: string, id: string) {
      await fetchFn(`${url}/rest/v1/docs?user_id=eq.${uid}&col=eq.${col}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() });
    },
    async savePhoto(uid: string, bytes: Uint8Array, type: string) {
      const id = crypto.randomUUID();
      const r = await fetchFn(`${url}/storage/v1/object/photos/${uid}/${id}`, {
        method: 'POST', headers: headers({ 'Content-Type': type, 'cache-control': 'max-age=31536000' }), body: new Blob([bytes as BlobPart], { type }),
      });
      return r.ok ? `${url}/storage/v1/object/public/photos/${uid}/${id}` : '';
    },
  };
}

// ---------------- reading a TikTok ----------------
const isTikTok = (u: string) => /(^|\.)tiktok\.com$/i.test(hostOf(u));
const isInstagram = (u: string) => /(^|\.)instagram\.com$/i.test(hostOf(u));
const isGoogleShort = (u: string) => /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i.test(hostOf(u));

// a short Google Maps link from the phone ("maps.app.goo.gl/…") -> the full link with the place and its coordinates
async function openGoogleShort(link: string, fetchFn: typeof fetch) {
  let u = link, lat: number | null = null, lng: number | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await fetchFn(u, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    const loc = r.headers.get('location');
    if (!loc) {
      // no more hops: the page itself may say where the map is centred
      const html = r.status === 200 ? await r.text() : '';
      const m = /APP_INITIALIZATION_STATE=\[\[\[[\d.]+,(-?\d+\.\d+),(-?\d+\.\d+)\]/.exec(html);
      if (m) { lng = +m[1]; lat = +m[2]; }
      break;
    }
    let next = new URL(loc, u).href;
    if (/(^|\.)consent\.google\./i.test(hostOf(next))) {       // Europe: Google's cookie page carries the real address inside
      const c = new URL(next).searchParams.get('continue'); if (c) next = c; else break;
    }
    u = next;
    if (/google\.[a-z.]+\/maps/i.test(u) && /(!3d-?\d|@-?\d+\.\d+,-?\d+\.\d+)/.test(decodeURIComponent(u))) break;
  }
  return { resolved: u, lat, lng };
}
function hostOf(u: string) { try { return new URL(u).hostname; } catch { return ''; } }
const videoId = (u: string) => (/\/(?:video|photo)\/(\d{8,})/.exec(u) || [])[1] || '';

async function readTikTok(link: string, fetchFn: typeof fetch) {
  const out: Json = { link, finalUrl: link, caption: '', author: '', hashtags: [] as string[], poi: null, place: '', thumb: '', id: videoId(link) };
  let html = '';
  // short links (vm.tiktok.com/…, tiktok.com/t/…) lead to the real video address
  try {
    const r = await fetchFn(link, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
    out.finalUrl = r.url || link; out.id = out.id || videoId(out.finalUrl);
    html = await r.text();
  } catch (_) { /* the oEmbed below may still work */ }
  // photo slideshows: TikTok leaves the description out of the /photo/ page and refuses it in oEmbed,
  // but gives the full post when asked for the same number as a /video/ address
  const photo = /^(https:\/\/www\.tiktok\.com\/@[^/?#]+)\/photo\/(\d{8,})/.exec(out.finalUrl) || /^(https:\/\/www\.tiktok\.com\/@[^/?#]+)\/photo\/(\d{8,})/.exec(link);
  if (photo) {
    out.finalUrl = `${photo[1]}/video/${photo[2]}`; out.id = out.id || photo[2]; out.photo = true;
    try {
      const r = await fetchFn(out.finalUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
      if (r.ok) html = await r.text();
    } catch (_) { /* keep what we have */ }
  }
  try {
    const r = await fetchFn(`https://www.tiktok.com/oembed?url=${encodeURIComponent(out.finalUrl)}`, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const j = await r.json();
      out.caption = j.title || ''; out.author = j.author_unique_id || j.author_name || ''; out.thumb = j.thumbnail_url || '';
    }
  } catch (_) { /* ignore */ }
  // the page itself carries more: the location tag, hashtags, a better caption
  const m = /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (m) {
    try {
      const d = JSON.parse(m[1]), it = d?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (it) {
        out.caption = it.desc || out.caption;
        out.author = it.author?.uniqueId || out.author;
        out.hashtags = (it.textExtra || []).map((t: Json) => t.hashtagName).filter(Boolean);
        if (it.poi && it.poi.name) {
          out.poi = { name: it.poi.name, address: it.poi.address || '', city: it.poi.city || '', region: it.poi.province || '', country: it.poi.country || '', kind: it.poi.ttTypeNameMedium || it.poi.ttTypeNameSuper || '' };
        }
        out.place = it.locationCreated || '';
        out.thumb = it.video?.cover || it.video?.originCover || out.thumb;
        out.id = out.id || it.id || '';
      }
    } catch (_) { /* layout changed: we still have the oEmbed caption */ }
  }
  return out;
}

// the top comments (people often ask "where is this?" and the creator answers there).
// TikTok has no official way to read them, so this may stop working; then it simply returns nothing.
async function readComments(id: string, author: string, fetchFn: typeof fetch) {
  if (!id) return [] as Json[];
  try {
    const r = await fetchFn(`https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${id}&count=40&cursor=0`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `https://www.tiktok.com/@${author || '_'}/video/${id}` },
    });
    if (!r.ok) return [];
    const t = await r.text(); if (!t || t[0] !== '{') return [];
    const j = JSON.parse(t), me = String(author || '').toLowerCase(), out: Json[] = [];
    const add = (c: Json) => {
      const text = String(c?.text || '').trim(); if (!text) return;
      out.push({ text: text.slice(0, 220), likes: +c.digg_count || 0, creator: !!me && String(c.user?.unique_id || '').toLowerCase() === me });
    };
    (j.comments || []).forEach((c: Json) => { add(c); (c.reply_comment || []).forEach(add); });
    return out.sort((a, b) => (+b.creator - +a.creator) || (b.likes - a.likes)).slice(0, 25);
  } catch (_) { return []; }
}

// ---------------- asking Claude which places the post is about ----------------
async function askClaude(post: Json, thumb: { b64: string; type: string } | null, apiKey: string, fetchFn: typeof fetch, hint = '') {
  const facts = [
    hint ? `IMPORTANT, from the person who saved it (trust this most): ${hint}` : '',
    `Caption: ${post.caption || '(none)'}`,
    post.hashtags.length ? `Hashtags: ${post.hashtags.map((h: string) => '#' + h).join(' ')}` : '',
    post.poi ? `Location tag on the video: ${[post.poi.name, post.poi.address, post.poi.city, post.poi.country].filter(Boolean).join(', ')}` : '',
    post.author ? `Posted by: @${post.author}` : '',
    post.comments && post.comments.length ? `Top comments (people often ask where it is; the creator's answers are marked):\n` +
      post.comments.map((c: Json) => `- ${c.creator ? '[creator] ' : ''}${c.text}`).join('\n') : '',
  ].filter(Boolean).join('\n');
  const content: Json[] = [];
  if (thumb) content.push({ type: 'image', source: { type: 'base64', media_type: thumb.type, data: thumb.b64 } });
  content.push({ type: 'text', text:
`This is a TikTok post someone saved because they want to visit the place(s) in it. ${thumb ? 'The image is its cover picture.' : ''}
${facts}

Which specific places is it about? Only real, specific places someone could put on a map: restaurants, cafés, bars, bakeries, shops, hotels, museums, viewpoints, parks, beaches, hikes, attractions. Not just a city or country, unless the post is about a natural spot that has its own name.
Never guess or invent a place. If the post doesn't make clear which place it is, return no places.
Separately, say which city or area (and country) the post is in, if that is clear from anything above (caption, hashtags, comments, picture), even when the exact place isn't.

Answer with JSON only, nothing else:
{"places":[{"name":"exact place name","local_name":"the name in the local language and script if you know it (e.g. Chinese characters), else empty","city":"city","country":"country","address":"street address if stated, else empty","kind":"one word: cafe/restaurant/bar/bakery/shop/hotel/museum/viewpoint/park/beach/hike/attraction/other","sure":0.0}],"area":{"city":"city or area, else empty","country":"country, else empty"},"about":"what the post is about, max 10 words"}
"sure" is how certain you are (0 to 1) that this exact place is meant. List every place the post recommends, at most 30.` });
  const r = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error('claude ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const text = (j.content || []).filter((c: Json) => c.type === 'text').map((c: Json) => c.text).join('');
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  const parsed = s >= 0 && e > s ? JSON.parse(text.slice(s, e + 1)) : { places: [] };
  const area = parsed.area && (parsed.area.city || parsed.area.country) ? { city: String(parsed.area.city || ''), country: String(parsed.area.country || '') } : null;
  return { places: Array.isArray(parsed.places) ? parsed.places.slice(0, 30) : [], area, about: String(parsed.about || ''), usage: j.usage || null };
}

// ---------------- finding a place on the map ----------------
async function maptiler(q: string, fetchFn: typeof fetch, extra = '') {
  const r = await fetchFn(`https://api.maptiler.com/geocoding/${encodeURIComponent(q)}.json?key=${MAPTILER_KEY}&limit=6${extra}`);
  return r.ok ? ((await r.json()).features || []) : [];
}
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// OpenStreetMap's free lookup can be slow: give each try at most 12 seconds, and don't wait for a second server after a timeout
async function overpass(q: string, fetchFn: typeof fetch) {
  for (const u of OVERPASS) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetchFn(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: ctl.signal });
      if (r.ok) return (await r.json()).elements || [];
    } catch (_) {
      if (ctl.signal.aborted) return [];
    } finally { clearTimeout(t); }
  }
  return [];
}
async function locate(p: Json, fetchFn: typeof fetch) {
  const name = String(p.name || '').trim(); if (!name) return null;
  const local = String(p.local_name || '').trim();
  const names = [name, ...(local && local !== name ? [local] : [])];
  const where = [p.city, p.country].filter(Boolean).join(', ');
  // 1) the map search: "Name, street, City, Country" (and the same with the local name)
  let best: Json = null, bestScore = 0;
  for (const n of names) {
    const feats = await maptiler([n, p.address, where].filter(Boolean).join(', '), fetchFn);
    for (const f of feats) {
      const s = Math.max(...names.map((x) => nameScore(x, f.text || ''))) + ((f.place_type || []).includes('poi') ? 0.1 : 0)
        + (p.city && fold(f.place_name).includes(fold(p.city)) ? 0.1 : 0);
      if (s > bestScore) { bestScore = s; best = f; }
    }
    if (best && bestScore >= 0.8) break;
  }
  if (best && bestScore >= 0.8) return { lat: best.center[1], lng: best.center[0], address: best.place_name || '', how: 'map' };
  // 2) OpenStreetMap: a place with that name around the city
  if (p.city) {
    const city = (await maptiler(where, fetchFn, '&types=municipality,locality,place,county,region'))[0] || (await maptiler(where, fetchFn))[0];
    if (city && city.center) {
      const [lng, lat] = city.center;
      // exact name matches (fast): the name as written, its English name, or the local name
      const keys = ['name', 'name:en', 'name:zh', 'name:ja', 'name:ko', 'name:th'];
      const variants = Array.from(new Set(names.flatMap((n) => [n, n.replace(/\b\w/g, (c) => c.toUpperCase())])));
      const q = variants.flatMap((n) => keys.map((k) => `nwr(around:20000,${lat},${lng})["${k}"="${n.replace(/["\\]/g, '')}"];`)).join('');
      const els = await overpass(`[out:json][timeout:12];(${q});out tags center 20;`, fetchFn);
      let pick: Json = null, pd = Infinity;
      for (const e of els) {
        const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon; if (la == null) continue;
        const d = metres(lat, lng, la, lo); if (d < pd) { pd = d; pick = { lat: la, lng: lo, tags: e.tags || {}, ref: e.type + '/' + e.id }; }
      }
      if (pick) {
        const t = pick.tags, street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
        return { lat: pick.lat, lng: pick.lng, address: [street, t['addr:city'] || p.city].filter(Boolean).join(', '), osm: pick.ref, how: 'osm' };
      }
    }
  }
  return null;
}

// ---------------- the whole job ----------------
// no single outside service may hold everything up: each request gets at most 25 seconds
const withTimeout = (fn: typeof fetch, ms: number) => ((input: any, init: any = {}) => {
  if (init.signal) return fn(input, init);
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  return fn(input, { ...init, signal: c.signal }).finally(() => clearTimeout(t));
}) as typeof fetch;

export async function handle(req: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  fetchFn = withTimeout(fetchFn, 25000);
  const started = Date.now();
  if (req.method !== 'POST') return reply({ ok: false, error: 'Use POST' }, 405);
  const db = sb(env, fetchFn);

  // who is asking: you in the app (logged in), or your iPhone Shortcut (with the share password)
  let user: Json = null;
  const shareKey = req.headers.get('x-share-key') || '', wantKey = env.get('SHARE_KEY') || '';
  if (shareKey && wantKey && shareKey === wantKey) user = await db.onlyUser();
  else {
    const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (tok && tok.split('.').length === 3) user = await db.userFromToken(tok);
  }
  if (!user || !user.id) return reply({ ok: false, error: 'Not allowed. Log in to the app, or check the Shortcut password.' }, 401);
  const uid = user.id;

  // the link (the Shortcut may send the whole shared text)
  const raw = await req.text();
  let text = raw, hint = '', inboxId = '';
  try { const j = JSON.parse(raw); text = j.url || j.text || raw; hint = String(j.hint || '').slice(0, 500).trim(); inboxId = String(j.inboxId || ''); } catch (_) { /* plain text */ }
  const link = (/https?:\/\/[^\s"'<>]+/.exec(String(text)) || [])[0] || '';
  if (!link) return reply({ ok: false, error: 'No link found.' }, 400);
  if (isGoogleShort(link)) {
    try { const g = await openGoogleShort(link, fetchFn); return reply({ ok: true, resolved: g.resolved, lat: g.lat, lng: g.lng }); }
    catch (_) { return reply({ ok: false, error: "Couldn't open that Google Maps link." }); }
  }
  if (isInstagram(link)) {
    const id = newId();
    await db.save(uid, 'inbox', id, { url: link, source: 'instagram', caption: '', reason: "Instagram links can't be read yet. Pin it yourself.", createdAt: new Date().toISOString() });
    return reply({ ok: true, added: [], inbox: id, message: "Instagram isn't supported yet, so it's in your Inbox." });
  }
  if (!isTikTok(link)) return reply({ ok: false, error: "That's not a TikTok link." }, 400);

  const post = await readTikTok(link, fetchFn);
  const canon = post.id ? `https://www.tiktok.com/@${post.author || '_'}/${post.photo ? 'photo' : 'video'}/${post.id}` : post.finalUrl;
  const srcId = post.id ? 'tiktok:' + post.id : '';

  // shared it before? a second tap within 2 minutes is a double tap: stop there.
  // Later, sharing it again means "look again": only places not on the map yet are added.
  const already: Json[] = await db.find(uid, srcId, link);
  const havePlaces = already.filter((r: Json) => r.col === 'places');
  const oldInbox = already.find((r: Json) => r.col === 'inbox');
  if (!inboxId && already.length) {
    const fresh = already.some((r: Json) => Date.now() - Date.parse(r.data?.createdAt || '') < 120000);
    if (fresh) {
      const names = havePlaces.map((r: Json) => r.data.name);
      return reply({ ok: true, duplicate: true, added: [], message: names.length ? `Already on your map: ${names.join(', ')}` : 'Already in your Inbox.' });
    }
    if (oldInbox) inboxId = oldInbox.id;                // reuse its Inbox entry instead of making a second one
  }
  const onMap = (n: string) => havePlaces.some((r: Json) => nameScore(n, r.data?.name || '') >= 0.8);

  // keep a copy of the cover picture (TikTok's own picture links expire)
  let thumb: { b64: string; type: string; bytes: Uint8Array } | null = null;
  if (post.thumb) {
    try {
      const r = await fetchFn(post.thumb, { headers: { 'User-Agent': UA } });
      const type = (r.headers.get('content-type') || '').split(';')[0];
      if (r.ok && /^image\/(jpeg|png|webp|gif)$/.test(type)) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length < 1500000) {
          let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          thumb = { b64: btoa(bin), type, bytes };
        }
      }
    } catch (_) { /* no picture then */ }
  }
  const thumbUrl = thumb ? await db.savePhoto(uid, thumb.bytes, thumb.type) : '';

  // which places? (the location tag alone is enough when there's no AI key)
  let guesses: Json[] = [], about = '', aiError = '', area: Json = null;
  const key = env.get('ANTHROPIC_API_KEY') || '';
  if (key) post.comments = await readComments(post.id, post.author, fetchFn);
  if (key && (post.caption || post.poi || thumb || hint)) {
    try { const a = await askClaude(post, thumb, key, fetchFn, hint); guesses = a.places; about = a.about; area = a.area; }
    catch (e) { aiError = String((e as Error).message || e); }
  }
  if (!area && post.poi && (post.poi.city || post.poi.country)) area = { city: post.poi.city, country: post.poi.country };
  // places without a city: use the post's city
  if (area) guesses.forEach((g) => { if (!g.city) g.city = area.city; if (!g.country) g.country = area.country; });
  if (post.poi && !guesses.some((g) => nameScore(g.name, post.poi.name) >= 0.8)) {
    guesses.unshift({ name: post.poi.name, city: post.poi.city, country: post.poi.country, address: post.poi.address, kind: post.poi.kind, sure: 0.95 });
  }
  guesses = guesses.filter((g) => g && g.name && (g.sure == null || g.sure >= 0.5));
  const before = guesses.length;
  guesses = guesses.filter((g) => !onMap(g.name));      // already on your map from this post
  const skipped = before - guesses.length;

  const now = new Date().toISOString(), added: Json[] = [], missed: Json[] = [];
  // look several places up at the same time; if time runs short, the rest go to the Inbox (nothing is lost)
  const one = async (g: Json) => {
    if (Date.now() - started > 95000) { missed.push(g); return; }
    const at = await locate(g, fetchFn);
    if (!at) { missed.push(g); return; }
    const id = newId();
    await db.save(uid, 'places', id, {
      name: String(g.name).slice(0, 120), emoji: emojiFor(g.kind), color: 'red', status: 'want', note: '',
      link: canon, gmapsUrl: '', address: at.address || '', lat: at.lat, lng: at.lng,
      source: 'tiktok', srcId, review: true, needsInfo: true, thumbUrl, author: post.author || '',
      caption: String(post.caption || '').slice(0, 400), ...(at.osm ? { osm: at.osm } : {}),
      createdAt: now, updatedAt: now,
    });
    added.push({ id, name: g.name });
  };
  for (let i = 0; i < guesses.length; i += 5) await Promise.all(guesses.slice(i, i + 5).map(one));
  // where roughly: the city, so "Pin it" can start there
  let areaAt: Json = null;
  if (area && (area.city || area.country)) {
    const name = [area.city, area.country].filter(Boolean).join(', ');
    const f = (await maptiler(name, fetchFn))[0];
    if (f && f.center) areaAt = { name, lat: f.center[1], lng: f.center[0] };
  }
  let inbox = '';
  if (skipped && !guesses.length) {                     // nothing new in it
    if (inboxId) await db.remove(uid, 'inbox', inboxId);
    return reply({ ok: true, duplicate: true, added: [], message: `Nothing new. Already on your map: ${havePlaces.map((r: Json) => r.data.name).join(', ')}` });
  }
  if (inboxId && added.length && !missed.length) await db.remove(uid, 'inbox', inboxId);       // helped: it's on the map now
  if (!added.length || missed.length) {
    inbox = inboxId || newId();
    await db.save(uid, 'inbox', inbox, {
      url: canon, source: 'tiktok', srcId, caption: String(post.caption || '').slice(0, 400), author: post.author || '', thumbUrl, about,
      ...(areaAt ? { area: areaAt } : {}), ...(hint ? { hint } : {}),
      guesses: missed.map((g) => ({ name: g.name, city: g.city || '', ...(g.local_name ? { local: g.local_name } : {}) })).slice(0, 30),
      reason: !guesses.length ? (aiError ? "Couldn't read it this time." : !key ? 'The AI key is missing, and the video has no location tag.'
          : hint ? "Still couldn't tell which place it is." : "Couldn't tell which place it is.")
        : added.length ? `Found ${added.length}, but couldn't find ${missed.length > 3 ? missed.length + ' others' : missed.map((g) => g.name).join(', ')} on the map.` : "Couldn't find it on the map.",
      createdAt: now,
    });
  }
  const message = added.length
    ? `Added ${added.length > 3 ? added.length + ' places' : added.map((a) => a.name).join(', ')} to your map${inbox ? ' (some went to the Inbox)' : ''}.`
    : `Couldn't place it${areaAt ? ` (somewhere in ${areaAt.name})` : ''}, so it's in your Inbox.`;
  return reply({ ok: true, added, inbox: inbox || null, area: areaAt, message,
    debug: { caption: !!post.caption, poi: !!post.poi, thumb: !!thumb, comments: (post.comments || []).length, ai: key ? (aiError || 'ok') : 'no key' } });
}

// Supabase runs this
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D && D.serve) D.serve((req: Request) => handle(req, D.env).catch((e: unknown) => reply({ ok: false, error: String((e as Error)?.message || e) }, 500)));
