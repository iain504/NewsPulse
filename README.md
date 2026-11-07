# NewsPulse — News Sentiment Study Lab & AI Trading Simulator

An AI-powered learning workspace that combines **news sentiment analysis** with a **paper-trading simulator** driven by LLM trade signals computed from live Binance market data.

Two AI models (`edge0-35b` for deep reasoning, `edge0-8b` for speed) are served through an OpenAI-compatible endpoint. Every response streams over SSE in two phases: a structured JSON payload first, then a human-readable analyst explanation — so the UI updates instantly while the rationale is still being written.

> ⚠️ **Educational project.** All trading is simulated ("paper") with a virtual **10,000 USDT** account. Nothing here is financial advice.

---

## ✨ Features

### 📰 Sentiment Lab
| Tab | What it does |
|---|---|
| **Live** | Server-side news discovery (web search + page reader) that follows your saved topics; articles are queued for one-click analysis |
| **Analyze** | Paste any article → streamed sentiment, score (−1…1), confidence, emotions, keywords, entities, summary and step-by-step reasoning |
| **Dashboard** | Aggregate stats: sentiment distribution, 14-day trend, model comparison, latency |
| **Study** | "Guess the sentiment" quiz game — you predict, the AI explains, scores are persisted |
| **History** | Every analysis stored in SQLite with full detail view, filters and deletion |

### 📈 Trading Simulator (Signals tab)
- **Candlestick chart** fed by the free Binance public API with **BUY / SELL signal markers** drawn on the bars
- **LLM trade signals** — the last N candles plus deterministic indicators (EMA, RSI-14, MACD 12/26/9) are passed to the model, which returns `direction, entry zone, stop-loss, take-profit, confidence, R:R, time horizon`
- **Paper trade engine** — trades fill at the live Binance spot price; stop-loss / take-profit levels are evaluated on every read and P&L is crystallised into the database
- **Manual or automated symbol scanning** — pick a symbol yourself or mark watchlist symbols for the auto-scan loop
- **One trade at a time** — the engine refuses to stack positions; a new signal closes nothing, it is simply skipped while a trade is open
- **Auto-trade gate** — automatic entries only fire when `confidence ≥ minConfidence` **and** `R:R ≥ minRR` (both configurable sliders, defaults **70%** and **1.8**); skipped signals are logged with the reason

### 🎯 Confidence-driven position sizing
Position size is a function of the model's confidence, so the account risks *more* when the AI is sure and *less* when it isn't:

```
mult       = 0.5 + (2.0 − 0.5) × (confidence − minConfidence) / (100 − minConfidence)
riskPct    = 1.0% × mult                       ← % of equity lost if the SL is hit
riskAmount = equity × riskPct
notional   = riskAmount / stopPct              ← position that risks exactly that
quantity   = notional / fillPrice
```

