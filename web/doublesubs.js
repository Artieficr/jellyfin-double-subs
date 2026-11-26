// Jellyfin Double Subs — client script. Loaded into jellyfin-web (browser, Jellyfin Desktop, web-based apps).
(() => {
  'use strict';

  const VERSION = '0.1.0'; // bump with each release (and <Version> in the .csproj); the release workflow checks both
  if (window.doubleSubs) return console.warn('[doublesubs] already loaded, skipping a second copy');
  const SENTINEL = -1000; // fake subtitle "track" index used for the Double subs row in the subtitles menu
  const PREFS = ['doublesubs', 'emby']; // DisplayPreferences id + client: per-user settings stored on the server
  const SHOW = { both: 'Main + secondary', main: 'Main only', secondary: 'Secondary only' };
  // Size (%) and lift (distance from the screen bottom, vh) of the live subtitles, set with arrows in the dialog.
  const LOOK = { size: { min: 50, max: 200, step: 10, def: 100 }, lift: { min: 0, max: 40, step: 2, def: 8 } };
  // Lucide icons (ISC license, lucide.dev), inlined: a-large-small, arrow-up-from-line, chevron-up, chevron-down.
  const svg = paths => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.map(d => `<path d="${d}"/>`).join('')}</svg>`;
  const ICON = {
    size: svg(['m15 16 2.536-7.328a1.02 1.02 1 0 1 1.928 0L22 16', 'M15.697 14h5.606', 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16', 'M3.304 13h6.392']),
    lift: svg(['m18 9-6-6-6 6', 'M12 3v14', 'M5 21h14']),
    up: svg(['m18 15-6-6-6 6']),
    down: svg(['m6 9 6 6 6-6']),
  };

  // jellyfin-web internals aren't global: reach them through the webpack runtime (module ids change per build).
  let req;
  self.webpackChunk.push([[Symbol()], {}, r => { req = r; }]);
  const findModule = re => Object.keys(req.m).find(k => re.test(req.m[k].toString()));

  const pmModule = findModule(/\.setSubtitleStreamIndex=function/);
  const pm = pmModule && Object.values(req(pmModule)).find(v => v && typeof v.getCurrentPlayer === 'function');
  if (!pm) return console.warn('[doublesubs] playbackManager not found, disabled');

  const isTv = () => document.documentElement.classList.contains('layout-tv'); // jellyfin-web's TV layout
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

  // ---------- settings (per user, on the server)

  async function loadSettings() {
    const d = await ApiClient.getDisplayPreferences(PREFS[0], ApiClient.getCurrentUserId(), PREFS[1]);
    const c = d.CustomPrefs || {};
    const look = k => (c[k] != null && c[k] !== '' && Number.isFinite(+c[k]) ? Math.min(LOOK[k].max, Math.max(LOOK[k].min, +c[k])) : LOOK[k].def);
    return { mainLang: c.mainLang || '', secondaryLang: c.secondaryLang || '', show: c.show || 'both', autoEnable: c.autoEnable !== 'false',
      size: look('size'), lift: look('lift') };
  }

  // Writes only the given keys (the defaults dialog and the size/lift arrows each save their own).
  async function saveSettings(s) {
    // Re-read right before writing: the server mixes a few global prefs into CustomPrefs and saves them back.
    const d = await ApiClient.getDisplayPreferences(PREFS[0], ApiClient.getCurrentUserId(), PREFS[1]);
    d.CustomPrefs = { ...d.CustomPrefs, ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)])) };
    await ApiClient.updateDisplayPreferences(PREFS[0], d, ApiClient.getCurrentUserId(), PREFS[1]);
  }

  let culturesP;
  const cultures = () => culturesP ||= ApiClient.getCultures().then(list => {
    const seen = new Set();
    return list.filter(c => c.ThreeLetterISOLanguageName && !seen.has(c.ThreeLetterISOLanguageName) && seen.add(c.ThreeLetterISOLanguageName))
      .sort((a, b) => a.DisplayName.localeCompare(b.DisplayName));
  });

  // ---------- subtitle tracks and their lines
  // A line ("cue") is { start, end, text } in ms. Image subtitles (PGS, VobSub) have text '' and an
  // `image` index into their parser; everything time-based (offset, pairing, pause list, seek) treats both alike.

  const origSubtitleTracks = pm.subtitleTracks, origSetSubtitle = pm.setSubtitleStreamIndex;
  const imageKind = t => ({ pgssub: 'pgs', dvdsub: 'vobsub', vobsub: 'vobsub' })[(t.Codec || '').toLowerCase()];
  const usableTracks = player => origSubtitleTracks.call(pm, player).filter(t => t.IsTextSubtitleStream || imageKind(t));

  function ctxOf(player) {
    const item = pm.currentItem(player), source = pm.currentMediaSource(player);
    return item && source && { player, itemId: item.Id, sourceId: source.Id };
  }

  const cache = new Map(); // "item/source/index" -> Promise<cue[]>
  // Strip ASS/HTML tags and join the file's own line breaks (we wrap to our box width instead),
  // but keep a break before a "- " line: that's a second speaker.
  const clean = t => t.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '').replace(/\\N/gi, '\n')
    .replace(/[ \t]*\n(?![-–—])[ \t]*/g, ' ').trim();

  function events(ctx, index) {
    const key = `${ctx.itemId}/${ctx.sourceId}/${index}`;
    if (!cache.has(key)) {
      const track = origSubtitleTracks.call(pm, ctx.player).find(t => t.Index === index);
      const path = `Videos/${ctx.itemId}/${ctx.sourceId}/Subtitles/${index}/0/Stream`;
      const kind = track && imageKind(track);
      // VobSub comes as a Matroska subtitle file (what jellyfin-web requests too). ponytail: untested end to
      // end, no VobSub file to try; the decoding was checked on a PGS→VobSub conversion.
      cache.set(key, (kind ? imageEvents(path + (kind === 'pgs' ? '.sup' : '.mks'), kind)
        : ApiClient.getJSON(ApiClient.getUrl(path + '.js'))
          .then(j => j.TrackEvents.map(e => ({ start: e.StartPositionTicks / 1e4, end: e.EndPositionTicks / 1e4, text: clean(e.Text) }))))
        .catch(err => { cache.delete(key); throw err; }));
    }
    return cache.get(key);
  }

  function clearCache() {
    cache.clear();
    images.clear();
    parsers.splice(0).forEach(p => p.free()); // wasm memory holds each whole subtitle file
  }

  // ---------- image subtitles (PGS, VobSub): decoded with jellyfin-web's own libbitsub (WebAssembly), loaded on demand

  let pgsLib;
  const parsers = [];
  const images = new Map(); // cue -> canvas; ponytail: FIFO of 150, plenty for a pause list + the live lines

  function libbitsub() {
    pgsLib ||= (async () => {
      const chunk = req.u.toString().match(/(\d+):"node_modules\.libbitsub"/)?.[1];
      if (!chunk) throw new Error('libbitsub not found in this jellyfin-web build');
      await req.e(chunk);
      const lib = req(findModule(/PgsParser:function/));
      await lib.default({ module_or_path: new URL(req(findModule(/libbitsub_bg[^"]*\.wasm/)), location.href).href });
      return lib;
    })().catch(err => { pgsLib = null; throw err; });
    return pgsLib;
  }

  async function imageEvents(path, kind) {
    const [lib, res] = await Promise.all([libbitsub(),
      fetch(ApiClient.getUrl(path), { headers: { Authorization: `MediaBrowser Token="${ApiClient.accessToken()}"` } })]);
    if (!res.ok) throw new Error(`${kind} subtitle download failed: ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    const parser = kind === 'pgs' ? new lib.PgsParser() : new lib.VobSubParser();
    parsers.push(parser);
    if (kind === 'pgs') parser.parse(data);
    else parser.loadFromMks(data);
    const cues = [];
    for (let i = 0; i < parser.count; i++) { // every other PGS "cue" is an empty one that clears the screen
      if (kind !== 'pgs' || parser.getCueCompositionCount(i)) {
        cues.push({ start: parser.getCueStartTime(i), end: parser.getCueEndTime(i), text: '', image: i, parser, screenH: parser.screenHeight });
      }
    }
    return cues;
  }

  // A cue's bitmap(s) as one canvas, compositions kept at their relative positions.
  function cueCanvas(cue) {
    let c = images.get(cue);
    if (c) return c;
    const r = cue.parser.renderAtIndex(cue.image);
    // PGS returns a result holding compositions; VobSub returns the single frame itself.
    const comps = !r ? [] : 'compositionCount' in r ? Array.from({ length: r.compositionCount }, (_, i) => r.getComposition(i)) : [r];
    const x0 = Math.min(...comps.map(p => p.x)), y0 = Math.min(...comps.map(p => p.y));
    c = document.createElement('canvas');
    c.width = Math.max(1, ...comps.map(p => p.x + p.width - x0));
    c.height = Math.max(1, ...comps.map(p => p.y + p.height - y0));
    const g = c.getContext('2d');
    for (const p of comps) {
      g.putImageData(new ImageData(new Uint8ClampedArray(p.getRgba()), p.width, p.height), p.x - x0, p.y - y0);
      p.free();
    }
    if (r && !comps.includes(r)) r.free();
    images.set(cue, c);
    if (images.size > 150) images.delete(images.keys().next().value);
    return c;
  }

  // DOM for some cues: their text as one text node (joined by sep), then any bitmaps. `scale` 1 = the
  // size the subtitle was authored at relative to the screen height.
  function cueNodes(cues, scale, sep) {
    const text = cues.filter(c => c.image == null).map(c => c.text).join(sep);
    const nodes = text ? [document.createTextNode(text)] : [];
    for (const cue of cues.filter(c => c.image != null)) {
      const src = cueCanvas(cue), c = document.createElement('canvas');
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      c.className = 'ds-img';
      // --ds-size: the size setting, set on the live overlay only (1 elsewhere, e.g. the pause list)
      c.style.height = `calc(${(src.height / cue.screenH) * 100 * scale}vh * var(--ds-size, 1))`;
      nodes.push(c);
    }
    return nodes;
  }

  // Best track for a language. Several tracks per language are common (signs-only + full), and the
  // signs track isn't reliably flagged forced (seen as IsDefault), so take the one with the most lines.
  async function pickTrack(ctx, tracks, lang) {
    if (!lang) return null;
    const names = (await cultures()).find(c => c.ThreeLetterISOLanguageNames.includes(lang))?.ThreeLetterISOLanguageNames || [lang];
    const candidates = tracks.filter(t => names.includes(t.Language));
    if (candidates.length < 2) return candidates[0] || null;
    const counts = await Promise.all(candidates.map(t => events(ctx, t.Index).then(e => e.length, () => 0)));
    return candidates[counts.indexOf(Math.max(...counts))];
  }

  // ---------- double subs state, live overlay, pause list
  // One 100 ms loop runs from playback start to stop. Players fire pause events on themselves, not on
  // playbackManager, so polling pm.paused() is simpler than tracking player changes.

  let state = null; // { player, itemId, sourceId, main, secondary, show, manualOffset, offset, mainEv, secEv }
  let loop, overlay, list, listKey = '';
  let look = { size: LOOK.size.def, lift: LOOK.lift.def }; // loaded from settings at playback start
  let preview = false; // true while the size/lift arrows are in use (until the dialog closes)

  // manualOffset: ms added to the secondary track's times, or null = estimate it.
  async function activate(ctx, main, secondary, show, manualOffset = null) {
    const [mainEv, secRaw] = await Promise.all([events(ctx, main), secondary == null ? [] : events(ctx, secondary)]);
    const offset = manualOffset ?? estimateOffset(mainEv, secRaw);
    // Display-only copy: shifted, and each line paired with the main line it belongs to (null = none).
    const secEv = secRaw.flatMap(x => splitAcross(mainEv, { ...x, start: x.start + offset, end: x.end + offset }));
    for (const x of secEv) x.pair ??= bestMatch(mainEv, x);
    origSetSubtitle.call(pm, -1, ctx.player); // hide Jellyfin's own subtitles, we draw both lines ourselves
    state = { ...ctx, main, secondary, show, manualOffset, offset, mainEv, secEv };
    listKey = '';
  }

  function deactivate() {
    state = null;
    listKey = '';
  }

  function startLoop() {
    clearInterval(loop);
    loop = setInterval(tick, 100);
  }

  function stopLoop() {
    clearInterval(loop);
    deactivate();
    overlay?.remove();
    list?.remove();
  }

  function tick() {
    const player = pm.getCurrentPlayer();
    if (!player) return;
    const t = pm.currentTime(player), paused = pm.paused(player); // ms
    if (preview) { // adjusting size/lift: a sample line instead of real subtitles or the pause list
      renderOverlay(t);
      if (list?.isConnected) { list.remove(); listKey = ''; }
      return;
    }
    renderOverlay(state && !paused ? t : null); // while paused the list shows the current line instead
    if (paused) renderList(player, t);
    else if (list?.isConnected) { list.remove(); listKey = ''; }
  }

  const activeAt = (ev, t) => ev.filter(e => e.start <= t && t < e.end);
  const PREVIEW_MAIN = [{ text: 'Main subtitles look like this' }], PREVIEW_SEC = [{ text: 'Secondary subtitles look like this' }];

  // Rebuild a slot only when its set of cues changes (bitmaps are copied per rebuild).
  function setSlot(node, cues, scale, sep) {
    if (node.cues?.length === cues.length && node.cues.every((c, i) => c === cues[i])) return;
    node.cues = cues;
    node.replaceChildren(...cueNodes(cues, scale, sep));
  }

  function renderOverlay(t) {
    if (t == null) return overlay?.remove();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'ds-overlay';
      overlay.innerHTML = '<div class="ds-main"></div><div class="ds-sec"></div>';
    }
    if (!overlay.isConnected) document.body.appendChild(overlay);
    overlay.style.setProperty('--ds-size', look.size / 100);
    overlay.style.zIndex = preview ? 10001 : ''; // preview: above the dialog's dimmed backdrop, as it will really look
    // Stay above the player's controls while they're shown (.osdControls, not the bar, which includes its fade).
    // Jellyfin can keep an old, hidden video page around, so take the bar that is actually laid out.
    // The size/lift preview shows the normal position, as if the controls were hidden.
    const bar = !preview && [...document.querySelectorAll('.videoOsdBottom:not(.videoOsdBottom-hidden):not(.hide)')].find(b => b.offsetHeight);
    const top = bar && (bar.querySelector('.osdControls') || bar).getBoundingClientRect().top;
    const lift = (innerHeight * look.lift) / 100;
    overlay.style.bottom = `${top ? Math.max(lift, innerHeight - top + 12) : lift}px`;
    if (preview) {
      setSlot(overlay.children[0], PREVIEW_MAIN, 1, '\n');
      setSlot(overlay.children[1], PREVIEW_SEC, 0.7, ' ');
      return;
    }
    const main = activeAt(state.mainEv, t);
    // Both shown: a secondary line is locked to its main line (appears/disappears with it).
    // Alone, or without a matching main line: its own (shifted) timing.
    const sec = state.show === 'secondary' ? activeAt(state.secEv, t)
      : state.secEv.filter(x => (x.pair ? main.includes(x.pair) : x.start <= t && t < x.end));
    // Whatever is shown alone gets the main (big) size.
    const [big, small] = state.show === 'main' ? [main, []] : state.show === 'secondary' ? [sec, []] : [main, sec];
    setSlot(overlay.children[0], big, 1, '\n');
    setSlot(overlay.children[1], small, 0.7, ' ');
  }

  // The main line a secondary line belongs to: the one it overlaps longest (lines split differently per language).
  const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const bestMatch = (main, x) => main.reduce((best, e) => (overlap(e, x) > (best ? overlap(best, x) : 0) ? e : best), null);

  // One secondary line spanning several main lines (the other language merged them) is split back
  // when its own structure says how: speaker dashes first, else sentence ends. Only when the piece
  // count equals the number of main lines it covers (each ≥30 % covered); otherwise left whole.
  function splitAcross(main, x) {
    const covered = main.filter(e => overlap(e, x) > 0.3 * (e.end - e.start));
    if (covered.length > 1) {
      for (const parts of [x.text.split(/\n(?=[-–—])/), x.text.split(/(?<=[.!?…])\s+/)]) {
        if (parts.length !== covered.length) continue;
        return parts.map((text, i) => ({
          start: Math.max(x.start, covered[i].start), end: Math.min(x.end, covered[i].end),
          text: text.replace(/^[-–—]\s*/, ''), pair: covered[i],
        }));
      }
    }
    return [x];
  }

  // How many ms to add to the secondary track so its lines start with the main track's (whole-track
  // shift, e.g. another release of the subtitles). Each secondary start votes for the shift to every
  // main start within ±15 s, in 100 ms buckets; true matches pile up in one bucket, the rest is spread.
  // ponytail: constant shift only; fit a linear drift (25 vs 23.976 fps) if that case shows up.
  function estimateOffset(main, sec) {
    const B = 100, W = 15000, votes = new Map();
    let j = 0;
    for (const x of sec) {
      while (j < main.length && main[j].start < x.start - W) j++;
      for (let k = j; k < main.length && main[k].start <= x.start + W; k++) {
        const b = Math.round((main[k].start - x.start) / B);
        votes.set(b, (votes.get(b) || 0) + 1);
      }
    }
    const score = b => (votes.get(b - 1) || 0) + (votes.get(b) || 0) + (votes.get(b + 1) || 0);
    let best = 0;
    for (const b of votes.keys()) if (score(b) > score(best)) best = b;
    // Shift only on clear evidence: beats "no shift" by 50% and matches at least 15% of the lines.
    return score(best) > 1.5 * score(0) && score(best) >= 0.15 * Math.min(main.length, sec.length) ? best * B : 0;
  }

  // Pause list: the last 8 lines of the main track, each with the secondary lines that overlap it in
  // time (always both languages, whatever the overlay shows). Without Double subs: Jellyfin's own
  // track, if it's a text track. Click a line → seek to its start.
  async function renderList(player, t) {
    const nativeIndex = pm.getSubtitleStreamIndex(player);
    const key = `${Math.round(t / 250)}/${state?.main}/${state?.secondary}/${nativeIndex}`;
    if (key === listKey) return; // rebuild only when something changed, so hover/focus survive
    listKey = key;
    let main = state?.mainEv, sec = state?.secEv || [];
    if (!state) {
      const ctx = ctxOf(player);
      if (!ctx || !usableTracks(player).some(tr => tr.Index === nativeIndex)) return list?.remove();
      try { main = await events(ctx, nativeIndex); } catch { return; }
      if (listKey !== key) return; // moved on while loading
    }
    const lines = main.filter(e => e.start <= t + 250).slice(-50); // +250: a seek can land just before a line's start
    if (!lines.length) return list?.remove();
    if (!list) {
      list = document.createElement('div');
      list.className = 'ds-list';
      list.addEventListener('keydown', e => moveFocus(e, [...list.children], { ArrowDown: 1, ArrowUp: -1 }));
    }
    const fresh = !list.isConnected, hadFocus = list.contains(document.activeElement);
    list.replaceChildren(...lines.map(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ds-line';
      const m = document.createElement('div');
      m.append(...cueNodes([e], 0.45, ' '));
      b.append(m);
      const s = sec.filter(x => x.pair === e);
      if (s.length) {
        const d = Object.assign(document.createElement('div'), { className: 'ds-line-sec' });
        d.append(...cueNodes(s, 0.35, ' '));
        b.append(d);
      }
      // Desktop: blur, otherwise Space would "click" this line again instead of resuming playback.
      // TV: keep focus so the rebuilt list takes it back.
      b.onclick = () => { if (!isTv()) b.blur(); pm.seek(Math.round(e.start * 1e4), player); };
      return b;
    }));
    if (!list.isConnected) document.body.appendChild(list);
    // As many lines as fit the screen height: drop the oldest until the top one is fully inside.
    // (Bottom-aligned flex content overflows upward, which scrollHeight doesn't count; offsetTop goes negative.)
    while (list.children.length > 1 && list.firstChild.offsetTop < 0) list.firstChild.remove();
    // TV layout: start on the newest line when the list appears, and again after a jump rebuilt it, so the
    // remote can reach it. Not otherwise: that would pull focus back from the player controls. (Not on
    // desktop at all: Space would hit a line instead of resuming.)
    if (isTv() && (fresh || hadFocus)) list.lastChild.focus();
  }

  // ---------- subtitles menu: add a "Double subs" row (with a gear) to Jellyfin's own action sheet

  let menuOpening = false, gearClicked = false;

  document.addEventListener('click', e => {
    const t = e.target;
    gearClicked = !!t.closest?.('.ds-gear');
    if (t.closest?.('.btnSubtitles')) {
      menuOpening = true; // the OSD handler calls pm.subtitleTracks() synchronously right after this
      setTimeout(() => { menuOpening = false; });
    }
    const row = t.closest?.('.actionSheet .actionSheetMenuItem');
    if (row && row.parentNode.querySelector(`[data-id="${SENTINEL}"]`)) {
      const id = Number(row.dataset.id), player = pm.getCurrentPlayer(), gear = gearClicked;
      if (id === SENTINEL) {
        // open after the sheet has closed and given focus back, so our dialog keeps focus
        row.closest('.actionSheet').addEventListener('close', () => setTimeout(() => (gear ? openSettings : openDialog)(player)), { once: true });
      } else if (state) {
        deactivate(); // any normal choice (including Off, which Jellyfin ignores as "unchanged") turns us off
      }
    }
  }, true);

  pm.subtitleTracks = function (player) {
    const tracks = origSubtitleTracks.apply(this, arguments);
    if (!menuOpening) return tracks;
    menuOpening = false;
    const p = player || this.getCurrentPlayer();
    if (!p?.isLocalPlayer || !tracks.length) return tracks;
    decorateSheet();
    return [{ Index: SENTINEL, DisplayTitle: 'Double subs' }, ...tracks];
  };

  pm.setSubtitleStreamIndex = function (index) {
    if (index === SENTINEL) return; // our row: handled by the click listener above
    if (state) deactivate(); // user picked a normal track (menu, keyboard shortcut, ...)
    return origSetSubtitle.apply(this, arguments);
  };

  function decorateSheet() {
    const mo = new MutationObserver(() => {
      const row = document.querySelector(`.actionSheet .actionSheetMenuItem[data-id="${SENTINEL}"]`);
      if (!row) return;
      mo.disconnect();
      row.insertAdjacentHTML('beforeend', '<span class="listItemAside ds-gear material-icons settings" data-tip="Double subs defaults" aria-label="Double subs defaults"></span>');
      if (state) { // Jellyfin thinks subtitles are Off: move the check mark to our row
        row.parentNode.querySelectorAll('.actionsheetMenuItemIcon').forEach(i => { i.style.visibility = 'hidden'; });
        const icon = row.querySelector('.actionsheetMenuItemIcon');
        if (icon) icon.style.visibility = 'visible';
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 3000);
  }

  // ---------- dialogs

  // Arrow-key / TV-remote focus moves within our own UI. Jellyfin's spatial navigation doesn't know
  // about our elements, and the OSD would turn the arrows into seeks/volume.
  function moveFocus(e, items, steps) {
    const step = steps[e.key], i = items.indexOf(document.activeElement);
    if (!step || i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    items[(i + step + items.length) % items.length].focus();
  }

  const isBack = e => ['Escape', 'GoBack', 'BrowserBack'].includes(e.key) || e.keyCode === 461 || e.keyCode === 10009; // webOS, Tizen

  function modal(title, html, onClose) {
    const root = document.createElement('div');
    root.className = 'ds-modal';
    root.innerHTML = `<form class="ds-box"><h2>${esc(title)}</h2>${html}</form>`;
    const close = () => { root.remove(); onClose?.(); };
    // Keep keys away from the video OSD (arrows seek, space pauses, Escape leaves the player).
    // Up/Down step through the fields, Left/Right through the buttons; Enter works natively.
    root.addEventListener('keydown', e => {
      e.stopPropagation();
      if (isBack(e)) { e.preventDefault(); close(); return; }
      const fields = [...root.querySelectorAll('select, input, button:not(:disabled)')];
      moveFocus(e, fields, e.target.tagName === 'BUTTON' ? { ArrowDown: 1, ArrowUp: -1, ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 });
    });
    // No close-on-backdrop-click: in Jellyfin Desktop (Qt) a <select> popup can extend past the box,
    // and picking an option there delivers the click to the backdrop.
    root.addEventListener('click', e => {
      if (e.target.dataset.act === 'cancel') close();
    });
    document.body.appendChild(root);
    root.querySelector('select, input, button')?.focus();
    return { form: root.firstChild, close };
  }

  // [icon] [▲][▼] row for one LOOK setting. Changes apply live (with a sample line, see `preview`) and save
  // per user; an arrow is disabled at its limit.
  const lookRow = (key, label, upLabel, downLabel) => `
    <div class="ds-look" role="group" aria-label="${label}"><span class="ds-look-icon" data-tip="${label}">${ICON[key]}</span>
      <button type="button" data-step="${key}:1" data-tip="${upLabel}" aria-label="${upLabel}">${ICON.up}</button>
      <button type="button" data-step="${key}:-1" data-tip="${downLabel}" aria-label="${downLabel}">${ICON.down}</button></div>`;

  function updateLookButtons(form) {
    for (const b of form.querySelectorAll('[data-step]')) {
      const [key, dir] = b.dataset.step.split(':');
      b.disabled = look[key] === (dir === '1' ? LOOK[key].max : LOOK[key].min);
    }
  }

  let lookSave;
  function stepLook(form, button) {
    const [key, dir] = button.dataset.step.split(':'), L = LOOK[key];
    look[key] = Math.min(L.max, Math.max(L.min, look[key] + Number(dir) * L.step));
    preview = true;
    updateLookButtons(form);
    // A disabled button loses focus; keep keyboard/remote users on the row.
    if (button.disabled) form.querySelector(`[data-step="${key}:${-Number(dir)}"]`).focus();
    clearTimeout(lookSave);
    lookSave = setTimeout(() => saveSettings({ size: look.size, lift: look.lift })
      .catch(err => console.error('[doublesubs] could not save size/position', err)), 500);
  }

  const showOptions = sel => Object.entries(SHOW).map(([v, label]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${label}</option>`).join('');

  async function openDialog(player) {
    const ctx = ctxOf(player);
    if (!ctx) return;
    const tracks = usableTracks(player);
    if (!tracks.length) {
      modal('Double subs', `<p>This file's subtitles are in a format Double subs can't read. Text, Blu-ray (PGS)
        and DVD (VobSub) subtitles work. Add a text subtitle file (.srt) for it to work.</p>
        <div class="ds-buttons"><button type="button" data-act="cancel">OK</button></div>`);
      return;
    }
    let main, secondary, show, manualOffset = null;
    if (state) ({ main, secondary, show, manualOffset } = state);
    else {
      const s = await loadSettings();
      const native = pm.getSubtitleStreamIndex(player);
      main = (await pickTrack(ctx, tracks, s.mainLang))?.Index ?? (tracks.some(t => t.Index === native) ? native : tracks[0].Index);
      secondary = (await pickTrack(ctx, tracks, s.secondaryLang))?.Index ?? null;
      show = s.show;
    }
    const options = sel => tracks.map(t => `<option value="${t.Index}"${t.Index === sel ? ' selected' : ''}>${esc(t.DisplayTitle)}</option>`).join('');
    const m = modal('Double subs', `
      <label>Main (large, on top)<select name="main">${options(main)}</select></label>
      <label>Secondary (small, below)<select name="secondary"><option value="">None</option>${options(secondary)}</select></label>
      <label>Show<select name="show">${showOptions(show)}</select></label>
      <div class="ds-looks">${lookRow('size', 'Subtitle size', 'Bigger', 'Smaller')}${lookRow('lift', 'Distance from the bottom', 'Higher', 'Lower')}</div>
      <label>Secondary timing, seconds (+ later, − earlier; empty = automatic)
        <input type="number" name="offset" step="0.1" value="${manualOffset == null ? '' : manualOffset / 1000}"
          placeholder="${state && state.manualOffset == null ? `auto: ${(state.offset / 1000).toFixed(1)}` : 'auto'}"></label>
      <div class="ds-buttons">
        <button type="button" data-act="settings" class="ds-left">Defaults…</button>
        ${state ? '<button type="button" data-act="off">Turn off</button>' : '<button type="button" data-act="cancel">Cancel</button>'}
        <button type="submit">Apply</button>
      </div>`, () => { preview = false; });
    updateLookButtons(m.form);
    m.form.addEventListener('click', e => {
      const stepBtn = e.target.closest('[data-step]');
      if (stepBtn) stepLook(m.form, stepBtn);
      const act = e.target.dataset.act;
      if (act === 'off') { m.close(); deactivate(); }
      if (act === 'settings') { m.close(); openSettings(player); }
    });
    m.form.onsubmit = e => {
      e.preventDefault();
      const f = m.form.elements;
      m.close();
      const offset = f.offset.value.trim() === '' ? null : Math.round(Number(f.offset.value) * 1000);
      activate(ctx, Number(f.main.value), f.secondary.value === '' ? null : Number(f.secondary.value), f.show.value, Number.isFinite(offset) ? offset : null)
        .catch(err => console.error('[doublesubs] could not load subtitles', err));
    };
  }

  async function openSettings() {
    const [s, list] = await Promise.all([loadSettings(), cultures()]);
    const langs = sel => '<option value="">None</option>' + list.map(c =>
      `<option value="${esc(c.ThreeLetterISOLanguageName)}"${c.ThreeLetterISOLanguageName === sel ? ' selected' : ''}>${esc(c.DisplayName)}</option>`).join('');
    const m = modal('Double subs defaults', `
      <label>Default main language<select name="mainLang">${langs(s.mainLang)}</select></label>
      <label>Default secondary language<select name="secondaryLang">${langs(s.secondaryLang)}</select></label>
      <label>Show<select name="show">${showOptions(s.show)}</select></label>
      <label class="ds-check"><input type="checkbox" name="autoEnable"${s.autoEnable ? ' checked' : ''}>
        Turn on Double subs automatically when both languages are found</label>
      <div class="ds-buttons"><button type="button" data-act="cancel">Cancel</button><button type="submit">Save</button></div>`);
    m.form.onsubmit = e => {
      e.preventDefault();
      const f = m.form.elements;
      m.close();
      saveSettings({ mainLang: f.mainLang.value, secondaryLang: f.secondaryLang.value, show: f.show.value, autoEnable: f.autoEnable.checked })
        .catch(err => console.error('[doublesubs] could not save settings', err));
    };
  }

  // ---------- playback lifecycle: reset per item, auto-enable from the defaults

  Events.on(pm, 'playbackstop', () => { stopLoop(); clearCache(); });

  Events.on(pm, 'playbackstart', async (e, player) => {
    stopLoop();
    clearCache();
    const ctx = player?.isLocalPlayer && ctxOf(player);
    if (!ctx) return;
    startLoop();
    try {
      const s = await loadSettings();
      look = { size: s.size, lift: s.lift };
      if (!s.autoEnable || !s.mainLang || !s.secondaryLang) return;
      const tracks = usableTracks(player);
      const [main, secondary] = await Promise.all([pickTrack(ctx, tracks, s.mainLang), pickTrack(ctx, tracks, s.secondaryLang)]);
      if (main && secondary && pm.currentItem(player)?.Id === ctx.itemId) await activate(ctx, main.Index, secondary.Index, s.show);
    } catch (err) {
      console.error('[doublesubs] auto-enable failed', err);
    }
  });

  // ---------- styles

  document.head.insertAdjacentHTML('beforeend', `<style>
    .ds-overlay { position: fixed; left: 5%; right: 5%; bottom: 8vh; z-index: 1000; pointer-events: none; text-align: center;
      color: #fff; white-space: pre-line; line-height: 1.25; text-shadow: 0 0 4px #000, 0 0 2px #000, 1px 1px 2px #000;
      transition: bottom .3s ease; } /* glide with the player controls' fade instead of jumping */
    .ds-main { font-size: calc(4.2vh * var(--ds-size, 1)); }
    .ds-sec { font-size: calc(3vh * var(--ds-size, 1)); opacity: .9; margin-top: .3em; } /* always 70 % of main */
    .ds-overlay div:empty { display: none; }
    .ds-list { position: fixed; left: 3vw; bottom: 15vh; z-index: 1001; width: max-content; max-width: min(60em, 70vw);
      max-height: 73vh; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: .15em;
      padding: .5em; background: rgba(0,0,0,.6); border-radius: 8px; }
    .ds-line { all: unset; display: block; flex-shrink: 0; padding: .35em .7em; border-radius: 6px; cursor: pointer;
      color: #fff; font-size: 2.4vh; line-height: 1.3; opacity: .7; }
    .ds-line:last-child { opacity: 1; }
    .ds-line:hover, .ds-line:focus-visible { opacity: 1; background: rgba(255,255,255,.14); }
    .ds-line-sec { font-size: .8em; color: #bbb; }
    .ds-img { display: block; width: auto; margin: .1em auto; }
    .ds-line .ds-img { margin: .1em 0; }
    .ds-modal { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); }
    .ds-box { background: #202020; color: #eee; padding: 1.2em 1.5em; border-radius: 8px; width: min(28em, 90vw); font-size: 1rem; }
    .ds-box h2 { margin: 0 0 .8em; font-weight: 500; }
    .ds-box label { display: block; margin: .7em 0; }
    .ds-box select, .ds-box input[type=number] { box-sizing: border-box; display: block; width: 100%; margin-top: .3em; padding: .45em; font: inherit; color: inherit; background: #2b2b2b; border: 1px solid #555; border-radius: 4px; }
    .ds-box .ds-check { display: flex; gap: .6em; align-items: center; }
    .ds-buttons { display: flex; gap: .5em; justify-content: flex-end; margin-top: 1.4em; }
    .ds-buttons button { padding: .55em 1.1em; font: inherit; color: inherit; background: #333; border: 0; border-radius: 4px; cursor: pointer; }
    .ds-buttons button[type=submit] { background: #00a4dc; color: #fff; }
    .ds-buttons .ds-left { margin-right: auto; }
    .ds-looks { display: flex; flex-wrap: wrap; gap: .6em 2.5em; margin: .9em 0; }
    .ds-look { display: flex; align-items: center; gap: .4em; }
    .ds-look-icon { display: flex; width: 2.2em; justify-content: center; opacity: .85; }
    .ds-look button { display: flex; padding: .3em .5em; color: inherit; background: #333; border: 0; border-radius: 4px; cursor: pointer; }
    .ds-look button:disabled { opacity: .3; cursor: default; }
    .ds-look svg { width: 1.3em; height: 1.3em; }
    /* Tooltips: on hover and on keyboard/remote focus (TVs have no hover; Qt may not show native title tips) */
    [data-tip] { position: relative; }
    [data-tip]:hover::after, [data-tip]:focus-visible::after {
      content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      z-index: 1; padding: .3em .6em; border-radius: 4px; background: #000; color: #fff; white-space: nowrap; pointer-events: none;
      font: 400 .85rem/1.3 system-ui, sans-serif; letter-spacing: normal; text-transform: none; font-feature-settings: normal; }
    .ds-gear[data-tip]:hover::after { bottom: auto; left: auto; top: 50%; right: calc(100% + 8px); transform: translateY(-50%); }
    .ds-box :focus-visible { outline: 2px solid #00a4dc; outline-offset: 1px; }
    .ds-gear { margin-left: auto; padding: 0 .6em 0 .8em; opacity: .7; }
    .ds-gear:hover { opacity: 1; }
  </style>`);

  window.doubleSubs = { pm, get state() { return state; } }; // console access while developing
  console.log(`[doublesubs] ${VERSION} loaded`);
})();
