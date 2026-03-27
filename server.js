require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const RSSParser = require('rss-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const rssParser = new RSSParser({
  headers: {
    'User-Agent': 'RedditIntentMonitor/1.0 (Node.js RSS Reader)',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
  timeout: 15000,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --------------- In-Memory Store ---------------

const MAX_RESULTS = 200;
let results = [];
let lastChecked = null;
let activeMode = 'rss'; // 'rss' or 'api'
let cronJob = null;
let redditAccessToken = null;
let tokenExpiresAt = 0;

// User OAuth tokens (for replying)
let userAccessToken = null;
let userRefreshToken = null;
let userTokenExpiresAt = 0;
let redditUsername = null;

// Current monitoring config (set via /api/settings)
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
];

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
  // Deduplicate by URL
  const existingUrls = new Set(results.map(r => r.url));
  const unique = newItems.filter(item => !existingUrls.has(item.url));
  results = [...unique, ...results].slice(0, MAX_RESULTS);
  lastChecked = new Date().toISOString();
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

// --------------- RSS Mode ---------------

async function fetchRSSFeed(url) {
  // Try rss-parser first
  try {
    return await rssParser.parseURL(url);
  } catch (err) {
    console.log(`[RSS] rss-parser failed, trying axios fallback: ${err.message}`);
  }

  // Fallback: fetch with axios and parse
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'RedditIntentMonitor/1.0 (Node.js RSS Reader)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });
    return await rssParser.parseString(response.data);
  } catch (err) {
    throw new Error(`Both RSS methods failed: ${err.message}`);
  }
}

async function pollRSS() {
  const { subreddits, keywords } = monitorConfig;
  if (!subreddits.length || !keywords.length) {
    console.log('[RSS] Skipped — no subreddits or keywords configured');
    lastChecked = new Date().toISOString();
    return;
  }

  console.log(`[RSS] Starting poll: ${subreddits.length} subs x ${keywords.length} keywords`);
  const newItems = [];
  let errors = 0;

  for (const sub of subreddits) {
    for (const keyword of keywords) {
      // Use Reddit JSON API instead of RSS (more reliable)
      const jsonUrl = `https://www.reddit.com/r/${sub.trim()}/search.json?q=${encodeURIComponent(keyword.trim())}&sort=new&restrict_sr=on&limit=25`;
      try {
        const response = await axios.get(jsonUrl, {
          headers: {
            'User-Agent': 'RedditIntentMonitor/1.0 (Node.js; lead monitoring tool)',
          },
          timeout: 15000,
        });

        const posts = response.data?.data?.children || [];
        console.log(`[RSS] r/${sub} "${keyword}" — ${posts.length} posts found`);

        for (const child of posts) {
          const post = child.data;
          const title = post.title || '';
          const snippet = (post.selftext || '').slice(0, 300);
          const combined = `${title} ${snippet}`;
          const postUrl = `https://www.reddit.com${post.permalink}`;

          newItems.push({
            id: post.permalink || post.id,
            thingId: post.name || `t3_${post.id}`,
            subreddit: sub.trim(),
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
        console.error(`[RSS] Error r/${sub} "${keyword}": ${err.message}`);
      }

      // Delay between requests to respect rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const added = addResults(newItems);
  console.log(`[RSS] Done — ${newItems.length} total, ${added} new, ${errors} errors`);
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

async function searchRedditAPI(query, subreddit) {
  const token = await getRedditToken();
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

  const subPath = subreddit ? `/r/${subreddit}` : '';
  const url = `https://oauth.reddit.com${subPath}/search?q=${encodeURIComponent(query)}&sort=new&limit=25&type=link`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
    },
  });

  return (res.data.data?.children || []).map(child => child.data);
}

async function searchRedditComments(query, subreddit) {
  const token = await getRedditToken();
  const userAgent = process.env.REDDIT_USER_AGENT || 'RedditIntentMonitor/1.0';

  const url = `https://oauth.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(query)}&sort=new&limit=25&type=comment`;

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      },
    });
    return (res.data.data?.children || []).map(child => child.data);
  } catch {
    return [];
  }
}

