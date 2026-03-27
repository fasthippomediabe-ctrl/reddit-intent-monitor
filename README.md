# Reddit Intent Monitor

Monitor Reddit in real-time for buying signals and keyword mentions. Find potential customers by tracking subreddits for posts like "looking for", "recommend", "best tool for", etc.

Two modes: **RSS (free, no API key)** and **Reddit API (OAuth, more powerful)**.

![Dashboard](https://img.shields.io/badge/Status-Ready-brightgreen) ![Node](https://img.shields.io/badge/Node.js-18+-339933)

---

## Quick Start (RSS Mode — No API Key)

```bash
# 1. Clone / download this folder
cd reddit-intent-monitor

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open your browser
# http://localhost:3000
```

That's it. RSS mode works immediately — no API keys needed.

---

## Setup: Reddit API Mode (Optional, More Powerful)

Reddit API mode lets you search comments (not just posts) and handles rate limits better.

### Step 1: Create a Reddit App

1. Go to [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Scroll down and click **"create another app..."**
3. Fill in:
   - **Name**: `RedditIntentMonitor` (anything you want)
   - **Type**: Select **script**
   - **Redirect URI**: `http://localhost:3000`
4. Click **Create app**
5. Note your credentials:
   - **Client ID**: the string under your app name
   - **Client Secret**: the "secret" field

### Step 2: Configure .env

```bash
cp .env.example .env
```

Edit `.env`:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=RedditIntentMonitor/1.0 (by /u/your_username)
```

### Step 3: Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000), click **Settings**, switch to **Reddit API** mode, and click **Test Connection**.

---

## How to Use

1. Open [http://localhost:3000](http://localhost:3000)
2. Click **Settings** (top right)
3. Enter subreddits: `entrepreneur, SaaS, smallbusiness, startups`
4. Enter keywords: `looking for, recommend, best tool, need help`
5. Choose mode (RSS or API)
6. Click **Save & Start Monitoring**
7. Results appear in the live feed, newest first

### Features

- **Buying Signal Detection** — Posts containing phrases like "looking for", "recommend", "alternatives to" are flagged with an orange badge
- **Filter Bar** — Filter by subreddit, keyword, or buying signals only
- **Copy to Clipboard** — Copy individual results or the entire feed
- **Email Digest** — Generate a formatted email summary (HTML or plain text)
- **Sound Notifications** — Optional ping when new results arrive
- **Auto-Refresh** — Dashboard updates every 30 seconds

---

## Deploy Free

### Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) and connect your repo
3. Add environment variables (`REDDIT_CLIENT_ID`, etc.) if using API mode
4. Deploy — Railway auto-detects the start script

### Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Add environment variables if using API mode
6. Deploy

---

## Scripts

```bash
npm start    # Start production server
npm run dev  # Start with auto-reload (nodemon)
```

## Tech Stack

- **Backend**: Node.js, Express, node-cron, axios, rss-parser
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Storage**: In-memory (last 200 results, resets on restart)
