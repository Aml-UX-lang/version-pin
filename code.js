// Version Pin — Figma plugin main thread.
// Keeps every version of a screen (frame) or of a whole page in the file, and makes the final one
// unmistakable for developers: canvas badges, page names, page banners, Dev Mode "Ready for dev",
// a Dev Mode inspect panel, "Being built" tracking, and Slack / Teams messages.

const NS = 'versionpin';
const ARCHIVE_PAGE = 'Version archive';
// Bump when badges or banners change look, so files are redrawn automatically on next open.
const DECOR_VERSION = '4';
const isDev = figma.editorType === 'dev';

const STATUS_LABEL = { draft: 'DRAFT', review: 'IN REVIEW', final: 'FINAL', superseded: 'SUPERSEDED' };
const STATUS_RGB = {
  draft: { r: 0.42, g: 0.45, b: 0.5 },
  review: { r: 0.8, g: 0.5, b: 0.05 },
  final: { r: 0.07, g: 0.5, b: 0.29 },
  superseded: { r: 0.65, g: 0.22, b: 0.23 },
  old: { r: 0.65, g: 0.22, b: 0.23 },
};
const PAGE_PREFIX = { final: '✅ FINAL – ', review: '🟠 IN REVIEW – ', draft: '✏️ DRAFT – ', old: '⛔ OLD – ' };
const PAGE_PREFIX_RE = /^(✅ FINAL|🟠 IN REVIEW|✏️ DRAFT|⛔ OLD) – /;
const PAGE_WORD = { final: 'FINAL', review: 'IN REVIEW', draft: 'DRAFT', old: 'OLD' };

let settings = {
  badges: true, dim: true, rename: true, devStatus: true, // frames
  badgePlace: 'above', badgeGap: 48, // badge position
  pageNames: true, pageBanners: true, dimOldPages: true, // pages
};

figma.showUI(__html__.replace("__VP_MODE='demo'", "__VP_MODE='figma'"), { width: 360, height: 640, themeColors: true });

// ---------- helpers ----------
const get = (n, k) => n.getSharedPluginData(NS, k);
const put = (n, k, v) => n.setSharedPluginData(NS, k, v == null ? '' : String(v));
function userName() {
  try { return figma.currentUser ? figma.currentUser.name : 'Someone'; } catch (e) { return 'Someone'; }
}
const isBadge = (n) => get(n, 'isBadge') === '1';
const isBanner = (n) => get(n, 'isBanner') === '1';
const isDivider = (p) => get(p, 'isDivider') === '1' || !!p.isPageDivider;
const isCopy = (n) => get(n, 'nodeId') !== n.id; // plugin data travels with duplicates
const baseName = (name) => name.replace(/\s·\sv\d+.*$/, '').trim();
const pageBase = (name) => name.replace(PAGE_PREFIX_RE, '');
const uid = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const toast = (text) => figma.ui.postMessage({ type: 'toast', text });
const realPages = () => figma.root.children.filter((p) => !isDivider(p));

function pageOf(n) {
  let c = n;
  while (c && c.type !== 'PAGE') c = c.parent;
  return c;
}
function trackedAncestor(n) {
  let c = n;
  while (c && c.type !== 'PAGE' && c.type !== 'DOCUMENT') {
    if (get(c, 'group')) return c;
    c = c.parent;
  }
  return null;
}
function topLevel(n) {
  let c = n;
  while (c.parent && c.parent.type !== 'PAGE' && c.parent.type !== 'SECTION') c = c.parent;
  return c;
}
function stamp(n) {
  put(n, 'updatedBy', userName());
  put(n, 'updatedAt', new Date().toISOString());
}
function builders(n) {
  try { return JSON.parse(get(n, 'building') || '[]'); } catch (e) { return []; }
}
function names(list) {
  return list.map((b) => b.name).join(', ');
}

function findByKey(key) {
  try {
    return figma.root.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: [key] } });
  } catch (e) {
    // Older Figma versions: fall back to a full scan.
    return figma.root.findAll((n) => n.getSharedPluginData(NS, key) !== '');
  }
}
async function allTracked() {
  return findByKey('group').filter((n) => get(n, 'group') && !isBadge(n));
}
async function groupNodes(groupId) {
  return (await allTracked()).filter((n) => get(n, 'group') === groupId);
}

