#!/usr/bin/env node

import { Page, Stagehand } from '@browserbasehq/stagehand';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { spawn, ChildProcess, execSync } from 'child_process';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findLocalChrome, prepareChromeProfile, takeScreenshot, getAnthropicApiKey } from './browser-utils.js';
import { getBlockedDomain, actionReferencesBlockedDomain, getRandomCdpPort } from './security.js';
import { z } from 'zod/v4';
import dotenv from 'dotenv';

// Validate ES module environment
if (!import.meta.url) {
  console.error('Error: This script must be run as an ES module');
  console.error('Ensure your package.json has "type": "module" and Node.js version is 14+');
  process.exit(1);
}

// Resolve plugin root directory from script location
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

// Load .env from plugin root directory
dotenv.config({ path: join(PLUGIN_ROOT, '.env'), quiet: true });

const apiKeyResult = getAnthropicApiKey();
if (!apiKeyResult) {
  console.error('Error: No Anthropic API key found.');
  console.error('\n🔑 Export in terminal: export ANTHROPIC_API_KEY="your-api-key"');
  console.error('   Or create a .env file with: ANTHROPIC_API_KEY="your-api-key"');
  process.exit(1);
}
process.env.ANTHROPIC_API_KEY = apiKeyResult.apiKey;

// Persistent browser state
let stagehandInstance: Stagehand | null = null;
let currentPage: Page | null = null;
let chromeProcess: ChildProcess | null = null;
let weStartedChrome = false;

// SECURITY: Random CDP port, persisted for session reuse
const CDP_PORT_FILE = join(PLUGIN_ROOT, '.cdp-port');
function getCdpPort(): number {
  if (existsSync(CDP_PORT_FILE)) {
    try {
      const saved = parseInt(readFileSync(CDP_PORT_FILE, 'utf-8').trim(), 10);
      if (saved > 0) return saved;
    } catch {}
  }
  const port = getRandomCdpPort();
  writeFileSync(CDP_PORT_FILE, String(port));
  return port;
}
const CDP_PORT = getCdpPort();

