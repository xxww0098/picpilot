const CACHE_NAME = 'picpilot-v0.1.26'
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './pwa-icon.png', './pwa-icon-192.png', './pwa-icon-512.png']

const sw = self as unknown as ServiceWorkerGlobalScope

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  )
  sw.skipWaiting()
})

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  sw.clients.claim()
})

sw.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event

  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== sw.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/api-proxy/')) return
  if (request.headers.has('authorization') || request.headers.has('x-picpilot-authorization')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy))
          return response
        })
        .catch(async () => (await caches.match('./index.html')) ?? Response.error()),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