// ---------- notifications (Slack / Teams) ----------
function getNotify() {
  let cfg = {};
  try { cfg = JSON.parse(figma.root.getPluginData('notify') || '{}'); } catch (e) {}
  return Object.assign({ slack: '', teams: '', onFrames: true, onPages: true }, cfg);
}
// A text hyperlink to a node. With the file link available it opens the exact page or frame
// (also from Dev Mode); otherwise Figma's own node link is used.
function linkFor(node) {
  const url = linkTo(node.id);
  return url ? { type: 'URL', value: url } : { type: 'NODE', value: node.id };
}
function linkTo(id) {
  return figma.fileKey ? `https://www.figma.com/design/${figma.fileKey}/?node-id=${encodeURIComponent(id.replace(':', '-'))}` : '';
}
function notify(kind, text, id) {
  const cfg = getNotify();
  if (!cfg.slack && !cfg.teams) return;
  if (kind === 'frame' && !cfg.onFrames) return;
  if (kind === 'page' && !cfg.onPages) return;
  figma.ui.postMessage({ type: 'notify', text, url: linkTo(id), slack: cfg.slack, teams: cfg.teams });
}

// ---------- "being built" watch list (stored on this person's computer) ----------
async function getWatch() {
  return (await figma.clientStorage.getAsync('watch')) || [];
}
async function alerts() {
  const out = [];
  for (const w of await getWatch()) {
    const n = await figma.getNodeByIdAsync(w.id);
    if (!n || n.removed) {
      out.push({ id: w.id, kind: w.kind, text: `“${w.label}” was deleted from the file.` });
      continue;
    }
    if (w.kind === 'frame') {
      const st = get(n, 'status');
      if (st === 'final' || st === w.status) continue;
      const fin = (await groupNodes(get(n, 'group'))).find((s) => get(s, 'status') === 'final' && !isCopy(s));
      out.push({
        id: w.id, kind: 'frame',
        text: fin
          ? `You're building ${get(n, 'groupName')} v${get(n, 'version')}. v${get(fin, 'version')} is now the final version.`
          : `${get(n, 'groupName')} v${get(n, 'version')}, which you're building, is no longer final.`,
        finalId: fin ? fin.id : null, finalLabel: fin ? 'v' + get(fin, 'version') : null, note: fin ? get(fin, 'note') : '',
      });
    } else {
      const st = get(n, 'pstatus');
      if (st === 'final' || st === w.status) continue;
      const fp = get(n, 'finalPage') ? await figma.getNodeByIdAsync(get(n, 'finalPage')) : null;
      out.push({
        id: w.id, kind: 'page',
        text: `The page “${pageBase(n.name)}” you're building is now ${st ? PAGE_WORD[st].toLowerCase() : 'unmarked'}.${fp ? ` The final page is “${pageBase(fp.name)}”.` : ''}`,
        finalId: fp ? fp.id : null, finalLabel: fp ? pageBase(fp.name) : null, note: fp ? get(fp, 'note') : '',
      });
    }
  }
  return out;
}

async function setBuilding(id, on) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return;
  const me = userName();
  const kind = n.type === 'PAGE' ? 'page' : 'frame';
  const list = builders(n).filter((b) => b.name !== me);
  if (on) list.push({ name: me, since: new Date().toISOString(), version: kind === 'frame' ? +get(n, 'version') : null });
  let shared = true;
  try { put(n, 'building', JSON.stringify(list)); } catch (e) { shared = false; }

  let watch = (await getWatch()).filter((w) => w.id !== id);
  if (on) {
    watch.push({
      id, kind, at: Date.now(),
      status: kind === 'page' ? get(n, 'pstatus') : get(n, 'status'),
      label: kind === 'page' ? pageBase(n.name) : `${get(n, 'groupName')} v${get(n, 'version')}`,
    });
  }
  await figma.clientStorage.setAsync('watch', watch);

  if (!isDev && kind === 'frame') await decorateGroup(get(n, 'group'));
  if (!shared) toast("Saved on your computer only. Figma didn't let the plugin write to this file, so ask the designer to add you.");
  else toast(on ? "Marked as being built by you. You'll get an alert here if it changes." : 'Removed you from the builders.');
}

async function unwatch(id) {
  await figma.clientStorage.setAsync('watch', (await getWatch()).filter((w) => w.id !== id));
}

