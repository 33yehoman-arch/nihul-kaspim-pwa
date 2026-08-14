'use strict';

var CACHE_NAME = 'finance-app-v2';
var CORE_ASSETS = ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function(event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CORE_ASSETS);
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

// Network-first: always try to fetch the latest version when online (so app
// updates reach installed/offline-capable clients), falling back to the
// cached copy when offline.
self.addEventListener('fetch', function(event) {
  event.respondWith(
    fetch(event.request).then(function(response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function(cache) { cache.put(event.request, copy); });
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});

// ---------- Shared IndexedDB (snapshots written by the main page) ----------
var DB_NAME = 'financeAppDB';
var DEBTS_STORE = 'debts';
var EMPLOYERS_STORE = 'employers';
var SUMMARY_STORE = 'summary';
var NOTIFY_LOG_STORE = 'notifyLog';

function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = function() {
      var db = req.result;
      if (!db.objectStoreNames.contains(DEBTS_STORE)) db.createObjectStore(DEBTS_STORE);
      if (!db.objectStoreNames.contains(EMPLOYERS_STORE)) db.createObjectStore(EMPLOYERS_STORE);
      if (!db.objectStoreNames.contains(SUMMARY_STORE)) db.createObjectStore(SUMMARY_STORE);
      if (!db.objectStoreNames.contains(NOTIFY_LOG_STORE)) db.createObjectStore(NOTIFY_LOG_STORE);
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}

function getStoreCurrent(storeName) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).get('current');
      req.onsuccess = function() { resolve(req.result || []); };
      req.onerror = function() { reject(req.error); };
    });
  });
}

// ---------- Once-per-month de-duplication for reminder notifications ----------
function currentMonthKey() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function hasNotifiedThisMonth(tag) {
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(NOTIFY_LOG_STORE, 'readonly');
      var req = tx.objectStore(NOTIFY_LOG_STORE).get(tag);
      req.onsuccess = function() { resolve(req.result === currentMonthKey()); };
      req.onerror = function() { resolve(false); };
    });
  }).catch(function() { return false; });
}

function markNotified(tag) {
  return openDB().then(function(db) {
    return new Promise(function(resolve) {
      var tx = db.transaction(NOTIFY_LOG_STORE, 'readwrite');
      tx.objectStore(NOTIFY_LOG_STORE).put(currentMonthKey(), tag);
      tx.oncomplete = function() { resolve(); };
      tx.onerror = function() { resolve(); };
    });
  }).catch(function() {});
}

function notifyDebts() {
  var tag = 'monthly-debt-reminder';
  return hasNotifiedThisMonth(tag).then(function(already) {
    if (already) return;
    return getStoreCurrent(DEBTS_STORE).then(function(debts) {
      if (!debts || debts.length === 0) return;
      var total = debts.reduce(function(s, d) { return s + d.amount; }, 0);
      var names = debts.map(function(d) { return d.name + ' (₪' + d.amount + ')'; }).join(', ');
      return self.registration.showNotification('תזכורת ל-10 בחודש 💰', {
        body: 'סה"כ ₪' + total + ' ממתין מ: ' + names,
        icon: 'icon.svg',
        badge: 'icon.svg',
        tag: tag,
        renotify: true
      }).then(function() { return markNotified(tag); });
    });
  });
}

function notifyEmployers() {
  var tag = 'monthly-employer-reminder';
  return hasNotifiedThisMonth(tag).then(function(already) {
    if (already) return;
    return getStoreCurrent(EMPLOYERS_STORE).then(function(employers) {
      if (!employers || employers.length === 0) return;
      var total = employers.reduce(function(s, e) { return s + e.amount; }, 0);
      var names = employers.map(function(e) { return e.name + ' (₪' + e.amount + ')'; }).join(', ');
      return self.registration.showNotification('💼 תשלום מהמעסיקים על החודש שעבר', {
        body: 'סה"כ ₪' + total + ' מ: ' + names,
        icon: 'icon.svg',
        badge: 'icon.svg',
        tag: tag,
        renotify: true
      }).then(function() { return markNotified(tag); });
    });
  });
}

function notifyMonthSummary() {
  var tag = 'month-summary-reminder';
  return hasNotifiedThisMonth(tag).then(function(already) {
    if (already) return;
    return getStoreCurrent(SUMMARY_STORE).then(function(summary) {
      if (!summary) return;
      var data = Array.isArray(summary) ? null : summary;
      if (!data) return;
      return self.registration.showNotification('📊 סיכום החודש מוכן', {
        body: 'הכנסות: ₪' + data.income + ' · הוצאות: ₪' + data.expense + ' · יתרה: ₪' + data.balance + ' - הקישו לפרטים',
        icon: 'icon.svg',
        badge: 'icon.svg',
        tag: tag,
        renotify: true
      }).then(function() { return markNotified(tag); });
    });
  });
}

function isLastDayOfMonth(date) {
  var lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return date.getDate() === lastDay;
}

function checkAndNotify() {
  var now = new Date();
  var day = now.getDate();
  var tasks = [];
  if (day >= 8 && day <= 15) tasks.push(notifyDebts(), notifyEmployers());
  if (isLastDayOfMonth(now)) tasks.push(notifyMonthSummary());
  return Promise.all(tasks);
}

// Best-effort background trigger. Actual firing interval/timing is decided
// by the browser and is NOT guaranteed to be exactly the 10th - Chrome/Android only.
self.addEventListener('periodicsync', function(event) {
  if (event.tag === 'monthly-debt-reminder') {
    event.waitUntil(checkAndNotify());
  }
});

// Fallback trigger: the page asks the SW to check right now (e.g. on app open).
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CHECK_DEBT_REMINDER') {
    event.waitUntil(checkAndNotify());
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var tab = event.notification.tag === 'month-summary-reminder' ? 'summary' : null;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if ('focus' in client) {
          if (tab) client.postMessage({ type: 'OPEN_TAB', tab: tab });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(tab ? ('./index.html?tab=' + tab) : './index.html');
      }
    })
  );
});
