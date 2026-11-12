(() => {
  const S = window.TrefacSearch;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // 価格の幅（円、税込）。下限以上・上限未満
  const PRICE = [["p1", "〜2,999円", 0, 3000], ["p2", "3,000〜5,999円", 3000, 6000], ["p3", "6,000〜9,999円", 6000, 10000],
    ["p4", "1万〜2万9,999円", 10000, 30000], ["p5", "3万〜9万9,999円", 30000, 100000], ["p6", "10万円〜", 100000, Infinity]];
  const priceBand = (n) => PRICE.find((b) => n >= b[2] && n < b[3])[0];
  const PRICE_LABEL = Object.fromEntries(PRICE.map((b) => [b[0], b[1]]));
  // 色の名前。並びは虹の順
  const COLOR = { red: "赤", orange: "オレンジ", yellow: "黄", green: "緑・カーキ", blue: "青・紺", purple: "紫", pink: "ピンク",
    brown: "茶", beige: "ベージュ", white: "白", gray: "グレー", black: "黒", silver: "シルバー", gold: "ゴールド", multi: "いろいろな色" };
  const COND_ORDER = [6, 5, 4, 3, 2, 1];
  const COND_SHORT = { 6: "未使用", 5: "未使用に近い", 4: "使用感少なめ", 3: "やや傷・汚れ", 2: "傷・汚れあり", 1: "使用感あり" };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const EASE_OUT = "cubic-bezier(.22, .8, .24, 1)";
  const EASE_IN = "cubic-bezier(.4, 0, 1, 1)";
  const done = (a) => a.finished.catch(() => {});
  const PAGE = 48;

  let items = [], cats = [], conds = {}, base = "", latest = 0, partial = true, brandCount = new Map();
  let current = { hits: [], mode: "none", terms: [] }, filtered = [];
  const state = { q: "", prices: new Set(), colors: new Set(), sizes: new Set(), conds: new Set(), brands: new Set(), cat: [],
    mine: false, today: false, fresh: false, sale: false, sort: "rel", shown: PAGE };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  let myBrands = new Set(store.get("myBrands", []));
  const saveMine = () => store.set("myBrands", [...myBrands]);

  // ---------- URL と状態 ----------
  function readURL() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.prices = new Set((p.get("price") || "").split(",").filter((b) => PRICE_LABEL[b]));
    state.colors = new Set((p.get("color") || "").split(",").filter((c) => COLOR[c]));
    state.sizes = new Set(p.getAll("size"));
    state.conds = new Set((p.get("cond") || "").split(",").map(Number).filter((c) => COND_SHORT[c]));
    state.brands = new Set(p.getAll("brand"));
    state.cat = (p.get("cat") || "").split(">").filter(Boolean);
    state.mine = p.get("mine") === "1";
    state.today = p.get("today") === "1";
    state.fresh = p.get("new") === "1";
    state.sale = p.get("sale") === "1";
    state.sort = ["new", "low", "high"].includes(p.get("sort")) ? p.get("sort") : "rel";
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    for (const b of state.brands) p.append("brand", b);
    if (state.cat.length) p.set("cat", state.cat.join(">"));
    for (const s of state.sizes) p.append("size", s);
    if (state.colors.size) p.set("color", [...state.colors].join(","));
    if (state.conds.size) p.set("cond", [...state.conds].join(","));
    if (state.prices.size) p.set("price", [...state.prices].join(","));
    if (state.mine) p.set("mine", "1");
    if (state.today) p.set("today", "1");
    if (state.fresh) p.set("new", "1");
    if (state.sale) p.set("sale", "1");
    if (state.sort !== "rel") p.set("sort", state.sort);
    const qs = p.toString();
    history.replaceState(null, "", qs ? "?" + qs : location.pathname);
  }

  // ---------- 絞り込み ----------
  const pathMatches = (path, n = state.cat.length) => {
    for (let i = 0; i < n; i++) if (cats[path[i]] !== state.cat[i]) return false;
    return true;
  };
  function passes(it, skip) {
    if (skip !== "brand" && state.brands.size && !state.brands.has(it.brand)) return false;
    if (state.mine && !myBrands.has(it.brand)) return false;
    if (skip !== "cat" && state.cat.length && !pathMatches(it.path)) return false;
    if (skip !== "size" && state.sizes.size && !state.sizes.has(it.size)) return false;
    if (skip !== "color" && state.colors.size && !state.colors.has(it.cc)) return false;
    if (skip !== "cond" && state.conds.size && !state.conds.has(it.cond)) return false;
    if (skip !== "price" && state.prices.size && !state.prices.has(it.band)) return false;
    if (state.today && it.first !== latest) return false;
    if (state.fresh && !(it.flags & 1)) return false;
    if (state.sale && !(it.flags & 2)) return false;
    return true;
  }
  // 新着順：このサイトで見つけた日の新しい順 → トレファクの登録番号の新しい順
  const byNew = (a, b) => b.item.first - a.item.first || b.item.c - a.item.c;
  let priceTrimmed = false;
  function sortList(list) {
    if (state.sort === "low" || state.sort === "high") {
      // 価格順では検索語の合い方が並びに出ないので、色や店の名前だけで当たった商品は外す
      priceTrimmed = list.some((h) => h.strong) && list.some((h) => !h.strong);
      if (priceTrimmed) list = list.filter((h) => h.strong);
      const dir = state.sort === "low" ? 1 : -1;
      return list.slice().sort((a, b) => dir * (a.item.price - b.item.price) || byNew(a, b));
    }
    if (state.sort === "new" || current.mode === "none") return list.slice().sort(byNew);
    return list;
  }

  function runSearch() {
    current = S.search(items, state.q);
    refresh();
  }
  function refresh(keepShown) {
    if (!keepShown) state.shown = PAGE;
    priceTrimmed = false;
    filtered = sortList(current.hits.filter((h) => passes(h.item)));
    renderFilters();
    renderMine();
    renderResults();
    writeURL();
  }

  // ---------- 絞り込み欄 ----------
  const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "FREE"];
  function sizeKey(s) {
    const i = SIZE_ORDER.indexOf(s);
    if (i >= 0) return [0, i, s];
    const n = parseFloat(s);
    if (!isNaN(n) && /^[\d.]+$/.test(s)) return [1, n, s];
    return [2, 0, s];
  }
  const cmpSize = (a, b) => { const x = sizeKey(a), y = sizeKey(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
  const star = (b) => `<button type="button" class="star" data-star="${esc(b)}" aria-pressed="${myBrands.has(b)}" title="${myBrands.has(b) ? "マイブランドから外す" : "マイブランドに入れる"}">${myBrands.has(b) ? "★" : "☆"}</button>`;

  function renderFilters() {
    const count = (skip, key) => {
      const m = new Map();
      for (const h of current.hits) if (passes(h.item, skip)) { const k = key(h.item); m.set(k, (m.get(k) || 0) + 1); }
      return m;
    };

    // ブランド：選んだブランド → 多い順
    const bc = count("brand", (it) => it.brand);
    const all = $("#f-brand").dataset.all === "1";
    const top = [...bc].filter(([b]) => b && !state.brands.has(b)).sort((a, b) => b[1] - a[1]);
    const shown = [...[...state.brands].map((b) => [b, bc.get(b) || 0]), ...top.slice(0, all ? 60 : 12)];
    let bh = shown.map(([b, n]) => `<div class="brow">${star(b)}<button type="button" class="bname" data-brand="${esc(b)}" aria-pressed="${state.brands.has(b)}"><span>${esc(b)}</span><span class="n">${n.toLocaleString()}</span></button></div>`).join("");
    if (top.length > (all ? 60 : 12)) bh += `<button type="button" class="catmore" data-more="1">${all ? "" : `ほか${(top.length - 12).toLocaleString()}ブランド・多い順に60まで表示`}</button>`;
    if (!shown.length) bh = `<p class="path">該当なし</p>`;
    $("#f-brand").innerHTML = bh;

    // カテゴリ（いまの階層の 1 つ下を数える）
    const level = state.cat.length;
    const counts = new Map();
    for (const h of current.hits) {
      const it = h.item;
      if (level >= 2 || !passes(it, "cat") || !pathMatches(it.path, level)) continue;
      const name = cats[it.path[level]];
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const kids = [...counts].sort((a, b) => b[1] - a[1]);
    let html = "";
    if (level) {
      html += `<button type="button" class="cat up" data-depth="0">← すべてのカテゴリ</button>`;
      state.cat.forEach((c, i) => { html += `<button type="button" class="cat lv${i + 1}" aria-pressed="true" data-depth="${i + 1}">${esc(c)}</button>`; });
    }
    html += kids.map(([name, n]) =>
      `<button type="button" class="cat lv${level + 1}" aria-pressed="false" data-pick="${esc(name)}">${esc(name)}<span class="n">${n.toLocaleString()}</span></button>`).join("");
    if (!kids.length && !level) html += `<p class="path">該当なし</p>`;
    $("#f-cat").innerHTML = html;

    // サイズ：多い順に 24 個 → 並べ直す
    const sc = count("size", (it) => it.size);
    sc.delete("");
    for (const s of state.sizes) if (!sc.has(s)) sc.set(s, 0);
    const sizes = [...sc].sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0]).sort(cmpSize);
    $("#g-size").hidden = !sizes.length;
    $("#f-size").innerHTML = sizes.map((s) =>
      `<button type="button" class="size" data-size="${esc(s)}" aria-pressed="${state.sizes.has(s)}" title="${esc(s)} ${sc.get(s)}件">${esc(s)}<span class="n">${sc.get(s).toLocaleString()}</span></button>`).join("");

    // 色
    const kc = count("color", (it) => it.cc);
    const sw = $("#f-color");
    if (!sw.children.length) sw.innerHTML = Object.keys(COLOR).map((c) => `<button type="button" class="swatch" data-color="${c}" aria-pressed="false"></button>`).join("");
    for (const b of sw.children) {
      const c = b.dataset.color, n = kc.get(c) || 0, on = state.colors.has(c);
      b.hidden = !n && !on;
      b.setAttribute("aria-pressed", on);
      b.setAttribute("aria-label", `${COLOR[c]} ${n.toLocaleString()}件`);
      b.title = `${COLOR[c]} ${n.toLocaleString()}件`;
    }

    // 状態
    const cc = count("cond", (it) => it.cond);
    $("#f-cond").innerHTML = COND_ORDER.map((c) =>
      `<label class="check"><input type="checkbox" value="${c}" ${state.conds.has(c) ? "checked" : ""}>${esc(conds[c] || COND_SHORT[c])}<span class="n">${(cc.get(c) || 0).toLocaleString()}</span></label>`).join("");

    // 価格
    const pc = count("price", (it) => it.band);
    $("#f-price").innerHTML = PRICE.map(([b, label]) =>
      `<label class="check"><input type="checkbox" value="${b}" ${state.prices.has(b) ? "checked" : ""}>${label}<span class="n">${(pc.get(b) || 0).toLocaleString()}</span></label>`).join("");

    setSeg($("#sort"), "sort", state.sort);
    $("#f-mine").checked = state.mine;
    $("#f-mine").disabled = !myBrands.size && !state.mine;
    $("#l-mine").title = myBrands.size ? "" : "ブランドの ☆ を押すとマイブランドに入ります";
    $("#f-today").checked = state.today;
    $("#f-new").checked = state.fresh;
    $("#f-sale").checked = state.sale;

    // 付いている条件のチップ
    const chips = [];
    for (const b of state.brands) chips.push([b, () => state.brands.delete(b)]);
    if (state.mine) chips.push(["マイブランドだけ", () => (state.mine = false)]);
    if (state.cat.length) chips.push([state.cat.join(" › "), () => (state.cat = [])]);
    if (state.sizes.size) chips.push([`サイズ：${[...state.sizes].sort(cmpSize).join("・")}`, () => (state.sizes = new Set())]);
    if (state.colors.size) chips.push([`色：${[...state.colors].map((c) => COLOR[c]).join("・")}`, () => (state.colors = new Set())]);
    if (state.conds.size) chips.push([`状態：${[...state.conds].sort((a, b) => b - a).map((c) => COND_SHORT[c]).join("・")}`, () => (state.conds = new Set())]);
    PRICE.forEach(([b, label]) => state.prices.has(b) && chips.push([label, () => state.prices.delete(b)]));
    if (state.today) chips.push(["今日見つけた", () => (state.today = false)]);
    if (state.fresh) chips.push(["NEW", () => (state.fresh = false)]);
    if (state.sale) chips.push(["SALE", () => (state.sale = false)]);
    chipActions = chips.map((c) => c[1]);
    $("#chips").innerHTML = chips.map((c, i) => `<button type="button" class="chip${prevChips.has(c[0]) ? "" : " pop"}" data-chip="${i}">${esc(c[0])}<span aria-label="外す">×</span></button>`).join("");
    prevChips = new Set(chips.map((c) => c[0]));
    const catKey = state.cat.join(">");
    if (catKey !== prevCat) replay($("#f-cat"), "enter");
    prevCat = catKey;
    $("#filterBadge").textContent = chips.length || "";
  }
  let chipActions = [], prevChips = new Set(), prevCat = "";
  function setSeg(el, key, value) {
    [...el.querySelectorAll("button")].forEach((b, i) => {
      const on = b.dataset[key] === value;
      b.setAttribute("aria-checked", on);
      if (on) el.dataset.active = i;
    });
  }
  function replay(el, cls) {
    if (reduceMotion.matches) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  // マイブランドの並び（検索バーの下）
  function renderMine() {
    const list = [...myBrands];
    $("#mybar").hidden = !list.length;
    $("#mychips").innerHTML = list.map((b) => {
      const n = brandCount.get(b) || 0;
      return `<button type="button" class="mychip" data-brand="${esc(b)}" aria-pressed="${state.brands.has(b) && state.brands.size === 1}">${esc(b)}${partial ? "" : `<span class="n">${n.toLocaleString()}</span>`}</button>`;
    }).join("") + (list.length > 1 ? `<button type="button" class="mychip all" data-mine="1" aria-pressed="${state.mine}">まとめて見る</button>` : "");
  }

  // ---------- 結果 ----------
  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    let normStr = "";
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const n = S.norm(text[i]);
      for (const ch of n) { normStr += ch; map.push(i); }
    }
    const marks = new Array(text.length).fill(false);
    for (const t of terms) for (const a of t.hl || t.alts) {
      if (!a || a.length < 2) continue;
      let from = 0, at;
      while ((at = normStr.indexOf(a, from)) !== -1) {
        for (let k = at; k < at + a.length; k++) marks[map[k]] = true;
        from = at + a.length;
      }
    }
    let out = "", open = false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] && !open) { out += "<mark>"; open = true; }
      if (!marks[i] && open) { out += "</mark>"; open = false; }
      out += esc(text[i]);
    }
    return out + (open ? "</mark>" : "");
  }
  const yen = (n) => n.toLocaleString();
  const imgURL = (it) => `${base}/image/item/${it.id}/w300/${it.id}_${typeof it.img === "number" ? `01_${it.img}w.jpeg` : it.img}`;
  function card(it, terms, i = 99) {
    const pct = it.prev > it.price ? Math.round((1 - it.price / it.prev) * 100) : 0;
    const flag = it.first === latest && latest ? `<span class="flag today">今日</span>`
      : it.flags & 1 ? `<span class="flag new">NEW</span>` : "";
    const sale = it.flags & 2 ? `<span class="flag sale">${pct ? `-${pct}%` : "SALE"}</span>` : "";
    const price = `<span class="pricetag${it.flags & 2 ? " sale" : ""}">${pct ? `<s>${yen(it.prev)}</s>` : ""}${yen(it.price)}<em>円</em></span>`;
    const spec = [it.size && `サイズ ${esc(it.size)}`, COND_SHORT[it.cond]].filter(Boolean).join("・");
    return `<a class="card in" style="--i:${Math.min(i, 14)}" href="${base}/store/${it.id}/c${it.c}/" target="_blank" rel="noopener">
      <div class="thumb"><img src="${esc(imgURL(it))}" alt="" loading="lazy" decoding="async"><span class="flags">${flag}${sale}</span>${price}</div>
      <div class="title"><span class="bname-card">${highlight(it.brand, terms)}</span><span class="pname">${highlight(it.name, terms)}</span></div>
      <div class="spec"><span class="cdot" data-c="${it.cc}" title="${esc(it.color)}"></span><span>${spec}</span><span class="shop">${esc(it.shop)}</span></div>
    </a>`;
  }

  function renderResults() {
    const n = filtered.length;
    const any = state.q || n !== items.length;
    $("#count").innerHTML = any ? `<b>${n.toLocaleString()}</b>件${state.q ? `　「${esc(state.q)}」` : ""}` : `全<b>${n.toLocaleString()}</b>件`;

    const notice = $("#notice");
    const wasNotice = notice.hidden ? "" : notice.textContent;
    if (partial && any) {
      notice.hidden = false;
      notice.textContent = "全商品を読み込んでいます。いまは新着の一部から表示しています…";
    } else if (current.mode === "some") {
      notice.hidden = false;
      notice.textContent = "すべての語を含む商品がなかったので、どれかの語を含む商品を表示しています。";
    } else if (current.mode === "fuzzy") {
      notice.hidden = false;
      notice.textContent = `「${state.q}」と一致する商品がなかったので、似た表記の商品を表示しています。`;
    } else if (priceTrimmed) {
      notice.hidden = false;
      notice.textContent = `価格順では、ブランド・商品名・カテゴリに「${state.q.trim()}」が当たる商品だけを並べています。`;
    } else notice.hidden = true;
    if (!notice.hidden && notice.textContent !== wasNotice) replay(notice, "pop");

    const terms = current.mode === "fuzzy" ? [] : current.terms;
    if (!n) {
      const hit = current.hits.length > 0;
      $("#grid").innerHTML = `<div class="empty"><b>${partial ? "読み込み中…" : "見つかりませんでした"}</b>${partial ? "" : hit
        ? `<span>検索語には${current.hits.length.toLocaleString()}件が当たっています。絞り込みを外すと表示されます。</span><button type="button" class="ex" id="emptyReset">絞り込みを外す</button>`
        : `<span>ブランドは英語でもカタカナでも探せます。語を減らすのも効きます。</span>`}</div>`;
      $("#more").hidden = true;
      return;
    }
    $("#grid").innerHTML = filtered.slice(0, state.shown).map((h, i) => card(h.item, terms, i)).join("");
    markReady($("#grid"));
    $("#more").hidden = n <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り${(n - state.shown).toLocaleString()}件）`;
  }
  function markReady(root) {
    requestAnimationFrame(() => root.querySelectorAll(".thumb img:not(.ready)").forEach((img) => {
      if (img.complete && img.naturalWidth) img.classList.add("ready");
    }));
  }
  function showMore() {
    if (state.shown >= filtered.length) return;
    const terms = current.mode === "fuzzy" ? [] : current.terms;
    const next = filtered.slice(state.shown, state.shown + PAGE).map((h, i) => card(h.item, terms, i)).join("");
    state.shown += PAGE;
    $("#grid").insertAdjacentHTML("beforeend", next);
    markReady($("#grid"));
    $("#more").hidden = filtered.length <= state.shown;
    $("#moreBtn").textContent = `もっと見る（残り${(filtered.length - state.shown).toLocaleString()}件）`;
  }

  // ---------- 候補（サジェスト） ----------
  let sugg = [], suggIdx = -1, brandKeys = [];
  const pickBrand = (b) => { state.brands = new Set([b]); $("#q").value = ""; setQuery(""); };
  function renderSuggest() {
    const q = S.norm($("#q").value);
    const box = $("#suggest");
    sugg = [];
    if (!q) {
      sugg = [
        ...[...myBrands].slice(0, 4).map((b) => ({ kind: "マイ", label: b, act: () => pickBrand(b) })),
        ...store.get("recent", []).slice(0, 5).map((w) => ({ kind: "履歴", label: w, act: () => setQuery(w) })),
      ];
    } else {
      // ブランド：名前かカナの頭に当たるもの → 途中に当たるもの。それぞれ件数の多い順
      const alts = S.expand(q);
      const head = [], mid = [];
      for (const k of brandKeys) {
        if (alts.some((a) => k.full.startsWith(a) || k.kana.startsWith(a))) head.push(k);
        else if (q.length >= 2 && alts.some((a) => k.full.includes(a) || k.kana.includes(a))) mid.push(k);
        if (head.length >= 6) break;
      }
      sugg = [...head, ...mid].slice(0, 6).map((k) => ({
        kind: "ブランド", label: k.brand, sub: k.sub, n: k.n, act: () => { remember(k.brand); pickBrand(k.brand); },
      }));
      // カテゴリ
      const seen = new Set();
      for (let gi = 0; gi < catPaths.length; gi++) {
        const p = catPaths[gi];
        const hay = S.norm(p.map((i) => cats[i]).join(" "));
        if (alts.some((a) => hay.includes(a)) && !seen.has(p.join(">"))) {
          seen.add(p.join(">"));
          sugg.push({ kind: "カテゴリ", label: p.map((i) => cats[i]).join(" › "), act: () => { state.cat = p.map((i) => cats[i]); $("#q").value = ""; setQuery(""); } });
        }
        if (sugg.length >= 9) break;
      }
    }
    suggIdx = -1;
    const show = sugg.length && document.activeElement === $("#q");
    if (show && box.hidden) { box.hidden = false; replay(box, "pop"); }
    else if (!show) closeSuggest();
    box.innerHTML = sugg.map((s, i) => `<li role="option" id="sg${i}" data-i="${i}" aria-selected="false"><span class="kind">${s.kind}</span><span>${esc(s.label)}${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</span>${s.n ? `<span class="n">${s.n.toLocaleString()}件</span>` : ""}</li>`).join("");
  }
  let catPaths = [];
  function moveSuggest(d) {
    if (!sugg.length) return;
    suggIdx = (suggIdx + d + sugg.length) % sugg.length;
    document.querySelectorAll(".suggest li").forEach((li, i) => li.setAttribute("aria-selected", i === suggIdx));
    $("#q").setAttribute("aria-activedescendant", "sg" + suggIdx);
  }
  function closeSuggest() {
    const box = $("#suggest");
    suggIdx = -1;
    if (box.hidden || box.dataset.closing) return;
    if (reduceMotion.matches) { box.hidden = true; return; }
    box.dataset.closing = "1";
    done(box.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], { duration: 120, easing: EASE_IN }))
      .then(() => { box.hidden = true; delete box.dataset.closing; });
  }

  function setQuery(q) {
    $("#q").value = q;
    state.q = q;
    $("#clear").hidden = !q;
    runSearch();
  }
  function remember(q) {
    q = q.trim();
    if (!q) return;
    store.set("recent", [q, ...store.get("recent", []).filter((w) => w !== q)].slice(0, 10));
  }
  function toggleMine(b) {
    myBrands.has(b) ? myBrands.delete(b) : myBrands.add(b);
    saveMine();
    if (!myBrands.size) state.mine = false;
    refresh(true);
  }

  // ---------- イベント ----------
  function bind() {
    let timer;
    $("#q").addEventListener("input", (e) => {
      const wasHidden = $("#clear").hidden;
      $("#clear").hidden = !e.target.value;
      if (wasHidden && e.target.value) replay($("#clear"), "pop");
      renderSuggest();
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value; runSearch(); }, items.length > 50000 ? 260 : 140);
    });
    $("#q").addEventListener("focus", renderSuggest);
    $("#q").addEventListener("blur", () => setTimeout(closeSuggest, 150));
    $("#q").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); }
      else if (e.key === "Escape" && !$("#suggest").hidden) { e.preventDefault(); closeSuggest(); }
      else if (e.key === "Enter" && suggIdx >= 0) { e.preventDefault(); sugg[suggIdx].act(); closeSuggest(); }
    });
    $("#form").addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(timer);
      state.q = $("#q").value;
      remember(state.q);
      closeSuggest();
      $("#q").blur();
      runSearch();
    });
    $("#suggest").addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); sugg[+li.dataset.i].act(); closeSuggest(); }
    });
    $("#clear").addEventListener("click", () => { setQuery(""); $("#q").focus(); });
    document.querySelectorAll(".ex").forEach((b) => b.addEventListener("click", () => { setQuery(b.textContent); remember(b.textContent); }));

    $("#mychips").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.mine) { state.mine = !state.mine; if (state.mine) state.brands = new Set(); }
      else if (state.brands.size === 1 && state.brands.has(b.dataset.brand)) state.brands = new Set();
      else { state.brands = new Set([b.dataset.brand]); state.mine = false; }
      refresh();
    });
    $("#f-brand").addEventListener("click", (e) => {
      const s = e.target.closest("[data-star]");
      if (s) { toggleMine(s.dataset.star); return; }
      const m = e.target.closest("[data-more]");
      if (m) { $("#f-brand").dataset.all = "1"; renderFilters(); return; }
      const b = e.target.closest("[data-brand]");
      if (!b) return;
      const name = b.dataset.brand;
      state.brands.has(name) ? state.brands.delete(name) : state.brands.add(name);
      refresh();
    });
    $("#f-color").addEventListener("click", (e) => {
      const b = e.target.closest("[data-color]");
      if (!b) return;
      const c = b.dataset.color;
      state.colors.has(c) ? state.colors.delete(c) : state.colors.add(c);
      refresh();
    });
    $("#f-size").addEventListener("click", (e) => {
      const b = e.target.closest("[data-size]");
      if (!b) return;
      const s = b.dataset.size;
      state.sizes.has(s) ? state.sizes.delete(s) : state.sizes.add(s);
      refresh();
    });
    $("#f-cond").addEventListener("change", (e) => {
      const c = +e.target.value;
      e.target.checked ? state.conds.add(c) : state.conds.delete(c);
      refresh();
    });
    $("#f-price").addEventListener("change", (e) => {
      const b = e.target.value;
      e.target.checked ? state.prices.add(b) : state.prices.delete(b);
      refresh();
    });
    $("#f-cat").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.pick) state.cat = [...state.cat, b.dataset.pick];
      else state.cat = state.cat.slice(0, +b.dataset.depth);
      refresh();
    });
    $("#f-mine").addEventListener("change", (e) => { state.mine = e.target.checked; refresh(); });
    $("#f-today").addEventListener("change", (e) => { state.today = e.target.checked; refresh(); });
    $("#f-new").addEventListener("change", (e) => { state.fresh = e.target.checked; refresh(); });
    $("#f-sale").addEventListener("change", (e) => { state.sale = e.target.checked; refresh(); });
    $("#sort").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b && b.dataset.sort !== state.sort) { state.sort = b.dataset.sort; refresh(); }
    });
    const resetAll = () => {
      Object.assign(state, { prices: new Set(), colors: new Set(), sizes: new Set(), conds: new Set(), brands: new Set(), cat: [],
        mine: false, today: false, fresh: false, sale: false });
      $("#f-brand").dataset.all = "";
      refresh();
    };
    $("#reset").addEventListener("click", resetAll);
    $("#grid").addEventListener("click", (e) => { if (e.target.id === "emptyReset") resetAll(); });
    $("#chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-chip]");
      if (c) { chipActions[+c.dataset.chip](); refresh(); }
    });
    $("#moreBtn").addEventListener("click", showMore);
    document.addEventListener("load", (e) => { if (e.target.tagName === "IMG") e.target.classList.add("ready"); }, true);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => { if (es[0].isIntersecting) showMore(); }, { rootMargin: "800px" }).observe($("#sentinel"));
    }

    // スマホの絞り込みシート
    const sheet = $("#filters");
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    document.body.append(scrim);
    const openSheet = (open) => { sheet.classList.toggle("open", open); scrim.classList.toggle("show", open); };
    const phone = matchMedia("(max-width: 820px)");

    // パソコン：絞り込み欄をまるごと閉じて、左端の細い帯から開き直す
    const applyCollapsed = (c) => {
      $("#view-search").classList.toggle("collapsed", c);
      $("#railOpen").setAttribute("aria-expanded", String(!c));
      store.set("filtersCollapsed", c);
    };
    applyCollapsed(store.get("filtersCollapsed", false));

    let busy = false;
    // 並びが変わる前後の位置を測り、カードを前の位置から新しい位置へすべらせる（FLIP）
    function flip(change, extra = "") {
      const els = [...document.querySelectorAll("#grid .card, .resbar, .chips, .notice" + extra)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > -100 && r.top < innerHeight + 100;
      });
      const before = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
      change();
      const anims = [];
      for (const el of els) {
        const a = before.get(el), b = el.getBoundingClientRect();
        if (!b.width) continue;
        const dx = a.left - b.left, dy = a.top - b.top, sx = a.width / b.width;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01) continue;
        const scale = el.classList.contains("card") ? `scale(${sx})` : "";
        anims.push(el.animate(
          [{ transformOrigin: "0 0", transform: `translate(${dx}px, ${dy}px) ${scale}` }, { transformOrigin: "0 0", transform: "none" }],
          { duration: 420, easing: EASE_OUT }).finished.catch(() => {}));
      }
      return Promise.all(anims);
    }
    async function setCollapsed(c) {
      if (busy || $("#view-search").classList.contains("collapsed") === c) return;
      if (reduceMotion.matches) { applyCollapsed(c); return; }
      busy = true;
      const side = $("#filters"), rail = $("#railOpen");
      if (c) {
        const out = side.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(-18px)" }],
          { duration: 170, easing: EASE_IN, fill: "forwards" });
        await out.finished.catch(() => {});
        const moving = flip(() => { applyCollapsed(true); out.cancel(); });
        rail.animate([{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }],
          { duration: 260, delay: 160, easing: EASE_OUT, fill: "backwards" });
        await moving;
      } else {
        const out = rail.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: "ease-in", fill: "forwards" });
        await out.finished.catch(() => {});
        const moving = flip(() => { applyCollapsed(false); out.cancel(); });
        side.animate([{ opacity: 0, transform: "translateX(-18px)" }, { opacity: 1, transform: "none" }],
          { duration: 320, delay: 90, easing: EASE_OUT, fill: "backwards" });
        await moving;
      }
      busy = false;
    }
    $("#sideClose").addEventListener("click", () => (phone.matches ? openSheet(false) : setCollapsed(true)));
    $("#railOpen").addEventListener("click", () => setCollapsed(false));
    $("#filterOpen").addEventListener("click", () => openSheet(true));

    // 検索バーの開け閉め
    const applySearchOpen = (open) => {
      document.body.classList.toggle("search-closed", !open);
      $("#searchToggle").setAttribute("aria-expanded", String(open));
      $("#searchToggle").title = $("#searchToggleLabel").textContent = open ? "検索バーを閉じる" : "検索する";
      store.set("searchOpen", open);
    };
    applySearchOpen(store.get("searchOpen", true));
    let searchBusy = false;
    async function setSearchOpen(open) {
      if (searchBusy) return;
      const parts = [$("#form"), $("#hint")];
      const below = ", #filters, #railOpen, #mybar";
      if (reduceMotion.matches) { applySearchOpen(open); if (open) $("#q").focus(); return; }
      searchBusy = true;
      if (!open) {
        const outs = parts.map((el) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }],
          { duration: 160, easing: EASE_IN, fill: "forwards" }));
        await Promise.all(outs.map((a) => a.finished.catch(() => {})));
        await flip(() => { applySearchOpen(false); outs.forEach((a) => a.cancel()); }, below);
      } else {
        const moving = flip(() => applySearchOpen(true), below);
        parts.forEach((el, i) => el.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }],
          { duration: 300, delay: 120 + i * 50, easing: EASE_OUT, fill: "backwards" }));
        $("#q").focus({ preventScroll: true });
        await moving;
      }
      searchBusy = false;
    }
    $("#searchToggle").addEventListener("click", () => setSearchOpen(document.body.classList.contains("search-closed")));
    scrim.addEventListener("click", () => openSheet(false));
  }

  // ---------- 読み込み ----------
  function setData(data) {
    base = data.base;
    conds = data.conds;
    partial = !!data.partial;
    latest = +String(data.updated).slice(0, 10).replace(/-/g, "");
    // カテゴリ名の表と、小分類ごとの道筋 [大分類, 小分類]
    cats = [];
    const ci = new Map();
    const idx = (name) => { if (!ci.has(name)) { ci.set(name, cats.length); cats.push(name); } return ci.get(name); };
    const kindPath = data.kinds.map(([, g, , k]) => [idx(g), idx(k)]);
    catPaths = [...new Map(kindPath.flatMap((p) => [[String(p[0]), [p[0]]], [p.join(">"), p]])).values()];
    const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
    items = data.items.map((r) => {
      const [brand, kana] = data.brands[r[F.brand]];
      const color = data.colors[r[F.color]];
      return {
        id: r[F.id], c: r[F.c], bi: r[F.brand], brand, kana, name: r[F.name], color, cc: data.colorClass[color] || "",
        size: data.sizes[r[F.size]], price: r[F.price], prev: r[F.prev], path: kindPath[r[F.kind]], cond: r[F.cond],
        flags: r[F.flags], shop: data.shops[r[F.shop]], first: r[F.first], img: r[F.img], band: priceBand(r[F.price]),
      };
    });
    S.buildIndex(items, cats, conds);
    brandCount = new Map();
    for (const it of items) brandCount.set(it.brand, (brandCount.get(it.brand) || 0) + 1);
    const seenB = new Map();
    for (const it of items) if (!seenB.has(it.brand)) seenB.set(it.brand, { brand: it.brand, sub: it.kana, full: it._b.full, kana: it._b.kana, n: 0 });
    for (const [b, k] of seenB) k.n = brandCount.get(b);
    brandKeys = [...seenB.values()].sort((a, b) => b.n - a.n);
    const todayN = items.filter((it) => it.first === latest).length;
    $("#l-today").hidden = !todayN && !state.today;
    $("#todayLabel").textContent = `今日見つけた商品だけ${partial ? "" : `（${todayN.toLocaleString()}件）`}`;
    $("#updated").textContent = `最終更新：${data.updated}（メンズ ${data.total.toLocaleString()}件）`;
  }

  async function load() {
    $("#grid").innerHTML = Array.from({ length: 12 }, () => `<div class="skeleton"></div>`).join("");
    readURL();
    $("#q").value = state.q;
    $("#clear").hidden = !state.q;
    bind();
    try {
      // まず新着の一部を読んですぐ出し、そのあと全商品に入れ替える
      const full = fetch("data/catalog.json").then((r) => r.json());
      const first = await (await fetch("data/recent.json")).json();
      if (partial) { setData(first); runSearch(); }
      const data = await full;
      const y = scrollY, shown = state.shown;
      setData(data);
      current = S.search(items, state.q);
      state.shown = shown;
      refresh(true);
      scrollTo(0, y);
    } catch (e) {
      console.error(e);
      $("#count").textContent = "";
      $("#grid").innerHTML = `<div class="empty"><b>商品データを読み込めませんでした</b><span>通信状態を確かめて、ページを開き直してください。</span></div>`;
    }
  }
  load();
})();
