const CACHE='trevoga-ua-shell-v11';
const FILES=['./','./index.html','./manifest.webmanifest','./icon.svg','./push-config.js'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('trevoga-ua-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin) return;
  e.respondWith((async()=>{
    try{
      const response=await fetch(e.request);
      if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
      return response;
    }catch(error){
      const cached=await caches.match(e.request);
      if(cached)return cached;
      // Only navigations may fall back to the app shell; never return HTML for a missing JS/CSS/image.
      if(e.request.mode==='navigate')return (await caches.match('./index.html'))||Response.error();
      return Response.error();
    }
  })());
});
// Обработчик принимает push от отдельного Web Push-сервера даже при закрытой вкладке.
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{};}catch(e){data={body:event.data?event.data.text():'Открой карту для проверки статуса.'};}
  const title=data.title||'Тревога UA';
  const options={
    body:data.body||'Поступило обновление статуса воздушной тревоги.',
    icon:'./icon.svg',
    badge:'./icon.svg',
    tag:data.tag||'trevoga-ua-alert',
    renotify:false,
    vibrate:Array.isArray(data.vibrate)?data.vibrate:[300,150,300],
    data:{url:data.url||'./'}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  let targetUrl=new URL(event.notification.data&&event.notification.data.url||'./',self.location.origin);
  if(targetUrl.origin!==self.location.origin)targetUrl=new URL('./',self.location.origin);
  const target=targetUrl.href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async list=>{
    for(const client of list){
      if(client.url.startsWith(self.location.origin)&&'focus'in client){
        try{if('navigate'in client)await client.navigate(target);}catch(e){}
        return client.focus();
      }
    }
    return clients.openWindow?clients.openWindow(target):undefined;
  }));
});
