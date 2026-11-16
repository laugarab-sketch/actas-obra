/* sw.js — Service worker de «Actas de obra».
 * Objetivo: que la app ABRA y FUNCIONE SIN COBERTURA (sótanos, obra sin señal).
 * - Guarda en caché los archivos propios de la app (no datos: esos viven en IndexedDB y en Drive).
 * - Archivos propios: primero red (para recibir actualizaciones) y, si no hay red, caché.
 * - Nunca intercepta Google ni Anthropic (otras direcciones): pasan directas a la red.
 * Al publicar una versión nueva, subir VERSION para que los móviles descarten la caché antigua.
 */
const VERSION = "actas-obra-v1";
const ARCHIVOS = [
  "./", "./index.html", "./generar_acta.js", "./acta_plantilla.docx", "./manifest.json",
  "./vendor/pizzip.min.js", "./vendor/docxtemplater.min.js", "./vendor/anthropic.js",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // Google / Anthropic: sin tocar
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("./index.html")))
  );
});
