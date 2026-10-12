// ==UserScript==
// @name         Pinterest Section Quick Save
// @namespace    local.pinterest.quicksave
// @version      0.2.3
// @description  「今の保存先」(ボード/セクション)をパネルで設定し、Alt+Sまたはボタンで1ピンずつ保存する。外部通信なし。
// @match        https://jp.pinterest.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.2.3'; // @version と合わせる
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

  // ホバー中の要素から親をたどり、保存先プルダウンのボタンを識別子で探す(「保存済み」表示でも使える)
  function findDropdownByTestId() {
    const sel = '[data-test-id="PinBetterSaveDropdown"]';
    for (let el = lastHover; el && el !== document.documentElement; el = el.parentElement) {
      const hit = [...el.querySelectorAll(sel)].find(visible);
      if (hit) return hit;
    }
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }

  function findDropdownButton() {
    const byId = findDropdownByTestId();
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

  async function savePin() {
    if (!current.board) { toast('先に保存先のボード名を設定してください', true); return; }
    const dropdown = findDropdownButton();
    if (!dropdown) { toast('保存ボタンが見つかりません(ピンにマウスを乗せてください)', true); return; }

    if (dropdown.getAttribute('aria-expanded') !== 'true') dropdown.click(); // 開いたままなら閉じてしまうので押さない
    const boardEl = await waitFor(() => findInPicker(['保存する'], current.board));
    if (!boardEl) { toast('ボード「' + current.board + '」が一覧に見つかりません', true); return; }

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
      if (!sectionEl) { toast('サブボード「' + current.section + '」が見つかりません', true); return; }
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
    const inputCss = 'width:100%;box-sizing:border-box;margin:2px 0;padding:4px;border:1px solid #bbb;border-radius:4px';
    const btnCss = 'padding:5px 8px;border:0;border-radius:6px;background:#e60023;color:#fff;cursor:pointer';

    panel.appendChild(el('div', { textContent: '現在の保存先 (v' + VERSION + ')' }, 'font-weight:bold;margin-bottom:4px'));
    const board = el('input', { placeholder: 'ボード名', value: current.board }, inputCss);
    const section = el('input', { placeholder: 'セクション名(省略可)', value: current.section }, inputCss);
    panel.append(board, section);

    const row = el('div', {}, 'display:flex;gap:6px;margin-top:4px');
    const setBtn = el('button', { textContent: '設定' }, btnCss + ';background:#555');
    setBtn.onclick = () => setCurrent(board.value, section.value);
    const saveBtn = el('button', { textContent: 'このピンを保存 (Alt+S)' }, btnCss + ';flex:1');
    saveBtn.onmousedown = (e) => e.preventDefault(); // ホバー状態を保つ
    saveBtn.onclick = () => { setCurrent(board.value, section.value); savePin(); };
    row.append(setBtn, saveBtn);
    panel.appendChild(row);

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
  document.addEventListener('mousemove', (e) => {
    if (!e.target.closest || !e.target.closest('#' + PANEL_ID)) lastHover = e.target;
  }, { passive: true });

  // Pinterest側より先に受け取るため、キャプチャ段階で登録する
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      e.stopImmediatePropagation();
      savePin();
    }
  }, true);
})();
