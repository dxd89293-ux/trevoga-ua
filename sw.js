const CACHE='trevoga-ua-shell-v2';
const FILES=['./','./index.html','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('trevoga-ua-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(response=>{
    if(response.ok&&new URL(e.request.url).origin===self.location.origin){const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
    return response;
  }).catch(()=>caches.match('./index.html'))));
});
// Push-уведомления в фоне пока не подключены: для них нужен сервер Web Push и сохранение подписок.
