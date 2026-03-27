require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --------------- In-Memory Store ---------------

const MAX_RESULTS = 1000;
let results = [];
let lastChecked = null;
let activeMode = 'rss';
let cronJob = null;
let redditAccessToken = null;
let tokenExpiresAt = 0;

// User OAuth tokens (for replying)
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpiresAt = 0;
let redditUsername = null;

// Lead status tracking (shared across all users)
// key: url, value: { status: 'Qualified'|'Replied'|'Unqualified', updatedBy: username, updatedAt: timestamp }
const leadStatuses = new Map();

// Current monitoring config
let monitorConfig = {
  subreddits: [],
  keywords: [],
  pollMinutes: 5,
  mode: 'rss',
};

const BUYING_SIGNALS = [
  'recommend', 'looking for', 'anyone built', 'need help with',
  'best tool for', 'suggest', 'alternatives to', 'switch from',
  'anyone use', 'what do you use', 'how do you', 'should i use',
  'worth it', 'compared to', 'vs', 'better than', 'moving from',
  'replacement for', 'budget for', 'paying for', 'shopping for',
  'in the market', 'searching for', 'need a', 'want a',
  'hire', 'hiring', 'looking to hire', 'agency',
];

// --------------- Google Sheets ---------------

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID || '';

function getGoogleAuth() {
  try {
    const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credsJson) return null;
    const creds = JSON.parse(credsJson);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return auth;
  } catch (err) {
    console.error('[Sheets] Auth error:', err.message);
    return null;
  }
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  if (!auth) return null;
  return google.sheets({ version: 'v4', auth });
}

async function saveToSheets(newItems) {
  if (!SPREADSHEET_ID || !newItems.length) return;
  const sheets = await getSheetsClient();
  if (!sheets) return;

  try {
    // Check if "Results" sheet exists, create if not
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetNames = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!sheetNames.includes('Results')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: 'Results' } } }],
        },
      });
      // Add header row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Results!A1:K1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [['Timestamp', 'Subreddit', 'Title', 'Author', 'URL', 'Snippet', 'Buying Signal', 'Keywords', 'Score', 'Comments', 'Replied']],
        },
      });
    }

    // Get existing URLs to avoid duplicates
    let existingUrls = new Set();
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Results!E:E',
      });
      if (existing.data.values) {
        existingUrls = new Set(existing.data.values.flat());
      }
    } catch {}

    // Filter out duplicates
    const uniqueItems = newItems.filter(item => !existingUrls.has(item.url));
    if (!uniqueItems.length) {
      console.log('[Sheets] No new unique items to save');
      return;
    }

    // Append new rows
    const rows = uniqueItems.map(item => [
      new Date(item.date).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      `r/${item.subreddit}`,
      item.title,
      `u/${item.author}`,
      item.url,
      (item.snippet || '').slice(0, 200),
      item.buyingSignal ? 'YES' : '',
      (item.matchedKeywords || []).join(', '),
      item.score || 0,
      item.numComments || 0,
      '',
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Results!A:K',
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    console.log(`[Sheets] Saved ${rows.length} new results`);
  } catch (err) {
    console.error('[Sheets] Save error:', err.message);
  }
}

async function loadFromSheets() {
  if (!SPREADSHEET_ID) return;
  const sheets = await getSheetsClient();
  if (!sheets) return;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Results!A:K',
    });

    const rows = res.data.values;
    if (!rows || rows.length <= 1) return;

    const header = rows[0];
    const loaded = [];

    for (let i = rows.length - 1; i >= 1 && loaded.length < MAX_RESULTS; i--) {
      const row = rows[i];
      const title = row[2] || '';
      const snippet = row[5] || '';
      const combined = `${title} ${snippet}`;

      loaded.push({
        id: row[4] || `sheet-${i}`,
        thingId: null,
        subreddit: (row[1] || '').replace('r/', ''),
        title,
        author: (row[3] || '').replace('u/', ''),
        url: row[4] || '',
        snippet,
        date: new Date(row[0] || Date.now()).toISOString(),
        timeAgo: '',
        buyingSignal: row[6] === 'YES',
        matchedKeywords: (row[7] || '').split(', ').filter(Boolean),
        source: 'sheets',
        type: 'post',
        score: parseInt(row[8]) || 0,
        numComments: parseInt(row[9]) || 0,
      });
    }

    if (loaded.length) {
      // Merge with in-memory, avoiding duplicates
      const existingUrls = new Set(results.map(r => r.url));
      const newFromSheets = loaded.filter(r => !existingUrls.has(r.url));
      results = [...results, ...newFromSheets].slice(0, MAX_RESULTS);
      console.log(`[Sheets] Loaded ${newFromSheets.length} results from history`);
    }
  } catch (err) {
    console.error('[Sheets] Load error:', err.message);
  }
}

