# Amazon Marketplace with Aria AI: Shopping & Customer Support Copilot

An Amazon-style online store powered by **Aria**, an intelligent AI Copilot built with **CrewAI**, **FastAPI**, and **Groq**. Aria acts as both your personal shopping assistant and 24/7 customer support lead: check inventory, place orders, track shipments, update delivery addresses, cancel orders, and resolve issues with support tickets.

---

## 🌟 What We Have Built

| Customer Action | What Aria Does | Tool / Logic |
|---|---|---|
| *"Do you have Smart Fitness Watch in stock?"* | Checks live inventory and reports stock count, price, and specs | `check_inventory` |
| *"Order 2 water bottles to 12 Lake Road, Chennai"* | Places order, assigns Order ID (e.g. `ORD1009`), updates inventory | `place_order` |
| *"Where is my order ORD1001?"* | Shows status (`Shipped`), tracking ID, and delivery estimate | `lookup_order` |
| *"Change my delivery address for ORD1003"* | Updates address if still in `Processing` status | `update_delivery_address` |
| *"Cancel my order ORD1003"* | Cancels order if still in `Processing` status and triggers refund | `cancel_order` |
| *"What is your refund policy?"* | Answers policy questions with eligibility and conditions | `search_policy` |
| *"My item arrived damaged"* | Opens a support ticket and returns a `TKT-XXXX` reference | `create_support_ticket` |

---

## 🛠️ Key Architectural Highlights

1. **Amazon-Inspired Storefront**:
   - Header with location picker (*"Deliver to: Chennai 600001"*), search bar with category filtering, Cart counter, Returns & Orders modal, and **Ask Aria AI** copilot.
   - Live product grid with star ratings, prices, Prime delivery promises, in-stock badges, and quick action buttons.

2. **No Heavy Database Required & Per-User Chat Deletion**:
   - Clean, lightweight JSON storage (`data/knowledge_base.json`) with atomic file locking (`_DB_LOCK`) for products, orders, tickets, and policies.
   - User chat history is saved in browser `localStorage`.
   - Each conversation has an individual **Delete Chat** button (`🗑️`), and a **Clear All** button is provided to erase all history with one click.

3. **Safe DOM-Based Markdown Rendering (`frontend/markdown.js`)**:
   - Renders **bold**, *italic*, code, bullet lists, numbered lists, headings, and tables.
   - Uses pure DOM nodes (`createElement` and `textContent`), **never `innerHTML`**, preventing XSS and injection vulnerabilities.

4. **100% Render-Resilient (Zero 503 Outages)**:
   - Dynamic port binding via `${PORT:-8000}`.
   - Host binding to `0.0.0.0` with universal CORS.
   - Resilient intent handler: If the LLM key is missing, expired, or forbidden (HTTP 403), Aria continues operating seamlessly without crashing.

---

## 🚀 Running Locally

### 1. Activate Virtual Environment
```powershell
cd C:\Users\ADMIN\OneDrive\Documents\CrewAI_Agents\ai_customer_support_agent
..\.venv312\Scripts\activate
```

### 2. Configure Environment (`.env`)
```ini
GROQ_API_KEY=your_groq_api_key_here
MODEL_NAME=groq/llama-3.3-70b-versatile
APP_HOST=0.0.0.0
APP_PORT=8000
DEBUG=false
```

### 3. Start the Server
```powershell
python -m uvicorn app:app --reload --host 0.0.0.0 --port 8000
```
Open **`http://127.0.0.1:8000`** in your browser.

---

## ☁️ Deploying to Render (Free Tier)

### Why 503 Errors Happened on Render Previously
1. **Missing `GROQ_API_KEY`**: Render does not read `.env` unless configured in **Environment Variables** in the Render Dashboard.
2. **Port Mismatch**: Render injects a `$PORT` environment variable (e.g. `10000`). If uvicorn hardcodes `8000` or binds to `127.0.0.1`, Render's router cannot reach the server and returns `503 Service Unavailable`.
3. **Free Tier Cold Starts**: Render spins down free tier instances when idle. When spinning up, if the model initialization takes over 60 seconds, requests could time out.

### How It Is Resolved
1. **`Dockerfile` updated**:
   ```dockerfile
   CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
   ```
2. **Resilient Fallback**: Even without an API key or during network spin-up, Aria serves requests immediately.
3. **In the Render Dashboard**:
   - Go to your Web Service -> **Environment**.
   - Add:
     - `GROQ_API_KEY`: your free key from [console.groq.com](https://console.groq.com)
     - `MODEL_NAME`: `groq/llama-3.3-70b-versatile` or `groq/llama-3.1-8b-instant`
     - `PYTHONUNBUFFERED`: `1`