- Notional is **capped at 5× equity** (a tight stop can't produce an absurd position) with a **$10 floor**
- The full sizing snapshot (`confidence`, `multiplier`, `riskPct`, `riskAmount`) is stored with every trade

### 🧾 Auditable trade history
Every trade — open or closed — keeps and displays:
- the **analyst rationale** (streamed trading-plan prose)
- the **full signal detail**: entry zone, stop-loss, take-profit, R:R, interval, time horizon, reasons & risks
- the **confidence level** and **risk snapshot** (risk %, risk amount)
- source (**MANUAL / AUTO**) and exit reason (**TP / SL / MANUAL**), realised P&L in USDT and %

---

## 🛠 Tech stack

- **Next.js 16** (App Router) + **TypeScript 5**
- **Tailwind CSS 4** + **shadcn/ui** (New York) + Lucide icons + Framer Motion
- **Prisma 6** + **SQLite** — zero-config persistence
- **TanStack Query** for server state, **Zustand** for client state
- LLM access via a generic **OpenAI-compatible client** (`src/lib/edgezero.ts`) with SSE streaming
- Market data from the **free Binance public REST API** (no API key required)

## 🚀 Getting started

```bash
# 1. install dependencies
bun install        # or: npm install / pnpm install

# 2. configure environment
cp .env.example .env

# 3. create the database
bun run db:push

# 4. start the dev server
bun run dev        # → http://localhost:3000
```

## ⚙️ Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | SQLite file, e.g. `file:./db/custom.db` |
| `EDGEZERO_API_BASE` | — | `https://edgezero.space-z.ai/api/v1` | Any OpenAI-compatible base URL |
| `EDGEZERO_API_KEY` | — | `local` | Bearer token for the endpoint |

Models are expected to be named `edge0-35b` (deep reasoning) and `edge0-8b` (fast) — see `GET /api/models` to list what your endpoint exposes.

## 🔌 API reference

| Route | Method | Description |
|---|---|---|
| `/api/analyze` | POST | Two-phase SSE sentiment analysis (JSON → streamed rationale) |
| `/api/models` | GET | List models exposed by the LLM endpoint |
| `/api/analyses` | GET / DELETE | List / delete stored analyses |
| `/api/stats` | GET | Dashboard aggregates (trend, distribution, model comparison) |
| `/api/news/search` | POST | Discover recent news for a topic |
| `/api/news/fetch` | POST | Extract full article text from a URL |
| `/api/topics` | GET / POST / DELETE | Followed news topics |
| `/api/quiz/next` · `/answer` · `/stats` | POST / GET | Study game endpoints |
| `/api/market/klines` | GET | Binance OHLCV candles (proxied) |
| `/api/market/quote` | GET | Live spot price for a symbol |
| `/api/signals` | GET | Stored trade signals |
| `/api/signals/analyze` | POST | Two-phase SSE trade-signal generation for a symbol/interval |
| `/api/trades` | GET / POST | Open trades (with live SL/TP evaluation) / open a new paper trade |
| `/api/trades/close` | POST | Close a trade manually at market |
| `/api/trades/sizing` | GET | Confidence-scaled position sizing preview for a signal |
| `/api/watchlist` | GET / POST / DELETE | Watchlist symbols + auto-scan flags |

## 🗄 Database schema (Prisma)

| Model | Purpose |
|---|---|
| `Analysis` | Stored sentiment result (score, emotions, keywords, entities, reasoning…) |
| `QuizRound` | One round of the study game |
| `FollowedTopic` | Topics the live news feed follows |
| `Signal` | LLM trade signal — direction, entry zone, SL, TP, R:R, confidence, indicators snapshot, rationale |
| `Trade` | Paper trade — linked signal, sizing snapshot (`confidence`, `riskPct`, `riskAmount`), status, exit reason, realised P&L |
| `WatchItem` | Watchlist symbols flagged for auto-scan |

## 📁 Project structure

```
src/
├── app/
│   ├── page.tsx              # single-page workspace (6 tabs)
│   └── api/                  # route handlers (see API reference)
├── components/
│   ├── news-sentiment/       # Live / Analyze / Dashboard / Study / History panels
│   ├── trading/              # candle chart, signals panel, trades panel
│   └── ui/                   # shadcn/ui primitives
├── lib/
│   ├── edgezero.ts           # OpenAI-compatible client (SSE)
│   ├── binance.ts            # klines + 24h tickers helpers
│   ├── indicators.ts         # EMA / RSI / MACD (deterministic, server-side)
│   ├── signal.ts             # trading prompt + signal schema parsing
│   ├── sizing.ts             # confidence-driven risk position sizing
│   ├── trades.ts             # paper-trade engine (SL/TP evaluation, P&L)
│   ├── news.ts               # news search + article extraction
│   └── sentiment.ts          # sentiment prompt + JSON normalisation
└── prisma/schema.prisma      # Analysis · QuizRound · FollowedTopic · Signal · Trade · WatchItem
```

## 🧪 Scripts

| Command | Action |
|---|---|
| `bun run dev` | Dev server on port 3000 |
| `bun run build` / `start` | Production build / serve |
| `bun run lint` | ESLint |
| `bun run db:push` | Push Prisma schema to SQLite |
| `bun run db:generate` | Regenerate Prisma client |

## ⚠️ Disclaimer

NewsPulse is a **learning sandbox**. Signals are generated by a language model reading a handful of candles and indicators — they are **not** investment research. All trades are simulated against a virtual balance; no real funds, orders or exchange accounts are ever touched. Trade at your own risk elsewhere.