async function saveConfigToSheets() {
  if (!SPREADSHEET_ID) return;
  const sheets = await getSheetsClient();
  if (!sheets) return;

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetNames = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!sheetNames.includes('Config')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{ addSheet: { properties: { title: 'Config' } } }],
        },
      });
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Config!A1:B4',
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          ['subreddits', monitorConfig.subreddits.join(', ')],
          ['keywords', monitorConfig.keywords.join(', ')],
          ['pollMinutes', monitorConfig.pollMinutes],
          ['mode', monitorConfig.mode],
        ],
      },
    });
    console.log('[Sheets] Config saved');
  } catch (err) {
    console.error('[Sheets] Config save error:', err.message);
  }
}

async function loadConfigFromSheets() {
  if (!SPREADSHEET_ID) return;
  const sheets = await getSheetsClient();
  if (!sheets) return;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Config!A1:B4',
    });

    const rows = res.data.values;
    if (!rows) return;

    for (const [key, value] of rows) {
      if (key === 'subreddits' && value) {
        monitorConfig.subreddits = value.split(',').map(s => s.trim()).filter(Boolean);
      }
      if (key === 'keywords' && value) {
        monitorConfig.keywords = value.split(',').map(k => k.trim()).filter(Boolean);
      }
      if (key === 'pollMinutes' && value) {
        monitorConfig.pollMinutes = parseInt(value) || 5;
      }
      if (key === 'mode' && value) {
        monitorConfig.mode = value;
      }
    }

    console.log(`[Sheets] Config loaded: ${monitorConfig.subreddits.length} subs, ${monitorConfig.keywords.length} keywords`);

    // Auto-start if config was loaded
    if (monitorConfig.subreddits.length && monitorConfig.keywords.length) {
      console.log('[Sheets] Auto-starting monitoring from saved config');
      startPolling();
    }
  } catch (err) {
    console.error('[Sheets] Config load error:', err.message);
  }
}

// --------------- Helpers ---------------

function hasBuyingSignal(text) {
  const lower = (text || '').toLowerCase();
  return BUYING_SIGNALS.some(signal => lower.includes(signal));
}

function matchesKeywords(text, keywords) {
  const lower = (text || '').toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function addResults(newItems) {
  const existingUrls = new Set(results.map(r => r.url));
  const unique = newItems.filter(item => !existingUrls.has(item.url));
  results = [...unique, ...results]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_RESULTS);
  lastChecked = new Date().toISOString();

  // Save new items to Google Sheets in background
  if (unique.length) {
    saveToSheets(unique).catch(err => console.error('[Sheets] Background save error:', err.message));
  }

  return unique.length;
}

function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// --------------- RSS Mode (uses Reddit JSON API) ---------------