// ---------- state for the UI ----------
function readMeta(n) {
  return {
    id: n.id, name: n.name, version: +get(n, 'version') || 0, status: get(n, 'status') || 'draft',
    note: get(n, 'note'), updatedBy: get(n, 'updatedBy'), updatedAt: get(n, 'updatedAt'),
    page: pageBase((pageOf(n) || {}).name || ''), isCopy: isCopy(n), building: builders(n),
  };
}
function pageMeta(p, archived) {
  return {
    id: p.id, name: p.name, base: pageBase(p.name), status: get(p, 'pstatus'), finalPage: get(p, 'finalPage'),
    note: get(p, 'note'), building: builders(p), updatedBy: get(p, 'updatedBy'), updatedAt: get(p, 'updatedAt'),
    divider: isDivider(p), archived: !!archived, current: p === figma.currentPage,
  };
}
function pagesState() {
  let afterDivider = false;
  return figma.root.children.map((p) => {
    if (get(p, 'isDivider') === '1') afterDivider = true;
    return pageMeta(p, afterDivider && !isDivider(p));
  });
}

async function buildState() {
  const map = {};
  for (const n of await allTracked()) {
    const id = get(n, 'group');
    if (!map[id]) map[id] = { id, name: get(n, 'groupName'), versions: [] };
    map[id].versions.push(readMeta(n));
  }
  const groups = Object.values(map)
    .map((g) => {
      g.versions.sort((a, b) => a.version - b.version || a.isCopy - b.isCopy);
      const f = g.versions.find((v) => v.status === 'final' && !v.isCopy);
      g.finalId = f ? f.id : null;
      return g;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: 'state', isDev, settings, user: userName(), groups, context: context(),
    pages: pagesState(), currentPageId: figma.currentPage.id, alerts: await alerts(),
    notify: isDev ? null : getNotify(),
  };
}

function selectedUntrackedTops() {
  const sel = figma.currentPage.selection.filter((n) => !isBadge(n) && !isBanner(n));
  return [...new Set(sel.map(topLevel))].filter((n) => !get(n, 'group') && !isBadge(n) && !isBanner(n));
}
function context() {
  const sel = figma.currentPage.selection.filter((n) => !isBadge(n) && !isBanner(n));
  if (!sel.length) return { kind: 'none' };
  const t = trackedAncestor(sel[0]);
  if (t) return { kind: 'tracked', nodeId: t.id, groupId: get(t, 'group') };
  const tops = selectedUntrackedTops();
  const suggested = tops.length ? baseName(tops[0].name).replace(/[\s_-]*(copy|final|old|new|v\d+)\b.*$/i, '').trim() : '';
  return { kind: 'untracked', count: tops.length, suggestedName: suggested || 'Untitled screen' };
}

let pushTimer = null;
function push() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (!ready) return;
    try {
      figma.ui.postMessage(await buildState());
    } catch (e) {
      figma.ui.postMessage({ type: 'error', text: e && e.message ? e.message : String(e) });
    }
  }, 30);
}
let ready = false;

// ---------- frame decoration ----------
// Removes the badge. If someone dragged it away from where the plugin put it,
// remember that offset so the next badge appears in the same place.
async function removeBadge(n) {
  const id = get(n, 'badgeId');
  if (id) {
    const b = await figma.getNodeByIdAsync(id);
    if (b && !b.removed && get(b, 'for') === n.id) {
      if (b.parent === n.parent && !resettingBadges) {
        const dx = Math.round(b.x - n.x), dy = Math.round(b.y - n.y);
        if (`${dx},${dy}` !== get(b, 'autoOffset')) put(n, 'badgeOffset', `${dx},${dy}`);
      }
      b.remove();
    }
  }
  put(n, 'badgeId', '');
}

let resettingBadges = false;
async function resetBadges() {
  resettingBadges = true;
  try {
    for (const n of await allTracked()) put(n, 'badgeOffset', '');
    await refreshAll();
  } finally {
    resettingBadges = false;
  }
}

function placeBadge(f, n) {
  const custom = get(n, 'badgeOffset');
  const gap = settings.badgeGap;
  let dx = 0, dy = -(f.height + gap);
  if (settings.badgePlace === 'below') dy = n.height + gap;
  if (settings.badgePlace === 'left') { dx = -(f.width + gap); dy = 0; }
  put(f, 'autoOffset', `${Math.round(dx)},${Math.round(dy)}`);
  if (custom) [dx, dy] = custom.split(',').map(Number);
  f.x = n.x + dx;
  f.y = n.y + dy;
}

