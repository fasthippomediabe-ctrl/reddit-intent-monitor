// --------------- State ---------------
const API = '';
let soundEnabled = true;
let previousCount = 0;
let digestData = null;
let autoRefreshInterval = null;
let redditConnected = false;
let redditUser = null;
let authToken = null;

// --------------- Auth ---------------
function getHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['x-auth-token'] = authToken;
  return h;
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');

  try {
    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      errorEl.textContent = data.error || 'Login failed';
      return;
    }

    authToken = data.token;
    localStorage.setItem('rim-token', data.token);
    localStorage.setItem('rim-user', JSON.stringify({ username: data.username, role: data.role, name: data.name }));
    showApp(data);
  } catch (err) {
    errorEl.textContent = 'Connection error';
  }
}

async function checkAuth() {
  const savedToken = localStorage.getItem('rim-token');
  if (!savedToken) return false;

  try {
    const res = await fetch(`${API}/api/check-auth`, {
      headers: { 'x-auth-token': savedToken },
    });
    const data = await res.json();
    if (data.authenticated) {
      authToken = savedToken;
      showApp(data);
      return true;
    }
  } catch {}

  localStorage.removeItem('rim-token');
  localStorage.removeItem('rim-user');
  return false;
}

function showApp(user) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('logged-in-user').textContent = user.name || user.username;
  initApp();
}

async function handleLogout() {
  try {
    await fetch(`${API}/api/logout`, { method: 'POST', headers: getHeaders() });
  } catch {}
  authToken = null;
  localStorage.removeItem('rim-token');
  localStorage.removeItem('rim-user');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
}

// --------------- Init ---------------
document.addEventListener('DOMContentLoaded', async () => {
  const loggedIn = await checkAuth();
  if (!loggedIn) {
    document.getElementById('login-screen').classList.remove('hidden');
  }
});

function initApp() {
  loadSettings();
  fetchResults();
  startAutoRefresh();
  checkRedditLogin();
  updateSheetsLink();

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'reddit-auth') {
      redditConnected = true;
      redditUser = e.data.username;
      updateRedditUI();
      showToast(`Connected as u/${redditUser}`);
    }
  });

  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-copy-all').addEventListener('click', copyAll);
  document.getElementById('btn-digest').addEventListener('click', openDigest);
  document.getElementById('btn-refresh').addEventListener('click', manualPoll);
  document.getElementById('sound-toggle').addEventListener('click', toggleSound);

  document.getElementById('filter-subreddit').addEventListener('input', fetchResults);
  document.getElementById('filter-keyword').addEventListener('input', fetchResults);
  document.getElementById('filter-buying-signal').addEventListener('change', fetchResults);
}

function updateSheetsLink() {
  // Try to get spreadsheet ID from results endpoint
  fetch(`${API}/api/results?` + new URLSearchParams()).then(r => r.json()).then(data => {
    if (data.sheetsConnected) {
      // The link will be updated when we know the ID
    }
  }).catch(() => {});
}

