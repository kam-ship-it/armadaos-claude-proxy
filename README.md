# ArmadaOS Claude Proxy v2.0

Connect your Claude Max/Pro subscription (or Anthropic API key) to ArmadaOS with a single command. No ngrok signup, no manual token extraction, no complex setup.

## Quick Start

### Option A: Anthropic API Key (Simplest)

```powershell
# Windows PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-your-key-here"
npx github:kam-ship-it/armadaos-claude-proxy
```

```bash
# macOS / Linux
export ANTHROPIC_API_KEY="sk-ant-your-key-here"
npx github:kam-ship-it/armadaos-claude-proxy
```

Get your API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

### Option B: Claude Code OAuth (Auto-Detected)

If you have Claude Code installed and logged in, the proxy will automatically find your token.

```bash
# Make sure you're logged into Claude Code first
claude login

# Then just run the proxy — it finds your token automatically
npx github:kam-ship-it/armadaos-claude-proxy
```

## What Happens

1. The proxy auto-detects your Claude credentials (API key, OAuth token from Claude Code, or OS keychain)
2. A local HTTP server starts on port 3456
3. A free Cloudflare tunnel is created automatically (no account needed)
4. You get a public URL — paste it into ArmadaOS

```
  ╔══════════════════════════════════════════════════╗
  ║  TUNNEL READY                                    ║
  ╚══════════════════════════════════════════════════╝

    https://random-words-here.trycloudflare.com

  Next step:
    1. Copy the URL above
    2. Go to staging.armadaos.ai → Settings → Compute
    3. Find Claude Max → Paste the URL → Click Connect
```

## Credential Detection Order

The proxy checks for credentials in this order:

| Priority | Source | How to Set |
|----------|--------|-----------|
| 1 | `ANTHROPIC_API_KEY` env var | `export ANTHROPIC_API_KEY="sk-ant-..."` |
| 2 | `CLAUDE_CODE_OAUTH_TOKEN` env var | `export CLAUDE_CODE_OAUTH_TOKEN="..."` |
| 3 | `~/.claude.json` file | Auto-created by `claude login` |
| 4 | macOS Keychain | Auto-stored by Claude Code on macOS |
| 5 | Windows Credential Manager | Auto-stored by Claude Code on Windows |
| 6 | Linux Secret Service | Auto-stored by Claude Code on Linux |

## Available Models

Once connected, ArmadaOS can use these Claude models:

| Model | ID |
|-------|-----|
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250514` |
| Claude Sonnet 4 | `claude-sonnet-4-20250514` |
| Claude Opus 4 | `claude-opus-4-20250514` |
| Claude 3.5 Sonnet | `claude-3-5-sonnet-20241022` |
| Claude 3.5 Haiku | `claude-3-5-haiku-20241022` |
| Claude 3 Opus | `claude-3-opus-20240229` |
| Claude 3 Haiku | `claude-3-haiku-20240307` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (takes priority over OAuth) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude Code OAuth token (manual override) |
| `PORT` | `3456` | Local server port |
| `NO_TUNNEL` | `0` | Set to `1` to skip auto-tunnel (use your own ngrok/cloudflared) |

## Manual Tunnel (if auto-tunnel fails)

If the automatic Cloudflare tunnel doesn't work, you can create one manually:

```bash
# Option 1: Cloudflare (free, no signup)
cloudflared tunnel --url http://localhost:3456

# Option 2: ngrok
ngrok http 3456
```

Then paste the tunnel URL into ArmadaOS.

## Troubleshooting

**"No Claude credentials found"** — You need to either set `ANTHROPIC_API_KEY` or log into Claude Code first (`claude login`).

**"Token may have expired"** — Claude Code OAuth tokens expire after about 1 hour. Run `claude login` again to refresh, then restart the proxy.

**"Could not create automatic tunnel"** — The proxy tried to install `cloudflared` but it failed. Install it manually or use ngrok instead.

**Windows PowerShell execution policy error** — Run PowerShell as Administrator and execute: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

## Architecture

```
Your Computer                          Cloud
┌─────────────────┐                ┌──────────────┐
│ Claude Proxy    │◄── Tunnel ────►│  ArmadaOS    │
│ (port 3456)     │    (HTTPS)     │  (staging)   │
└────────┬────────┘                └──────────────┘
         │
         │ Your credentials
         │ (never leave your machine)
         ▼
┌─────────────────┐
│ Anthropic API   │
│ (api.anthropic  │
│  .com)          │
└─────────────────┘
```

Your credentials stay on your machine. The proxy translates OpenAI-compatible requests from ArmadaOS into Anthropic API calls using your local credentials.

## License

MIT