async function pollRSS() {
  const { subreddits, keywords } = monitorConfig;
  if (!subreddits.length || !keywords.length) {
    console.log('[RSS] Skipped — no subreddits or keywords configured');
    lastChecked = new Date().toISOString();
    return;
  }

  // Combine keywords into OR query (max ~5 per query to avoid too-long URLs)
  // Short keywords (1-2 words) use plain search, longer phrases use quotes
  const keywordChunks = [];
  for (let i = 0; i < keywords.length; i += 5) {
    keywordChunks.push(keywords.slice(i, i + 5));
  }

  console.log(`[RSS] Starting poll: ${subreddits.length} subs, ${keywordChunks.length} keyword groups`);
  const newItems = [];
  let errors = 0;
  let totalFetched = 0;

  for (const sub of subreddits) {
    for (const chunk of keywordChunks) {
      // Use quotes only for multi-word phrases, plain for single words
      const query = chunk.map(kw => kw.includes(' ') ? `(${kw})` : kw).join(' OR ');
      const jsonUrl = `https://www.reddit.com/r/${sub.trim()}/search.json?q=${encodeURIComponent(query)}&sort=new&restrict_sr=on&limit=50&t=week`;

      try {
        const response = await axios.get(jsonUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 15000,
        });

        const posts = response.data?.data?.children || [];
        totalFetched += posts.length;

        for (const child of posts) {
          const post = child.data;
          if (!post || post.over_18) continue;

          const title = post.title || '';
          const snippet = (post.selftext || '').slice(0, 300);
          const combined = `${title} ${snippet}`;
          const postUrl = `https://www.reddit.com${post.permalink}`;

          // Extract thing_id for reply feature
          const thingId = post.name || `t3_${post.id}`;

          newItems.push({
            id: post.permalink || post.id,
            thingId,
            subreddit: post.subreddit || sub.trim(),
            title,
            author: post.author || 'unknown',
            url: postUrl,
            snippet,
            date: new Date((post.created_utc || 0) * 1000).toISOString(),
            timeAgo: timeAgo(new Date((post.created_utc || 0) * 1000).toISOString()),
            buyingSignal: hasBuyingSignal(combined),
            matchedKeywords: keywords.filter(kw => combined.toLowerCase().includes(kw.toLowerCase())),
            source: 'rss',
            type: 'post',
            score: post.score || 0,
            numComments: post.num_comments || 0,
          });
        }
      } catch (err) {
        errors++;
        const status = err.response?.status || 'unknown';
        console.error(`[RSS] Error r/${sub} (${status}): ${err.message}`);

        // If rate limited, wait longer
        if (status === 429) {
          console.log('[RSS] Rate limited — waiting 60s');
          await new Promise(r => setTimeout(r, 60000));
        }
      }

      // Delay between requests (Reddit allows ~10 req/min without auth)
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const added = addResults(newItems);
  console.log(`[RSS] Done — fetched ${totalFetched} posts, ${added} new unique, ${errors} errors`);
}

// --------------- Reddit API Mode ---------------

async function getRedditToken() {
  if (redditAccessToken && Date.now() < tokenExpiresAt) {
    return redditAccessToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

  if (!clientId || !clientSecret) {
    throw new Error('Reddit API credentials not configured in .env');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
    }
  );

  redditAccessToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return redditAccessToken;
}

async function pollRedditAPI() {
  const { subreddits, keywords } = monitorConfig;
  if (!keywords.length) return;

  const newItems = [];
  const token = await getRedditToken();
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

  // Combine keywords into OR query chunks
  const keywordChunks = [];
  for (let i = 0; i < keywords.length; i += 5) {
    keywordChunks.push(keywords.slice(i, i + 5));
  }

  for (const sub of subreddits) {
    for (const chunk of keywordChunks) {
      const query = chunk.map(kw => kw.includes(' ') ? `(${kw})` : kw).join(' OR ');

      try {
        // Search posts
        const url = `https://oauth.reddit.com/r/${sub.trim()}/search?q=${encodeURIComponent(query)}&sort=new&restrict_sr=on&limit=50&t=week&type=link`;
        const res = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': userAgent,
          },
        });

        for (const child of (res.data.data?.children || [])) {
          const post = child.data;
          if (!post || post.over_18) continue;

          const title = post.title || '';
          const snippet = (post.selftext || '').slice(0, 300);
          const combined = `${title} ${snippet}`;

          newItems.push({
            id: post.permalink || post.id,
            thingId: post.name || `t3_${post.id}`,
            subreddit: post.subreddit || sub.trim(),
            title,
            author: post.author || 'unknown',
            url: `https://www.reddit.com${post.permalink}`,
            snippet,
            date: new Date((post.created_utc || 0) * 1000).toISOString(),
            timeAgo: timeAgo(new Date((post.created_utc || 0) * 1000).toISOString()),
            buyingSignal: hasBuyingSignal(combined),
            matchedKeywords: keywords.filter(kw => combined.toLowerCase().includes(kw.toLowerCase())),
            source: 'api',
            type: 'post',
            score: post.score || 0,
            numComments: post.num_comments || 0,
          });
        }
      } catch (err) {
        console.error(`[API] Error r/${sub}: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 1200));
    }
  }

  const added = addResults(newItems);
  console.log(`[API] Polled — ${added} new results`);
}

// --------------- Cron Scheduling ---------------

function startPolling() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  const { mode, pollMinutes } = monitorConfig;
  activeMode = mode;

  const pollFn = mode === 'api' ? pollRedditAPI : pollRSS;
  const interval = Math.max(1, pollMinutes || (mode === 'api' ? 3 : 5));

  // Run immediately
  pollFn().catch(err => console.error('Poll error:', err.message));

  // Then on schedule
  cronJob = cron.schedule(`*/${interval} * * * *`, () => {
    pollFn().catch(err => console.error('Poll error:', err.message));
  });

  console.log(`[Monitor] Started ${mode.toUpperCase()} mode — polling every ${interval} min`);
}

function stopPolling() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  console.log('[Monitor] Stopped polling');
}

// --------------- Team Login ---------------

const TEAM_USERS = {
  boss: { password: 'leadfinder123', role: 'admin', name: 'Boss' },
  bryan: { password: 'bryan2024', role: 'admin', name: 'Bryan' },
  user1: { password: 'user1pass', role: 'user', name: 'Team Member 1' },
  user2: { password: 'user2pass', role: 'user', name: 'Team Member 2' },
};

// Simple token store (in production, use JWT)
const activeSessions = new Map();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = activeSessions.get(token);
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = TEAM_USERS[username];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = generateToken();
  activeSessions.set(token, { username, role: user.role, name: user.name });

  res.json({ ok: true, token, username, role: user.role, name: user.name });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) activeSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/check-auth', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token || !activeSessions.has(token)) {
    return res.json({ authenticated: false });
  }
  const user = activeSessions.get(token);
  res.json({ authenticated: true, ...user });
});

// --------------- Status Update (Replied/Rejected) ---------------

app.post('/api/update-status', authMiddleware, async (req, res) => {
  const { url, status } = req.body;
  const validStatuses = ['Qualified', 'Replied', 'Unqualified', ''];
  if (!url || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid url or status' });
  }

  // Store in memory (shared across all users)
  if (status) {
    leadStatuses.set(url, {
      status,
      updatedBy: req.user?.name || req.user?.username || 'unknown',
      updatedAt: new Date().toISOString(),
    });
  } else {
    leadStatuses.delete(url);
  }

  // Update in Google Sheets (background)
  if (SPREADSHEET_ID) {
    const sheets = await getSheetsClient();
    if (sheets) {
      try {
        const data = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Results!E:K',
        });
        const rows = data.data.values || [];
        for (let i = 0; i < rows.length; i++) {
          if (rows[i][0] === url) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `Results!K${i + 1}`,
              valueInputOption: 'RAW',
              requestBody: { values: [[`${status} by ${req.user?.name || 'unknown'}`]] },
            });
            break;
          }
        }
      } catch (err) {
        console.error('[Sheets] Status update error:', err.message);
      }
    }
  }

  res.json({ ok: true });
});

// --------------- API Routes ---------------

// Health check (for UptimeRobot)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), results: results.length, isRunning: !!cronJob });
});

// Get results
app.get('/api/results', (req, res) => {
  const { subreddit, keyword, buyingSignalOnly } = req.query;
  let filtered = [...results];

  if (subreddit) {
    filtered = filtered.filter(r => r.subreddit.toLowerCase() === subreddit.toLowerCase());
  }
  if (keyword) {
    filtered = filtered.filter(r =>
      r.title.toLowerCase().includes(keyword.toLowerCase()) ||
      r.snippet.toLowerCase().includes(keyword.toLowerCase())
    );
  }
  if (buyingSignalOnly === 'true') {
    filtered = filtered.filter(r => r.buyingSignal);
  }

  // Attach lead statuses and filter out Unqualified
  filtered = filtered
    .map(r => {
      const ls = leadStatuses.get(r.url);
      return { ...r, timeAgo: timeAgo(r.date), leadStatus: ls || null };
    })
    .filter(r => !r.leadStatus || r.leadStatus.status !== 'Unqualified');

  res.json({
    results: filtered,
    total: filtered.length,
    lastChecked,
    activeMode,
    isRunning: !!cronJob,
    sheetsConnected: !!SPREADSHEET_ID,
    sheetsUrl: SPREADSHEET_ID ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/` : null,
    config: {
      subreddits: monitorConfig.subreddits,
      keywords: monitorConfig.keywords,
      pollMinutes: monitorConfig.pollMinutes,
      mode: monitorConfig.mode,
    },
  });
});

