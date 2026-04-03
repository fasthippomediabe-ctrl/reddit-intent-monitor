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
      body: JSON.stringify({ username, password, app: 'reddit' }),
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

  // Show admin button for admins
  if (user.role === 'admin') {
    document.getElementById('btn-admin').classList.remove('hidden');
  } else {
    document.getElementById('btn-admin').classList.add('hidden');
  }

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
  fetchStats();
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
  document.getElementById('filter-pinned').addEventListener('change', fetchResults);
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

    // Sort: pinned first, then newest
    let sorted = (data.results || []).sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.date) - new Date(a.date);
    });

    // Filter pinned only
    const pinnedOnly = document.getElementById('filter-pinned')?.checked;
    if (pinnedOnly) sorted = sorted.filter(r => r.pinned);

    renderResults(sorted);
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
async function updateStatus(url, status) {
  try {
    await fetch(`${API}/api/update-status`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ url, status }),
    });
  } catch (err) {
    console.error('Status update error:', err);
  }
}

function markQualified(thingId, url) {
  // Open reply box — when they post, it auto-marks as "Replied" in sheets
  handleReply(thingId, url);

  // Highlight the card as qualified
  const card = document.getElementById(`card-${CSS.escape(url)}`);
  if (card) {
    card.querySelector('.qualified-btn')?.classList.add('active-qualified');
    card.querySelector('.unqualified-btn')?.classList.remove('active-unqualified');
  }
}

