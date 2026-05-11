# Getting Started

## Requirements

- Node.js 18+

## Install and run

```bash
npm install
npm start
```

For auto-reload during development:

```bash
npm run dev
```

Open: `http://localhost:3000`

To use a different port:

```bash
PORT=8080 npm start
```

## First chat checklist

1. Open the Settings panel (`☰`).
2. Select a provider:
   - `NanoGPT`
   - `Z.ai — Standard API`
   - `Z.ai — Coding Plan`
3. Paste your API key.
4. Enter a model name.
5. (Optional) tune streaming, temperature, and max tokens.
6. Send a message.

## Local data behavior

- Settings and chat history are persisted in browser `localStorage`.
- Session logs are persisted as JSON files under `logs/` on the local server.
