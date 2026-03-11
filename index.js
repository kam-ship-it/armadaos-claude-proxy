#!/usr/bin/env node

/**
 * armadaos-claude-proxy v2.0.0
 *
 * One-command connection of your Claude Max/Pro subscription to ArmadaOS.
 *
 * Usage:
 *   npx github:kam-ship-it/armadaos-claude-proxy
 *
 * What it does:
 *   1. Auto-detects your Claude Code OAuth token (macOS Keychain, Windows Credential Manager, Linux Secret Service, ~/.claude.json)
 *   2. Starts a local HTTP server that translates OpenAI-compatible requests to Anthropic API
 *   3. Automatically creates a free Cloudflare tunnel (no ngrok, no signup needed)
 *   4. Prints the tunnel URL — paste it into ArmadaOS Settings → Compute → Claude Max → Connect
 *
 * Environment Variables:
 *   CLAUDE_CODE_OAUTH_TOKEN  — Override auto-detection with a specific token
 *   ANTHROPIC_API_KEY        — Use an Anthropic API key instead of OAuth token
 *   PORT                     — Local server port (default: 3456)
 *   NO_TUNNEL                — Set to "1" to skip tunnel creation (use with your own ngrok/tunnel)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const os = require("os");

const PORT = parseInt(process.env.PORT || "3456", 10);
const ANTHROPIC_API_URL = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";
const VERSION = "2.0.0";

// ─── Pretty Console Output ────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

function log(msg) { console.log(`  ${msg}`); }
function logOk(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function logWarn(msg) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function logErr(msg) { console.error(`  ${RED}✗${RESET} ${msg}`); }
function logStep(n, msg) { console.log(`  ${CYAN}[${n}]${RESET} ${msg}`); }

// ─── Token Resolution ──────────────────────────────────────────────────────

function getTokenFromEnv() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

function getApiKeyFromEnv() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function getTokenFromClaudeJson() {
  // Check multiple possible locations for .claude.json
  const homedir = os.homedir();
  const possiblePaths = [
    path.join(homedir, ".claude.json"),
    path.join(homedir, ".claude", "credentials.json"),
    path.join(homedir, ".claude", "auth.json"),
  ];

  // On Windows, also check APPDATA
  if (process.platform === "win32" && process.env.APPDATA) {
    possiblePaths.push(path.join(process.env.APPDATA, "Claude", "claude.json"));
    possiblePaths.push(path.join(process.env.APPDATA, "claude-code", "credentials.json"));
  }

  for (const filePath of possiblePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);

      // Claude Code stores OAuth tokens in various formats — check all known paths
      const candidates = [
        data.oauthAccessToken,
        data.oauth?.accessToken,
        data.accessToken,
        data.credentials?.accessToken,
        data.claudeAiOauth?.accessToken,
        data.token,
      ];

      for (const candidate of candidates) {
        if (candidate && typeof candidate === "string" && candidate.length > 20) {
          return { token: candidate, source: filePath };
        }
      }
    } catch {
      // File doesn't exist or isn't valid JSON — try next
    }
  }
  return null;
}

function getTokenFromMacKeychain() {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execSync(
      'security find-generic-password -s "claude-code-credentials" -w 2>/dev/null',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!raw) return null;

    // Keychain may store a JSON blob or a raw token
    try {
      const parsed = JSON.parse(raw);
      const token = parsed.accessToken || parsed.oauthAccessToken || parsed.token;
      if (token) return { token, source: "macOS Keychain" };
    } catch {
      // Not JSON — treat as raw token
      if (raw.length > 20) return { token: raw, source: "macOS Keychain" };
    }
  } catch {
    // Keychain item not found
  }
  return null;
}

function getTokenFromWindowsCredentialManager() {
  if (process.platform !== "win32") return null;

  // Method 1: Try PowerShell with CredentialManager module
  try {
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $cred = Get-StoredCredential -Target 'claude-code-credentials' 2>$null
      if ($cred) {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password)
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        Write-Output $plain
      }
    `;
    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, " ")}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (result && result.length > 20) {
      try {
        const parsed = JSON.parse(result);
        const token = parsed.accessToken || parsed.oauthAccessToken || parsed.token;
        if (token) return { token, source: "Windows Credential Manager" };
      } catch {
        return { token: result, source: "Windows Credential Manager" };
      }
    }
  } catch {
    // CredentialManager module not available
  }

  // Method 2: Try cmdkey + dpapi (less reliable but more universal)
  try {
    const psScript2 = `
      $ErrorActionPreference = 'SilentlyContinue'
      $targets = cmdkey /list 2>$null | Select-String 'claude' -SimpleMatch
      if ($targets) { Write-Output $targets.Line }
    `;
    const result2 = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript2.replace(/\n/g, " ")}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    if (result2) {
      log(`${DIM}Found Windows credential entries: ${result2}${RESET}`);
    }
  } catch {
    // cmdkey not available
  }

  return null;
}

function getTokenFromLinuxSecretService() {
  if (process.platform !== "linux") return null;
  try {
    // Try secret-tool (GNOME Keyring / KDE Wallet)
    const raw = execSync(
      'secret-tool lookup service claude-code-credentials 2>/dev/null',
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (raw && raw.length > 20) {
      try {
        const parsed = JSON.parse(raw);
        const token = parsed.accessToken || parsed.oauthAccessToken || parsed.token;
        if (token) return { token, source: "Linux Secret Service" };
      } catch {
        return { token: raw, source: "Linux Secret Service" };
      }
    }
  } catch {
    // secret-tool not available
  }
  return null;
}

function resolveCredentials() {
  // Priority 1: Anthropic API key (officially supported, no ToS issues)
  const apiKey = getApiKeyFromEnv();
  if (apiKey) {
    return { token: apiKey, source: "ANTHROPIC_API_KEY environment variable", isApiKey: true };
  }

  // Priority 2: Explicit OAuth token env var
  const envToken = getTokenFromEnv();
  if (envToken) {
    return { token: envToken, source: "CLAUDE_CODE_OAUTH_TOKEN environment variable", isApiKey: false };
  }

  // Priority 3: ~/.claude.json and related files
  const fileResult = getTokenFromClaudeJson();
  if (fileResult) {
    return { token: fileResult.token, source: fileResult.source, isApiKey: false };
  }

  // Priority 4: OS-specific credential stores
  if (process.platform === "darwin") {
    const keychainResult = getTokenFromMacKeychain();
    if (keychainResult) {
      return { token: keychainResult.token, source: keychainResult.source, isApiKey: false };
    }
  } else if (process.platform === "win32") {
    const winResult = getTokenFromWindowsCredentialManager();
    if (winResult) {
      return { token: winResult.token, source: winResult.source, isApiKey: false };
    }
  } else if (process.platform === "linux") {
    const linuxResult = getTokenFromLinuxSecretService();
    if (linuxResult) {
      return { token: linuxResult.token, source: linuxResult.source, isApiKey: false };
    }
  }

  return null;
}

// ─── Model Mapping ─────────────────────────────────────────────────────────

const CLAUDE_MODELS = [
  { id: "claude-sonnet-4-5-20250514", name: "Claude Sonnet 4.5", flagship: true },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", flagship: false },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", flagship: false },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", flagship: false },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", flagship: false },
  { id: "claude-3-opus-20240229", name: "Claude 3 Opus", flagship: false },
  { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", flagship: false },
];

const MODEL_MAP = {};
for (const m of CLAUDE_MODELS) {
  MODEL_MAP[m.id] = m.id;
  // Also map short names
  const short = m.id.replace(/-\d{8}$/, "");
  if (short !== m.id) MODEL_MAP[short] = m.id;
}
// Common aliases
MODEL_MAP["claude-sonnet-4-5"] = "claude-sonnet-4-5-20250514";
MODEL_MAP["claude-sonnet-4"] = "claude-sonnet-4-20250514";
MODEL_MAP["claude-opus-4"] = "claude-opus-4-20250514";
MODEL_MAP["claude-3-5-sonnet"] = "claude-3-5-sonnet-20241022";
MODEL_MAP["claude-3-5-haiku"] = "claude-3-5-haiku-20241022";
MODEL_MAP["claude-3-opus"] = "claude-3-opus-20240229";
MODEL_MAP["claude-3-haiku"] = "claude-3-haiku-20240307";

function resolveModel(requestedModel) {
  if (!requestedModel) return "claude-sonnet-4-5-20250514";
  if (MODEL_MAP[requestedModel]) return MODEL_MAP[requestedModel];
  const lower = requestedModel.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return value;
  }
  return requestedModel;
}

// ─── Request Translation ───────────────────────────────────────────────────

function openaiToAnthropic(openaiBody) {
  const model = resolveModel(openaiBody.model);
  const messages = openaiBody.messages || [];

  let system = undefined;
  const nonSystemMessages = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = (system ? system + "\n\n" : "") + (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    } else {
      nonSystemMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  // Ensure messages alternate user/assistant (Anthropic requirement)
  if (nonSystemMessages.length > 0 && nonSystemMessages[0].role !== "user") {
    nonSystemMessages.unshift({ role: "user", content: "Continue." });
  }

  // Merge consecutive same-role messages (Anthropic doesn't allow them)
  const merged = [];
  for (const msg of nonSystemMessages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += "\n\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }

  if (merged.length === 0) {
    merged.push({ role: "user", content: system || "Hello" });
    system = undefined;
  }

  const anthropicBody = {
    model,
    messages: merged,
    max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || 4096,
  };

  if (system) anthropicBody.system = system;
  if (openaiBody.temperature !== undefined) anthropicBody.temperature = openaiBody.temperature;
  if (openaiBody.top_p !== undefined) anthropicBody.top_p = openaiBody.top_p;
  if (openaiBody.stop) {
    anthropicBody.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
  }

  return anthropicBody;
}

function anthropicToOpenai(anthropicResponse, model) {
  const content = anthropicResponse.content || [];
  const textParts = content.filter((c) => c.type === "text").map((c) => c.text);

  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textParts.join(""),
        },
        finish_reason:
          anthropicResponse.stop_reason === "end_turn"
            ? "stop"
            : anthropicResponse.stop_reason === "max_tokens"
            ? "length"
            : "stop",
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

// ─── HTTP Helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf-8");
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Server ────────────────────────────────────────────────────────────────

let requestCount = 0;
let totalTokens = 0;

async function handleRequest(req, res, credentials) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url;

  // Health check
  if (url === "/" || url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        provider: "claude",
        proxy: "armadaos-claude-proxy",
        version: VERSION,
        requests: requestCount,
        totalTokens: totalTokens,
        uptime: Math.floor(process.uptime()),
      })
    );
    return;
  }

  // Models list
  if (url === "/v1/models" || url === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: CLAUDE_MODELS.map((m) => ({
          id: m.id,
          object: "model",
          created: 1700000000,
          owned_by: "anthropic",
        })),
      })
    );
    return;
  }

  // Chat completions
  if (
    (url === "/v1/chat/completions" || url === "/chat/completions") &&
    req.method === "POST"
  ) {
    requestCount++;
    const reqNum = requestCount;
    try {
      const rawBody = await readBody(req);
      const openaiBody = JSON.parse(rawBody);
      const anthropicBody = openaiToAnthropic(openaiBody);

      log(
        `${DIM}#${reqNum}${RESET} → ${BOLD}${anthropicBody.model}${RESET} | ${anthropicBody.messages.length} messages`
      );

      const requestBody = JSON.stringify(anthropicBody);

      // Build headers based on credential type
      const headers = {
        "Content-Type": "application/json",
        "anthropic-version": ANTHROPIC_API_VERSION,
      };

      if (credentials.isApiKey) {
        headers["x-api-key"] = credentials.token;
      } else {
        // OAuth token — use as Bearer token
        headers["Authorization"] = `Bearer ${credentials.token}`;
      }

      const response = await makeRequest(
        `${ANTHROPIC_API_URL}/v1/messages`,
        { method: "POST", headers },
        requestBody
      );

      if (response.statusCode !== 200) {
        const errBody = response.body.slice(0, 500);
        logErr(`#${reqNum} Anthropic API error: ${response.statusCode}`);
        log(`${DIM}${errBody}${RESET}`);

        // If 401, token may have expired
        if (response.statusCode === 401) {
          logWarn("Token may have expired. Try running 'claude login' to refresh your token, then restart this proxy.");
        }

        res.writeHead(response.statusCode, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Anthropic API error: ${response.statusCode}`,
              details: errBody,
            },
          })
        );
        return;
      }

      const anthropicResponse = JSON.parse(response.body);
      const openaiResponse = anthropicToOpenai(anthropicResponse, anthropicBody.model);

      totalTokens += openaiResponse.usage.total_tokens;
      logOk(
        `#${reqNum} ${openaiResponse.usage.total_tokens} tokens (${openaiResponse.usage.prompt_tokens} in / ${openaiResponse.usage.completion_tokens} out)`
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiResponse));
    } catch (err) {
      logErr(`#${reqNum} Error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
}

// ─── Tunnel ────────────────────────────────────────────────────────────────

async function startTunnel(port) {
  // Try to use the cloudflared npm package for a zero-config tunnel
  let tunnelUrl = null;

  try {
    // Check if cloudflared is available
    let cloudflaredBin;
    try {
      // Check if installed globally
      const which = process.platform === "win32" ? "where" : "which";
      cloudflaredBin = execSync(`${which} cloudflared 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim().split("\n")[0];
    } catch {
      // Not installed globally — try to install via npm
      logStep("3a", "Installing cloudflared tunnel tool...");
      try {
        execSync("npm install -g cloudflared 2>&1", {
          encoding: "utf-8",
          timeout: 60000,
          stdio: "pipe",
        });
        const which = process.platform === "win32" ? "where" : "which";
        cloudflaredBin = execSync(`${which} cloudflared 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 5000,
        }).trim().split("\n")[0];
      } catch (installErr) {
        log(`${DIM}Could not install cloudflared: ${installErr.message}${RESET}`);
      }
    }

    if (cloudflaredBin) {
      logStep("3b", "Starting Cloudflare tunnel (free, no account needed)...");

      return new Promise((resolve) => {
        const proc = spawn(cloudflaredBin, ["tunnel", "--url", `http://localhost:${port}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let resolved = false;
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

        function checkOutput(data) {
          const text = data.toString();
          const match = text.match(urlRegex);
          if (match && !resolved) {
            resolved = true;
            resolve({ url: match[0], process: proc });
          }
        }

        proc.stdout.on("data", checkOutput);
        proc.stderr.on("data", checkOutput);

        proc.on("error", (err) => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        proc.on("exit", (code) => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 30000);
      });
    }
  } catch (err) {
    log(`${DIM}Tunnel setup error: ${err.message}${RESET}`);
  }

  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(`  ${BOLD}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`  ${BOLD}║   ${MAGENTA}ArmadaOS Claude Proxy${RESET} ${BOLD}v${VERSION}              ║${RESET}`);
  console.log(`  ${BOLD}║   Connect Claude Max/Pro to ArmadaOS            ║${RESET}`);
  console.log(`  ${BOLD}╚══════════════════════════════════════════════════╝${RESET}`);
  console.log("");

  // Step 1: Resolve credentials
  logStep(1, "Looking for Claude credentials...");
  console.log("");

  const credentials = resolveCredentials();

  if (!credentials) {
    console.log("");
    logErr(`${BOLD}No Claude credentials found.${RESET}`);
    console.log("");
    log(`${BOLD}How to fix this:${RESET}`);
    console.log("");
    log(`${CYAN}Option A: Use an Anthropic API key (recommended)${RESET}`);
    log(`  1. Go to ${BOLD}https://console.anthropic.com/settings/keys${RESET}`);
    log(`  2. Create a new API key`);
    log(`  3. Run:`);
    console.log("");
    if (process.platform === "win32") {
      log(`     ${GREEN}$env:ANTHROPIC_API_KEY = "sk-ant-..."${RESET}`);
      log(`     ${GREEN}npx github:kam-ship-it/armadaos-claude-proxy${RESET}`);
    } else {
      log(`     ${GREEN}export ANTHROPIC_API_KEY="sk-ant-..."${RESET}`);
      log(`     ${GREEN}npx github:kam-ship-it/armadaos-claude-proxy${RESET}`);
    }
    console.log("");
    log(`${CYAN}Option B: Use Claude Code OAuth token${RESET}`);
    log(`  1. Install Claude Code: ${GREEN}npm install -g @anthropic-ai/claude-code${RESET}`);
    log(`  2. Log in: ${GREEN}claude login${RESET}`);
    log(`  3. Run this proxy again`);
    console.log("");
    log(`${CYAN}Option C: Set token manually${RESET}`);
    if (process.platform === "win32") {
      log(`     ${GREEN}$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"${RESET}`);
      log(`     ${GREEN}npx github:kam-ship-it/armadaos-claude-proxy${RESET}`);
    } else {
      log(`     ${GREEN}export CLAUDE_CODE_OAUTH_TOKEN="your-token"${RESET}`);
      log(`     ${GREEN}npx github:kam-ship-it/armadaos-claude-proxy${RESET}`);
    }
    console.log("");
    process.exit(1);
  }

  const credType = credentials.isApiKey ? "API Key" : "OAuth Token";
  logOk(`Found ${credType} from: ${BOLD}${credentials.source}${RESET}`);
  console.log("");

  // Step 2: Start the local server
  logStep(2, `Starting local proxy server on port ${PORT}...`);

  const server = http.createServer((req, res) =>
    handleRequest(req, res, credentials)
  );

  await new Promise((resolve) => {
    server.listen(PORT, "0.0.0.0", () => {
      logOk(`Proxy running on http://localhost:${PORT}`);
      resolve();
    });
  });
  console.log("");

  // Step 3: Start tunnel (unless disabled)
  if (process.env.NO_TUNNEL === "1") {
    logStep(3, "Tunnel disabled (NO_TUNNEL=1)");
    console.log("");
    log(`${BOLD}Manual tunnel setup:${RESET}`);
    log(`  Run in a new terminal: ${GREEN}ngrok http ${PORT}${RESET}`);
    log(`  Or: ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
    console.log("");
    log(`Then paste the tunnel URL into ArmadaOS → Settings → Compute → Claude Max`);
    console.log("");
  } else {
    logStep(3, "Creating tunnel...");

    const tunnel = await startTunnel(PORT);

    if (tunnel && tunnel.url) {
      console.log("");
      console.log(`  ${BOLD}╔══════════════════════════════════════════════════╗${RESET}`);
      console.log(`  ${BOLD}║  ${GREEN}TUNNEL READY${RESET}${BOLD}                                    ║${RESET}`);
      console.log(`  ${BOLD}╚══════════════════════════════════════════════════╝${RESET}`);
      console.log("");
      log(`  ${BOLD}${CYAN}${tunnel.url}${RESET}`);
      console.log("");
      log(`${BOLD}Next step:${RESET}`);
      log(`  1. Copy the URL above`);
      log(`  2. Go to ${BOLD}staging.armadaos.ai${RESET} → Settings → Compute`);
      log(`  3. Find ${BOLD}Claude Max${RESET} → Paste the URL → Click ${BOLD}Connect${RESET}`);
      console.log("");

      // Handle cleanup
      process.on("SIGINT", () => {
        console.log("");
        log("Shutting down...");
        if (tunnel.process) tunnel.process.kill();
        server.close();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        if (tunnel.process) tunnel.process.kill();
        server.close();
        process.exit(0);
      });
    } else {
      logWarn("Could not create automatic tunnel.");
      console.log("");
      log(`${BOLD}Manual tunnel options:${RESET}`);
      console.log("");
      log(`  ${CYAN}Option 1: Cloudflare (free, no signup)${RESET}`);
      if (process.platform === "win32") {
        log(`    Download from: ${BOLD}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${RESET}`);
        log(`    Then run: ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
      } else {
        log(`    ${GREEN}brew install cloudflared${RESET}  (macOS)`);
        log(`    ${GREEN}sudo apt install cloudflared${RESET}  (Linux)`);
        log(`    Then: ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
      }
      console.log("");
      log(`  ${CYAN}Option 2: ngrok${RESET}`);
      log(`    Download from: ${BOLD}https://ngrok.com/download${RESET}`);
      log(`    Then run: ${GREEN}ngrok http ${PORT}${RESET}`);
      console.log("");
      log(`Then paste the tunnel URL into ArmadaOS → Settings → Compute → Claude Max`);
      console.log("");
    }
  }

  // Status line
  log(`${DIM}Waiting for requests... (Ctrl+C to stop)${RESET}`);
  console.log("");

  // Periodic status
  setInterval(() => {
    if (requestCount > 0) {
      log(`${DIM}Stats: ${requestCount} requests | ${totalTokens.toLocaleString()} tokens | uptime ${Math.floor(process.uptime())}s${RESET}`);
    }
  }, 300000); // Every 5 minutes
}

main().catch((err) => {
  logErr(`Fatal error: ${err.message}`);
  process.exit(1);
});
