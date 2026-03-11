# armadaos-claude-proxy

Connect your Claude Max/Pro subscription to ArmadaOS. Uses your existing Claude Code OAuth credentials to proxy API requests through your local machine.

## Quick Start

```bash
# 1. Make sure you're logged into Claude Code
npm install -g @anthropic-ai/claude-code
claude login

# 2. Start the proxy
npx armadaos-claude-proxy

# 3. In a new terminal, start ngrok
ngrok http 3456

# 4. Copy the ngrok URL and paste into ArmadaOS
#    Settings → Compute → Claude Max → Paste URL → Connect
```

## How It Works

1. Reads your Claude Code OAuth token from `~/.claude.json` or macOS Keychain
2. Starts a local HTTP server on port 3456
3. Translates OpenAI-compatible requests to Anthropic API format
4. ArmadaOS connects via your ngrok tunnel URL

## Available Models

Once connected, ArmadaOS will discover these models:
- Claude Sonnet 4.5
- Claude Opus 4
- Claude 3.5 Sonnet
- Claude 3.5 Haiku
- Claude 3 Opus
- Claude 3 Haiku

## Environment Variables

| Variable | Description |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Override token (skip auto-detection) |
| `PORT` | Server port (default: 3456) |

## Token Resolution Order

1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable
2. `~/.claude.json` file
3. macOS Keychain (`claude-code-credentials`)

## License

MIT