// --------------- API Calls ---------------
async function fetchResults() {
  const params = new URLSearchParams();
  const subFilter = document.getElementById('filter-subreddit')?.value?.trim();
  const kwFilter = document.getElementById('filter-keyword')?.value?.trim();
  const bsOnly = document.getElementById('filter-buying-signal')?.checked;

  if (subFilter) params.set('subreddit', subFilter);
  if (kwFilter) params.set('keyword', kwFilter);
  if (bsOnly) params.set('buyingSignalOnly', 'true');

  try {
    const res = await fetch(`${API}/api/results?${params}`);
    const data = await res.json();

    updateHeader(data);

    if (data.total > previousCount && previousCount > 0 && soundEnabled) {
      playNotification();
    }
    previousCount = data.total;

    renderResults(data.results);
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

async function saveAndStart() {
  const subreddits = document.getElementById('setting-subreddits').value;
  const keywords = document.getElementById('setting-keywords').value;
  const pollMinutes = document.getElementById('setting-poll').value;
  const mode = document.querySelector('.mode-btn.active').id === 'mode-api' ? 'api' : 'rss';

  localStorage.setItem('rim-subreddits', subreddits);
  localStorage.setItem('rim-keywords', keywords);
  localStorage.setItem('rim-poll', pollMinutes);
  localStorage.setItem('rim-mode', mode);

  try {
    const settingsRes = await fetch(`${API}/api/settings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        subreddits: subreddits.split(',').map(s => s.trim()).filter(Boolean),
        keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
        pollMinutes: parseInt(pollMinutes) || 5,
        mode,
      }),
    });

    if (!settingsRes.ok) {
      const text = await settingsRes.text();
      showToast('Settings error: ' + text, true);
      return;
    }

    const startRes = await fetch(`${API}/api/start`, { method: 'POST' });
    const startData = await startRes.json().catch(() => ({ error: 'Server error' }));

    if (!startRes.ok || startData.error) {
      showToast(startData.error || 'Failed to start', true);
      return;
    }

    showToast(`Monitoring started in ${mode.toUpperCase()} mode`);
    closeSettings();
    setTimeout(fetchResults, 3000);
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
}

async function stopMonitoring() {
  try {
    await fetch(`${API}/api/stop`, { method: 'POST' });
    showToast('Monitoring stopped');
    fetchResults();
  } catch (err) {
    showToast('Error stopping: ' + err.message, true);
  }
}

async function manualPoll() {
  const btn = document.getElementById('btn-refresh');
  btn.textContent = 'Polling...';
  btn.disabled = true;

  try {
    await fetch(`${API}/api/poll-now`, { method: 'POST' });
    await fetchResults();
    showToast('Refreshed');
  } catch (err) {
    showToast('Poll error: ' + err.message, true);
  }

  btn.textContent = 'Refresh Now';
  btn.disabled = false;
}

async function testConnection() {
  const status = document.getElementById('connection-status');
  status.textContent = 'Testing...';
  status.style.color = 'var(--text-muted)';

  try {
    const res = await fetch(`${API}/api/test-connection`, { method: 'POST' });
    const data = await res.json();
    status.textContent = data.ok ? data.message : (data.error || 'Failed');
    status.style.color = data.ok ? 'var(--green)' : 'var(--red)';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = 'var(--red)';
  }
}

async function clearResults() {
  if (!confirm('Clear all results?')) return;
  await fetch(`${API}/api/clear`, { method: 'POST' });
  previousCount = 0;
  fetchResults();
  showToast('Results cleared');
}

// --------------- Status Updates ---------------
async function updateStatus(url, status, btn) {
  try {
    await fetch(`${API}/api/update-status`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ url, status }),
    });

    // Update button visuals
    const card = btn.closest('.card-footer');
    card.querySelectorAll('.status-btn').forEach(b => {
      b.classList.remove('active-replied', 'active-rejected');
    });

    if (status === 'replied') btn.classList.add('active-replied');
    if (status === 'rejected') btn.classList.add('active-rejected');

    showToast(`Marked as ${status || 'cleared'}`);
  } catch (err) {
    showToast('Error updating status', true);
  }
}

// --------------- Rendering ---------------
function updateHeader(data) {
  const statusBadge = document.getElementById('status-badge');
  const modeBadge = document.getElementById('mode-badge');
  const resultCount = document.getElementById('result-count');
  const lastChecked = document.getElementById('last-checked');

  statusBadge.textContent = data.isRunning ? 'Running' : 'Stopped';
  statusBadge.className = `badge ${data.isRunning ? 'badge-running' : 'badge-stopped'}`;
  modeBadge.textContent = (data.activeMode || 'rss').toUpperCase();
  resultCount.textContent = `${data.total} result${data.total !== 1 ? 's' : ''}`;

  if (data.lastChecked) {
    const d = new Date(data.lastChecked);
    lastChecked.textContent = `Last checked: ${d.toLocaleTimeString()}`;
  }

  // Update sheets link if connected
  const sheetsLink = document.getElementById('sheets-link');
  if (data.sheetsUrl) {
    sheetsLink.href = data.sheetsUrl;
    sheetsLink.style.display = '';
  } else {
    sheetsLink.style.display = 'none';
  }
}

function renderResults(items) {
  const feed = document.getElementById('results-feed');

  if (!items || items.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <span style="font-size:48px;">&#129435;</span>
        <p>No results yet. Configure your subreddits and keywords, then start monitoring.</p>
        <button onclick="openSettings()" class="btn btn-brand">Open Settings</button>
      </div>`;
    return;
  }

  feed.innerHTML = items.map(item => `
    <div class="result-card ${item.buyingSignal ? 'buying-signal' : ''}">
      <div class="card-header">
        <span class="sub-badge">r/${escapeHtml(item.subreddit)}</span>
        ${item.buyingSignal ? '<span class="signal-badge">Buying Signal</span>' : ''}
        ${item.type === 'comment' ? '<span class="comment-badge">Comment</span>' : ''}
        <span class="card-meta">u/${escapeHtml(item.author)} &bull; ${escapeHtml(item.timeAgo)}</span>
      </div>
      <div class="card-title">
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
      </div>
      ${item.snippet ? `<div class="card-snippet">${escapeHtml(item.snippet.slice(0, 200))}${item.snippet.length > 200 ? '...' : ''}</div>` : ''}
      <div class="card-footer">
        ${(item.matchedKeywords || []).map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('')}
        <button class="status-btn" onclick="updateStatus('${escapeHtml(item.url)}', 'replied', this)">Replied</button>
        <button class="status-btn" onclick="updateStatus('${escapeHtml(item.url)}', 'rejected', this)">Rejected</button>
        <div class="card-actions">
          <button class="btn btn-small btn-secondary" onclick="copyResult(this, ${escapeAttr(JSON.stringify(item))})">Copy</button>
          ${item.thingId && redditConnected ? `<button class="btn btn-small btn-secondary" onclick="toggleReplyBox('${escapeHtml(item.thingId)}')">Reply</button>` : ''}
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="btn btn-small btn-brand">Open</a>
        </div>
      </div>
      <div id="reply-${escapeHtml(item.thingId || '')}" class="reply-box hidden">
        <textarea id="reply-text-${escapeHtml(item.thingId || '')}" placeholder="Write your reply... Be genuine and helpful." oninput="updateCharCount('${escapeHtml(item.thingId || '')}')"></textarea>
        <div class="reply-actions">
          <button class="btn btn-small btn-brand" onclick="submitReply('${escapeHtml(item.thingId || '')}', this)">Post Reply</button>
          <button class="btn btn-small btn-secondary" onclick="toggleReplyBox('${escapeHtml(item.thingId || '')}')">Cancel</button>
          <span class="char-count" id="char-count-${escapeHtml(item.thingId || '')}">0 chars</span>
        </div>
        <div id="reply-status-${escapeHtml(item.thingId || '')}" class="reply-status"></div>
      </div>
    </div>
  `).join('');
}

// --------------- Copy Functions ---------------
function copyResult(btn, item) {
  const text = `r/${item.subreddit} \u2022 ${item.title} \u2022 ${item.url} \u2022 ${item.timeAgo}`;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    showToast('Copied to clipboard');
  });
}

function copyAll() {
  const cards = document.querySelectorAll('.result-card');
  if (cards.length === 0) { showToast('No results to copy'); return; }

  const lines = [];
  cards.forEach(card => {
    const sub = card.querySelector('.sub-badge')?.textContent || '';
    const title = card.querySelector('.card-title a')?.textContent || '';
    const url = card.querySelector('.card-title a')?.href || '';
    const meta = card.querySelector('.card-meta')?.textContent || '';
    lines.push(`${sub} \u2022 ${title} \u2022 ${url} \u2022 ${meta}`);
  });

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast(`Copied ${lines.length} results`);
  });
}