async function pollRedditAPI() {
  const { subreddits, keywords } = monitorConfig;
  if (!keywords.length) return;

  const newItems = [];

  for (const keyword of keywords) {
    // Global search across all subreddits
    try {
      const posts = subreddits.length
        ? (await Promise.all(subreddits.map(sub => searchRedditAPI(keyword, sub.trim())))).flat()
        : await searchRedditAPI(keyword, '');

      for (const post of posts) {
        const title = post.title || '';
        const snippet = (post.selftext || '').slice(0, 300);
        const combined = `${title} ${snippet}`;

        newItems.push({
          id: post.permalink || post.id,
          thingId: post.name || `t3_${post.id}`,
          subreddit: post.subreddit || 'unknown',
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
      console.error(`API post search error ["${keyword}"]: ${err.message}`);
    }

    // Comment search per subreddit
    for (const sub of subreddits) {
      try {
        const comments = await searchRedditComments(keyword, sub.trim());
        for (const comment of comments) {
          const body = (comment.body || '').slice(0, 300);
          if (matchesKeywords(body, [keyword])) {
            newItems.push({
              id: comment.permalink || comment.id,
              thingId: comment.name || `t1_${comment.id}`,
              subreddit: comment.subreddit || sub.trim(),
              title: `Comment in r/${comment.subreddit || sub.trim()}`,
              author: comment.author || 'unknown',
              url: comment.permalink ? `https://www.reddit.com${comment.permalink}` : '',
              snippet: body,
              date: new Date((comment.created_utc || 0) * 1000).toISOString(),
              timeAgo: timeAgo(new Date((comment.created_utc || 0) * 1000).toISOString()),
              buyingSignal: hasBuyingSignal(body),
              matchedKeywords: [keyword],
              source: 'api',
              type: 'comment',
              score: comment.score || 0,
            });
          }
        }
      } catch (err) {
        console.error(`API comment search error [r/${sub} "${keyword}"]: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 1200));
  }

  const added = addResults(newItems);
  console.log(`[API] Polled ${keywords.length} keywords — ${added} new results`);
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

// --------------- API Routes ---------------

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

  // Refresh timeAgo
  filtered = filtered.map(r => ({ ...r, timeAgo: timeAgo(r.date) }));

  res.json({
    results: filtered,
    total: filtered.length,
    lastChecked,
    activeMode,
    isRunning: !!cronJob,
    config: {
      subreddits: monitorConfig.subreddits,
      keywords: monitorConfig.keywords,
      pollMinutes: monitorConfig.pollMinutes,
      mode: monitorConfig.mode,
    },
  });
});

// Update settings and start/restart monitoring
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

  // Group by subreddit
  const grouped = {};
  for (const item of items.slice(0, 50)) {
    const sub = item.subreddit;
    if (!grouped[sub]) grouped[sub] = [];
    grouped[sub].push(item);
  }

  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const subjectLine = `Reddit Intent Monitor Digest — ${now}`;

  // Plain text
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

  // HTML
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

// Step 1: Redirect user to Reddit login
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

// Step 2: Reddit calls back with auth code
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

    // Get username
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

// Refresh user token
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

// Check login status
app.get('/api/reddit-user', (req, res) => {
  res.json({
    loggedIn: !!userAccessToken,
    username: redditUsername || null,
  });
});

// Logout
app.post('/api/reddit-logout', (req, res) => {
  userAccessToken = null;
  userRefreshToken = null;
  userTokenExpiresAt = 0;
  redditUsername = null;
  res.json({ ok: true });
});

// Reply to a Reddit post/comment
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

    const response = await axios.post(
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

    const commentData = response.data?.jquery || response.data;
    res.json({ ok: true, message: 'Reply posted successfully' });
  } catch (err) {
    const errMsg = err.response?.data?.json?.errors?.[0]?.[1] || err.message;
    console.error('Reply error:', errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// Catch-all: return JSON 404 for any unmatched API route
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Serve index.html for all other routes (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// --------------- Start Server ---------------

app.listen(PORT, () => {
  console.log(`\n  Reddit Intent Monitor running at http://localhost:${PORT}\n`);
});
