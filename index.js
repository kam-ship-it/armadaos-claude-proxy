#!/usr/bin/env node

/**
 * armadaos-claude-proxy
 * 
 * Connects your Claude Max/Pro subscription to ArmadaOS.
 * Reads your Claude Code OAuth token and exposes a local API proxy
 * that ArmadaOS can connect to via tunnel URL.
 * 
 * Usage:
 *   npx armadaos-claude-proxy
 *   # Then run: ngrok http 3456
 *   # Paste the ngrok URL into ArmadaOS Settings → Compute → Claude Max
 * 
 * How it works:
 *   1. Reads your Claude Code OAuth token from ~/.claude.json or macOS Keychain
 *   2. Starts a local HTTP server on port 3456
 *   3. Proxies OpenAI-compatible /v1/chat/completions requests to Anthropic's API
 *   4. ArmadaOS connects via your ngrok tunnel URL
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '3456', 10);
const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';

// ─── Token Resolution ───────────────────────────────────────────────────────

function getTokenFromEnv() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;
}

function getTokenFromClaudeJson() {
  const claudeJsonPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude.json');
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    // Claude Code stores OAuth in various formats — check common paths
    if (data.oauthAccessToken) return data.oauthAccessToken;
    if (data.oauth && data.oauth.accessToken) return data.oauth.accessToken;
    if (data.accessToken) return data.accessToken;
    // Check for credentials object
    if (data.credentials && data.credentials.accessToken) return data.credentials.accessToken;
  } catch (e) {
    // File doesn't exist or isn't valid JSON
  }
  return null;
}

function getTokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const token = execSync(
      'security find-generic-password -s "claude-code-credentials" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (token) {
      // Keychain may store a JSON blob
      try {
        const parsed = JSON.parse(token);
        return parsed.accessToken || parsed.oauthAccessToken || parsed.token || token;
      } catch {
        return token;
      }
    }
  } catch (e) {
    // Keychain item not found
  }
  return null;
}

function resolveToken() {
  // Priority: env var > ~/.claude.json > macOS Keychain
  let token = getTokenFromEnv();
  if (token) {
    console.log('✓ Using token from CLAUDE_CODE_OAUTH_TOKEN environment variable');
    return token;
  }

  token = getTokenFromClaudeJson();
  if (token) {
    console.log('✓ Using token from ~/.claude.json');
    return token;
  }

  token = getTokenFromKeychain();
  if (token) {
    console.log('✓ Using token from macOS Keychain');
    return token;
  }

  return null;
}

// ─── Model Mapping ──────────────────────────────────────────────────────────

// Map OpenAI-style model names to Anthropic model IDs
const MODEL_MAP = {
  // Direct Anthropic model names pass through
  'claude-sonnet-4-5-20250514': 'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-opus-4-20250514': 'claude-opus-4-20250514',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet-20241022': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
};

function resolveModel(requestedModel) {
  if (!requestedModel) return 'claude-sonnet-4-5-20250514';
  // Direct match
  if (MODEL_MAP[requestedModel]) return MODEL_MAP[requestedModel];
  // Partial match
  const lower = requestedModel.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return value;
  }
  // Pass through as-is (Anthropic will validate)
  return requestedModel;
}

// ─── Request Translation ────────────────────────────────────────────────────

function openaiToAnthropic(openaiBody) {
  const model = resolveModel(openaiBody.model);
  const messages = openaiBody.messages || [];
  
  // Extract system message
  let system = undefined;
  const nonSystemMessages = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      system = (system ? system + '\n\n' : '') + msg.content;
    } else {
      nonSystemMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  // Ensure messages alternate user/assistant (Anthropic requirement)
  // If first message isn't user, prepend a user message
  if (nonSystemMessages.length > 0 && nonSystemMessages[0].role !== 'user') {
    nonSystemMessages.unshift({ role: 'user', content: 'Continue.' });
  }

  const anthropicBody = {
    model,
    messages: nonSystemMessages,
    max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || 4096,
  };

  if (system) anthropicBody.system = system;
  if (openaiBody.temperature !== undefined) anthropicBody.temperature = openaiBody.temperature;
  if (openaiBody.top_p !== undefined) anthropicBody.top_p = openaiBody.top_p;
  if (openaiBody.stop) anthropicBody.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];

  return anthropicBody;
}

function anthropicToOpenai(anthropicResponse, model) {
  const content = anthropicResponse.content || [];
  const textParts = content.filter(c => c.type === 'text').map(c => c.text);
  
  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: textParts.join(''),
      },
      finish_reason: anthropicResponse.stop_reason === 'end_turn' ? 'stop' : 
                     anthropicResponse.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Available Models Endpoint ──────────────────────────────────────────────

function getAvailableModels() {
  return {
    object: 'list',
    data: [
      { id: 'claude-sonnet-4-5-20250514', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-3-5-haiku-20241022', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-3-opus-20240229', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-3-haiku-20240307', object: 'model', created: 1700000000, owned_by: 'anthropic' },
    ],
  };
}

// ─── Server ─────────────────────────────────────────────────────────────────

async function handleRequest(req, res, token) {
  // CORS headers for ArmadaOS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url;

  // Health check
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', provider: 'claude', proxy: 'armadaos-claude-proxy' }));
    return;
  }

  // Models list (for ArmadaOS model discovery)
  if (url === '/v1/models' || url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAvailableModels()));
    return;
  }

  // Chat completions
  if ((url === '/v1/chat/completions' || url === '/chat/completions') && req.method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const openaiBody = JSON.parse(rawBody);
      const anthropicBody = openaiToAnthropic(openaiBody);

      console.log(`→ ${anthropicBody.model} | ${anthropicBody.messages.length} messages`);

      const requestBody = JSON.stringify(anthropicBody);
      const response = await makeRequest(
        `${ANTHROPIC_API_URL}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': token,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
        },
        requestBody
      );

      if (response.statusCode !== 200) {
        console.error(`✗ Anthropic API error: ${response.statusCode}`);
        console.error(response.body);
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Anthropic API error: ${response.statusCode}`, details: response.body } }));
        return;
      }

      const anthropicResponse = JSON.parse(response.body);
      const openaiResponse = anthropicToOpenai(anthropicResponse, anthropicBody.model);

      console.log(`✓ ${openaiResponse.usage.total_tokens} tokens`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openaiResponse));
    } catch (err) {
      console.error('✗ Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Not found' } }));
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     ArmadaOS Claude Proxy v1.0.0        ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  const token = resolveToken();

  if (!token) {
    console.error('');
    console.error('  ✗ No Claude OAuth token found.');
    console.error('');
    console.error('  To fix this, do ONE of the following:');
    console.error('');
    console.error('  Option 1: Log in with Claude Code first');
    console.error('    $ npm install -g @anthropic-ai/claude-code');
    console.error('    $ claude login');
    console.error('    $ npx armadaos-claude-proxy');
    console.error('');
    console.error('  Option 2: Set the token manually');
    console.error('    $ export CLAUDE_CODE_OAUTH_TOKEN="your-token-here"');
    console.error('    $ npx armadaos-claude-proxy');
    console.error('');
    console.error('  Option 3 (macOS): Extract from Keychain');
    console.error('    $ security find-generic-password -s "claude-code-credentials" -w');
    console.error('    $ export CLAUDE_CODE_OAUTH_TOKEN="<paste-token>"');
    console.error('    $ npx armadaos-claude-proxy');
    console.error('');
    process.exit(1);
  }

  const server = http.createServer((req, res) => handleRequest(req, res, token));

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`  ✓ Proxy running on http://localhost:${PORT}`);
    console.log('');
    console.log('  Next steps:');
    console.log(`    1. In a new terminal: ngrok http ${PORT}`);
    console.log('    2. Copy the https://... URL from ngrok');
    console.log('    3. Paste it into ArmadaOS → Settings → Compute → Claude Max');
    console.log('    4. Click Connect');
    console.log('');
    console.log('  Endpoints:');
    console.log(`    GET  http://localhost:${PORT}/health          → Health check`);
    console.log(`    GET  http://localhost:${PORT}/v1/models        → Available models`);
    console.log(`    POST http://localhost:${PORT}/v1/chat/completions → Chat (OpenAI format)`);
    console.log('');
    console.log('  Waiting for requests...');
    console.log('');
  });
}

main();
