const CACHE='trevoga-ua-shell-v6';
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
      return (await caches.match(e.request))||(await caches.match('./index.html'));
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
    data:{url:data.url||'./'}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data&&event.notification.data.url||'./',self.location.origin).href;
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const client of list){if(client.url.startsWith(self.location.origin)&&'focus'in client)return client.focus();}
    return clients.openWindow?clients.openWindow(target):undefined;
  }));
});