// --------------- Digest ---------------
async function openDigest() {
  document.getElementById('digest-overlay').classList.remove('hidden');
  document.getElementById('digest-modal').classList.remove('hidden');
  await generateDigest();
}

function closeDigest() {
  document.getElementById('digest-overlay').classList.add('hidden');
  document.getElementById('digest-modal').classList.add('hidden');
}

async function generateDigest() {
  const buyingOnly = document.getElementById('digest-buying-only').checked;
  try {
    const res = await fetch(`${API}/api/digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyingSignalOnly: buyingOnly }),
    });
    digestData = await res.json();
    document.getElementById('digest-subject').textContent = `Subject: ${digestData.subjectLine}`;
    document.getElementById('digest-preview').innerHTML = digestData.html;
  } catch (err) {
    showToast('Error generating digest: ' + err.message, true);
  }
}

function copyDigestHTML() {
  if (!digestData) return;
  navigator.clipboard.writeText(digestData.html).then(() => showToast('HTML copied'));
}

function copyDigestPlain() {
  if (!digestData) return;
  navigator.clipboard.writeText(digestData.plain).then(() => showToast('Plain text copied'));
}

// --------------- How To Use ---------------
function openHowTo() {
  document.getElementById('howto-overlay').classList.remove('hidden');
  document.getElementById('howto-modal').classList.remove('hidden');
}

function closeHowTo() {
  document.getElementById('howto-overlay').classList.add('hidden');
  document.getElementById('howto-modal').classList.add('hidden');
}

function downloadInstructions() {
  const text = `==========================================================
    REDDIT LEAD MONITOR - User Guide
    Powered by Fast Hippo Media
    https://fasthippomedia.com
==========================================================

OVERVIEW
--------
Reddit Lead Monitor scans Reddit in real-time for posts
where people are actively looking for marketing, SEO,
web design, and other services your agency offers.

STEP 1: Login
-------------
Use your team credentials to log in.

STEP 2: Configure Settings
--------------------------
- Click "Settings" in the top right
- Enter subreddits (e.g. smallbusiness, entrepreneur, SEO)
- Enter keywords (e.g. looking for agency, need SEO help)
- Set poll interval (default: 5 minutes)
- Click "Save & Start Monitoring"

STEP 3: Monitor Results
-----------------------
- Results appear in the feed, newest first
- "Buying Signal" badge = high-intent post
- Click "Open" to view the Reddit post
- Click "Reply" to respond directly (requires Reddit account)
- Click "Replied" or "Rejected" to track status

STEP 4: Reply Effectively
--------------------------
1. Read the full post
2. Write a genuine, helpful comment
3. Mention you can help further via DM
4. Mark as "Replied" in the dashboard

EXAMPLE REPLY:
"I run a digital marketing agency and we work with a lot
of [their industry] businesses. The biggest quick wins I'd
suggest are [specific advice]. Happy to take a look for
free if you want - just DM me."

FEATURES
--------
- Buying signal detection (25+ intent phrases)
- Google Sheets integration (auto-saves all results)
- Email digest generator
- Sound notifications
- Copy to clipboard
- Status tracking (Replied/Rejected)
- Reddit account integration for direct replies

TIPS
----
- Focus on "Buying Signal" posts first
- Reply during US business hours (8am-8pm EST)
- Be helpful first, promotional second
- Follow Reddit's 90/10 rule (90% helpful, 10% promo)
- Check the Google Sheets link for full history

==========================================================
  Fast Hippo Media | fasthippomedia.com
  Award Winning Digital Marketing Agency
==========================================================`;

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'FastHippoMedia_Reddit_Lead_Monitor_Guide.txt';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Instructions downloaded');
}

// --------------- Settings Panel ---------------
function openSettings() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  document.getElementById('settings-panel').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
  document.getElementById('settings-panel').classList.add('hidden');
}

function setMode(mode) {
  document.getElementById('mode-rss').classList.toggle('active', mode === 'rss');
  document.getElementById('mode-api').classList.toggle('active', mode === 'api');
  document.getElementById('api-settings').classList.toggle('hidden', mode !== 'api');
  const pollInput = document.getElementById('setting-poll');
  if (mode === 'api' && pollInput.value === '5') pollInput.value = '3';
  if (mode === 'rss' && pollInput.value === '3') pollInput.value = '5';
}

function loadSettings() {
  const subs = localStorage.getItem('rim-subreddits');
  const kws = localStorage.getItem('rim-keywords');
  const poll = localStorage.getItem('rim-poll');
  const mode = localStorage.getItem('rim-mode');
  if (subs) document.getElementById('setting-subreddits').value = subs;
  if (kws) document.getElementById('setting-keywords').value = kws;
  if (poll) document.getElementById('setting-poll').value = poll;
  if (mode) setMode(mode);
}

// --------------- Sound ---------------
function toggleSound() {
  soundEnabled = !soundEnabled;
  document.getElementById('sound-on-icon').style.display = soundEnabled ? '' : 'none';
  document.getElementById('sound-off-icon').style.display = soundEnabled ? 'none' : '';
  document.getElementById('sound-toggle').classList.toggle('active', soundEnabled);
  showToast(soundEnabled ? 'Sound on' : 'Sound off');
}

function playNotification() {
  try {
    const audio = document.getElementById('notification-sound');
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {}
}

// --------------- Auto-Refresh ---------------
function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(fetchResults, 30000);
}

// --------------- Reddit Login & Reply ---------------
async function checkRedditLogin() {
  try {
    const res = await fetch(`${API}/api/reddit-user`);
    const data = await res.json();
    redditConnected = data.loggedIn;
    redditUser = data.username;
    updateRedditUI();
  } catch {}
}

function updateRedditUI() {
  const btn = document.getElementById('btn-reddit-login');
  if (redditConnected && redditUser) {
    btn.textContent = `u/${redditUser}`;
    btn.classList.add('connected');
    btn.onclick = logoutReddit;
  } else {
    btn.textContent = 'Connect Reddit';
    btn.classList.remove('connected');
    btn.onclick = loginReddit;
  }
}

function loginReddit() {
  const w = 600, h = 700;
  const left = (screen.width - w) / 2;
  const top = (screen.height - h) / 2;
  window.open('/auth/reddit', 'RedditLogin', `width=${w},height=${h},left=${left},top=${top}`);
}

async function logoutReddit() {
  if (!confirm('Disconnect Reddit account?')) return;
  await fetch(`${API}/api/reddit-logout`, { method: 'POST' });
  redditConnected = false;
  redditUser = null;
  updateRedditUI();
  fetchResults();
  showToast('Reddit disconnected');
}

function toggleReplyBox(thingId) {
  const box = document.getElementById(`reply-${thingId}`);
  if (box) box.classList.toggle('hidden');
}

function updateCharCount(thingId) {
  const text = document.getElementById(`reply-text-${thingId}`);
  const count = document.getElementById(`char-count-${thingId}`);
  if (text && count) count.textContent = `${text.value.length} chars`;
}

async function submitReply(thingId, btn) {
  const textarea = document.getElementById(`reply-text-${thingId}`);
  const statusEl = document.getElementById(`reply-status-${thingId}`);
  const text = textarea?.value?.trim();

  if (!text) { showToast('Write a reply first', true); return; }

  btn.disabled = true;
  btn.textContent = 'Posting...';
  statusEl.textContent = '';

  try {
    const res = await fetch(`${API}/api/reply`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ thingId, text }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      statusEl.textContent = 'Reply posted!';
      statusEl.className = 'reply-status success';
      textarea.value = '';
      updateCharCount(thingId);
      showToast('Reply posted successfully');
      setTimeout(() => toggleReplyBox(thingId), 2000);
    } else {
      statusEl.textContent = data.error || 'Failed to post';
      statusEl.className = 'reply-status error';
      showToast(data.error || 'Reply failed', true);
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
    statusEl.className = 'reply-status error';
  }

  btn.disabled = false;
  btn.textContent = 'Post Reply';
}

// --------------- Helpers ---------------
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--red)' : 'var(--fhm-blue)';
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2500);
}
