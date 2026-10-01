const CACHE = "our-days-off-v14-simple-shifts";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./design-system.css", "./availability.js", "./calendar-export.js", "./app.js", "./config.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
const REMOTE_DEPS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
  "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
    await Promise.allSettled(REMOTE_DEPS.map(async url=>{
      const response=await fetch(url,{mode:"cors"});
      if(response.ok) await cache.put(url,response.clone());
    }));
    // v12 deliberately activates immediately once so users escape the older cache-first v11 worker.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

self.addEventListener("message", event => {
  if(event.data?.type==="SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  const sameOrigin=url.origin===self.location.origin;
  const isJsDelivr=url.hostname==="cdn.jsdelivr.net";
  if(!sameOrigin&&!isJsDelivr) return;

  if(sameOrigin){
    event.respondWith((async()=>{
      try{
        const fresh=await fetch(event.request);
        const cache=await caches.open(CACHE);
        cache.put(event.request,fresh.clone());
        return fresh;
      }catch{
        return (await caches.match(event.request)) || (await caches.match("./index.html"));
      }
    })());
    return;
  }

  event.respondWith((async()=>{
    const cached=await caches.match(event.request);
    if(cached) return cached;
    const fresh=await fetch(event.request);
    const cache=await caches.open(CACHE);
    cache.put(event.request,fresh.clone());
    return fresh;
  })());
});
