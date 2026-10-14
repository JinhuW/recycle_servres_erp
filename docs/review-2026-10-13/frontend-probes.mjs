// Read-only reproductions against current source. Run from the repository root:
// node docs/review-2026-10-13/frontend-probes.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript');

// Old callbacks must be judged against the current parent's state, not just
// the captured render's phase. Execute the actual handoff after replacing it.
const cameraContext = {
  capture: { phase: 'camera', lines: [], category: 'RAM', draftId: 'PO-A' },
  setCapture(next) { this.capture = typeof next === 'function' ? next(this.capture) : next; },
  findDuplicateLine: () => null,
};
// Arrow callbacks below do not bind `this`; match React's setter signature.
cameraContext.setCapture = next => { cameraContext.capture = typeof next === 'function' ? next(cameraContext.capture) : next; };
const abandonedCamera = bind('apps/frontend/src/MobileApp.tsx', ['onDetected'], cameraContext);
cameraContext.capture = { phase: 'camera', lines: [], category: 'SSD', draftId: 'PO-B' };
abandonedCamera.onDetected({ extracted: { partNumber: 'OLD-RAM' } });
assert.equal(cameraContext.capture.draftId, 'PO-B');
assert.equal(cameraContext.capture.phase, 'form');
assert.equal(cameraContext.capture.detected.extracted.partNumber, 'OLD-RAM');
console.log('CONFIRMED: abandoned camera callback applies its result to the later camera capture.');

const metadataContext = {
  id: 'internal-record', title: 'unsaved new title', note: 'unsaved new note', dirty: true,
  useCallback: fn => fn,
  api: { get: async () => ({ title: 'server title', note: 'server note' }), post: async () => ({}) },
  setRec: () => {}, setAdding: () => {}, onChanged: () => {},
  handleFetchError: error => { throw error; },
};
metadataContext.setTitle = value => { metadataContext.title = value; };
metadataContext.setNote = value => { metadataContext.note = value; };
metadataContext.setDirty = value => { metadataContext.dirty = value; };
const metadata = bind('apps/frontend/src/pages/desktop/DesktopInternalTxns.tsx', ['load', 'addMember'], metadataContext);
await metadata.addMember('payment');
await Promise.resolve();
assert.equal(metadataContext.note, 'server note');
assert.equal(metadataContext.title, 'server title');
assert.equal(metadataContext.dirty, false);
console.log('CONFIRMED: adding a payment reloads and discards unsaved internal-record metadata.');

