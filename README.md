# BlushedCV — Virtual Makeup Filter

A real-time virtual makeup try-on app powered by WebGL + MediaPipe, with AI color analysis via Google Gemini.

---

## Demo

> Video coming soon!

---

## Prerequisites

- **Python 3.10+**
- **Node.js 18+** and **npm**
- A **Gemini API key** — get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/your-username/Blushed.CV.git
cd Blushed.CV
```

### 2. Add your API key

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_key_here
```

---

## Running on Windows (PowerShell)

### Install Python dependencies

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> If you get a script execution error, run this first:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

### Build the frontend

```powershell
cd webgl
npm install
npm run build
cd ..
```

### Start the server

```powershell
uvicorn app:app --reload
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## Running on Mac

### Install Python dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Build the frontend

```bash
cd webgl
npm install
npm run build
cd ..
```

### Start the server

```bash
uvicorn app:app --reload
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## Running the Full App (with Landing Page)

`npm run dev` only starts the Vite dev server — it serves the WebGL app directly and skips the landing page. To see the full experience (landing page → filter app), run FastAPI instead.

### Windows (PowerShell)

```powershell
# 1. Activate your virtual environment
.\venv\Scripts\Activate.ps1

# 2. Build the frontend
cd webgl
npm install
npm run build
cd ..

# 3. Start the server
uvicorn app:app --reload
```

### Mac

```bash
# 1. Activate your virtual environment
source venv/bin/activate

# 2. Build the frontend
cd webgl
npm install
npm run build
cd ..

# 3. Start the server
uvicorn app:app --reload
```

Then open [http://localhost:8000](http://localhost:8000) — the landing page loads first, and the **Try the Filter** button takes you to the app.

> **Tip:** If you see `could not import app`, make sure your virtual environment is activated (`(venv)` should appear in your prompt) and that you've run `pip install -r requirements.txt`.

---

## Routes

| Route | Description |
|---|---|
| `/` | Landing page |
| `/app` | Virtual makeup try-on app |
| `/api/analyze-makeup-colors` | AI color analysis endpoint (POST) |

---

## Tech Stack

- **Backend:** FastAPI + Uvicorn
- **Frontend:** TypeScript + WebGL + Vite
- **Face tracking:** MediaPipe
- **AI analysis:** Google Gemini (`gemini-2.5-flash-lite`)
