import { describe, it, expect } from 'vitest';
import { fbSellerTabPath, fbSellerThreadPath, matchFbSellerRoute, pathToDesktopView } from './route';

describe('Leads ▸ Facebook routes', () => {
  it('opens Needs human at the root and every tab beside it', () => {
    expect(pathToDesktopView('/leads/facebook')).toBe('leadsFacebook');
    expect(matchFbSellerRoute('/leads/facebook')).toEqual({ kind: 'tab', tab: 'needs' });
    for (const tab of ['inbox', 'ads', 'photos', 'agent', 'settings'] as const) {
      expect(fbSellerTabPath(tab)).toBe(`/leads/facebook/${tab}`);
      expect(matchFbSellerRoute(fbSellerTabPath(tab))).toEqual({ kind: 'tab', tab });
      expect(pathToDesktopView(fbSellerTabPath(tab))).toBe('leadsFacebook');
    }
    expect(fbSellerTabPath('needs')).toBe('/leads/facebook');
  });

  it('opens a thread by its numeric id, and nothing else', () => {
    expect(matchFbSellerRoute(fbSellerThreadPath(42))).toEqual({ kind: 'thread', id: 42 });
    expect(pathToDesktopView('/leads/facebook/thread/42')).toBe('leadsFacebook');
    expect(matchFbSellerRoute('/leads/facebook/thread/abc')).toBeNull();
    expect(matchFbSellerRoute('/leads/facebook/nope')).toBeNull();
    expect(pathToDesktopView('/leads/facebook/nope')).toBe('home');
  });
});
