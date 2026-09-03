import type { Plugin } from 'vite';

// Emits a tiny classic script into <head>, ahead of the module entry, that does
// the two things the app otherwise cannot start until 255 KB of JavaScript has
// downloaded and parsed:
//
//   1. preloads the shell chunk the viewport is going to ask for. The shell is
//      chosen at runtime (App.tsx: innerWidth < 720 → Mobile, else Desktop), so
//      Vite cannot emit a static modulepreload for it and the browser only
//      discovers the need after executing the entry.
//   2. starts /api/me, /api/lookups and /api/workspace. None of them needs
//      React, and today they wait behind the whole bundle.
//
// The two must ship together: they currently overlap each other, so pulling
// only one of them forward saves very little.
//
// Emitted as a hashed asset rather than inlined. /assets/* is already immutable
// in public/_headers, and the Docker stack's Caddyfile sets `script-src 'self'`
// with no 'unsafe-inline', which an inline tag would trip.

const BOOT_ENDPOINTS = ['/api/me', '/api/lookups', '/api/workspace'];

// Matches App.tsx. Duplicated rather than imported because this file runs in
// the Vite config's context, not the app's.
const PHONE_BREAKPOINT = 720;

const source = (desktop: string[], mobile: string[]): string => `(function () {
  // The vendor and seller portals are different shells reached by URL token,
  // and they talk to /api/public/*. Preloading a shell they will not render and
  // calling endpoints they cannot use would be pure waste.
  if (/^\\/(v|s)\\//.test(location.pathname)) return;

  var shell = window.innerWidth < ${PHONE_BREAKPOINT}
    ? ${JSON.stringify(mobile)}
    : ${JSON.stringify(desktop)};
  for (var i = 0; i < shell.length; i++) {
    var href = shell[i];
    var link = document.createElement('link');
    var isCss = href.slice(-4) === '.css';
    link.rel = isCss ? 'preload' : 'modulepreload';
    if (isCss) link.as = 'style';
    link.href = href;
    document.head.appendChild(link);
  }

  // Speculative: a 401 resolves to null and the consumer falls back to the
  // normal api.get path, which refreshes and retries. Parked as the parsed-JSON
  // promise, not the Response, because a Response body can only be read once.
  var boot = {};
  ${JSON.stringify(BOOT_ENDPOINTS)}.forEach(function (url) {
    boot[url] = fetch(url, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  });
  window.__boot = boot;
})();
`;

export function bootPlugin(): Plugin {
  let fileName: string | null = null;

  return {
    name: 'recycle-erp-boot',
    apply: 'build',

    // emitFile needs a plugin context, which transformIndexHtml is not given —
    // Vite calls that hook as a bare function, so `this` is undefined there.
    // Hence the split: build the asset here, inject the tag there. User plugins'
    // generateBundle runs before vite:build-html's, so the name is ready in time.
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(
        (c) => c.type === 'chunk' && c.isEntry,
      );
      const entryOwns = new Set<string>(
        entry && entry.type === 'chunk' ? [entry.fileName, ...entry.imports] : [],
      );

      const shellFor = (suffix: string): string[] => {
        const chunk = Object.values(bundle).find(
          (c) => c.type === 'chunk' && c.facadeModuleId?.endsWith(suffix),
        );
        if (!chunk || chunk.type !== 'chunk') return [];
        // The facade alone is not enough — its own static imports and CSS are
        // still a hop behind it, which is the hop this exists to remove.
        const css = [...(chunk.viteMetadata?.importedCss ?? [])];
        return [chunk.fileName, ...chunk.imports, ...css]
          .filter((f) => !entryOwns.has(f))
          .map((f) => '/' + f);
      };

      const desktop = shellFor('/DesktopApp.tsx');
      const mobile = shellFor('/MobileApp.tsx');
      // Nothing to preload means the shells were not found — a rename, most
      // likely. Skip rather than ship a script that only does half its job
      // silently.
      if (desktop.length === 0 || mobile.length === 0) {
        this.warn('boot: shell chunks not found; skipping the boot script');
        return;
      }

      const ref = this.emitFile({
        type: 'asset',
        name: 'boot.js',
        source: source(desktop, mobile),
      });
      fileName = this.getFileName(ref);
    },

    transformIndexHtml: {
      order: 'post',
      handler() {
        // Dev never runs generateBundle, so nothing is injected and every
        // consumer falls back to its existing api.get path.
        if (!fileName) return;
        return [{
          tag: 'script',
          attrs: { src: '/' + fileName },
          injectTo: 'head-prepend' as const,
        }];
      },
    },
  };
}