async function initBrowser(): Promise<{ stagehand: Stagehand }> {
  if (stagehandInstance) {
    return { stagehand: stagehandInstance };
  }

  const chromePath = findLocalChrome();
  if (!chromePath) {
    throw new Error('Could not find Chrome installation');
  }

  const cdpPort = CDP_PORT;
  // PERSISTENT profile -- copied once from user's Chrome, then kept between sessions.
  // This prevents Google logout since the sessions diverge after initial copy.
  const persistentProfileDir = join(PLUGIN_ROOT, '.chrome-profile');

  // Check if Chrome is already running on the CDP port
  let chromeReady = false;
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (response.ok) {
      chromeReady = true;
      console.error('Reusing existing Chrome instance on port', cdpPort);
    }
  } catch {}

  // Launch Chrome if not already running
  if (!chromeReady) {
    chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${persistentProfileDir}`,
      '--window-position=0,0',
      '--window-size=1920,1080',
    ], {
      stdio: 'ignore',
      detached: false,
    });

    if (chromeProcess.pid) {
      writeFileSync(join(PLUGIN_ROOT, '.chrome-pid'), JSON.stringify({
        pid: chromeProcess.pid,
        startTime: Date.now()
      }));
    }

    // Wait for Chrome to be ready
    for (let i = 0; i < 60; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (response.ok) {
          chromeReady = true;
          weStartedChrome = true;
          break;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!chromeReady) {
      throw new Error('Chrome failed to start');
    }
  }

  // Get the WebSocket URL from Chrome's CDP endpoint
  const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const versionData = await versionResponse.json() as { webSocketDebuggerUrl: string };
  const wsUrl = versionData.webSocketDebuggerUrl;

  // Initialize Stagehand
  stagehandInstance = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    model: "anthropic/claude-haiku-4-5-20251001",
    localBrowserLaunchOptions: {
      cdpUrl: wsUrl,
    },
  });

  await stagehandInstance.init();
  currentPage = stagehandInstance.context.pages()[0];

  // Set viewport via CDP for consistent screenshots
  const cdpSession = currentPage.mainFrame().session;
  await cdpSession.send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false
  });

  // Wait for page to be ready
  let retries = 0;
  while (retries < 30) {
    try {
      await currentPage.evaluate('document.readyState');
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
      retries++;
    }
  }

  // Configure downloads
  const downloadsPath = join(PLUGIN_ROOT, 'agent', 'downloads');
  if (!existsSync(downloadsPath)) {
    mkdirSync(downloadsPath, { recursive: true });
  }

  const client = currentPage.mainFrame().session;
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsPath,
    eventsEnabled: true,
  });

  return { stagehand: stagehandInstance };
}

async function closeBrowser() {
  const cdpPort = CDP_PORT;
  const pidFilePath = join(PLUGIN_ROOT, '.chrome-pid');

  if (stagehandInstance) {
    try {
      await stagehandInstance.close();
    } catch (error) {
      console.error('Error closing Stagehand:', error instanceof Error ? error.message : String(error));
    }
    stagehandInstance = null;
    currentPage = null;
  }

  if (chromeProcess && weStartedChrome) {
    try {
      chromeProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (chromeProcess.exitCode === null) {
        chromeProcess.kill('SIGKILL');
      }
    } catch (error) {
      console.error('Error killing Chrome:', error instanceof Error ? error.message : String(error));
    }
    chromeProcess = null;
    weStartedChrome = false;
  }

  // For separate CLI invocations, try graceful CDP shutdown
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      const versionData = await response.json() as { webSocketDebuggerUrl: string };
      const wsUrl = versionData.webSocketDebuggerUrl;

      const tempStagehand = new Stagehand({
        env: "LOCAL",
        verbose: 0,
        model: "anthropic/claude-haiku-4-5-20251001",
        localBrowserLaunchOptions: { cdpUrl: wsUrl },
      });
      await tempStagehand.init();
      await tempStagehand.close();
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Force kill via PID if still running
      try {
        await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (existsSync(pidFilePath)) {
          const { pid } = JSON.parse(readFileSync(pidFilePath, 'utf8'));
          try {
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const { stdout } = await promisify(exec)(`ps -p ${pid} -o comm=`);
            if (stdout.trim().toLowerCase().includes('chrome')) {
              process.kill(pid, 'SIGKILL');
            }
          } catch {}
        }
      } catch {
        // Chrome successfully closed
      }
    }
  } catch {
    // Chrome not running
  } finally {
    if (existsSync(pidFilePath)) {
      try { unlinkSync(pidFilePath); } catch {}
    }
  }
}

// CLI commands
async function navigate(url: string) {
  // SECURITY: Check domain blocklist
  const blockedDomain = getBlockedDomain(url);
  if (blockedDomain) {
    return {
      success: false,
      error: `BLOCKED: Navigation to "${blockedDomain}" is restricted by security policy.`
    };
  }

  try {
    const { stagehand } = await initBrowser();
    const page = stagehand.context.pages()[0];

    await page.goto(url, { waitUntil: 'networkidle', timeoutMs: 30000 }).catch(() => {
      return page.goto(url, { waitUntil: 'domcontentloaded', timeoutMs: 15000 });
    });

    // Wait for JS-heavy pages to render
    await new Promise(resolve => setTimeout(resolve, 3000));

    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return {
      success: true,
      message: `Successfully navigated to ${url}`,
      screenshot: screenshotPath
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function act(action: string) {
  // SECURITY: Check blocklist
  const blockedDomain = actionReferencesBlockedDomain(action);
  if (blockedDomain) {
    return {
      success: false,
      error: `BLOCKED: Action references restricted domain "${blockedDomain}".`
    };
  }

  try {
    const { stagehand } = await initBrowser();
    await stagehand.act(action);
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return { success: true, message: `Successfully performed action: ${action}`, screenshot: screenshotPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function extract(instruction: string, schema?: Record<string, string>) {
  try {
    const { stagehand } = await initBrowser();

    let zodSchemaObject;
    if (schema) {
      try {
        const zodSchema: Record<string, any> = {};
        let hasValidTypes = true;
        for (const [key, type] of Object.entries(schema)) {
          switch (type) {
            case "string": zodSchema[key] = z.string(); break;
            case "number": zodSchema[key] = z.number(); break;
            case "boolean": zodSchema[key] = z.boolean(); break;
            default: hasValidTypes = false; break;
          }
        }
        if (hasValidTypes && Object.keys(zodSchema).length > 0) {
          zodSchemaObject = z.object(zodSchema);
        }
      } catch {}
    }

    const extractOptions: any = { instruction };
    if (zodSchemaObject) extractOptions.schema = zodSchemaObject;

    const result = await stagehand.extract(extractOptions);
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return { success: true, message: `Successfully extracted data: ${JSON.stringify(result)}`, screenshot: screenshotPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function observe(query: string) {
  try {
    const { stagehand } = await initBrowser();
    const actions = await stagehand.observe(query);
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return { success: true, message: `Successfully observed: ${actions}`, screenshot: screenshotPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function screenshot() {
  try {
    const { stagehand } = await initBrowser();
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return { success: true, screenshot: screenshotPath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Main CLI handler
async function main() {
  // Prepare persistent Chrome profile (copies once, keeps between sessions)
  prepareChromeProfile(PLUGIN_ROOT);

  const args = process.argv.slice(2);
  const command = args[0];

  try {
    let result: { success: boolean; [key: string]: any };

    switch (command) {
      case 'navigate':
        if (args.length < 2) throw new Error('Usage: browser navigate <url>');
        result = await navigate(args[1]);
        break;

      case 'act':
        if (args.length < 2) throw new Error('Usage: browser act "<action>"');
        result = await act(args.slice(1).join(' '));
        break;

      case 'extract':
        if (args.length < 2) throw new Error('Usage: browser extract "<instruction>"');
        const instruction = args[1];
        const schema = args[2] ? JSON.parse(args[2]) : undefined;
        result = await extract(instruction, schema);
        break;

      case 'observe':
        if (args.length < 2) throw new Error('Usage: browser observe "<query>"');
        result = await observe(args.slice(1).join(' '));
        break;

      case 'screenshot':
        result = await screenshot();
        break;

      case 'close':
        await closeBrowser();
        if (existsSync(CDP_PORT_FILE)) {
          try { unlinkSync(CDP_PORT_FILE); } catch {}
        }
        // NOTE: .chrome-profile is kept intentionally to prevent Google logout
        result = { success: true, message: 'Browser closed (profile preserved)' };
        break;

      default:
        throw new Error(`Unknown command: ${command}\nAvailable: navigate, act, extract, observe, screenshot, close`);
    }

    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    await closeBrowser();
    console.error(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exit(1);
  }
}

// Handle cleanup
process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch(console.error);