function markUnqualified(url) {
  if (!confirm('Mark as unqualified and hide this lead?')) return;

  updateStatus(url, 'Unqualified');

  // Animate out and hide the card
  const card = document.getElementById(`card-${CSS.escape(url)}`);
  if (card) {
    card.style.transition = 'all 0.3s ease';
    card.style.opacity = '0';
    card.style.transform = 'translateX(50px)';
    card.style.maxHeight = card.scrollHeight + 'px';
    setTimeout(() => {
      card.style.maxHeight = '0';
      card.style.padding = '0';
      card.style.margin = '0';
      card.style.overflow = 'hidden';
    }, 200);
    setTimeout(() => card.remove(), 500);
  }
  showToast('Marked as Unqualified — hidden');
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

  feed.innerHTML = items.map(item => {
    const safeUrl = escapeHtml(item.url);
    const safeThingId = escapeHtml(item.thingId || '');
    const ageClass = getAgeClass(item.date);
    const encodedUrl = encodeURIComponent(item.url);
    return `
    <div class="result-card ${item.buyingSignal ? 'buying-signal' : ''} ${item.leadStatus?.status === 'Replied' ? 'card-replied' : ''} ${item.leadStatus?.status === 'Qualified' ? 'card-qualified' : ''} ${item.pinned ? 'card-pinned' : ''}" id="card-${safeUrl}">
      <div class="card-header">
        <button class="pin-btn ${item.pinned ? 'pinned' : ''}" onclick="togglePin('${safeUrl}')" title="${item.pinned ? 'Unpin' : 'Pin this lead'}">${item.pinned ? '&#9733;' : '&#9734;'}</button>
        <span class="age-dot ${ageClass}" title="${escapeHtml(item.timeAgo)}"></span>
        <span class="sub-badge">r/${escapeHtml(item.subreddit)}</span>
        ${item.buyingSignal ? '<span class="signal-badge">Buying Signal</span>' : ''}
        ${item.type === 'comment' ? '<span class="comment-badge">Comment</span>' : ''}
        <span class="card-meta">u/${escapeHtml(item.author)} &bull; ${escapeHtml(item.timeAgo)}${item.score ? ` &bull; ${item.score} pts` : ''}</span>
      </div>
      <div class="card-title">
        <a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
      </div>
      ${item.snippet ? `<div class="card-snippet">${escapeHtml(item.snippet.slice(0, 200))}${item.snippet.length > 200 ? '...' : ''}</div>` : ''}
      <div class="card-footer">
        ${(item.matchedKeywords || []).map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('')}
        ${item.leadStatus?.status === 'Replied'
          ? `<span class="status-btn active-qualified">Replied by ${escapeHtml(item.leadStatus.updatedBy)}</span>`
          : item.leadStatus?.status === 'Qualified'
            ? `<span class="status-btn active-qualified">Qualified by ${escapeHtml(item.leadStatus.updatedBy)}</span>`
            : `<button class="status-btn qualified-btn" onclick="markQualified('${safeThingId}', '${safeUrl}')">Qualified Lead</button>`
        }
        ${!item.leadStatus ? `<button class="status-btn unqualified-btn" onclick="markUnqualified('${safeUrl}')">Unqualified</button>` : ''}
        <button class="notes-toggle" onclick="toggleNotes('${encodedUrl}')">${item.notesCount ? `Notes (${item.notesCount})` : 'Add Note'}</button>
        <div class="card-actions">
          <button class="btn btn-small btn-secondary" onclick="copyResult(this, ${escapeAttr(JSON.stringify(item))})">Copy</button>
          ${item.leadStatus?.status !== 'Replied' ? `<button class="btn btn-small btn-secondary reply-btn" onclick="handleReply('${safeThingId}', '${safeUrl}')">Reply</button>` : ''}
          <a href="${safeUrl}" target="_blank" rel="noopener" class="btn btn-small btn-brand">Open</a>
        </div>
      </div>
      <div id="notes-${encodedUrl}" class="notes-section hidden">
        <div id="notes-list-${encodedUrl}"></div>
        <div class="note-input-row">
          <input type="text" class="input-field" id="note-input-${encodedUrl}" placeholder="Add a note..." onkeydown="if(event.key==='Enter')addNote('${encodedUrl}')">
          <button class="btn btn-small btn-brand" onclick="addNote('${encodedUrl}')">Add</button>
        </div>
      </div>
      <div id="reply-${safeThingId}" class="reply-box hidden" data-url="${safeUrl}">
        <select class="template-select" onchange="applyTemplate(this, '${safeThingId}')">
          <option value="">Use a reply template...</option>
        </select>
        <textarea id="reply-text-${safeThingId}" placeholder="Write your reply... Be genuine and helpful." oninput="updateCharCount('${safeThingId}')"></textarea>
        <div class="reply-actions">
          <button class="btn btn-small btn-brand" onclick="submitReply('${safeThingId}', this)">Post Reply</button>
          <button class="btn btn-small btn-secondary" onclick="toggleReplyBox('${safeThingId}')">Cancel</button>
          <span class="char-count" id="char-count-${safeThingId}">0 chars</span>
        </div>
        <div id="reply-status-${safeThingId}" class="reply-status"></div>
      </div>
    </div>`;
  }).join('');

  // Load templates into all dropdowns
  loadTemplates();
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

It monitors subreddits for keywords you set, flags
high-intent "Buying Signal" posts, and lets you reply
directly from the dashboard.

STEP 1: Login
-------------
Use your team credentials to log in.
- boss / leadfinder123
- bryan / bryan2024
(Ask admin for additional accounts)

STEP 2: Configure Settings
--------------------------
- Click "Settings" (top right)
- Enter subreddits: smallbusiness, entrepreneur, SEO,
  marketing, web_design, HVAC, plumbing, RealEstate, etc.
- Enter keywords: agency, marketing, SEO help, need
  website, Google Ads, PPC, branding, need leads, etc.
- Use broad, short keywords for more results
- Set poll interval (default: 5 minutes)
- Click "Save & Start Monitoring"

STEP 3: Lead Qualification Workflow
------------------------------------
For each post in the feed:

1. Click "Open" to read the full Reddit post
2. Decide: is this a real potential lead?

   IF YES -> Click "Qualified Lead"
          -> Reply box opens
          -> Write and post your reply
          -> Status auto-updates to "Replied" in
             Google Sheets

   IF NO  -> Click "Unqualified"
          -> Card disappears from everyone's feed
          -> Saved as "Unqualified" in Google Sheets

MULTI-USER STATUS SYNC
-----------------------
- Multiple team members can use the app simultaneously
- When you mark a lead, all users see the update
  within 30 seconds
- Status shows WHO took action (e.g. "Replied by Bryan")
- Unqualified leads are hidden from everyone's feed
- All statuses saved to Google Sheets

FILTERING (PER-USER)
---------------------
Keywords are shared across the team. To focus on your
area, use the filter bar at the top:

- "Filter by subreddit" - see only specific subreddits
- "Filter by keyword" - narrow by topic
- "Buying signals only" checkbox - high-intent only
- Filters are per-browser, don't affect other users

HOW TO REPLY EFFECTIVELY
--------------------------
1. Read the full post carefully
2. Write a genuine, helpful comment
3. Be specific to their situation
4. Offer to help via DM - don't hard-sell
5. Reply during US business hours (8am-8pm EST)

REPLY TEMPLATES
----------------

For someone needing a website:
"I build websites for [industry] businesses. A few
quick tips: clear CTA above the fold, mobile-first
design, fast load times. For [industry] specifically,
[tip]. Happy to take a look - just DM me."

For someone needing marketing help:
"I run a marketing agency and work with [industry]
businesses. The biggest quick wins: [1-2 tips]. We've
helped similar businesses [result]. Happy to give you
a free audit - just DM me."

For someone asking about SEO/PPC:
"Common challenge. For your situation, I'd recommend
[advice]. Key metrics to watch: [metrics]. We manage
this for several [industry] clients - DM me if you
want to compare notes."

FEATURES
--------
- Buying signal detection (25+ intent phrases)
- Qualified / Unqualified lead workflow
- Real-time status sync across team members
- Google Sheets integration (auto-saves all results)
- Reddit account integration for direct replies
- Email digest generator (HTML and plain text)
- Copy to clipboard (single or all results)
- Sound notifications for new results
- Auto-refresh every 30 seconds
- Per-user filtering

TIPS FOR BEST RESULTS
----------------------
- Use broad, short keywords (not long phrases)
- Add industry subreddits (HVAC, plumbing, dentistry)
- Focus on "Buying Signal" posts first
- Don't reply to posts older than 3-4 days
- Follow Reddit's 90/10 rule (90% helpful, 10% promo)
- Keep the tab open for sound notifications
- Check Google Sheets for full lead history

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
  autoRefreshInterval = setInterval(() => { fetchResults(); fetchStats(); }, 30000);
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

function handleReply(thingId, url) {
  if (!redditConnected) {
    showConnectPrompt();
    return;
  }
  if (!thingId) {
    showToast('Cannot reply — post ID not available. Try opening the post directly.', true);
    return;
  }
  toggleReplyBox(thingId);
  // Mark as Qualified in sheets immediately
  if (url) updateStatus(url, 'Qualified');
}

function showConnectPrompt() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.onclick = () => overlay.remove();

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.width = '420px';
  modal.innerHTML = `
    <div class="modal-header">
      <h2>Connect Reddit Account</h2>
      <button class="btn-close" onclick="this.closest('.overlay').remove()">&times;</button>
    </div>
    <div class="modal-body" style="text-align:center; padding:30px;">
      <span style="font-size:48px;">&#129435;</span>
      <p style="margin:16px 0; color:var(--text-muted); font-size:14px;">
        To reply directly from the dashboard, you need to connect your Reddit account first.
      </p>
      <p style="margin-bottom:20px; color:var(--text-muted); font-size:12px;">
        This requires Reddit API credentials configured in the app settings.<br>
        Ask your admin to set up REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.
      </p>
      <div style="display:flex; gap:10px; justify-content:center;">
        <button class="btn btn-reddit" onclick="loginReddit(); this.closest('.overlay').remove();">Connect Reddit</button>
        <button class="btn btn-secondary" onclick="this.closest('.overlay').remove()">Cancel</button>
      </div>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
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
      showToast('Reply posted — marked as Replied in Sheets');

      // Auto-update status to "Replied" in Google Sheets
      const replyBox = document.getElementById(`reply-${thingId}`);
      const postUrl = replyBox?.dataset?.url;
      if (postUrl) {
        updateStatus(postUrl, 'Replied');
        // Update card visual
        const card = document.getElementById(`card-${CSS.escape(postUrl)}`);
        if (card) {
          card.classList.add('card-replied');
          const qBtn = card.querySelector('.qualified-btn');
          if (qBtn) { qBtn.classList.add('active-qualified'); qBtn.textContent = 'Replied'; }
        }
      }

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

// --------------- Admin Panel ---------------
function openAdmin() {
  document.getElementById('admin-overlay').classList.remove('hidden');
  document.getElementById('admin-modal').classList.remove('hidden');
  loadUsers();
}

function closeAdmin() {
  document.getElementById('admin-overlay').classList.add('hidden');
  document.getElementById('admin-modal').classList.add('hidden');
}

async function loadUsers() {
  const list = document.getElementById('admin-user-list');
  list.innerHTML = '<p style="color:var(--text-muted); font-size:13px;">Loading...</p>';

  try {
    const res = await fetch(`${API}/api/users`, { headers: getHeaders() });
    const data = await res.json();

    if (!data.users || data.users.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);">No users found.</p>';
      return;
    }

    list.innerHTML = data.users.map(u => `
      <div class="user-row">
        <div class="user-info">
          <div class="user-name">${escapeHtml(u.name)}</div>
          <div class="user-detail">@${escapeHtml(u.username)}</div>
        </div>
        <span class="role-badge ${u.role}">${escapeHtml(u.role)}</span>
        <button class="btn btn-small btn-secondary" onclick="editUser('${escapeHtml(u.username)}')">Edit</button>
        <button class="btn btn-small btn-danger" onclick="deleteUser('${escapeHtml(u.username)}')">Remove</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = '<p style="color:var(--red);">Error loading users</p>';
  }
}

