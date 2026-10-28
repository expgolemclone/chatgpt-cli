import type { BrowserContext } from 'playwright';
import { assertProfileDirectory, readProfileId, type Profile } from './profiles.ts';

export async function launchProfile(profile: Profile): Promise<BrowserContext> {
  assertProfileDirectory(profile.path, true);
  if (profile.id !== undefined && readProfileId(profile.path) !== profile.id) {
    throw new Error('Profile identity changed before launch.');
  }
  const { chromium } = await import('playwright');
  // Chromium owns the profile lock. Never terminate another browser or remove its locks.
  return chromium.launchPersistentContext(profile.path, {
    channel: 'msedge', headless: false, viewport: null, timeout: 30_000,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-features=msImplicitSignin,msEnableWebToBrowserSignIn,msEnableAADWebToBrowserSignIn,msSeamlessWebToBrowserSignIn,msEdgeOnRampImport,msEdgeFRESpartanImportAllowed,msEdgeContinuousMigrationUser'],
  });
}