async function addBadge(n, st, v, fin) {
  const finalVersion = fin ? +get(fin, 'version') : null;
  if (!n.parent || n.parent.type === 'DOCUMENT') return;
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  const f = figma.createFrame();
  n.parent.appendChild(f);
  f.name = 'Version Pin badge';
  put(f, 'isBadge', '1');
  put(f, 'dv', DECOR_VERSION);
  put(f, 'for', n.id);
  f.layoutMode = 'HORIZONTAL';
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'AUTO';
  f.paddingLeft = f.paddingRight = 10;
  f.paddingTop = f.paddingBottom = 5;
  f.cornerRadius = 6;
  f.fills = [{ type: 'SOLID', color: STATUS_RGB[st] }];
  const t = figma.createText();
  t.fontName = { family: 'Inter', style: 'Bold' };
  t.fontSize = 12;
  t.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  let label = st === 'final' ? `FINAL · v${v}` : `v${v} · ${STATUS_LABEL[st]}`;
  if (st !== 'final' && finalVersion) label += `  →  final is v${finalVersion}`;
  const b = builders(n);
  if (b.length) label += `  ·  being built by ${names(b)}`;
  t.characters = label;
  if (fin) {
    const part = `final is v${finalVersion}`;
    const i = label.indexOf(part);
    if (i >= 0) {
      try { t.setRangeHyperlink(i, i + part.length, linkFor(fin)); t.setRangeTextDecoration(i, i + part.length, 'UNDERLINE'); } catch (e) {}
    }
  }
  f.appendChild(t);
  placeBadge(f, n); // not locked: designers can drag it, and the plugin keeps the new spot
  put(n, 'badgeId', f.id);
}

async function decorate(n, fin) {
  const st = get(n, 'status') || 'draft';
  const v = +get(n, 'version');
  const copy = isCopy(n);

  if (settings.rename && !copy) {
    const suffix = st === 'final' ? ' ✓ FINAL' : st === 'superseded' ? ' · old' : '';
    n.name = `${baseName(n.name)} · v${v}${suffix}`;
  }
  if (settings.dim && st === 'superseded' && !copy) {
    if (get(n, 'origOpacity') === '') put(n, 'origOpacity', n.opacity);
    n.opacity = 0.45;
  } else if (get(n, 'origOpacity') !== '') {
    n.opacity = +get(n, 'origOpacity');
    put(n, 'origOpacity', '');
  }
  if (settings.devStatus && 'devStatus' in n) {
    try {
      if (st === 'final' && !copy) n.devStatus = { type: 'READY_FOR_DEV', description: `Final version (v${v}), marked with Version Pin` };
      else if (n.devStatus && n.devStatus.type === 'READY_FOR_DEV') n.devStatus = null;
    } catch (e) { /* only top-level frames and sections have a dev status */ }
  }
  if (copy) return;
  await removeBadge(n);
  if (settings.badges) await addBadge(n, st, v, fin);
}

async function decorateGroup(groupId) {
  const nodes = await groupNodes(groupId);
  const fin = nodes.find((n) => get(n, 'status') === 'final' && !isCopy(n));
  for (const n of nodes) await decorate(n, fin);
}

// ---------- page decoration ----------
async function removeBanner(p) {
  const id = get(p, 'bannerId');
  if (id) {
    const b = await figma.getNodeByIdAsync(id);
    if (b && !b.removed) b.remove();
  }
  put(p, 'bannerId', '');
}