async function addUser() {
  const name = document.getElementById('new-user-name').value.trim();
  const username = document.getElementById('new-user-username').value.trim();
  const password = document.getElementById('new-user-password').value;
  const role = document.getElementById('new-user-role').value;

  if (!username || !password) {
    showToast('Username and password required', true);
    return;
  }

  try {
    const res = await fetch(`${API}/api/users`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username, password, role, name: name || username }),
    });
    const data = await res.json();

    if (res.ok) {
      showToast(data.message || 'User created');
      document.getElementById('new-user-name').value = '';
      document.getElementById('new-user-username').value = '';
      document.getElementById('new-user-password').value = '';
      loadUsers();
    } else {
      showToast(data.error || 'Failed to create user', true);
    }
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
}

async function editUser(username) {
  const newPassword = prompt(`Enter new password for "${username}" (leave blank to keep current):`);
  if (newPassword === null) return; // cancelled

  const newRole = prompt(`Role for "${username}"? Type "admin" or "user":`, 'user');
  if (newRole === null) return;

  const newName = prompt(`Display name for "${username}":`, username);
  if (newName === null) return;

  const body = {};
  if (newPassword) body.password = newPassword;
  if (newRole) body.role = newRole;
  if (newName) body.name = newName;

  try {
    const res = await fetch(`${API}/api/users/${username}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (res.ok) {
      showToast(data.message || 'User updated');
      loadUsers();
    } else {
      showToast(data.error || 'Failed to update', true);
    }
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
}

async function deleteUser(username) {
  if (!confirm(`Remove team member "${username}"? They will lose access immediately.`)) return;

  try {
    const res = await fetch(`${API}/api/users/${username}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
    const data = await res.json();

    if (res.ok) {
      showToast(data.message || 'User removed');
      loadUsers();
    } else {
      showToast(data.error || 'Failed to remove', true);
    }
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
}

// --------------- Stats & Analytics ---------------
async function fetchStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const s = await res.json();

    document.getElementById('stat-today').textContent = s.today?.leads || 0;
    document.getElementById('stat-signals').textContent = s.today?.buyingSignals || 0;
    document.getElementById('stat-replied').textContent = s.statuses?.replied || 0;
    document.getElementById('stat-qualified').textContent = s.statuses?.qualified || 0;
    document.getElementById('stat-week').textContent = s.week?.leads || 0;
    document.getElementById('stat-pinned').textContent = s.pinnedCount || 0;

    // Store for analytics tab
    window._statsData = s;
  } catch {}
}

