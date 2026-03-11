#!/usr/bin/env node

/**
 * armadaos-claude-proxy v3.0.0
 *
 * Uses your Claude Max/Pro subscription via Claude Code CLI.
 * No API key needed — just have Claude Code installed and logged in.
 *
 * Usage:
 *   npx github:kam-ship-it/armadaos-claude-proxy
 *
 * How it works:
 *   1. Verifies Claude Code CLI is installed and authenticated
 *   2. Spawns `claude` CLI as a subprocess for each request
 *   3. Exposes an OpenAI-compatible HTTP API on localhost
 *   4. Auto-creates a free Cloudflare tunnel
 *   5. Paste the tunnel URL into ArmadaOS → Settings → Compute → Claude Max
 *
 * Prerequisites:
 *   - Claude Max or Pro subscription ($100-200/mo)
 *   - Claude Code CLI: npm install -g @anthropic-ai/claude-code
 *   - Logged in: claude login
 *
 * Environment Variables:
 *   PORT       — Local server port (default: 3456)
 *   NO_TUNNEL  — Set to "1" to skip tunnel creation
 */

const http = require("http");
const { spawn, execSync } = require("child_process");
const os = require("os");

const PORT = parseInt(process.env.PORT || "3456", 10);
const VERSION = "3.0.0";

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

// ─── Claude CLI Detection ─────────────────────────────────────────────────

function findClaudeCli() {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${which} claude 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim().split("\n")[0];
    return result || null;
  } catch {
    return null;
  }
}

function checkClaudeAuth() {
  // Quick check: run `claude --version` to see if CLI works
  try {
    const version = execSync("claude --version 2>&1", {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return version;
  } catch {
    return null;
  }
}

// ─── Model Mapping ────────────────────────────────────────────────────────

// Models available through Claude Code CLI with Max subscription
const CLAUDE_MODELS = [
  { id: "claude-sonnet-4-5-20250514", name: "Claude Sonnet 4.5", cliModel: "sonnet" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", cliModel: "sonnet" },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", cliModel: "opus" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", cliModel: "sonnet" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", cliModel: "haiku" },
];

// Map any incoming model name to a CLI model flag
function resolveCliModel(requestedModel) {
  if (!requestedModel) return "sonnet";
  const lower = requestedModel.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet"; // default to sonnet
}

// Map incoming model to a full model ID for the response
function resolveModelId(requestedModel) {
  if (!requestedModel) return "claude-sonnet-4-5-20250514";
  const lower = requestedModel.toLowerCase();
  if (lower.includes("opus")) return "claude-opus-4-20250514";
  if (lower.includes("haiku")) return "claude-3-5-haiku-20241022";
  if (lower.includes("4-5") || lower.includes("4.5")) return "claude-sonnet-4-5-20250514";
  if (lower.includes("sonnet-4") || lower.includes("sonnet4")) return "claude-sonnet-4-20250514";
  return "claude-sonnet-4-5-20250514";
}

// ─── Claude CLI Subprocess ────────────────────────────────────────────────

/**
 * Run a prompt through Claude Code CLI and return the response.
 * Uses --print mode with stream-json output for reliable parsing.
 */
function runClaudeCli(prompt, model, stream) {
  return new Promise((resolve, reject) => {
    const cliModel = resolveCliModel(model);
    
    const args = [
      "--print",                    // Non-interactive mode
      "--output-format", "stream-json", // JSON streaming output
      "--verbose",                  // Required for stream-json
      "--model", cliModel,          // Model selection
      "--no-session-persistence",   // Don't save sessions
      prompt,                       // The prompt
    ];

    const proc = spawn("claude", args, {
      cwd: os.homedir(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Close stdin — prompt is passed as argument
    proc.stdin.end();

    let buffer = "";
    const chunks = [];
    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      
      // Process complete JSON lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        try {
          const event = JSON.parse(trimmed);
          
          // Collect streaming chunks for SSE mode
          if (stream && event.type === "content_block_delta" && event.delta?.text) {
            chunks.push(event.delta.text);
          }
          
          // Assistant message with content
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                resultText += block.text;
              }
            }
          }

          // Result message (final)
          if (event.type === "result") {
            if (event.result) {
              resultText = event.result;
            }
            if (event.usage) {
              inputTokens = event.usage.input_tokens || 0;
              outputTokens = event.usage.output_tokens || 0;
            }
          }

          // Content delta (streaming)
          if (event.type === "content_block_delta" && event.delta?.text) {
            // Already handled above for streaming
          }

          // Message delta with usage info
          if (event.type === "message_delta" && event.usage) {
            outputTokens = event.usage.output_tokens || outputTokens;
          }

          // Message start with usage
          if (event.type === "message_start" && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || inputTokens;
          }

        } catch {
          // Not valid JSON — might be plain text output
          if (trimmed && !trimmed.startsWith("{")) {
            resultText += trimmed + "\n";
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text && !text.includes("Debug") && !text.includes("debug")) {
        // Only log actual errors, not debug output
        if (text.toLowerCase().includes("error") || text.toLowerCase().includes("fatal")) {
          logErr(`CLI stderr: ${text.slice(0, 200)}`);
        }
      }
    });

    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        reject(new Error("Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.type === "result" && event.result) {
            resultText = event.result;
          }
          if (event.usage) {
            inputTokens = event.usage.input_tokens || inputTokens;
            outputTokens = event.usage.output_tokens || outputTokens;
          }
        } catch {
          if (buffer.trim() && !resultText) {
            resultText += buffer.trim();
          }
        }
      }

      if (code !== 0 && !resultText) {
        reject(new Error(`Claude CLI exited with code ${code}`));
        return;
      }

      resolve({
        text: resultText.trim(),
        chunks,
        inputTokens,
        outputTokens,
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        reject(new Error("Request timed out after 5 minutes"));
      }
    }, 300000);
  });
}