async function addBanner(p, st) {
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const kids = p.children.filter((c) => !isBanner(c));
  let minX = 0, minY = 0, maxX = 1200;
  if (kids.length) {
    minX = Math.min(...kids.map((c) => c.x));
    minY = Math.min(...kids.map((c) => c.y));
    maxX = Math.max(...kids.map((c) => c.x + c.width));
  }
  const fp = get(p, 'finalPage') ? await figma.getNodeByIdAsync(get(p, 'finalPage')) : null;
  const title = {
    old: 'NOT FINAL · OLD VERSION',
    review: 'IN REVIEW · NOT APPROVED YET',
    draft: 'DRAFT · WORK IN PROGRESS',
    final: 'FINAL · BUILD FROM THIS PAGE',
  }[st];
  const sub = {
    old: fp ? `Use the page “${pageBase(fp.name)}” instead. This page is kept as history.` : 'This page is kept as history. Ask the designer which page is final.',
    review: "Don't start building until this page is marked final.",
    draft: "Don't build from this page yet.",
    final: `Marked final by ${get(p, 'updatedBy') || 'the designer'} on ${new Date(get(p, 'updatedAt') || Date.now()).toLocaleDateString()}.`,
  }[st];

  const f = figma.createFrame();
  p.appendChild(f);
  f.name = 'Version Pin page banner';
  put(f, 'isBanner', '1');
  put(f, 'dv', DECOR_VERSION);
  f.layoutMode = 'VERTICAL';
  const w = Math.max(720, maxX - minX);
  // Scale with the content so the banner stays readable when the page is zoomed out.
  const k = Math.max(1, w / 1400);
  f.resize(w, 100);
  f.primaryAxisSizingMode = 'AUTO';
  f.counterAxisSizingMode = 'FIXED';
  f.paddingLeft = f.paddingRight = Math.round(40 * k);
  f.paddingTop = f.paddingBottom = Math.round(28 * k);
  f.itemSpacing = Math.round(8 * k);
  f.cornerRadius = Math.round(16 * k);
  f.fills = [{ type: 'SOLID', color: STATUS_RGB[st] }];
  for (const [text, style, size] of [[title, 'Bold', Math.round(48 * k)], [sub, 'Regular', Math.round(24 * k)]]) {
    const t = figma.createText();
    t.fontName = { family: 'Inter', style };
    t.fontSize = size;
    t.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    t.characters = text;
    f.appendChild(t);
    t.layoutAlign = 'STRETCH';
    t.textAutoResize = 'HEIGHT';
  }
  if (st === 'old' && fp) {
    const btn = figma.createFrame();
    btn.name = 'Go to final page';
    btn.layoutMode = 'HORIZONTAL';
    btn.primaryAxisSizingMode = 'AUTO';
    btn.counterAxisSizingMode = 'AUTO';
    btn.paddingLeft = btn.paddingRight = Math.round(24 * k);
    btn.paddingTop = btn.paddingBottom = Math.round(12 * k);
    btn.cornerRadius = Math.round(10 * k);
    btn.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    const bt = figma.createText();
    bt.fontName = { family: 'Inter', style: 'Bold' };
    bt.fontSize = Math.round(26 * k);
    bt.fills = [{ type: 'SOLID', color: STATUS_RGB.old }];
    bt.characters = `Go to final page “${pageBase(fp.name)}”  →`;
    try { bt.setRangeHyperlink(0, bt.characters.length, linkFor(fp)); } catch (e) {}
    btn.appendChild(bt);
    f.appendChild(btn);
  }
  // Dev Mode shows annotations on the canvas without running any plugin.
  try {
    const url = fp ? linkTo(fp.id) : '';
    const md = st === 'old'
      ? (fp ? (url ? `**Not final.** [Go to final page “${pageBase(fp.name)}”](${url})` : `**Not final.** Final page: “${pageBase(fp.name)}”`) : '**Not final.** This page is kept as history.')
      : `**${PAGE_WORD[st]}** · ${sub}`;
    f.annotations = [{ labelMarkdown: md }];
  } catch (e) { /* annotations not available */ }
  f.x = minX;
  f.y = minY - f.height - Math.round(200 * k); // leave room for section and frame titles
  f.locked = true;
  put(p, 'bannerId', f.id);
}

async function decoratePage(p) {
  if (isDivider(p)) return;
  const st = get(p, 'pstatus');
  if (settings.pageNames) p.name = st ? PAGE_PREFIX[st] + pageBase(p.name) : pageBase(p.name);
  await p.loadAsync();
  await removeBanner(p);
  if (settings.pageBanners && st) await addBanner(p, st);
  for (const c of p.children) {
    if (isBanner(c) || isBadge(c)) continue;
    const dimIt = settings.dimOldPages && st === 'old' && get(c, 'origOpacity') === '';
    if (dimIt) {
      if (get(c, 'pageDimOrig') === '') put(c, 'pageDimOrig', c.opacity);
      c.opacity = 0.45;
    } else if (get(c, 'pageDimOrig') !== '') {
      c.opacity = +get(c, 'pageDimOrig');
      put(c, 'pageDimOrig', '');
    }
  }
}

async function cleanOrphans() {
  const badges = findByKey('isBadge');
  for (const b of badges) {
    const owner = await figma.getNodeByIdAsync(get(b, 'for'));
    if (!owner || owner.removed || get(owner, 'badgeId') !== b.id) b.remove();
  }
}

async function refreshAll() {
  const ids = [...new Set((await allTracked()).map((n) => get(n, 'group')))];
  for (const id of ids) await decorateGroup(id);
  for (const p of realPages()) await decoratePage(p);
  await cleanOrphans();
}

