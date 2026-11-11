// АвтоУчёт — service worker: офлайн-работа и напоминания
// При изменении файлов приложения увеличьте версию, чтобы обновить кэш.
const VERSION = 'v8';
const LIBS = 'avtouchet-libs';          // pdf.js и т.п. с CDN, переживает обновления
const CACHE = `avtouchet-${VERSION}`;
const DATA = 'avtouchet-data';          // снимок сроков от страницы + журнал отправленных уведомлений
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('avtouchet-') && k !== CACHE && k !== DATA && k !== LIBS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'check') e.waitUntil(checkReminders());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Библиотеки с CDN (просмотр PDF, распознавание чеков): кэшируем, чтобы работали офлайн
  if (url.origin !== location.origin) {
    if (/^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)$/.test(url.hostname)) {
      e.respondWith(caches.open(LIBS).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) c.put(req, res.clone());
        return res;
      }))));
    }
    return;
  }

  // Цены на топливо: всегда свежие из сети, при офлайне — последние сохранённые
  if (url.pathname.endsWith('/prices.json')) {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(DATA).then(c => c.put('prices.json', copy)); return res; })
        .catch(() => caches.open(DATA).then(c => c.match('prices.json')))
    );
    return;
  }

  // Страница: сначала сеть (чтобы получать обновления), при офлайне — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});

/* ---------- Напоминания ---------- */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'avtouchet-check') e.waitUntil(checkReminders());
});

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysUntil = s => { const t = new Date(); return Math.round((parseD(s) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000); };

async function readJson(cache, key, fallback) {
  try { const r = await cache.match(key); return r ? await r.json() : fallback; } catch (e) { return fallback; }
}

async function checkReminders() {
  const cache = await caches.open(DATA);
  const snap = await readJson(cache, 'reminders.json', null);
  if (!snap || !snap.enabled || Notification.permission !== 'granted') return;
  const sent = await readJson(cache, 'sent.json', {});
  const today = iso(new Date());
  const out = [];

  for (const r of snap.items || []) {
    const left = daysUntil(r.due);
    if (left > r.remind) continue;
    // Повторяем: за remind дней, за 7 дней, за 1 день и затем раз в 3 дня, пока не отметят выполнение
    const last = sent[r.key];
    const stageNow = left < 0 ? 'over' : left <= 1 ? 'd1' : left <= 7 ? 'd7' : 'early';
    const lastStage = last && last.stage;
    const daysSinceLast = last ? Math.round((parseD(today) - parseD(last.date)) / 86400000) : 999;
    if (last && lastStage === stageNow && (stageNow !== 'over' || daysSinceLast < 3)) continue;
    const when = left < 0 ? 'Срок прошёл' : left === 0 ? 'Сегодня' : left === 1 ? 'Завтра' : `Через ${left} дн.`;
    out.push({ key: r.key, stage: stageNow, title: `${when}: ${r.title}`, body: r.body, url: r.key[0] === 'd' ? './?action=docs' : './' });
  }

  // Раз в неделю — попросить обновить пробег
  for (const m of snap.mileage || []) {
    const age = m.date ? -daysUntil(m.date) : 999;
    const key = 'mileage:' + m.car;
    const last = sent[key];
    const since = last ? Math.round((parseD(today) - parseD(last.date)) / 86400000) : 999;
    if (age >= 7 && since >= 7) out.push({ key, stage: 'ask', title: 'Какой сейчас пробег?', body: `${m.car}: обновите пробег, чтобы сроки замены масла и расходников были точными.`, url: './?action=mileage' });
  }

  for (const n of out.slice(0, 4)) {
    await self.registration.showNotification(n.title, {
      body: n.body, tag: n.key, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: n.url },
    });
    sent[n.key] = { date: today, stage: n.stage };
  }
  if (out.length) await cache.put('sent.json', new Response(JSON.stringify(sent), { headers: { 'Content-Type': 'application/json' } }));
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.navigate(url).catch(() => {}); return w.focus(); } }
    return clients.openWindow(url);
  })());
});