// ─── OpenAI Format Helpers ────────────────────────────────────────────────

function buildOpenAiResponse(text, model, inputTokens, outputTokens) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resolveModelId(model),
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function extractPromptFromMessages(messages) {
  // Combine all messages into a single prompt for the CLI
  // The CLI doesn't support multi-turn natively in --print mode,
  // so we format the conversation as a prompt
  if (!messages || messages.length === 0) return "Hello";

  const parts = [];
  let systemPrompt = "";

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (msg.role === "system") {
      systemPrompt += content + "\n";
    } else if (msg.role === "user") {
      parts.push(`User: ${content}`);
    } else if (msg.role === "assistant") {
      parts.push(`Assistant: ${content}`);
    }
  }

  // If there's only one user message and no system prompt, just use it directly
  const userMessages = messages.filter(m => m.role === "user");
  if (userMessages.length === 1 && !systemPrompt && messages.length <= 2) {
    const content = typeof userMessages[0].content === "string" 
      ? userMessages[0].content 
      : JSON.stringify(userMessages[0].content);
    return content;
  }

  // Multi-turn: format as conversation
  let prompt = "";
  if (systemPrompt) {
    prompt += `System Instructions:\n${systemPrompt.trim()}\n\n`;
  }
  if (parts.length > 0) {
    prompt += parts.join("\n\n");
  }
  // Add instruction to continue as assistant
  if (parts.length > 0 && !parts[parts.length - 1].startsWith("User:")) {
    prompt += "\n\nPlease continue the conversation.";
  }

  return prompt || "Hello";
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ─── Server ───────────────────────────────────────────────────────────────

let requestCount = 0;
let totalTokens = 0;

