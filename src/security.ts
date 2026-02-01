import { existsSync, rmSync } from 'fs';

// ============================================================
// SECURITY MODULE - Mundi Princeps hardening for agent-browse
// ============================================================

// Blocked domains - the agent will refuse to navigate here.
// Add or remove domains as needed.
const BLOCKED_DOMAINS: string[] = [
  // Banking & Finance
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'citibank.com',
  'capitalone.com',
  'usbank.com',
  'pnc.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
  'tdameritrade.com',
  'etrade.com',
  'robinhood.com',
  'coinbase.com',
  'binance.com',
  'kraken.com',
  'paypal.com',
  'venmo.com',
  'zelle.com',
  'wise.com',
  'mercury.com',
  'brex.com',
  'stripe.com/dashboard',

  // Email
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.yahoo.com',
  'proton.me',
  'protonmail.com',

  // Healthcare
  'mychart.com',
  'mychartonline.com',
  'portal.anthem.com',
  'uhc.com',
  'cigna.com',
  'aetna.com',
  'kaiser.permanente.org',

  // Sensitive accounts
  'irs.gov',
  'ssa.gov',
  'id.me',
  'login.gov',
];

// Files to exclude when copying the Chrome profile
export const PROFILE_EXCLUDED_FILES: string[] = [
  'Login Data',
  'Login Data-journal',
  'Login Data For Account',
  'Login Data For Account-journal',
  'Web Data',             // Autofill data (credit cards, addresses)
  'Web Data-journal',
];

/**
 * Check if a URL targets a blocked domain.
 * Returns the matched domain if blocked, or null if allowed.
 */
export function getBlockedDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const fullPath = hostname + parsed.pathname;

    for (const domain of BLOCKED_DOMAINS) {
      // Support path-level blocks (e.g. "stripe.com/dashboard")
      if (domain.includes('/')) {
        if (fullPath.includes(domain)) return domain;
      } else {
        if (hostname === domain || hostname.endsWith('.' + domain)) return domain;
      }
    }
  } catch {
    // If URL can't be parsed, allow it (might be a relative URL or action string)
  }
  return null;
}

/**
 * Check if an action string references a blocked domain.
 * This is a heuristic check for act() commands that might contain URLs.
 */
export function actionReferencesBlockedDomain(action: string): string | null {
  const urlPattern = /https?:\/\/[^\s"'<>]+/gi;
  const urls = action.match(urlPattern);
  if (urls) {
    for (const url of urls) {
      const blocked = getBlockedDomain(url);
      if (blocked) return blocked;
    }
  }
  return null;
}

/**
 * Generate a random high port for CDP (between 10000-65000).
 * Avoids the well-known 9222.
 */
export function getRandomCdpPort(): number {
  return Math.floor(Math.random() * 55000) + 10000;
}

/**
 * Clean up the .chrome-profile directory.
 * Called on session end to prevent credentials persisting on disk.
 */
export function cleanupChromeProfile(profileDir: string): boolean {
  try {
    if (existsSync(profileDir)) {
      rmSync(profileDir, { recursive: true, force: true });
      return true;
    }
  } catch (error) {
    console.error('Warning: Failed to clean up chrome profile:', error instanceof Error ? error.message : String(error));
  }
  return false;
}

/**
 * Get the current blocked domains list (for documentation/logging).
 */
export function getBlockedDomains(): readonly string[] {
  return BLOCKED_DOMAINS;
}

/**
 * Add a domain to the blocklist at runtime.
 */
export function addBlockedDomain(domain: string): void {
  const normalized = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!BLOCKED_DOMAINS.includes(normalized)) {
    BLOCKED_DOMAINS.push(normalized);
  }
}

/**
 * Remove a domain from the blocklist at runtime.
 */
export function removeBlockedDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const index = BLOCKED_DOMAINS.indexOf(normalized);
  if (index !== -1) {
    BLOCKED_DOMAINS.splice(index, 1);
    return true;
  }
  return false;
}
