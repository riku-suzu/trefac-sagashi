// 検索エンジン本体。画面から切り離してあるので、Node でもそのまま試せる。
(function (root) {
  // ---- 表記ゆれの吸収 ----
  // 全角/半角・大文字/小文字・カタカナ/ひらがなを揃え、記号と空白を落とす
  const SYMBOLS = /[\s・･、。,.，．:：;；!！?？'"“”‘’`´()（）\[\]［］{}｛｝「」『』【】〔〕〈〉《》<>＜＞\/／\\＼|｜_＿\-－‐–—~〜～=＝+＊*#＃&＆@＠^＾♪☆★◆◇○●※…×]/g;
  const LATIN = { "ø": "o", "æ": "ae", "ß": "ss", "ł": "l", "đ": "d" };
  function norm(s) {
    return String(s || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[À-ɏ]/g, (c) => LATIN[c] || c.normalize("NFD")[0])
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[ｰー−]/g, "ー")
      .replace(/ゔ/g, "ぶ")
      .replace(SYMBOLS, "");
  }

  // ---- 言い換え辞書 ----
  // 同じ行の言葉はどれで探しても同じものが見つかる。ブランドは名前とカナの両方を持っているので、
  // ここには略し方（tnf、cdg など）だけを書く
  const SYNONYMS = [
    // 服の種類
    "tシャツ ティーシャツ tee tshirt カットソー",
    "ロンt ロングスリーブ 長袖tシャツ longsleeve",
    "パーカー パーカ フーディー フーディ hoodie parka",
    "スウェット スエット トレーナー sweat sweatshirt",
    "ニット セーター knit sweater",
    "カーディガン cardigan",
    "シャツ shirt",
    "ネルシャツ チェックシャツ flannel",
    "ポロシャツ ポロ polo",
    "ジャケット jacket ブルゾン",
    "コート coat",
    "ダウン down ダウンジャケット",
    "マウンテンパーカー マンパ mountainparka",
    "ma1 ma-1 フライトジャケット",
    "ライダース ライダースジャケット riders",
    "スタジャン スタジアムジャンパー varsity",
    "フリース fleece ボア",
    "ベスト vest ジレ",
    "セットアップ setup",
    "デニム ジーンズ ジーパン denim jeans",
    "パンツ ズボン pants trousers",
    "スラックス slacks",
    "ハーフパンツ ショーツ 短パン shorts ショートパンツ",
    "カーゴ cargo",
    "チノ chino チノパン",
    "スニーカー sneaker sneakers",
    "ブーツ boots boot",
    "革靴 レザーシューズ ビジネスシューズ",
    "サンダル sandal",
    "バッグ かばん 鞄 カバン bag",
    "リュック バックパック リュックサック backpack",
    "ショルダー shoulder",
    "トート tote",
    "財布 さいふ ウォレット wallet",
    "キャップ cap",
    "帽子 ぼうし キャップ ハット",
    "ハット hat",
    "ニット帽 ニットキャップ ビーニー beanie",
    "時計 腕時計 ウォッチ watch",
    "サングラス sunglasses",
    "メガネ めがね 眼鏡 glasses",
    "マフラー ストール scarf",
    "ベルト belt",
    "ネクタイ tie",
    "ネックレス necklace",
    "リング 指輪 ring",
    "ブレスレット バングル bracelet",
    "ミリタリー military",
    "ヴィンテージ ビンテージ vintage",
    "レザー 革 本革 leather",
    "スエード スウェード suede",
    "ナイロン nylon",
    "ウール wool",
    "コットン 綿 cotton",
    "リネン 麻 linen",
    "カシミヤ カシミア cashmere",
    "ゴアテックス goretex",
    // 色
    "黒 くろ ブラック black",
    "白 しろ ホワイト white",
    "グレー グレイ 灰色 gray grey",
    "紺 ネイビー navy",
    "青 ブルー blue",
    "赤 レッド red",
    "緑 グリーン green",
    "茶 茶色 ブラウン brown",
    "ベージュ beige",
    "カーキ khaki",
    "黄色 イエロー yellow",
    "ピンク pink",
    "紫 パープル purple",
    "オレンジ orange",
    // ブランドの略し方
    "tnf ノースフェイス northface",
    "cdg ギャルソン コムデギャルソン commedesgarcons",
    "nb ニューバランス newbalance",
    "lv ヴィトン ルイヴィトン louisvuitton",
    "rl ラルフ ラルフローレン ralphlauren",
    "アーク アークテリクス arcteryx",
    "マルジェラ margiela メゾンマルジェラ",
    "ギャップ gap",
    "ジーショック gショック gshock",
    "ドクターマーチン マーチン drmartens",
    "エルエルビーン llbean",
  ].map((line) => line.split(" ").map(norm));
  const SYN = new Map();
  for (const group of SYNONYMS) for (const w of group) SYN.set(w, [...new Set([...(SYN.get(w) || []), ...group])]);

  // 探す対象として意味のない語は無視する
  const STOP = new Set(["古着", "中古", "メンズ", "トレファク", "トレジャーファクトリー"].map(norm));

  // ---- クエリの解析 ----
  // スペース区切りは AND。「-語」は除外。"語" は言い換えなしの完全一致
  function parse(q) {
    const terms = [], excludes = [];
    const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
    let m;
    const raw = String(q || "").normalize("NFKC").replace(/　/g, " ");
    while ((m = re.exec(raw))) {
      const neg = m[1] || m[3];
      const exact = m[2] !== undefined;
      const word = norm(exact ? m[2] : m[4]);
      if (!word || (!exact && STOP.has(word))) continue;
      if (neg) { excludes.push(...(exact ? [word] : expand(word))); continue; }
      if (exact) { terms.push({ word, alts: [word], hl: [word] }); continue; }
      const alts = expand(word);
      terms.push({ word, alts, hl: alts });
    }
    return { terms, excludes };
  }
  function expand(word) {
    const alts = new Set([word]);
    (SYN.get(word) || []).forEach((w) => alts.add(w));
    if (/^[a-z]{3,}s$/.test(word)) {
      const one = word.replace(/s$/, "");
      alts.add(one);
      (SYN.get(one) || []).forEach((w) => alts.add(w));
    }
    return [...alts];
  }

  // ---- 索引 ----
  // ブランド（名前とカナ）、商品名、カテゴリ、そのほか（色・状態・サイズ・店）を正規化して持つ。
  // 語と語の間には「|」を挟み、語のつなぎ目での一致を防ぐ
  const joinNorm = (parts) => parts.flatMap((x) => String(x || "").split(/\s+/)).map(norm).filter(Boolean).join("|");
  // 同じ値（ブランド・色・サイズ・店・カテゴリ）は何度も出てくるので、正規化した結果を使い回す
  function buildIndex(items, catNames, conds) {
    const brandCache = new Map(), kindCache = new Map(), partCache = new Map();
    const part = (s) => { let v = partCache.get(s); if (v === undefined) { v = joinNorm([s]); partCache.set(s, v); } return v; };
    for (const it of items) {
      let b = brandCache.get(it.bi);
      if (!b) {
        b = { full: norm(it.brand), kana: norm(it.kana), words: joinNorm([it.brand, it.kana]) };
        brandCache.set(it.bi, b);
      }
      it._b = b;
      it._t = joinNorm([it.name]);
      it._n = it._t.replace(/\|/g, "");
      let k = kindCache.get(it.path);
      if (k === undefined) { k = joinNorm(it.path.map((i) => catNames[i])); kindCache.set(it.path, k); }
      it._k = k;
      it._c = [part(it.color), part(conds[it.cond]), part(it.size), part(it.shop)].filter(Boolean).join("|");
    }
  }

  function bigrams(s) {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  // ---- 検索 ----
  // 戻り値: { hits: [{item, score, strong}], mode: "all" | "some" | "fuzzy" | "none", terms }
  function search(items, query) {
    const { terms, excludes } = parse(query);
    const passExclude = (it) => !excludes.some((w) => it._t.includes(w) || it._b.words.includes(w) || it._k.includes(w));
    if (!terms.length) {
      return { mode: "none", terms, hits: items.filter(passExclude).map((item) => ({ item, score: 0, strong: true })) };
    }

    const termScore = (it, t) => {
      let best = 0;
      for (const a of t.alts) {
        const exactWord = a === t.word;
        const b = it._b;
        let s = 0;
        if (b.full === a || b.kana === a) s = 80;
        else if (a.length >= 2 && (b.full.startsWith(a) || b.kana.startsWith(a))) s = 55;
        else if (a.length >= 3 && (b.full.includes(a) || b.kana.includes(a))) s = 40;
        else if (it._t.includes(a)) s = 24;
        else if (a.length >= 3 && it._n.includes(a)) s = 20;
        else if (it._k.includes(a)) s = 16;
        else if (it._c.includes(a)) s = 8;
        if (s && !exactWord) s *= 0.85;
        if (s > best) best = s;
      }
      return best;
    };
    const bonus = (it) => (it.flags & 1 ? 1 : 0) - it._t.length / 60;

    let hits = [];
    for (const it of items) {
      if (!passExclude(it)) continue;
      let total = 0, ok = true, strong = true;
      for (const t of terms) {
        const s = termScore(it, t);
        if (!s) { ok = false; break; }
        if (s < 15) strong = false;
        total += s;
      }
      if (ok) hits.push({ item: it, score: total + bonus(it), strong });
    }
    if (hits.length) return { mode: "all", terms, hits: sortHits(hits) };

    // 全部の語を含む商品がないときは、一部の語に当たる商品を出す
    if (terms.length > 1) {
      for (const it of items) {
        if (!passExclude(it)) continue;
        let total = 0, matched = 0;
        for (const t of terms) { const s = termScore(it, t); if (s) { matched++; total += s; } }
        if (matched) hits.push({ item: it, score: matched * 100 + total + bonus(it), strong: true });
      }
      if (hits.length) return { mode: "some", terms, hits: sortHits(hits) };
    }

    // 打ち間違いに備えて、2 文字ずつの一致率で探す（ブランド名と商品名）
    const longest = terms.map((t) => t.word).filter((w) => w.length >= 3 && !/^\d+$/.test(w)).sort((a, b) => b.length - a.length)[0];
    if (longest) {
      const grams = bigrams(longest);
      const need = Math.max(2, Math.ceil(grams.length * 0.6));
      for (const it of items) {
        if (!passExclude(it)) continue;
        const hay = it._b.full + "|" + it._b.kana + "|" + it._n;
        let n = 0;
        for (const g of grams) if (hay.includes(g)) n++;
        if (n >= need) hits.push({ item: it, score: (n / grams.length) * 50 + bonus(it), strong: true });
      }
      if (hits.length) return { mode: "fuzzy", terms, hits: sortHits(hits) };
    }
    return { mode: "all", terms, hits: [] };
  }
  function sortHits(hits) {
    return hits.sort((a, b) => b.score - a.score || b.item.first - a.item.first || b.item.c - a.item.c);
  }

  root.TrefacSearch = { norm, parse, expand, buildIndex, search };
  if (typeof module !== "undefined") module.exports = root.TrefacSearch;
})(typeof window !== "undefined" ? window : globalThis);
