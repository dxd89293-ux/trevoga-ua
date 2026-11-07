import { sendPushNotification } from "@mmmike/web-push/send";

const REGIONS = {
  "vinnytska":"Вінницька область","volynska":"Волинська область",
  "dnipropetrovska":"Дніпропетровська область","donetska":"Донецька область",
  "zhytomyrska":"Житомирська область","zakarpatska":"Закарпатська область",
  "zaporizka":"Запорізька область","ivano-frankivska":"Івано-Франківська область",
  "kyivska":"Київська область","kirovohradska":"Кіровоградська область",
  "luhanska":"Луганська область","lvivska":"Львівська область",
  "mykolaivska":"Миколаївська область","odeska":"Одеська область",
  "poltavska":"Полтавська область","rivnenska":"Рівненська область",
  "sumska":"Сумська область","ternopilska":"Тернопільська область",
  "kharkivska":"Харківська область","khersonska":"Херсонська область",
  "khmelnytska":"Хмельницька область","cherkaska":"Черкаська область",
  "chernivetska":"Чернівецька область","chernihivska":"Чернігівська область",
  "kyiv":"місто Київ"
};

const norm = value => String(value || "").toLocaleLowerCase("uk").replace(/[’'\x60]/g, "").replace(/\s+/g, " ").trim();
function timestampOf(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", ...headers }
});
const corsHeaders = origin => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  "vary": "Origin"
});
function allowedPushHost(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return h === "fcm.googleapis.com" ||
      h.endsWith(".push.services.mozilla.com") ||
      h === "push.services.mozilla.com" ||
      h.endsWith(".push.apple.com") ||
      h === "web.push.apple.com" ||
      h.endsWith(".notify.windows.com");
  } catch { return false; }
}
async function keyFor(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "sub:" + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Source HTTP " + response.status);
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid source payload");
    // NEPTUN /api/v1/alerts does not promise a timestamp in its JSON body.
    // Record fetch time and HTTP cache metadata so freshness can be evaluated honestly.
    const ageSeconds = Number(response.headers.get("Age"));
    const dateHeader = Date.parse(response.headers.get("Date") || "");
    return {
      ...data,
      _fetchedAt: Date.now(),
      _httpDate: Number.isFinite(dateHeader) ? dateHeader : null,
      _cacheAgeMs: Number.isFinite(ageSeconds) && ageSeconds >= 0 ? ageSeconds * 1000 : 0
    };
  } finally { clearTimeout(timer); }
}
function currentStates(neptun, tryvoha) {
  const oblasts = Array.isArray(neptun?.oblasts) ? neptun.oblasts : [];
  const raions = Array.isArray(neptun?.raions) ? neptun.raions : [];
  // NEPTUN is the primary alert source. Tryvoha is auxiliary and cannot block primary-state push events.
  const sourceStamp = timestampOf(neptun?.serverTime || neptun?.updated_at || neptun?.updatedAt || neptun?.timestamp);
  const receivedAt = Number(neptun?._fetchedAt) || 0;
  const httpDate = Number(neptun?._httpDate) || 0;
  const cacheAgeMs = Number(neptun?._cacheAgeMs) || 0;
  const sourceAgeMs = sourceStamp > 0 ? Date.now() - sourceStamp : httpDate > 0 ? Date.now() - httpDate : receivedAt > 0 ? Date.now() - receivedAt : Infinity;
  const neptunFresh = sourceAgeMs >= -30000 && sourceAgeMs + cacheAgeMs < 180000;
  if (!Array.isArray(neptun?.oblasts) || !Array.isArray(neptun?.raions) || !neptunFresh) return null;

  const states = {};
  for (const [slug, name] of Object.entries(REGIONS)) {
    const nFull = oblasts.some(x => norm(x.name) === norm(name) || norm(x.oblast) === norm(name));
    const nPart = raions.some(x => norm(x.oblast) === norm(name));
    // Region alert state is determined by NEPTUN only; auxiliary feeds never override it.
    states[slug] = nFull || nPart;
  }
  return states;
}
async function allSubscriptions(env) {
  const result = [];
  let cursor;
  do {
    const page = await env.SUBSCRIPTIONS.list({ prefix: "sub:", cursor, limit: 1000 });
    for (const item of page.keys) {
      const value = await env.SUBSCRIPTIONS.get(item.name);
      if (value) {
        try {
          const parsed = JSON.parse(value);
          const wrapped = parsed && parsed.subscription;
          const { regions: savedRegions, vibration: savedVibration, subscription: ignoredWrapped, ...legacySubscription } = parsed || {};
          result.push({
            key: item.name,
            subscription: wrapped || legacySubscription,
            regions: Array.isArray(savedRegions) ? savedRegions : null,
            vibration: typeof savedVibration === "boolean" ? savedVibration : true
          });
        } catch { await env.SUBSCRIPTIONS.delete(item.name); }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return result;
}
async function sendToAll(env, payload, regionSlug) {
  const subs = await allSubscriptions(env);
  let allSent = true;
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT
  };
  for (const item of subs) {
    if (Array.isArray(item.regions) && !item.regions.includes(regionSlug)) continue;
    try {
      const devicePayload = { ...payload, vibrate: item.vibration ? payload.vibrate : [] };
      const delivered = await sendPushNotification(item.subscription, devicePayload, vapid);
      if (!delivered) await env.SUBSCRIPTIONS.delete(item.key);
    } catch (error) {
      // Expired browser subscriptions should be removed; transient failures stay in the outbox.
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await env.SUBSCRIPTIONS.delete(item.key);
      } else {
        // Do not log subscription endpoints: they are bearer secrets.
        console.error("Web Push send failed", error?.statusCode || error?.name || "unknown");
        allSent = false;
      }
    }
  }
  return allSent;
}
async function appendHistory(env, event) {
  let events = [];
  try { events = JSON.parse(await env.SUBSCRIPTIONS.get("history:events") || "[]"); } catch { events = []; }
  if (!Array.isArray(events)) events = [];
  if (!events.some(item => item.id === event.id)) {
    events.unshift(event);
    await env.SUBSCRIPTIONS.put("history:events", JSON.stringify(events.slice(0, 300)));
  }
}
async function deliverPending(env) {
  let pending = [];
  try { pending = JSON.parse(await env.SUBSCRIPTIONS.get("push:pending") || "[]"); } catch { pending = []; }
  if (!Array.isArray(pending) || !pending.length) return;
  const retry = [];
  for (const item of pending.slice(0, 100)) {
    const isThreat = item.kind === "threat";
    const sent = await sendToAll(env, {
      title: isThreat
        ? (item.type === "ballistic" ? "Угроза баллистики · NEPTUN" : "Угроза БПЛА · NEPTUN")
        : (item.active ? "Повітряна тривога" : "Відбій повітряної тривоги"),
      body: isThreat
        ? (item.region + " — " + (item.label || (item.type === "ballistic" ? "Баллистическая угроза" : "БПЛА")) + ". Новый сигнал NEPTUN.")
        : item.region + (item.active ? " — NEPTUN сообщил о тревоге." : " — NEPTUN больше не показывает тревогу."),
      url: "/",
      tag: item.id,
      vibrate: isThreat || item.active ? [300, 150, 300] : [120, 80, 120]
    }, item.slug);
    if (!sent) retry.push(item);
  }
  await env.SUBSCRIPTIONS.put("push:pending", JSON.stringify(retry));
}
function regionSlugFor(value) {
  const candidate = norm(value);
  for (const [slug, name] of Object.entries(REGIONS)) {
    if (candidate === norm(name) || candidate === norm(slug)) return slug;
  }
  return null;
}
function freshThreatRecords(payload) {
  const rows = Array.isArray(payload?.threats) ? payload.threats : null;
  if (!rows) return null;
  const now = Date.now();
  return rows.filter(item => {
    if (!item || item.status !== "active" || item.advisory === true) return false;
    if (item.type !== "ballistic" && item.type !== "uav") return false;
    const stamp = timestampOf(item.updatedAt);
    return stamp > 0 && now - stamp >= -30000 && now - stamp < 180000;
  });
}
async function checkAndNotify(env) {
  const results = await Promise.allSettled([
    fetchJson("https://neptun.in.ua/api/v1/alerts"),
    fetchJson("https://tryvoha.online/api/v1/alerts"),
    fetchJson("https://neptun.in.ua/api/v1/threats")
  ]);
  // Only the primary NEPTUN response is required for confirmed alert state.
  // Tryvoha is an optional cross-check and must never block primary notifications.
  const states = results[0].status === "fulfilled"
    ? currentStates(results[0].value, results[1].status === "fulfilled" ? results[1].value : null)
    : null;

  if (states) {
    const baseline = await env.SUBSCRIPTIONS.get("state:baseline");
    let previous;
    try { previous = baseline ? JSON.parse(baseline) : null; } catch { previous = null; }
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) previous = {};
    const nextBaseline = { ...previous };
    const pending = [];
    for (const [slug, active] of Object.entries(states)) {
      // Unknown/conflicting data must not erase the last confirmed state.
      if (typeof active !== "boolean") continue;
      if (typeof previous[slug] === "boolean" && previous[slug] !== active) {
        const event = { id: "trevoga-" + slug + "-" + (active ? "on" : "off") + "-" + Date.now(), slug, region: REGIONS[slug], active, timestamp: Date.now() };
        await appendHistory(env, event);
        pending.push(event);
      }
      // A region without an earlier baseline is initialized silently.
      nextBaseline[slug] = active;
    }
    if (pending.length) {
      let queued = [];
      try { queued = JSON.parse(await env.SUBSCRIPTIONS.get("push:pending") || "[]"); } catch { queued = []; }
      if (!Array.isArray(queued)) queued = [];
      await env.SUBSCRIPTIONS.put("push:pending", JSON.stringify([...queued, ...pending].slice(-100)));
    }
    // Persist only confirmed booleans; outages/conflicts cannot wipe the baseline.
    await env.SUBSCRIPTIONS.put("state:baseline", JSON.stringify(nextBaseline));
  }
  // Threat pushes are based only on fresh, active, non-advisory NEPTUN records.
  // Keep a short seen-ID window so repeated snapshots do not send duplicate alerts.
  if (results[2].status === "fulfilled") {
    const threats = freshThreatRecords(results[2].value);
    if (threats) {
      const now = Date.now();
      const savedSeen = await env.SUBSCRIPTIONS.get("threat:seen");
      const hasThreatBaseline = savedSeen !== null;
      let seen = {};
      try { seen = savedSeen ? JSON.parse(savedSeen) : {}; } catch { seen = {}; }
      if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
      const currentThreatIds = new Set(threats.map(item => String(item.id || "")).filter(Boolean));
      // Keep IDs for the full lifetime of an active record; prune only after it disappears.
      for (const id of Object.keys(seen)) {
        if (!currentThreatIds.has(id)) delete seen[id];
      }
      let queued = [];
      try { queued = JSON.parse(await env.SUBSCRIPTIONS.get("push:pending") || "[]"); } catch { queued = []; }
      if (!Array.isArray(queued)) queued = [];
      for (const threat of threats) {
        const id = String(threat.id || "");
        const slug = regionSlugFor(threat.region);
        if (!id || !slug || seen[id]) continue;
        seen[id] = now;
        // The first successful threat snapshot establishes a silent baseline.
        if (!hasThreatBaseline) continue;
        queued.push({
          kind: "threat",
          id: "neptun-threat-" + id,
          slug,
          region: REGIONS[slug],
          type: threat.type,
          label: String(threat.title || (threat.type === "ballistic" ? "Баллистическая угроза" : "БПЛА")).slice(0, 180),
          timestamp: now
        });
      }
      await env.SUBSCRIPTIONS.put("threat:seen", JSON.stringify(seen));
      if (queued.length) await env.SUBSCRIPTIONS.put("push:pending", JSON.stringify(queued.slice(-100)));
    }
  }
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    await deliverPending(env);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    // The app is published on Render and GitHub Pages; allow only these exact configured origins.
    const allowedOrigins = String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "")
      .split(",").map(value => value.trim()).filter(Boolean);
    const allowed = allowedOrigins.includes(origin);
    const cors = allowed ? corsHeaders(origin) : {};
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed) return json({ error: "Origin not allowed" }, 403);

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true }, 200, cors);
    if (url.pathname === "/history" && request.method === "GET") {
      let events = [];
      try { events = JSON.parse(await env.SUBSCRIPTIONS.get("history:events") || "[]"); } catch { events = []; }
      if (!Array.isArray(events)) events = [];
      const requested = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(300, Math.floor(requested))) : 100;
      return json({ events: events.slice(0, limit) }, 200, { ...cors, "cache-control": "no-store" });
    }
    if (url.pathname === "/config" && request.method === "GET") {
      if (!env.VAPID_PUBLIC_KEY) return json({ error: "Push is not configured" }, 503, cors);
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
    }
    if (url.pathname === "/subscribe" && request.method === "POST") {
      let body, rawSubscription;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, cors); }
      rawSubscription = body?.subscription || body;
      if (!rawSubscription?.endpoint || !rawSubscription?.keys?.p256dh || !rawSubscription?.keys?.auth || !allowedPushHost(rawSubscription.endpoint)) {
        return json({ error: "Invalid push subscription" }, 400, cors);
      }
      const { regions: ignoredRegions, vibration: ignoredVibration, ...sub } = rawSubscription;
      const regions = Array.isArray(body?.regions)
        ? [...new Set(body.regions.filter(slug => Object.prototype.hasOwnProperty.call(REGIONS, slug)))]
        : Array.isArray(ignoredRegions) ? [...new Set(ignoredRegions.filter(slug => Object.prototype.hasOwnProperty.call(REGIONS, slug)))] : null;
      const vibration = typeof body?.vibration === "boolean" ? body.vibration : typeof ignoredVibration === "boolean" ? ignoredVibration : true;
      await env.SUBSCRIPTIONS.put(await keyFor(sub.endpoint), JSON.stringify({ subscription: sub, regions, vibration }));
      return json({ ok: true }, 201, cors);
    }
    if (url.pathname === "/subscribe" && request.method === "DELETE") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, cors); }
      if (!body?.endpoint || !allowedPushHost(body.endpoint)) return json({ error: "Invalid endpoint" }, 400, cors);
      await env.SUBSCRIPTIONS.delete(await keyFor(body.endpoint));
      return json({ ok: true }, 200, cors);
    }
    return json({ error: "Not found" }, 404, cors);
  },
  async scheduled(controller, env) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      console.error("VAPID is not configured; recording shared alert history without push delivery.");
    }
    await checkAndNotify(env);
  }
};