// --------------- Tab Switching ---------------
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => { if (b.textContent.toLowerCase().includes(tab)) b.classList.add('active'); });

  document.getElementById('tab-feed').classList.toggle('hidden', tab !== 'feed');
  document.getElementById('tab-analytics').classList.toggle('hidden', tab !== 'analytics');
  document.getElementById('tab-activity').classList.toggle('hidden', tab !== 'activity');

  if (tab === 'analytics') renderAnalytics();
  if (tab === 'activity') loadActivity();
}

function renderAnalytics() {
  const s = window._statsData;
  if (!s) { fetchStats().then(renderAnalytics); return; }

  // Daily chart
  const daily = document.getElementById('chart-daily');
  const maxLeads = Math.max(...(s.dailyCounts || []).map(d => d.leads), 1);
  daily.innerHTML = (s.dailyCounts || []).map(d => `
    <div class="bar-group">
      <div class="bar-value">${d.leads}</div>
      <div class="bar bar-leads" style="height:${(d.leads / maxLeads) * 100}px"></div>
      <div class="bar bar-signals" style="height:${(d.signals / maxLeads) * 100}px"></div>
      <div class="bar-label">${d.date}</div>
    </div>
  `).join('');

  // Subreddits
  const subs = document.getElementById('chart-subreddits');
  const maxSub = Math.max(...(s.topSubreddits || []).map(s => s.count), 1);
  subs.innerHTML = (s.topSubreddits || []).slice(0, 8).map(sub => `
    <div class="sub-row">
      <span class="sub-name">r/${escapeHtml(sub.name)}</span>
      <div class="sub-bar-bg"><div class="sub-bar-fill" style="width:${(sub.count / maxSub) * 100}%"></div></div>
      <span class="sub-count">${sub.count}</span>
    </div>
  `).join('') || '<p style="color:var(--text-muted)">No data yet</p>';

  // Funnel
  const funnel = document.getElementById('chart-funnel');
  const total = s.total || 1;
  const funnelData = [
    { label: 'Total Leads', count: s.total, color: 'var(--fhm-blue)' },
    { label: 'Buying Signal', count: Math.round(total * (s.signalPct || 0) / 100), color: 'var(--accent)' },
    { label: 'Qualified', count: s.statuses?.qualified || 0, color: 'var(--blue)' },
    { label: 'Replied', count: s.statuses?.replied || 0, color: 'var(--green)' },
  ];
  funnel.innerHTML = funnelData.map(f => `
    <div class="funnel-row">
      <span class="funnel-label">${f.label}</span>
      <div class="funnel-bar-bg">
        <div class="funnel-bar-fill" style="width:${Math.max((f.count / total) * 100, 2)}%; background:${f.color};">${f.count}</div>
      </div>
    </div>
  `).join('');

  // Signal rate
  document.getElementById('chart-signal-rate').innerHTML = `
    <div style="font-size:48px; font-weight:700; color:var(--accent);">${s.signalPct || 0}%</div>
    <div style="font-size:13px; color:var(--text-muted); margin-top:4px;">of all leads are buying signals</div>
    <div style="margin-top:12px; font-size:12px; color:var(--text-muted);">Total: ${s.total} leads</div>
  `;
}