// ---------- frame actions ----------
function initNode(n, groupId, groupName, version) {
  put(n, 'group', groupId);
  put(n, 'groupName', groupName);
  put(n, 'version', version);
  put(n, 'status', 'draft');
  put(n, 'nodeId', n.id);
  stamp(n);
  n.setRelaunchData({ open: 'See which version of this screen is final' });
}
const byPosition = (a, b) =>
  a.absoluteTransform[0][2] - b.absoluteTransform[0][2] || a.absoluteTransform[1][2] - b.absoluteTransform[1][2];

async function createGroup(name) {
  const tops = selectedUntrackedTops().sort(byPosition);
  if (!tops.length) return toast('Select one or more frames first.');
  const id = uid();
  const clean = (name || '').trim() || 'Untitled screen';
  tops.forEach((n, i) => initNode(n, id, clean, i + 1));
  await decorateGroup(id);
  toast(`Tracking ${tops.length} version${tops.length > 1 ? 's' : ''} of “${clean}”.`);
}

async function addVersions(groupId) {
  const tops = selectedUntrackedTops().sort(byPosition);
  if (!tops.length) return toast('Select the new frames first.');
  const nodes = (await groupNodes(groupId)).filter((n) => !isCopy(n));
  if (!nodes.length) return toast('That screen no longer exists.');
  let max = Math.max(...nodes.map((n) => +get(n, 'version')));
  const name = get(nodes[0], 'groupName');
  tops.forEach((n) => initNode(n, groupId, name, ++max));
  await decorateGroup(groupId);
  toast(`Added as v${max - tops.length + 1}${tops.length > 1 ? '–v' + max : ''} of “${name}”.`);
}

async function setStatus(id, status) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return;
  const groupId = get(n, 'group');
  const v = +get(n, 'version');
  let prevFinal = null;
  const replacedBuilders = [];
  if (status === 'final') {
    for (const s of await groupNodes(groupId)) {
      if (s.id === n.id || isCopy(s)) continue;
      const st = get(s, 'status');
      if (st === 'final') prevFinal = +get(s, 'version');
      // Older versions and any previous final become superseded; newer drafts keep their status.
      if (st === 'final' || +get(s, 'version') < v) {
        put(s, 'status', 'superseded');
        stamp(s);
      }
      for (const b of builders(s)) replacedBuilders.push(`${b.name} (v${get(s, 'version')})`);
    }
  }
  put(n, 'status', status);
  stamp(n);
  await decorateGroup(groupId);

  if (status === 'final') {
    toast(`v${v} is now the final version.`);
    const name = get(n, 'groupName');
    let text = `✅ ${name}: v${v} is now FINAL${prevFinal ? ` (replaces v${prevFinal})` : ''}.`;
    if (get(n, 'note')) text += `\nWhat changed: ${get(n, 'note')}`;
    if (replacedBuilders.length) text += `\n⚠️ Being built from an older version: ${replacedBuilders.join(', ')}. Please switch to v${v}.`;
    text += `\nMarked by ${userName()}.`;
    notify('frame', text, n.id);
  }
}

async function renumber(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return;
  const groupId = get(n, 'group');
  const originals = (await groupNodes(groupId)).filter((s) => !isCopy(s));
  const next = Math.max(0, ...originals.map((s) => +get(s, 'version'))) + 1;
  put(n, 'badgeId', '');
  put(n, 'nodeId', n.id);
  put(n, 'version', next);
  put(n, 'status', 'draft');
  put(n, 'building', '');
  stamp(n);
  await decorateGroup(groupId);
  toast(`Tracked as v${next}.`);
}

async function setNote(id, note) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return;
  put(n, 'note', note);
  stamp(n);
}

async function jump(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) return toast('That item was deleted.');
  if (n.type === 'PAGE') {
    await figma.setCurrentPageAsync(n);
    return;
  }
  const page = pageOf(n);
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  figma.viewport.scrollAndZoomIntoView([n]);
  try { figma.currentPage.selection = [n]; } catch (e) {}
}

async function archiveFrames(groupId) {
  const old = (await groupNodes(groupId)).filter(
    (n) => get(n, 'status') === 'superseded' && !isCopy(n) && pageOf(n).name !== ARCHIVE_PAGE
  );
  if (!old.length) return toast('No old versions to archive.');
  let page = figma.root.children.find((p) => p.name === ARCHIVE_PAGE);
  if (!page) {
    page = figma.createPage();
    page.name = ARCHIVE_PAGE;
  }
  await page.loadAsync();
  let x = page.children.reduce((m, c) => Math.max(m, c.x + c.width), 0) + (page.children.length ? 200 : 0);
  for (const n of old.sort(byPosition)) {
    await removeBadge(n);
    page.appendChild(n);
    n.x = x;
    n.y = 0;
    x += n.width + 80;
  }
  await decorateGroup(groupId);
  toast(`Moved ${old.length} old version${old.length > 1 ? 's' : ''} to the “${ARCHIVE_PAGE}” page.`);
}

