# ArmadaOS Claude Proxy v3.0

**Use your Claude Max/Pro subscription ($200/mo) with ArmadaOS — no API key needed.**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible API, allowing ArmadaOS to use your Claude Max subscription instead of paying per-API-call. Same approach used by OpenClaw, Continue.dev, and other tools.

## Quick Start

```powershell
# 1. Install Claude Code CLI (if you haven't already)
npm install -g @anthropic-ai/claude-code

# 2. Log in with your Claude Max/Pro account
claude login

# 3. Run the proxy
npx github:kam-ship-it/armadaos-claude-proxy
```

That's it. No API key. No token extraction. The proxy uses your existing Claude Code login.

## What Happens

1. The proxy verifies Claude Code CLI is installed and authenticated
2. A local HTTP server starts on port 3456
3. A free Cloudflare tunnel is created automatically (no account needed)
4. You get a public URL — paste it into ArmadaOS

```
  ╔══════════════════════════════════════════════════╗
  ║  READY — USING YOUR CLAUDE MAX SUBSCRIPTION      ║
  ╚══════════════════════════════════════════════════╝

    https://random-words-here.trycloudflare.com

  Next step:
    1. Copy the URL above
    2. Go to staging.armadaos.ai → Settings → Compute
    3. Find Claude Max → Paste the URL → Click Connect
```

## How It Works

```
ArmadaOS Engine
     ↓
HTTP Request (OpenAI format)
     ↓
armadaos-claude-proxy (this tool)
     ↓
Claude Code CLI (subprocess with --print flag)
     ↓
Your Max/Pro subscription (OAuth)
     ↓
Response → OpenAI format → ArmadaOS
```

Each request spawns a `claude --print` subprocess that uses your authenticated CLI session. Your OAuth credentials never leave your machine — the CLI handles all authentication through its own secure keychain storage.

## Available Models

| Model | ID |
|-------|-----|
| Claude Sonnet 4.5 (default) | `claude-sonnet-4-5-20250514` |
| Claude Sonnet 4 | `claude-sonnet-4-20250514` |
| Claude Opus 4 | `claude-opus-4-20250514` |
| Claude 3.5 Sonnet | `claude-3-5-sonnet-20241022` |
| Claude 3.5 Haiku | `claude-3-5-haiku-20241022` |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (OpenAI format) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Local server port |
| `NO_TUNNEL` | `0` | Set to `1` to skip auto-tunnel |

## Cost Savings

| Approach | Cost |
|----------|------|
| Anthropic API | ~$15/M input, ~$75/M output tokens |
| Claude Max subscription | $200/month flat |
| **This proxy** | **$0 extra** (uses your Max subscription) |

## Troubleshooting

**"Claude CLI not found"** — Install it: `npm install -g @anthropic-ai/claude-code`

**"Not authenticated"** — Run `claude login` to authenticate with your Claude account.

**"Could not create automatic tunnel"** — Install cloudflared manually, or use ngrok:

```bash
cloudflared tunnel --url http://localhost:3456
# or
ngrok http 3456
```

## Architecture

```
Your Computer                          Cloud
┌─────────────────┐                ┌──────────────┐
│ Claude Proxy    │◄── Tunnel ────►│  ArmadaOS    │
│ (port 3456)     │    (HTTPS)     │  (staging)   │
└────────┬────────┘                └──────────────┘
         │
         │ claude --print (subprocess)
         ▼
┌─────────────────┐
│ Claude Code CLI │
│ (your Max sub)  │
└─────────────────┘
```

Your credentials stay on your machine. The proxy spawns Claude Code CLI subprocesses and translates their output to OpenAI-compatible format for ArmadaOS.

## License

MIT