// --------------- Activity Log ---------------
async function loadActivity() {
  const container = document.getElementById('activity-list');
  container.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:20px;">Loading...</p>';

  try {
    const res = await fetch(`${API}/api/activity`);
    const data = await res.json();

    if (!data.activities?.length) {
      container.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:40px;">No activity yet. Start qualifying leads to see activity here.</p>';
      return;
    }

    container.innerHTML = data.activities.map(a => {
      const time = new Date(a.timestamp);
      const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `
        <div class="activity-item">
          <span class="activity-time">${dateStr}<br>${timeStr}</span>
          <div>
            <span class="activity-user">${escapeHtml(a.user)}</span>
            <span class="activity-action"> ${escapeHtml(a.action)}</span>
            ${a.detail ? `<div class="activity-detail">${escapeHtml(a.detail)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch {
    container.innerHTML = '<p style="color:var(--red);">Error loading activity</p>';
  }
}

// --------------- Lead Age Indicator ---------------
function getAgeClass(dateStr) {
  const hours = (Date.now() - new Date(dateStr).getTime()) / 3600000;
  if (hours < 2) return 'age-fresh';
  if (hours < 24) return 'age-recent';
  return 'age-old';
}

// --------------- Pin ---------------
async function togglePin(url) {
  try {
    const res = await fetch(`${API}/api/pin`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    showToast(data.pinned ? 'Pinned' : 'Unpinned');
    fetchResults();
    fetchStats();
  } catch {
    showToast('Error pinning', true);
  }
}

// --------------- Notes ---------------
function toggleNotes(encodedUrl) {
  const section = document.getElementById(`notes-${encodedUrl}`);
  if (!section) return;
  const isHidden = section.classList.contains('hidden');
  section.classList.toggle('hidden');
  if (isHidden) loadNotes(encodedUrl);
}

async function loadNotes(encodedUrl) {
  const container = document.getElementById(`notes-list-${encodedUrl}`);
  if (!container) return;

  try {
    const res = await fetch(`${API}/api/notes/${encodedUrl}`);
    const data = await res.json();
    const notes = data.notes || [];

    container.innerHTML = notes.length
      ? notes.map(n => {
          const time = new Date(n.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return `<div class="note-item"><span class="note-author">${escapeHtml(n.author)}</span> <span style="color:var(--text-muted); font-size:10px;">${time}</span><br>${escapeHtml(n.text)}</div>`;
        }).join('')
      : '<div style="font-size:12px; color:var(--text-muted); padding:4px 0;">No notes yet</div>';
  } catch {
    container.innerHTML = '<div style="color:var(--red); font-size:12px;">Error loading notes</div>';
  }
}

async function addNote(encodedUrl) {
  const input = document.getElementById(`note-input-${encodedUrl}`);
  const text = input?.value?.trim();
  if (!text) return;

  try {
    await fetch(`${API}/api/notes`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ url: decodeURIComponent(encodedUrl), text }),
    });
    input.value = '';
    loadNotes(encodedUrl);
    showToast('Note added');
  } catch {
    showToast('Error adding note', true);
  }
}

// --------------- Reply Templates ---------------
let cachedTemplates = null;

async function loadTemplates() {
  if (!cachedTemplates) {
    try {
      const res = await fetch(`${API}/api/templates`);
      const data = await res.json();
      cachedTemplates = data.templates || [];
    } catch { cachedTemplates = []; }
  }

  document.querySelectorAll('.template-select').forEach(sel => {
    if (sel.options.length <= 1) {
      cachedTemplates.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.text;
        opt.textContent = t.name;
        sel.appendChild(opt);
      });
    }
  });
}

function applyTemplate(select, thingId) {
  const textarea = document.getElementById(`reply-text-${thingId}`);
  if (textarea && select.value) {
    textarea.value = select.value;
    updateCharCount(thingId);
  }
  select.selectedIndex = 0;
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
