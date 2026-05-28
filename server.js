// StudyFlow Push Server
// Supports Declarative Web Push (iOS 18.4+) with fallback to legacy Web Push

const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ── VAPID keys ──
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:your@email.com';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('ERROR: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

// ── In-memory store ──
const subscribers = new Map();

// ── Helpers ──
function clearTimers(entry) {
  if (entry?.timers) {
    entry.timers.forEach(id => clearTimeout(id));
    entry.timers = [];
  }
}

// Detect if subscription supports Declarative Web Push
// Declarative Web Push subscriptions include a 'type' field or specific endpoint pattern
// In practice we detect by user-agent stored at subscribe time
function isDeclarative(entry) {
  return entry?.declarative === true;
}

// Build payload based on push type
// Declarative Web Push: plain JSON with notification fields at top level
// Legacy Web Push: JSON with title/body wrapped (sw.js handles display)
function buildPayload(title, body, declarative) {
  if (declarative) {
    // W3C Declarative Web Push format - OS renders directly, no SW needed
    return JSON.stringify({
      notification: {
        title,
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `${title}|${body}`.slice(0, 64),
        requireInteraction: false,
      }
    });
  } else {
    // Legacy format - sw.js pushEvent handler renders this
    return JSON.stringify({ title, body });
  }
}

async function sendPush(entry, title, body) {
  const declarative = isDeclarative(entry);
  const payload = buildPayload(title, body, declarative);
  try {
    await webpush.sendNotification(
      entry.subscription,
      payload,
      {
        TTL: 3600,
        // Declarative Web Push requires specific content-type hint
        headers: declarative ? { 'X-WNS-Type': 'wns/raw' } : {},
      }
    );
    console.log(`[PUSH] Sent (${declarative ? 'declarative' : 'legacy'}): ${title}`);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      subscribers.delete(entry.subscription.endpoint);
      console.log('[PUSH] Subscription expired/invalid, removed');
    } else {
      console.error('[PUSH] Error:', err.statusCode, err.message);
    }
  }
}

function scheduleForSubscriber(entry) {
  clearTimers(entry);
  const now = Date.now();
  entry.timers = [];
  const seen = new Set();

  (entry.schedule || []).forEach(n => {
    const delay = n.time - now;
    if (delay <= 0 || delay > 7 * 24 * 3600 * 1000) return;
    const key = `${n.title}|${n.body}|${n.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    const id = setTimeout(() => sendPush(entry, n.title, n.body), delay);
    entry.timers.push(id);
  });

  console.log(`[SCHED] ${entry.timers.length} notifications for ...${entry.subscription.endpoint.slice(-8)} (${isDeclarative(entry) ? 'declarative' : 'legacy'})`);
}

// ── Routes ──

app.get('/', (req, res) => {
  res.json({ status: 'ok', subscribers: subscribers.size, uptime: process.uptime() });
});
app.get('/healthz', (req, res) => res.sendStatus(200));

app.get('/debug-subs', (req, res) => {
  const info = [...subscribers.entries()].map(([ep, entry]) => ({
    endpoint: '...' + ep.slice(-20),
    scheduled: entry.timers?.length || 0,
    scheduleCount: entry.schedule?.length || 0,
    declarative: entry.declarative || false,
  }));
  res.json({ count: subscribers.size, subscribers: info });
});

// Subscribe
app.post('/subscribe', (req, res) => {
  const { subscription, schedule, declarative } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const existing = subscribers.get(subscription.endpoint);
  if (existing) clearTimers(existing);
  subscribers.delete(subscription.endpoint);

  const entry = {
    subscription,
    schedule: schedule || [],
    timers: [],
    // Client tells us if it supports declarative push
    declarative: declarative === true,
  };
  subscribers.set(subscription.endpoint, entry);
  scheduleForSubscriber(entry);

  console.log(`[SUB] Registered: ...${subscription.endpoint.slice(-20)}, declarative=${entry.declarative}, total=${subscribers.size}`);
  res.json({ ok: true, scheduled: entry.timers.length, declarative: entry.declarative });
});

// Update schedule
app.post('/update-schedule', (req, res) => {
  const { subscription, schedule } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  let entry = subscribers.get(subscription.endpoint);
  if (!entry) {
    entry = { subscription, schedule: schedule || [], timers: [], declarative: false };
    subscribers.set(subscription.endpoint, entry);
  } else {
    entry.schedule = schedule || [];
  }
  scheduleForSubscriber(entry);
  res.json({ ok: true, scheduled: entry.timers.length });
});

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const entry = subscribers.get(endpoint);
  if (entry) { clearTimers(entry); subscribers.delete(endpoint); }
  res.json({ ok: true });
});

// Test push
app.post('/test', (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid' });
  const entry = subscribers.get(subscription.endpoint) || { subscription, declarative: false };
  sendPush(entry, '🔔 テスト通知', 'StudyFlowサーバーから届いています！');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StudyFlow Push Server running on port ${PORT}`));
