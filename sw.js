/**
 * Service Worker para "El Bestiario de las Matrices" PWA
 * Proporciona funcionalidad offline y caché de recursos
 */

/**
 * Versión de la aplicación (única fuente de verdad).
 * La página la consulta vía mensaje { type: 'GET_VERSION' } y la muestra
 * en el chip del encabezado. Al subirla cambian también los nombres de
 * caché, por lo que el evento 'activate' purga automáticamente los restos
 * de versiones anteriores.
 */
const APP_VERSION = '1.0.10';
const CACHE_NAME = `bestiario-matrices-${APP_VERSION}`;
const STATIC_CACHE = `bestiario-static-${APP_VERSION}`;
const DYNAMIC_CACHE = `bestiario-dynamic-${APP_VERSION}`;

// Recursos estáticos para cachear en la instalación
const STATIC_ASSETS = [
    '/',
    '/matrices/',
    '/matrices/index.html',
    'manifest.json',
    'favicon.ico',
    'favicon.png',
    'icon-192x192.png',
    'icon-512x512.png'
];

// CDN externos que se usarán como fallback
const CDN_FALLBACKS = {
    'https://cdn.tailwindcss.com': null,
    'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css': null,
    'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js': null,
    'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js': null,
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css': null
};

/**
 * Evento de instalación - Cachear recursos estáticos
 */
self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker...');
    
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Cacheando recursos estáticos');
                return cache.addAll(STATIC_ASSETS).catch(err => {
                    console.warn('[SW] Algunos recursos no pudieron cachearse:', err);
                    // Continuar aunque algunos recursos fallen (pueden no existir aún)
                    return Promise.resolve();
                });
            })
            .then(() => {
                // Forzar activación inmediata
                return self.skipWaiting();
            })
    );
});

/**
 * Evento de activación - Limpiar caches antiguos
 */
self.addEventListener('activate', (event) => {
    console.log('[SW] Activando Service Worker...');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            // Eliminar caches que no sean los actuales
                            return name !== STATIC_CACHE && 
                                   name !== DYNAMIC_CACHE &&
                                   name !== CACHE_NAME;
                        })
                        .map((name) => {
                            console.log('[SW] Eliminando cache antiguo:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                // Tomar control de todas las páginas inmediatamente
                return self.clients.claim();
            })
    );
});

/**
 * Evento fetch - Estrategias de caché
 */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Solo manejar peticiones GET
    if (request.method !== 'GET') {
        return;
    }
    
    // Estrategia para navegación (documentos HTML)
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }
    
    // Estrategia para recursos del mismo origen (iconos, etc.)
    if (url.origin === self.location.origin) {
        // Para archivos de imagen/iconos: Cache First
        if (request.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|gif|ico|svg|webp)$/i)) {
            event.respondWith(cacheFirst(request));
            return;
        }
        
        // Para otros recursos propios: Stale While Revalidate
        event.respondWith(staleWhileRevalidate(request));
        return;
    }
    
    // Estrategia para recursos CDN externos (CSS, JS)
    if (isCDNRequest(url)) {
        event.respondWith(cdnCacheStrategy(request));
        return;
    }

    // Por defecto: Network First
    event.respondWith(networkFirst(request));
});

/**
 * Estrategia: Cache First
 * Busca en caché primero, si no existe va a la red
 */
async function cacheFirst(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return cachedResponse;
    }
    
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        console.warn('[SW] Error en cacheFirst:', error);
        return new Response('Recurso no disponible offline', { 
            status: 503, 
            statusText: 'Service Unavailable' 
        });
    }
}

/**
 * Estrategia: Network First
 * Intenta la red primero, fallback a caché
 */
async function networkFirst(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(DYNAMIC_CACHE);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        console.log('[SW] Red no disponible, buscando en caché:', request.url);
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Si es una navegación, mostrar página offline
        if (request.mode === 'navigate') {
            return caches.match('/matrices/') || new Response('Offline', { status: 503 });
        }
        
        return new Response('Recurso no disponible', { 
            status: 503, 
            statusText: 'Service Unavailable' 
        });
    }
}

/**
 * Estrategia: Stale While Revalidate
 * Sirve desde caché mientras actualiza en segundo plano
 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(DYNAMIC_CACHE);
    const cachedResponse = await cache.match(request);
    
    const networkPromise = fetch(request)
        .then((networkResponse) => {
            if (networkResponse.ok) {
                cache.put(request, networkResponse.clone());
            }
            return networkResponse;
        })
        .catch(() => {
            // La red falló, usaremos el caché
            return null;
        });
    
    // Devolver el caché inmediatamente si existe
    return cachedResponse || networkPromise;
}

/**
 * Estrategia especial para CDN
 * Cache con expiración larga pero intenta actualizar
 */
async function cdnCacheStrategy(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    
    // Devolver caché si existe (los CDN cambian raramente)
    if (cachedResponse) {
        // Actualizar en segundo plano sin esperar
        fetch(request).then((response) => {
            if (response.ok) {
                cache.put(request, response.clone());
            }
        }).catch(() => {});
        
        return cachedResponse;
    }
    
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        console.warn('[SW] CDN no disponible:', request.url);
        return new Response('CDN no disponible offline', { 
            status: 503, 
            statusText: 'Service Unavailable' 
        });
    }
}

/**
 * Verificar si la petición es a un CDN conocido
 */
function isCDNRequest(url) {
    const cdnHosts = [
        'cdn.tailwindcss.com',
        'cdn.jsdelivr.net',
        'cdnjs.cloudflare.com',
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'unpkg.com'
    ];
    return cdnHosts.some(host => url.hostname.includes(host));
}

/**
 * Manejar mensajes desde la aplicación
 */
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'GET_VERSION') {
        // Responder por el MessageChannel transferido por la página
        if (event.ports && event.ports[0]) {
            event.ports[0].postMessage({
                version: APP_VERSION,
                cacheName: CACHE_NAME
            });
        }
    }
});

console.log('[SW] Service Worker cargado - Bestiario de Matrices');