function sourceNode(file, name) {
  const source = fs.readFileSync(file, 'utf8');
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let found;
  const visit = n => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name?.getText(root) === name) found = n;
    ts.forEachChild(n, visit);
  };
  visit(root);
  assert.ok(found, `${file}: ${name} exists`);
  return ts.isVariableDeclaration(found) ? `const ${found.getText(root)};` : found.getText(root).replace(/^export /, '');
}
function compile(source) {
  return ts.transpileModule(source, { fileName: 'probe.tsx', compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
}
function bind(file, names, context = {}) {
  return Function('context', `with(context) { ${compile(names.map(n => sourceNode(file, n)).join('\n'))}; return {${names.join(',')}}; }`)(context);
}

const route = bind('apps/frontend/src/lib/route.ts', ['splitHash', 'readPath'], { window: { location: { hash: '', pathname: '/inventory' } } });
assert.equal(route.readPath(), '/');
console.log('CONFIRMED: real /inventory cold load resolves / (Dashboard).');
assert.throws(() => Response.redirect('/share-target?via=sw', 303), TypeError);
console.log('CONFIRMED: current share-target redirect throws TypeError for relative URL.');

const { toAddLine, buildOrderSubmit } = bind('apps/frontend/src/lib/orderSubmit.ts', ['toAddLine', 'buildOrderSubmit']);
const calls = [];
let release;
const write = new Promise(resolve => { release = resolve; });
const line = { _cid: 'client-new', category: 'SSD', brand: 'Mixed', qty: 1, unitCost: 5, partNumber: 'SSD1' };
const context = {
  capture: { phase: 'form', category: 'SSD', lines: [], draftId: 'PO-PENDING' },
  captureGen: { current: 0 },
  setCapture(next) { context.capture = typeof next === 'function' ? next(context.capture) : next; },
  api: {
    patch(url, body) { calls.push({ url, body }); return calls.length === 1 ? write : Promise.resolve({}); },
  },
  lineSyncBlock: () => null, toAddLine, buildOrderSubmit,
  flushLinePhotos: async () => {}, showToast: () => {}, t: s => s,
  navigate: () => {}, handleFetchError: () => {},
};
const mobile = bind('apps/frontend/src/MobileApp.tsx', ['onSaveLine', 'submitOrder'], context);
const saving = mobile.onSaveLine(line);
assert.equal(context.capture.phase, 'review');
await mobile.submitOrder();
assert.equal(calls.length, 2);
assert.equal(calls[0].url, calls[1].url);
assert.deepEqual(calls[0].body.addLines, calls[1].body.addLines);
release({ addedLineIds: ['line-new'], addedLineNos: [1] });
await saving;
console.log('CONFIRMED: actual mobile callbacks append identical line twice when Submit precedes autosave completion.');

const existing = { ...line, id: 'line-saved', _confirmed: true, unitCost: 7 };
context.capture = { phase: 'form', category: 'SSD', lines: [{ ...existing, unitCost: 5 }], editingLineIdx: 0, draftId: 'PO-PENDING' };
context.api.patch = async () => { throw new Error('simulated temporary failure'); };
await mobile.onSaveLine(existing);
assert.equal(context.capture.phase, 'review');
assert.equal(context.capture.lines[0].unitCost, 7);
assert.equal(buildOrderSubmit(context.capture).kind, 'noop');
console.log('CONFIRMED: failed edit of confirmed draft line remains changed locally but final submission is noop.');

const { forEachKeysetPage } = bind('apps/frontend/src/lib/keysetPages.ts', ['forEachKeysetPage']);
let pages = 0, displayed = 0, reportedDone = false;
await forEachKeysetPage(async () => { pages++; return { items: [pages], nextCursor: String(pages) }; }, (items, meta) => { displayed += items.length; reportedDone = meta.done; });
assert.equal(pages, 25);
assert.equal(displayed, 25);
assert.equal(reportedDone, true);
console.log('CONFIRMED: keyset walker reports done at page 25 despite non-null nextCursor.');

// A tiny hook scheduler executes the real DesktopApp function and its effects.
// JSX components are inert elements; no browser, API server or React renderer
// is needed to verify which order data the shell passes into the edit page.
const slots = [], effects = [];
let cursor = 0, pendingEffects = [], fetches = 0;
const oldOrder = { id: 'PO-PRIVATE', userId: 'manager-a', notes: 'private seller information' };
const noop = () => {};
const desktopContext = {
  currentUser: { id: 'manager-a', role: 'manager' },
  window: { location: { search: '' } },
  document: { body: { classList: { add: noop, remove: noop } } },
  React: { createElement: (type, props, ...children) => ({ type, props, children }) },
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
  },
  useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useEffect(fn, deps) {
    const index = cursor++;
    const before = effects[index];
    if (!before || deps.some((d, i) => d !== before[i])) { effects[index] = deps; pendingEffects.push(fn); }
  },
  useCallback: fn => fn,
  useAuth: () => ({ loading: false, user: desktopContext.currentUser, pendingRoleChoice: false }),
  useEffectiveUser: () => desktopContext.currentUser,
  useT: () => ({ t: noop }),
  useErrorDialogQueue: () => ({ current: null, push: noop, dismiss: noop }),
  usePreference: () => [false, noop],
  useRoute: () => ({ path: '/purchase-orders/PO-PRIVATE' }),
  pathToDesktopView: () => 'history',
  match: () => null, parseShippingRoute: () => null, matchPoCheck: () => null,
  matchPurchaseOrder: () => ({ id: 'PO-PRIVATE', screen: 'info' }),
  readSafeNext: () => null, isAuthorizePath: () => false,
  navigate: noop, showErrorDialog: noop,
  api: { get: async () => { fetches++; return { order: oldOrder }; } },
};
for (const name of ['DesktopInventory', 'DesktopEditOrder', 'FormSkeleton', 'DesktopOrders', 'Login', 'RolePicker', 'Sidebar', 'Topbar', 'RolePreviewBanner', 'Suspense', 'TweaksPanel']) desktopContext[name] = name;
const { DesktopApp } = bind('apps/frontend/src/DesktopApp.tsx', ['DesktopApp'], desktopContext);
const render = () => { cursor = 0; const output = DesktopApp(); const queued = pendingEffects; pendingEffects = []; queued.forEach(fn => fn()); return output; };
render();
await Promise.resolve();
render();
assert.equal(fetches, 1);
desktopContext.currentUser = null;
assert.equal(render().type, 'Login');
desktopContext.currentUser = { id: 'purchaser-b', role: 'purchaser' };
const find = n => n?.type === 'DesktopEditOrder' ? n : n?.children?.map(find).find(Boolean);
assert.equal(find(render()).props.order.notes, oldOrder.notes);
assert.equal(fetches, 1);
console.log('CONFIRMED: actual desktop shell gives previous manager PO data to a different logged-in purchaser without refetch.');

const preferenceSlots = [], preferenceEffects = [], timers = [];
let preferenceCursor = 0, preferencePending = [];
const writes = [];
const preferenceContext = {
  React: desktopContext.React,
  PreferencesCtx: { Provider: 'PreferencesProvider' },
  readCache: () => ({}), writeCache: noop,
  PATCH_DEBOUNCE_MS: 400,
  currentUser: { id: 'manager-a', preferences: { 'tweaks.density': 'comfortable' } },
  useAuth: () => ({ user: preferenceContext.currentUser }),
  useState(initial) {
    const index = preferenceCursor++;
    if (!(index in preferenceSlots)) preferenceSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [preferenceSlots[index], next => { preferenceSlots[index] = typeof next === 'function' ? next(preferenceSlots[index]) : next; }];
  },
  useRef(initial) { const index = preferenceCursor++; return preferenceSlots[index] ??= { current: initial }; },
  useEffect(fn, deps) {
    const index = preferenceCursor++;
    const before = preferenceEffects[index];
    if (!before || deps.some((d, i) => d !== before[i])) { preferenceEffects[index] = deps; preferencePending.push(fn); }
  },
  useCallback: fn => fn, useMemo: fn => fn(),
  window: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout: noop },
  console,
  api: { patch: (_url, body) => new Promise(resolve => { writes.push({ body, resolve }); }) },
};
const { PreferencesProvider } = bind('apps/frontend/src/lib/preferences.tsx', ['PreferencesProvider'], preferenceContext);
const renderPreferences = () => { preferenceCursor = 0; const output = PreferencesProvider({ children: null }); const queued = preferencePending; preferencePending = []; queued.forEach(fn => fn()); return output.props.value; };
renderPreferences();
renderPreferences().setPref('tweaks.density', 'compact');
timers.at(-1)();
renderPreferences().setPref('tweaks.density', 'comfortable');
timers.at(-1)();
assert.equal(writes.length, 2);
writes[1].resolve({ user: { preferences: { 'tweaks.density': 'comfortable' } } });
await Promise.resolve();
writes[0].resolve({ user: { preferences: { 'tweaks.density': 'compact' } } });
await Promise.resolve();
assert.equal(renderPreferences().prefs['tweaks.density'], 'compact');
console.log('CONFIRMED: actual preference provider replaces latest choice with an older delayed response.');
renderPreferences().setPref('tweaks.rolePreview', 'as_purchaser');
timers.at(-1)();
preferenceContext.currentUser = { id: 'purchaser-b', preferences: { 'tweaks.density': 'comfortable' } };
renderPreferences();
assert.equal(renderPreferences().prefs['tweaks.density'], 'comfortable');
writes[2].resolve({ user: { preferences: { 'tweaks.density': 'compact', 'tweaks.rolePreview': 'as_purchaser' } } });
await Promise.resolve();
assert.equal(renderPreferences().prefs['tweaks.rolePreview'], 'as_purchaser');
console.log('CONFIRMED: old-user delayed preference response replaces different signed-in user preferences.');
