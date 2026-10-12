// ==UserScript==
// @name         Pinterest Section Quick Save
// @namespace    local.pinterest.quicksave
// @version      0.7.0
// @description  「今の保存先」(ボード/セクション。候補を記憶して一覧から選ぶ)をパネルで設定し、S キー(1キー)またはボタンで1ピンずつ保存する(保存済みのピンでは保存を解除する)。外部通信なし。
// @match        https://jp.pinterest.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.7.0'; // @version と合わせる
  const HOTKEY = 'KeyS'; // 保存キー(修飾キーなしの1キー)。変えるときはKeyAなどのcodeを指定する
  const PANEL_ID = 'psq-panel';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = (key, fallback) => {
    try { return JSON.parse(GM_getValue(key, '')) ?? fallback; } catch { return fallback; }
  };
  const store = (key, value) => GM_setValue(key, JSON.stringify(value));

  let current = load('current', { board: '', section: '' });
  let history = load('history', []);
  let lastHover = null;

  const visible = (el) => el.getClientRects().length > 0;
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  // 表示中の要素のうち、テキストが完全一致する最も内側の要素を返す
  function findByText(root, label, exclude) {
    const sel = 'div,span,button,a,li,p,[role=button],[role=menuitem],[role=option]';
    const hits = [...root.querySelectorAll(sel)].filter((el) =>
      visible(el) &&
      !el.closest('#' + PANEL_ID) &&
      el !== exclude &&
      !(exclude && exclude.contains(el)) &&
      text(el) === label
    );
    return hits.find((el) => ![...el.children].some((c) => text(c) === label)) || hits[0] || null;
  }

  function toast(msg, isError) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'padding:10px 16px;border-radius:8px;color:#fff;font:14px sans-serif;' +
      'background:' + (isError ? '#c0392b' : '#2c3e50');
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  const CLICKABLE = 'button,[role=button],a,[aria-haspopup]';

  // ホバー中の要素から親をたどり、「保存」ラベルを含む最も近い祖先内で探す
  function findSaveLabel() {
    for (let el = lastHover; el && el !== document.documentElement; el = el.parentElement) {
      const hit = findByText(el, '保存');
      if (hit) return hit;
    }
    return findByText(document.body, '保存');
  }

  // ホバー中の要素から親をたどり、data-test-idで表示中の要素を探す
  function findByTestId(id) {
    const sel = '[data-test-id="' + id + '"]';
    for (let el = lastHover; el && el !== document.documentElement; el = el.parentElement) {
      const hit = [...el.querySelectorAll(sel)].find(visible);
      if (hit) return hit;
    }
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }

  function findDropdownButton() {
    const byId = findByTestId('PinBetterSaveDropdown');
    if (byId) return byId;
    const label = findSaveLabel();
    if (!label) return null;
    const saveBtn = label.closest(CLICKABLE) || label;
    let node = saveBtn;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      const parent = node.parentElement;
      const cand = [...parent.querySelectorAll(CLICKABLE)].find((b) =>
        visible(b) && !saveBtn.contains(b) && !b.contains(saveBtn) && !b.closest('#' + PANEL_ID));
      if (cand) return cand;
      node = parent;
    }
    return null;
  }

  // ボード名の行の右端(「＞」矢印)をクリックして、サブボードの画面へ進む
  function openSubboards(nameEl) {
    let row = nameEl;
    for (let i = 0; i < 8 && row.parentElement; i++) {
      const r = row.getBoundingClientRect();
      if (r.width > 200 && r.height > 30 && r.height < 120) break;
      row = row.parentElement;
    }
    const r = row.getBoundingClientRect();
    const target = document.elementFromPoint(r.right - 24, r.top + r.height / 2);
    if (!target) return false;
    realClick(target);
    return true;
  }

  // マウス操作と同じイベント列を要素の中心に送る(click()だけでは反応しない行があるため)
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, init));
    }
  }

  // 保存先ピッカー(見出しを含む最小の祖先)の中だけから探す。ピン上のボタンの文字を拾わないため
  function findInPicker(headerLabels, label) {
    for (const h of headerLabels) {
      const header = findByText(document.body, h);
      if (!header) continue;
      for (let el = header.parentElement; el; el = el.parentElement) {
        const hit = findByText(el, label, header);
        if (hit) return hit;
      }
    }
    return null;
  }

  // ---- 候補(ボード/セクション)の記憶 ----
  let catalog = load('catalog', { boards: [], sections: {} });
  let manageList = null;
  const saveCatalog = () => { store('catalog', catalog); refreshCatalogUI(); };

  function titledNames(root) {
    return [...root.querySelectorAll('[title]')]
      .filter((el) => visible(el) && text(el) === el.getAttribute('title'))
      .map((el) => ({ el, name: el.getAttribute('title') }));
  }

  function ancestorContaining(start, target) {
    for (let el = start.parentElement; el; el = el.parentElement) if (el.contains(target)) return el;
    return null;
  }

  // ボード一覧が全件表示されているときだけ、記憶している候補を画面の内容で置き換える
  function scanBoards(header, footer) {
    const root = ancestorContaining(header, footer);
    if (!root) return;
    const input = root.querySelector('input');
    if (input && input.value) return; // 絞り込み中は全件ではない
    const names = [...new Set(titledNames(root).map((t) => t.name))]
      .filter((n) => n !== 'プロフィール' && n !== '新規ボードを作成する');
    const m = text(root).match(/(\d+)\s*件のボード/);
    if (!m) return;
    const n = Number(m[1]);
    if (names.length !== n && names.length + 1 !== n) return; // 件数が合わなければ全件ではない
    if (JSON.stringify(names) === JSON.stringify(catalog.boards)) return;
    catalog.boards = names;
    for (const b of Object.keys(catalog.sections)) if (!names.includes(b)) delete catalog.sections[b];
    saveCatalog();
  }

  // サブボード画面が表示されたら、そのボードのセクション候補を画面の内容で置き換える
  function scanSubboards(header, footer) {
    const root = ancestorContaining(header, footer);
    if (!root) return;
    const items = titledNames(root);
    const before = items.filter((t) => header.compareDocumentPosition(t.el) & 2); // 見出しより前
    const after = items.filter((t) => header.compareDocumentPosition(t.el) & 4);  // 見出しより後
    if (!before.length) return;
    const board = before[before.length - 1].name;
    const secs = [...new Set(after.map((t) => t.name))].filter((n) => n !== 'サブボードを作成する');
    let changed = false;
    if (!catalog.boards.includes(board)) { catalog.boards.push(board); changed = true; }
    if (JSON.stringify(catalog.sections[board] || []) !== JSON.stringify(secs)) {
      if (secs.length) catalog.sections[board] = secs; else delete catalog.sections[board];
      changed = true;
    }
    if (changed) saveCatalog();
  }

  function scanPicker() {
    // 保存先の一覧が開いているときだけ調べる(通常時の負荷を避ける)
    if (!document.querySelector('[data-test-id="PinBetterSaveDropdown"][aria-expanded="true"]')) return;
    const subHeader = findByText(document.body, 'サブボード');
    const subFooter = findByText(document.body, 'サブボードを作成する');
    if (subHeader && subFooter) { scanSubboards(subHeader, subFooter); return; }
    const header = findByText(document.body, '保存する');
    const footer = findByText(document.body, '新規ボードを作成する');
    if (header && footer) scanBoards(header, footer);
  }

  let scanTimer = 0;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPicker, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });

  function removeBoard(name) {
    catalog.boards = catalog.boards.filter((b) => b !== name);
    delete catalog.sections[name];
    saveCatalog();
  }
  function removeSection(board, name) {
    const list = (catalog.sections[board] || []).filter((x) => x !== name);
    if (list.length) catalog.sections[board] = list; else delete catalog.sections[board];
    saveCatalog();
  }

  // 「候補の管理」の一覧を更新する(入力欄の候補は、▼を押したときにその都度作る)
  function refreshCatalogUI() {
    if (!manageList) return;
    const manageKey = JSON.stringify(catalog);
    if (manageList.dataset.key === manageKey) return;
    manageList.dataset.key = manageKey;

    const rowCss = 'display:flex;align-items:center;justify-content:space-between;margin-top:1px';
    const xCss = 'border:0;background:none;cursor:pointer;color:#c00';
    const rows = [];
    for (const b of catalog.boards) {
      const row = document.createElement('div');
      row.style.cssText = rowCss;
      const label = Object.assign(document.createElement('span'), { textContent: b });
      const x = Object.assign(document.createElement('button'), { textContent: '×', title: 'この候補を削除' });
      x.style.cssText = xCss;
      x.onclick = () => removeBoard(b);
      row.append(label, x);
      rows.push(row);
      for (const sec of catalog.sections[b] || []) {
        const r2 = document.createElement('div');
        r2.style.cssText = rowCss + ';padding-left:14px;color:#555';
        const l2 = Object.assign(document.createElement('span'), { textContent: '└ ' + sec });
        const x2 = Object.assign(document.createElement('button'), { textContent: '×', title: 'この候補を削除' });
        x2.style.cssText = xCss;
        x2.onclick = () => removeSection(b, sec);
        r2.append(l2, x2);
        rows.push(r2);
      }
    }
    const clear = Object.assign(document.createElement('button'), { textContent: '候補をすべてクリア' });
    clear.style.cssText = 'margin-top:6px;padding:3px 6px;cursor:pointer';
    clear.onclick = () => { catalog = { boards: [], sections: {} }; saveCatalog(); };
    manageList.replaceChildren(...rows, clear);
  }

  // quiet: キー操作用。ピンにマウスが乗っていないときは、通知を出さず何もしない
  async function savePin(quiet) {
    const dropdown = findDropdownButton();
    const saved = !dropdown && findByTestId('saved-button');
    if (quiet && !dropdown && !saved) return;
    if (saved) {
      // 保存済みのピン: 「保存済み」ボタンを押すと保存が削除される(トグル)
      realClick(saved);
      return;
    }
    if (!current.board) { toast('先に保存先のボードを選択してください', true); return; }
    if (!dropdown) { toast('保存ボタンが見つかりません(ピンにマウスを乗せてください)', true); return; }

    if (dropdown.getAttribute('aria-expanded') !== 'true') dropdown.click(); // 開いたままなら閉じてしまうので押さない
    const boardEl = await waitFor(() => findInPicker(['保存する'], current.board));
    if (!boardEl) {
      if (findByText(document.body, '保存する')) removeBoard(current.board); // 一覧が開いているのに無い=削除/改名済み
      toast('ボード「' + current.board + '」が一覧に見つかりません', true);
      return;
    }

    if (!current.section) {
      realClick(boardEl); // セクション指定なし: ボード行のクリックで保存
      // サブボードを持つボードは選択画面が開くので、「ボード」欄のボード自身をもう一度クリックする
      const header = await waitFor(() => findByText(document.body, 'サブボード'), 1500);
      if (header) {
        const self = findInPicker(['サブボード'], current.board);
        if (!self) { toast('ボード「' + current.board + '」の項目が見つかりません', true); return; }
        realClick(self);
      }
    } else {
      if (!openSubboards(boardEl)) { toast('ボード行の矢印を押せませんでした', true); return; }
      const header = await waitFor(() => findByText(document.body, 'サブボード'));
      if (!header) { toast('サブボードの画面が開きませんでした(このボードにはサブボードがない可能性)', true); return; }
      const sectionEl = findInPicker(['サブボード'], current.section);
      if (!sectionEl) {
        removeSection(current.board, current.section);
        toast('サブボード「' + current.section + '」が見つかりません', true);
        return;
      }
      realClick(sectionEl);
    }
  }

  function setCurrent(board, section) {
    current = { board: board.trim(), section: section.trim() };
    store('current', current);
    if (current.board) {
      history = history.filter((h) => !(h.board === current.board && h.section === current.section));
      history.unshift({ ...current });
      history = history.slice(0, 20);
      store('history', history);
    }
    render();
  }

  // ---- UI ----
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483646;width:240px;padding:10px;' +
    'background:#fff;color:#111;border:1px solid #ccc;border-radius:10px;font:13px sans-serif;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.2)';
  document.documentElement.appendChild(panel);
  // Pinterestが画面を作り直してパネルが消えた場合に付け直す
  setInterval(() => {
    if (!panel.isConnected) document.documentElement.appendChild(panel);
  }, 1000);

  function render() {
    panel.innerHTML = '';
    const el = (tag, props = {}, css = '') => {
      const e = document.createElement(tag);
      Object.assign(e, props);
      if (css) e.style.cssText = css;
      return e;
    };
    const btnCss = 'padding:5px 8px;border:0;border-radius:6px;background:#e60023;color:#fff;cursor:pointer';

    panel.appendChild(el('div', { textContent: '現在の保存先 (v' + VERSION + ')' }, 'font-weight:bold;margin-bottom:4px'));
    // 選択専用の欄。クリックで全候補の一覧を開き、選ぶと欄に表示される(文字は入力しない)
    const combo = (placeholder, value, getOptions, emptyMsg, clearLabel, onPick) => {
      const state = { value };
      const wrap = el('div', {}, 'position:relative;margin:2px 0');
      const btn = el('button', { type: 'button' },
        'width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid #bbb;border-radius:4px;' +
        'background:#fff;cursor:pointer;text-align:left;display:flex;justify-content:space-between;gap:6px');
      const label = el('span', {}, 'overflow:hidden;white-space:nowrap;text-overflow:ellipsis');
      btn.append(label, el('span', { textContent: '▼' }, 'color:#666'));
      const show = () => {
        label.textContent = state.value || placeholder;
        label.style.color = state.value ? '#111' : '#888';
      };
      show();
      const menu = el('div', {},
        'display:none;position:absolute;left:0;right:0;bottom:100%;max-height:180px;overflow:auto;' +
        'background:#fff;border:1px solid #bbb;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:1');
      menu.dataset.psqMenu = '1';
      const pick = (v) => {
        const changed = v !== state.value;
        state.value = v;
        menu.style.display = 'none';
        show();
        if (changed && onPick) onPick();
      };
      const item = (text, v, color) => {
        const it = el('div', { textContent: text },
          'padding:5px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + (color || '#111'));
        it.onmouseenter = () => { it.style.background = '#eee'; };
        it.onmouseleave = () => { it.style.background = ''; };
        it.onclick = () => pick(v);
        return it;
      };
      btn.onclick = () => {
        if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
        const opts = getOptions();
        const items = opts.map((o) => item(o, o));
        if (clearLabel) items.unshift(item(clearLabel, '', '#888'));
        menu.replaceChildren(...(items.length ? items : [el('div', { textContent: emptyMsg }, 'padding:5px 8px;color:#888')]));
        menu.style.display = 'block';
      };
      wrap.append(btn, menu);
      return { wrap, state, show };
    };
    const sectionCombo = combo('セクション(指定なし)', current.section,
      () => catalog.sections[board.value.trim()] || [], '候補なし', '(指定なし)');
    const boardCombo = combo('ボードを選択', current.board, () => catalog.boards,
      '候補なし(保存先の一覧を一度開くと取り込まれます)', '',
      () => { sectionCombo.state.value = ''; sectionCombo.show(); }); // ボードを変えたらセクションは選び直す
    const board = boardCombo.state;
    const section = sectionCombo.state;
    panel.append(boardCombo.wrap, sectionCombo.wrap);

    const row = el('div', {}, 'display:flex;gap:6px;margin-top:4px');
    const setBtn = el('button', { textContent: '設定' }, btnCss + ';background:#555');
    setBtn.onclick = () => setCurrent(board.value, section.value);
    const saveBtn = el('button', { textContent: '保存/解除 (S)' }, btnCss + ';flex:1');
    saveBtn.onmousedown = (e) => e.preventDefault(); // ホバー状態を保つ
    saveBtn.onclick = () => { setCurrent(board.value, section.value); savePin(); };
    row.append(setBtn, saveBtn);
    panel.appendChild(row);

    const details = el('details', {}, 'margin-top:8px');
    details.appendChild(el('summary', { textContent: '候補の管理' }, 'cursor:pointer;color:#666'));
    manageList = el('div', {}, 'max-height:160px;overflow:auto;margin-top:4px');
    details.appendChild(manageList);
    panel.appendChild(details);
    refreshCatalogUI();

    if (history.length) {
      panel.appendChild(el('div', { textContent: '履歴' }, 'margin-top:8px;color:#666'));
      history.forEach((h, i) => {
        const line = el('div', {}, 'display:flex;align-items:center;margin-top:2px');
        const pick = el('button', { textContent: h.board + (h.section ? ' / ' + h.section : '') },
          'flex:1;text-align:left;padding:3px 6px;border:1px solid #ddd;border-radius:4px;background:#f6f6f6;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis');
        pick.onclick = () => setCurrent(h.board, h.section);
        const del = el('button', { textContent: '×' }, 'border:0;background:none;cursor:pointer;color:#888');
        del.onclick = () => { history.splice(i, 1); store('history', history); render(); };
        line.append(pick, del);
        panel.appendChild(line);
      });
    }
  }
  render();
  // 候補一覧の外側をクリックしたら閉じる
  document.addEventListener('mousedown', (e) => {
    for (const m of panel.querySelectorAll('[data-psq-menu]')) {
      if (!m.parentElement.contains(e.target)) m.style.display = 'none';
    }
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (!e.target.closest || !e.target.closest('#' + PANEL_ID)) lastHover = e.target;
  }, { passive: true });

  // Pinterest側より先に受け取るため、キャプチャ段階で登録する
  document.addEventListener('keydown', (e) => {
    if (e.code !== HOTKEY || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return; // 文字入力中は何もしない
    e.preventDefault();
    e.stopImmediatePropagation();
    savePin(true);
  }, true);
})();