async function untrack(groupId) {
  const nodes = await groupNodes(groupId);
  for (const n of nodes) {
    if (!isCopy(n)) await removeBadge(n);
    if (get(n, 'origOpacity') !== '') n.opacity = +get(n, 'origOpacity');
    if (settings.rename) n.name = baseName(n.name);
    for (const k of ['group', 'groupName', 'version', 'status', 'note', 'updatedBy', 'updatedAt', 'origOpacity', 'nodeId', 'badgeId', 'building'])
      put(n, k, '');
    n.setRelaunchData({});
  }
  toast(`Stopped tracking ${nodes.length} frame${nodes.length > 1 ? 's' : ''}. The frames are untouched.`);
}

// ---------- page actions ----------
function dividerPage() {
  return figma.root.children.find((p) => get(p, 'isDivider') === '1');
}
function unarchivePage(p) {
  const div = dividerPage();
  if (!div) return;
  const di = figma.root.children.indexOf(div);
  if (figma.root.children.indexOf(p) > di) figma.root.insertChild(di, p);
}

async function setPageStatus(id, status, opts) {
  opts = opts || {};
  const p = await figma.getNodeByIdAsync(id);
  if (!p || p.type !== 'PAGE') return;
  const st = status === 'none' ? '' : status;
  const affected = new Set([p]);
  const alsoOld = opts.alsoOld || [];
  const nowOld = [];
  const hitBuilders = [];

  if (st === 'final') {
    for (const oid of alsoOld) {
      const o = await figma.getNodeByIdAsync(oid);
      if (!o || o === p) continue;
      put(o, 'pstatus', 'old');
      put(o, 'finalPage', p.id);
      stamp(o);
      affected.add(o);
      nowOld.push(pageBase(o.name));
      for (const b of builders(o)) hitBuilders.push(`${b.name} (“${pageBase(o.name)}”)`);
    }
    for (const q of realPages()) {
      if (get(q, 'pstatus') === 'old' && alsoOld.includes(get(q, 'finalPage'))) {
        put(q, 'finalPage', p.id);
        affected.add(q);
      }
    }
    put(p, 'finalPage', '');
  } else if (st === 'old') {
    let fid = opts.finalPageId;
    if (!fid) {
      const f = realPages().find((q) => q !== p && get(q, 'pstatus') === 'final');
      fid = f ? f.id : '';
    }
    put(p, 'finalPage', fid);
    for (const q of realPages()) {
      if (q !== p && get(q, 'finalPage') === p.id) {
        put(q, 'finalPage', fid);
        affected.add(q);
      }
    }
    for (const b of builders(p)) hitBuilders.push(b.name);
  } else {
    put(p, 'finalPage', '');
  }
  put(p, 'pstatus', st);
  stamp(p);
  if (st !== 'old') unarchivePage(p);
  for (const q of realPages()) if (get(q, 'finalPage') === p.id) affected.add(q);
  for (const q of affected) await decoratePage(q);

  const base = pageBase(p.name);
  if (st === 'final') {
    toast(`“${base}” is now the final page.`);
    let text = `✅ Page “${base}” is now FINAL. Build from this page.`;
    if (nowOld.length) text += `\nNow old (kept as history): ${nowOld.map((x) => `“${x}”`).join(', ')}.`;
    if (get(p, 'note')) text += `\nWhat changed: ${get(p, 'note')}`;
    if (hitBuilders.length) text += `\n⚠️ Being built from an old page: ${hitBuilders.join(', ')}. Please switch to “${base}”.`;
    text += `\nMarked by ${userName()}.`;
    notify('page', text, p.id);
  } else if (st === 'old') {
    const fp = get(p, 'finalPage') ? await figma.getNodeByIdAsync(get(p, 'finalPage')) : null;
    let text = `⛔ Page “${base}” is now OLD.${fp ? ` The final page is “${pageBase(fp.name)}”.` : ''}`;
    if (hitBuilders.length) text += `\n⚠️ Being built from this page: ${hitBuilders.join(', ')}. Please switch${fp ? ` to “${pageBase(fp.name)}”` : ''}.`;
    text += `\nMarked by ${userName()}.`;
    notify('page', text, p.id);
  } else if (st === 'review') {
    notify('page', `🟠 Page “${base}” is ready for review. Don't build from it yet.\nMarked by ${userName()}.`, p.id);
  }
}