// Update settings
app.post('/api/settings', (req, res) => {
  const { subreddits, keywords, pollMinutes, mode } = req.body;

  if (subreddits !== undefined) {
    monitorConfig.subreddits = Array.isArray(subreddits)
      ? subreddits.filter(Boolean)
      : subreddits.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (keywords !== undefined) {
    monitorConfig.keywords = Array.isArray(keywords)
      ? keywords.filter(Boolean)
      : keywords.split(',').map(k => k.trim()).filter(Boolean);
  }
  if (pollMinutes !== undefined) {
    monitorConfig.pollMinutes = Math.max(1, parseInt(pollMinutes) || 5);
  }
  if (mode !== undefined) {
    monitorConfig.mode = mode === 'api' ? 'api' : 'rss';
  }

  // Save config to sheets in background
  saveConfigToSheets().catch(() => {});

  res.json({ ok: true, config: monitorConfig });
});

// Start monitoring
app.post('/api/start', (req, res) => {
  if (!monitorConfig.subreddits.length && !monitorConfig.keywords.length) {
    return res.status(400).json({ error: 'Configure at least one subreddit and one keyword first' });
  }
  startPolling();
  res.json({ ok: true, mode: monitorConfig.mode });
});

// Stop monitoring
app.post('/api/stop', (req, res) => {
  stopPolling();
  res.json({ ok: true });
});

// Manual poll
app.post('/api/poll-now', async (req, res) => {
  try {
    const pollFn = monitorConfig.mode === 'api' ? pollRedditAPI : pollRSS;
    await pollFn();
    res.json({ ok: true, total: results.length, lastChecked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test Reddit API connection
app.post('/api/test-connection', async (req, res) => {
  try {
    const token = await getRedditToken();
    const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

    const me = await axios.get('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      },
    });

    res.json({ ok: true, message: `Connected! App type: ${me.data.name || 'script'}` });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

// Clear results
app.post('/api/clear', (req, res) => {
  results = [];
  lastChecked = null;
  res.json({ ok: true });
});

// Generate email digest
app.post('/api/digest', (req, res) => {
  const { buyingSignalOnly } = req.body;
  let items = [...results];
  if (buyingSignalOnly) {
    items = items.filter(r => r.buyingSignal);
  }

  const grouped = {};
  for (const item of items.slice(0, 50)) {
    const sub = item.subreddit;
    if (!grouped[sub]) grouped[sub] = [];
    grouped[sub].push(item);
  }

  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const subjectLine = `Reddit Intent Monitor Digest — ${now}`;

  let plain = `${subjectLine}\n${'='.repeat(50)}\n\n`;
  plain += `${items.length} matching posts found.\n\n`;
  for (const [sub, posts] of Object.entries(grouped)) {
    plain += `--- r/${sub} (${posts.length} posts) ---\n\n`;
    for (const p of posts) {
      plain += `  ${p.buyingSignal ? '[BUYING SIGNAL] ' : ''}${p.title}\n`;
      plain += `  ${p.url}\n`;
      plain += `  by u/${p.author} • ${p.timeAgo}\n`;
      if (p.snippet) plain += `  "${p.snippet.slice(0, 120)}..."\n`;
      plain += '\n';
    }
  }
  plain += `\nGenerated by Reddit Intent Monitor • ${new Date().toISOString()}\n`;

  let html = `<div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;">`;
  html += `<div style="background:#1a1a1b;padding:20px;border-radius:8px 8px 0 0;">`;
  html += `<h1 style="color:#FF4500;margin:0;font-size:22px;">Reddit Intent Monitor</h1>`;
  html += `<p style="color:#818384;margin:5px 0 0;">${now} &bull; ${items.length} results</p></div>`;
  html += `<div style="background:#fff;padding:20px;border:1px solid #ddd;">`;

  for (const [sub, posts] of Object.entries(grouped)) {
    html += `<h2 style="color:#1a1a1b;border-bottom:2px solid #FF4500;padding-bottom:5px;">r/${sub} <span style="color:#818384;font-weight:normal;font-size:14px;">(${posts.length})</span></h2><ul style="list-style:none;padding:0;">`;
    for (const p of posts) {
      html += `<li style="margin-bottom:15px;padding:12px;background:#f8f9fa;border-radius:6px;border-left:3px solid ${p.buyingSignal ? '#FF4500' : '#ddd'};">`;
      if (p.buyingSignal) html += `<span style="background:#FF4500;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;margin-bottom:5px;display:inline-block;">BUYING SIGNAL</span><br>`;
      html += `<a href="${p.url}" style="color:#1a1a1b;font-weight:bold;text-decoration:none;font-size:15px;">${p.title}</a><br>`;
      html += `<span style="color:#818384;font-size:12px;">u/${p.author} &bull; ${timeAgo(p.date)}</span>`;
      if (p.snippet) html += `<p style="color:#4a4a4a;font-size:13px;margin:5px 0 0;">"${p.snippet.slice(0, 150)}..."</p>`;
      html += `</li>`;
    }
    html += `</ul>`;
  }

  html += `</div>`;
  html += `<div style="background:#f0f0f0;padding:15px;text-align:center;border-radius:0 0 8px 8px;font-size:12px;color:#818384;">`;
  html += `Generated by Reddit Intent Monitor &bull; <a href="#" style="color:#FF4500;">Unsubscribe</a></div></div>`;

  res.json({ subjectLine, html, plain, resultCount: items.length });
});

// --------------- Reddit OAuth Login (for replying) ---------------

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const OAUTH_REDIRECT = `${APP_URL}/auth/reddit/callback`;

app.get('/auth/reddit', (req, res) => {
  const clientId = process.env.REDDIT_CLIENT_ID;
  if (!clientId) {
    return res.status(400).send('REDDIT_CLIENT_ID not configured in .env');
  }

  const state = Math.random().toString(36).substring(2, 15);
  const scope = 'identity submit read';
  const authUrl = `https://www.reddit.com/api/v1/authorize?client_id=${clientId}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}&duration=permanent&scope=${scope}`;

  res.redirect(authUrl);
});

app.get('/auth/reddit/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send('<script>window.close();</script><p>Login cancelled. You can close this window.</p>');
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent,
        },
      }
    );

    userAccessToken = tokenRes.data.access_token;
    userRefreshToken = tokenRes.data.refresh_token;
    userTokenExpiresAt = Date.now() + (tokenRes.data.expires_in - 60) * 1000;

    const meRes = await axios.get('https://oauth.reddit.com/api/v1/me', {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        'User-Agent': userAgent,
      },
    });
    redditUsername = meRes.data.name;

    res.send(`
      <html><body style="background:#1a1a1b;color:#d7dadc;font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="text-align:center;">
          <h2 style="color:#FF4500;">Connected as u/${redditUsername}</h2>
          <p>You can close this window and return to the dashboard.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'reddit-auth', username: '${redditUsername}' }, '*');
              setTimeout(() => window.close(), 2000);
            }
          </script>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send(`<p>Login failed: ${err.message}. <a href="/">Go back</a></p>`);
  }
});

async function refreshUserToken() {
  if (!userRefreshToken) throw new Error('Not logged in to Reddit');

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const tokenRes = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    `grant_type=refresh_token&refresh_token=${userRefreshToken}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
    }
  );

  userAccessToken = tokenRes.data.access_token;
  userTokenExpiresAt = Date.now() + (tokenRes.data.expires_in - 60) * 1000;
  return userAccessToken;
}

async function getUserToken() {
  if (userAccessToken && Date.now() < userTokenExpiresAt) {
    return userAccessToken;
  }
  return refreshUserToken();
}

app.get('/api/reddit-user', (req, res) => {
  res.json({
    loggedIn: !!userAccessToken,
    username: redditUsername || null,
  });
});

app.post('/api/reddit-logout', (req, res) => {
  userAccessToken = null;
  userRefreshToken = null;
  userTokenExpiresAt = 0;
  redditUsername = null;
  res.json({ ok: true });
});

app.post('/api/reply', async (req, res) => {
  const { thingId, text } = req.body;

  if (!thingId || !text) {
    return res.status(400).json({ error: 'Missing thingId or text' });
  }

  if (!userAccessToken) {
    return res.status(401).json({ error: 'Not logged in. Connect your Reddit account first.' });
  }

  try {
    const token = await getUserToken();
    const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

    await axios.post(
      'https://oauth.reddit.com/api/comment',
      `thing_id=${thingId}&text=${encodeURIComponent(text)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': userAgent,
        },
      }
    );

    res.json({ ok: true, message: 'Reply posted successfully' });
  } catch (err) {
    const errMsg = err.response?.data?.json?.errors?.[0]?.[1] || err.message;
    console.error('Reply error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// Catch-all
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// --------------- Start Server ---------------

app.listen(PORT, async () => {
  console.log(`\n  Reddit Intent Monitor running at http://localhost:${PORT}\n`);

  // Load data from Google Sheets on startup
  if (SPREADSHEET_ID) {
    console.log('[Sheets] Loading saved data...');
    await loadFromSheets().catch(err => console.error('[Sheets] Load error:', err.message));
    await loadConfigFromSheets().catch(err => console.error('[Sheets] Config load error:', err.message));
  }
});
