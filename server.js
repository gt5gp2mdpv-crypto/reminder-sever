// StudyFlow Push Server
// Deploy to Render.com (free tier)

const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ── VAPID keys (set via environment variables) ──
// Generate once with: npx web-push generate-vapid-keys
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:your@email.com';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('ERROR: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set as environment variables');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);

// ── In-memory store (resets on server restart) ──
// For persistence across restarts, use Upstash Redis (free tier)
// See README for Upstash setup
const subscribers = new Map(); // key: endpoint, value: { subscription, schedule, timers }

// ── Helpers ──
function clearTimers(entry) {
  if (entry && entry.timers) {
    entry.timers.forEach(id => clearTimeout(id));
    entry.timers = [];
  }
}

async function sendPush(subscription, title, body) {
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title, body }),
      { TTL: 3600 }
    );
    console.log(`[PUSH] Sent: ${title}`);
  } catch (err) {
    if (err.statusCode === 410) {
      // Subscription expired
      subscribers.delete(subscription.endpoint);
      console.log('[PUSH] Subscription expired, removed');
    } else {
      console.error('[PUSH] Error:', err.message);
    }
  }
}

function scheduleForSubscriber(entry) {
  clearTimers(entry);
  const now = Date.now();
  entry.timers = [];
  // dedup: track scheduled notification keys to avoid double-fire
  const seen = new Set();

  (entry.schedule || []).forEach(n => {
    const delay = n.time - now;
    if (delay <= 0 || delay > 7 * 24 * 3600 * 1000) return;
    // unique key per notification
    const key = `${n.title}|${n.body}|${n.time}`;
    if (seen.has(key)) return;
    seen.add(key);
    const id = setTimeout(() => {
      sendPush(entry.subscription, n.title, n.body);
    }, delay);
    entry.timers.push(id);
  });

  console.log(`[SCHED] ${entry.timers.length} notifications scheduled for ...${entry.subscription.endpoint.slice(-8)}`);
}

// ── Routes ──

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', subscribers: subscribers.size, uptime: process.uptime() });
});
app.get('/healthz', (req, res) => res.sendStatus(200));

// Debug: show registered endpoints (last 20 chars only for privacy)
app.get('/debug-subs', (req, res) => {
  const info=[...subscribers.entries()].map(([ep,entry])=>({
    endpoint:'...'+ep.slice(-20),
    scheduled:entry.timers?.length||0,
    scheduleCount:entry.schedule?.length||0,
  }));
  res.json({count:subscribers.size, subscribers:info});
});

// Subscribe: register device + initial schedule
app.post('/subscribe', (req, res) => {
  const { subscription, schedule } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  // Remove any existing entry for this endpoint before adding
  const existing = subscribers.get(subscription.endpoint);
  if (existing) clearTimers(existing);
  subscribers.delete(subscription.endpoint);

  const entry = {
    subscription,
    schedule: schedule || [],
    timers: []
  };
  subscribers.set(subscription.endpoint, entry);
  scheduleForSubscriber(entry);

  console.log(`[SUB] Registered: ...${subscription.endpoint.slice(-20)}, total: ${subscribers.size}`);
  res.json({ ok: true, scheduled: entry.timers.length });
});

// Update schedule (called when tasks change)
app.post('/update-schedule', (req, res) => {
  const { subscription, schedule } = req.body;
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const entry = subscribers.get(subscription.endpoint);
  if (!entry) {
    // Re-register
    const newEntry = { subscription, schedule: schedule || [], timers: [] };
    subscribers.set(subscription.endpoint, newEntry);
    scheduleForSubscriber(newEntry);
    return res.json({ ok: true, note: 'reregistered' });
  }

  entry.schedule = schedule || [];
  scheduleForSubscriber(entry);
  res.json({ ok: true, scheduled: entry.timers.length });
});

// Unsubscribe
app.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const entry = subscribers.get(endpoint);
  if (entry) {
    clearTimers(entry);
    subscribers.delete(endpoint);
  }
  res.json({ ok: true });
});

// Test push (for debugging)
app.post('/test', (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid' });
  sendPush(subscription, '🔔 テスト通知', 'StudyFlowサーバーから届いています！');
  res.json({ ok: true });
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`StudyFlow Push Server running on port ${PORT}`));