async function setPageNote(id, note) {
  const p = await figma.getNodeByIdAsync(id);
  if (!p) return;
  put(p, 'note', note);
  stamp(p);
}

async function archivePages() {
  const old = realPages().filter((p) => get(p, 'pstatus') === 'old');
  if (!old.length) return toast('No old pages to archive.');
  let div = dividerPage();
  if (!div) {
    div = figma.createPage();
    div.name = '---';
    put(div, 'isDivider', '1');
  }
  const rest = figma.root.children.filter((p) => p !== div && !old.includes(p));
  [...rest, div, ...old].forEach((p, i) => figma.root.insertChild(i, p));
  toast(`Moved ${old.length} old page${old.length > 1 ? 's' : ''} below the archive divider.`);
}

// ---------- wiring ----------
const DEV_ALLOWED = new Set(['jump', 'building', 'unwatch', 'switchBuilding']);

figma.ui.onmessage = async (msg) => {
  if (isDev && !DEV_ALLOWED.has(msg.type)) return toast('Dev Mode is read-only.');
  try {
    switch (msg.type) {
      case 'create': await createGroup(msg.name); break;
      case 'add': await addVersions(msg.groupId); break;
      case 'status': await setStatus(msg.id, msg.status); break;
      case 'renumber': await renumber(msg.id); break;
      case 'note': await setNote(msg.id, msg.note); break;
      case 'jump': await jump(msg.id); break;
      case 'archive': await archiveFrames(msg.groupId); break;
      case 'untrack': await untrack(msg.groupId); break;
      case 'pageStatus': await setPageStatus(msg.id, msg.status, msg.opts); break;
      case 'pageNote': await setPageNote(msg.id, msg.note); break;
      case 'archivePages': await archivePages(); break;
      case 'building': await setBuilding(msg.id, msg.on); break;
      case 'unwatch': await unwatch(msg.id); break;
      case 'switchBuilding':
        await setBuilding(msg.from, false);
        await setBuilding(msg.to, true);
        break;
      case 'settings':
        settings = Object.assign({}, settings, msg.settings);
        settings.badgeGap = Math.max(0, Math.min(2000, +settings.badgeGap || 0));
        await figma.clientStorage.setAsync('settings', settings);
        if ('badgePlace' in msg.settings || 'badgeGap' in msg.settings) await resetBadges();
        else await refreshAll();
        break;
      case 'setNotify':
        figma.root.setPluginData('notify', JSON.stringify(Object.assign(getNotify(), msg.cfg)));
        toast('Notification settings saved for everyone using Version Pin in this file.');
        break;
      case 'testNotify': {
        const cfg = getNotify();
        if (!cfg.slack && !cfg.teams) { toast('Add a Slack or Teams webhook URL first.'); break; }
        figma.ui.postMessage({ type: 'notify', text: `👋 Version Pin is connected. Version changes in “${figma.root.name}” will be posted here.`, url: '', slack: cfg.slack, teams: cfg.teams });
        break;
      }
      case 'refresh': await refreshAll(); toast('Badges, banners and labels refreshed.'); break;
      case 'resetBadges': await resetBadges(); toast('All badges moved back to the default position.'); break;
    }
  } catch (e) {
    toast('Something went wrong: ' + (e && e.message ? e.message : e));
  }
  push();
};

figma.on('selectionchange', push);
figma.on('currentpagechange', push);

(async () => {
  try {
    const saved = await figma.clientStorage.getAsync('settings');
    if (saved) settings = Object.assign({}, settings, saved);
    await figma.loadAllPagesAsync();
    // Redraw badges and banners made by an older version of the plugin (Design mode only).
    if (!isDev) {
      const stale = [...findByKey('isBadge'), ...findByKey('isBanner')].some((n) => get(n, 'dv') !== DECOR_VERSION);
      if (stale) {
        await refreshAll();
        toast('Updated badges and banners to the latest plugin version.');
      }
    }
  } catch (e) {
    figma.ui.postMessage({ type: 'error', text: 'Could not load the file: ' + (e && e.message ? e.message : e) });
  }
  ready = true;
  push();
})();
