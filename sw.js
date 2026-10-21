// Service worker: ทำให้ติดตั้งเป็นแอปได้ และเก็บโมเดล AI ไว้ในเครื่อง (เปิดครั้งต่อไปเร็วขึ้น)
const VERSION = 'v7';
const SHELL = `shell-${VERSION}`;
const CDN = `cdn-${VERSION}`;
const SHELL_FILES = ['./', 'index.html', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // POST ไป Apps Script ไม่แคช
  const url = new URL(req.url);
  if (url.hostname.includes('script.google')) return;

  // โมเดล AI / ไลบรารี / ฟอนต์: ใช้จากแคชก่อน
  if (/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(
      caches.open(CDN).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // ไฟล์แอป: ดึงใหม่ก่อน (อัปเดตทันที) ถ้าออฟไลน์ใช้แคช
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
  }
});