async function handleRequest(req, res) {
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
    res.end(JSON.stringify({
      status: "ok",
      provider: "claude-cli",
      proxy: "armadaos-claude-proxy",
      version: VERSION,
      method: "Claude Code CLI (uses Max/Pro subscription)",
      requests: requestCount,
      totalTokens,
      uptime: Math.floor(process.uptime()),
    }));
    return;
  }

  // Models list
  if (url === "/v1/models" || url === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: CLAUDE_MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      })),
    }));
    return;
  }

  // Chat completions
  if ((url === "/v1/chat/completions" || url === "/chat/completions") && req.method === "POST") {
    requestCount++;
    const reqNum = requestCount;

    try {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody);
      const model = body.model || "claude-sonnet-4-5-20250514";
      const prompt = extractPromptFromMessages(body.messages);

      log(`${DIM}#${reqNum}${RESET} → ${BOLD}${resolveCliModel(model)}${RESET} | ${body.messages?.length || 0} messages | ${prompt.length} chars`);

      const result = await runClaudeCli(prompt, model, false);

      totalTokens += result.inputTokens + result.outputTokens;
      logOk(`#${reqNum} ${result.inputTokens + result.outputTokens} tokens (${result.inputTokens} in / ${result.outputTokens} out)`);

      const openaiResponse = buildOpenAiResponse(result.text, model, result.inputTokens, result.outputTokens);

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

// ─── Tunnel ───────────────────────────────────────────────────────────────

async function startTunnel(port) {
  try {
    let cloudflaredBin;
    try {
      const which = process.platform === "win32" ? "where" : "which";
      cloudflaredBin = execSync(`${which} cloudflared 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim().split("\n")[0];
    } catch {
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

        proc.on("error", () => {
          if (!resolved) { resolved = true; resolve(null); }
        });

        proc.on("exit", () => {
          if (!resolved) { resolved = true; resolve(null); }
        });

        setTimeout(() => {
          if (!resolved) { resolved = true; resolve(null); }
        }, 30000);
      });
    }
  } catch (err) {
    log(`${DIM}Tunnel setup error: ${err.message}${RESET}`);
  }

  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(`  ${BOLD}╔══════════════════════════════════════════════════╗${RESET}`);
  console.log(`  ${BOLD}║   ${MAGENTA}ArmadaOS Claude Proxy${RESET} ${BOLD}v${VERSION}              ║${RESET}`);
  console.log(`  ${BOLD}║   Uses your Claude Max/Pro subscription         ║${RESET}`);
  console.log(`  ${BOLD}║   via Claude Code CLI — no API key needed       ║${RESET}`);
  console.log(`  ${BOLD}╚══════════════════════════════════════════════════╝${RESET}`);
  console.log("");

  // Step 1: Check Claude CLI is installed
  logStep(1, "Checking for Claude Code CLI...");

  const claudePath = findClaudeCli();
  if (!claudePath) {
    console.log("");
    logErr(`${BOLD}Claude Code CLI not found.${RESET}`);
    console.log("");
    log(`${BOLD}Install it:${RESET}`);
    log(`  ${GREEN}npm install -g @anthropic-ai/claude-code${RESET}`);
    console.log("");
    log(`${BOLD}Then log in:${RESET}`);
    log(`  ${GREEN}claude login${RESET}`);
    console.log("");
    log(`This will open your browser to authenticate with your Claude Max/Pro account.`);
    log(`Once logged in, run this proxy again.`);
    console.log("");
    process.exit(1);
  }

  logOk(`Found Claude CLI at: ${BOLD}${claudePath}${RESET}`);

  // Step 1b: Check authentication
  const cliVersion = checkClaudeAuth();
  if (cliVersion) {
    logOk(`Claude CLI version: ${BOLD}${cliVersion}${RESET}`);
  } else {
    logWarn("Could not verify Claude CLI version. Make sure you're logged in:");
    log(`  ${GREEN}claude login${RESET}`);
  }
  console.log("");

  // Step 2: Start the local server
  logStep(2, `Starting local proxy server on port ${PORT}...`);

  const server = http.createServer(handleRequest);

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
    log(`${BOLD}Use your own tunnel:${RESET}`);
    log(`  ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
    console.log("");
    log(`Then paste the tunnel URL into ArmadaOS → Settings → Compute → Claude Max`);
    console.log("");
  } else {
    logStep(3, "Creating tunnel...");

    const tunnel = await startTunnel(PORT);

    if (tunnel && tunnel.url) {
      console.log("");
      console.log(`  ${BOLD}╔══════════════════════════════════════════════════╗${RESET}`);
      console.log(`  ${BOLD}║  ${GREEN}READY — USING YOUR CLAUDE MAX SUBSCRIPTION${RESET}${BOLD}     ║${RESET}`);
      console.log(`  ${BOLD}╚══════════════════════════════════════════════════╝${RESET}`);
      console.log("");
      log(`  ${BOLD}${CYAN}${tunnel.url}${RESET}`);
      console.log("");
      log(`${BOLD}Next step:${RESET}`);
      log(`  1. Copy the URL above`);
      log(`  2. Go to ${BOLD}staging.armadaos.ai${RESET} → Settings → Compute`);
      log(`  3. Find ${BOLD}Claude Max${RESET} → Paste the URL → Click ${BOLD}Connect${RESET}`);
      console.log("");
      log(`${DIM}This uses your Claude Max/Pro subscription. No API key. No extra cost.${RESET}`);
      console.log("");

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
      log(`${BOLD}Manual tunnel:${RESET}`);
      if (process.platform === "win32") {
        log(`  Download cloudflared: ${BOLD}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${RESET}`);
        log(`  Then run: ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
      } else {
        log(`  ${GREEN}brew install cloudflared${RESET}  (macOS)`);
        log(`  Then: ${GREEN}cloudflared tunnel --url http://localhost:${PORT}${RESET}`);
      }
      console.log("");
      log(`Then paste the tunnel URL into ArmadaOS → Settings → Compute → Claude Max`);
      console.log("");
    }
  }

  log(`${DIM}Waiting for requests... (Ctrl+C to stop)${RESET}`);
  console.log("");

  setInterval(() => {
    if (requestCount > 0) {
      log(`${DIM}Stats: ${requestCount} requests | ${totalTokens.toLocaleString()} tokens | uptime ${Math.floor(process.uptime())}s${RESET}`);
    }
  }, 300000);
}

main().catch((err) => {
  logErr(`Fatal error: ${err.message}`);
  process.exit(1);
});
