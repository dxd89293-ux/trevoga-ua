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
    return await response.json();
  } finally { clearTimeout(timer); }
}
function currentStates(neptun, tryvoha) {
  const oblasts = Array.isArray(neptun?.oblasts) ? neptun.oblasts : [];
  const raions = Array.isArray(neptun?.raions) ? neptun.raions : [];
  const alerts = Array.isArray(tryvoha?.alerts) ? tryvoha.alerts : [];
  const stamp = Date.parse(tryvoha?.updated_at || "");
  const tryvohaFresh = Number.isFinite(stamp) && Date.now() - stamp >= -30000 && Date.now() - stamp < 180000;
  if (!Array.isArray(neptun?.oblasts) || !Array.isArray(neptun?.raions) || !tryvohaFresh) return null;

  const states = {};
  for (const [slug, name] of Object.entries(REGIONS)) {
    const nFull = oblasts.some(x => norm(x.name) === norm(name) || norm(x.oblast) === norm(name));
    const nPart = raions.some(x => norm(x.oblast) === norm(name));
    const matches = alerts.filter(x => x.slug === slug || x.oblast_slug === slug);
    const tFull = matches.some(x => x.slug === slug && x.type !== "district");
    const tPart = matches.some(x => x.type === "district");
    const nActive = nFull || nPart;
    const tActive = tFull || tPart;
    // Notify only when both independent feeds agree. A disagreement is unknown,
    // so it resets the baseline for this region without producing a push.
    states[slug] = nActive === tActive ? nActive : null;
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
          const { regions: savedRegions, ...legacySubscription } = parsed || {};
          result.push({
            key: item.name,
            subscription: wrapped ? parsed.subscription : legacySubscription,
            regions: Array.isArray(savedRegions) ? savedRegions : null
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
      const delivered = await sendPushNotification(item.subscription, payload, vapid);
      if (!delivered) await env.SUBSCRIPTIONS.delete(item.key);
    } catch (error) {
      // Do not log subscription endpoints: they are bearer secrets.
      console.error("Web Push send failed", error?.statusCode || error?.name || "unknown");
      allSent = false;
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
    const sent = await sendToAll(env, {
      title: item.active ? "Повітряна тривога" : "Відбій повітряної тривоги",
      body: item.region + (item.active ? " — джерела зафіксували тривогу." : " — джерела більше не показують тривогу."),
      url: "/",
      tag: item.id
    }, item.slug);
    if (!sent) retry.push(item);
  }
  await env.SUBSCRIPTIONS.put("push:pending", JSON.stringify(retry));
}
async function checkAndNotify(env) {
  const results = await Promise.allSettled([
    fetchJson("https://neptun.in.ua/api/v1/alerts"),
    fetchJson("https://tryvoha.online/api/v1/alerts")
  ]);
  const states = results.every(x => x.status === "fulfilled")
    ? currentStates(results[0].value, results[1].value)
    : null;

  if (states) {
    const baseline = await env.SUBSCRIPTIONS.get("state:baseline");
    if (!baseline) {
      await env.SUBSCRIPTIONS.put("state:baseline", JSON.stringify(states));
    } else {
      let previous;
      try { previous = JSON.parse(baseline); } catch { previous = null; }
      if (!previous) {
        await env.SUBSCRIPTIONS.put("state:baseline", JSON.stringify(states));
      } else {
        const pending = [];
        for (const [slug, active] of Object.entries(states)) {
          if (typeof active !== "boolean" || typeof previous[slug] !== "boolean" || previous[slug] === active) continue;
          const event = { id: "trevoga-" + slug + "-" + (active ? "on" : "off") + "-" + Date.now(), slug, region: REGIONS[slug], active, timestamp: Date.now() };
          await appendHistory(env, event);
          pending.push(event);
        }
        if (pending.length) {
          let queued = [];
          try { queued = JSON.parse(await env.SUBSCRIPTIONS.get("push:pending") || "[]"); } catch { queued = []; }
          if (!Array.isArray(queued)) queued = [];
          await env.SUBSCRIPTIONS.put("push:pending", JSON.stringify([...queued, ...pending].slice(-100)));
        }
        // Save the new baseline only after transitions have been persisted to history/outbox.
        await env.SUBSCRIPTIONS.put("state:baseline", JSON.stringify(states));
      }
    }
  }
  await deliverPending(env);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = origin === env.ALLOWED_ORIGIN;
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
      const { regions: ignoredRegions, ...sub } = rawSubscription;
      const regions = Array.isArray(body?.regions)
        ? [...new Set(body.regions.filter(slug => Object.prototype.hasOwnProperty.call(REGIONS, slug)))]
        : Array.isArray(ignoredRegions) ? [...new Set(ignoredRegions.filter(slug => Object.prototype.hasOwnProperty.call(REGIONS, slug)))] : null;
      await env.SUBSCRIPTIONS.put(await keyFor(sub.endpoint), JSON.stringify({ subscription: sub, regions }));
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
      console.error("Missing VAPID configuration");
      return;
    }
    await checkAndNotify(env);
  }
};
