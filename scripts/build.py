#!/usr/bin/env python3
"""トレファクオンライン（trefac.jp）のメンズの在庫を集めて public/data/ に書き出す。

標準ライブラリだけで動く。

トレファクの一覧は 1 つの条件につき 9,990 件（90 件 × 111 ページ）までしか見られないので、
「カテゴリ（約 120）× 状態（6 段階）」に分けて取る。分けたまとまりを「組」と呼ぶ。

  1. 毎朝、すべての組の 1 ページ目を新着順で開く。トレファクの新着順は「入荷」と「値下げ」が
     混ざった順なので、知らない商品・値段の変わった商品が 1 つもないページまでめくる
     （初回はどの商品も知らないので、全部めくる＝全件を取ることになる）
  2. そのうえで、最後に全部めくった日が古い組から ROTATE_PAGES ページぶん全部めくり直し、
     見つからなかった商品（売れた商品）を消す。全部で 1 週間ほどで一回りする
  3. 14 日見かけなかった商品も消す

  python3 scripts/build.py                 # ふつうに取る
  python3 scripts/build.py --limit-combos 5  # 試しに 5 組だけ（手元での確認用）
"""
import datetime as dt
import gzip
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "data")
STATE = os.path.join(ROOT, "data", "combos.json")
BASE = "https://www.trefac.jp"
UA = "trefac-sagashi/1.0 (personal catalog; once a day)"
INTERVAL = 2.0           # 取る間隔（秒）。1 秒おきに 1 時間ほど取ると 429（多すぎる）で断られた（2026-11-12）
PER_PAGE = 90            # 1 ページの件数（トレファクの最大）
MAX_PAGE = 111           # 1 つの条件でめくれるページの上限（90 × 111 = 9,990 件）
ROTATE_PAGES = 300       # 売れた商品を見つけるための見直しに使うページ数（1 日あたり）
NEW_PAGES = 5            # 新着と値下げを見るとき、1 つのカテゴリでめくるページの上限
STALE_DAYS = 14          # この日数見かけなかった商品は消す
MAX_MINUTES = 170        # これを過ぎたら取れた分で書き出す
RECENT_N = 3000          # 最初に読む「新着」ファイルの件数
JST = dt.timezone(dt.timedelta(hours=9))

CONDITIONS = {6: "未使用品", 5: "未使用に近い", 4: "使用感をあまり感じない", 3: "やや傷や汚れがあり",
              2: "傷や汚れがあり", 1: "全体的に使用感がある"}

# トレファクの色の名前 → 色の分類（画面の色見本）。「グレー×ブルー」は前の色で分ける
COLOR_WORDS = [
    ("オフホワイト", "white"), ("ホワイト", "white"), ("アイボリー", "white"), ("生成", "white"), ("クリーム", "white"), ("白", "white"),
    ("ブラック", "black"), ("黒", "black"),
    ("チャコール", "gray"), ("グレー", "gray"), ("グレイ", "gray"), ("灰", "gray"),
    ("ブラウン", "brown"), ("キャメル", "brown"), ("ダークブラウン", "brown"), ("茶", "brown"), ("モカ", "brown"), ("テラコッタ", "brown"),
    ("ベージュ", "beige"), ("サンド", "beige"), ("ナチュラル", "beige"), ("グレージュ", "beige"),
    ("カーキ", "green"), ("オリーブ", "green"), ("グリーン", "green"), ("黄緑", "green"), ("ミント", "green"), ("緑", "green"),
    ("ネイビー", "blue"), ("インディゴ", "blue"), ("ブルー", "blue"), ("サックス", "blue"), ("水色", "blue"), ("紺", "blue"), ("ターコイズ", "blue"), ("青", "blue"),
    ("パープル", "purple"), ("ラベンダー", "purple"), ("紫", "purple"),
    ("イエロー", "yellow"), ("マスタード", "yellow"), ("黄", "yellow"),
    ("ピンク", "pink"),
    ("ボルドー", "red"), ("ワイン", "red"), ("バーガンディ", "red"), ("レッド", "red"), ("赤", "red"),
    ("オレンジ", "orange"),
    ("シルバー", "silver"), ("ゴールド", "gold"), ("クリア", "clear"), ("透明", "clear"),
    ("マルチ", "multi"), ("総柄", "multi"), ("その他", "multi"),
]

_last = 0.0
_started = time.time()
_fails = 0
_blocked = False


def color_class(name):
    first = re.split(r"[×xX/／・]", name or "")[0]
    for key, c in COLOR_WORDS:
        if key in first:
            return c
    for key, c in COLOR_WORDS:
        if key in (name or ""):
            return c
    return ""


def out_of_time():
    return time.time() - _started > MAX_MINUTES * 60


def fetch(path):
    """ページを取る。だめなら None。断られ続けたら（10 回続けて失敗）それ以上は取らない"""
    global _last, _fails, _blocked
    if _fails >= 10 or _blocked:
        return None
    url = path if path.startswith("http") else BASE + path
    for attempt in range(4):
        wait = INTERVAL - (time.time() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja", "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
            _fails = 0
            return body.decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if getattr(e, "code", None) == 404:
                return None
            # 「多すぎる」と言われたら、その日はもう取らない
            if getattr(e, "code", None) in (429, 403):
                print(f"  断られた（{e}）。今日はここまでにします: {url}", file=sys.stderr)
                _blocked = True
                return None
            print(f"  取れなかった（{e}）: {url}  {attempt + 1}回目", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    _fails += 1
    return None


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


# ---------- 一覧ページを読む ----------
def parse_kinds(page):
    """左の「カテゴリ」欄から [(大分類番号, 大分類名, 小分類番号, 小分類名)] を作る"""
    i = page.find('<h2 class="sidebar_ttl">カテゴリ')
    side = page[i:page.find("</section>", i)]
    out, group = [], None
    for m in re.finditer(r'<span class="sidebar_list_btn[^"]*">([^<]+)</span>|data-side_gcateg="(\d+)" data-side_kind="(\d*)"[^>]*>\s*([^<]+?)\s*<div>', side):
        if m.group(1):
            group = clean(m.group(1))
        elif m.group(3):
            out.append((int(m.group(2)), group, int(m.group(3)), clean(m.group(4))))
    return out


def parse_total(page):
    m = re.search(r'search_result_num[^>]*>([\d,]+)', page)
    return int(m.group(1).replace(",", "")) if m else 0


LETTER = {"XXS": "XXS", "XS": "XS", "S": "S", "M": "M", "L": "L", "XL": "XL", "XXL": "XXL", "2XL": "XXL",
          "XXXL": "3XL", "3XL": "3XL", "4XL": "4XL", "XXXXL": "4XL", "5XL": "5XL", "F": "FREE", "FREE": "FREE",
          "SMALL": "S", "MEDIUM": "M", "LARGE": "L", "XLARGE": "XL", "X-LARGE": "XL", "XX-LARGE": "XXL", "ONESIZE": "FREE",
          "ONE SIZE": "FREE", "OS": "FREE"}


def norm_size(s):
    """サイズの書き方を揃える。「Ｍ」「JPN M」「SIZE M」→ M、「2XL」→ XXL。数字などはそのまま"""
    s = unicodedata.normalize("NFKC", html.unescape(s or "")).translate(SIZE_FIX).strip()
    s = re.sub(r"^(SIZE|Size|size)[\s:：]*", "", s).strip()
    if not s or s.startswith("不明") or s in ("-", "--", "ー", "なし"):
        return ""
    up = s.upper()
    if up in LETTER:
        return LETTER[up]
    # 「JPN M」「J 3XL」「ASIA M JAPAN M」「SMALL 34-36」は、国の名前を飛ばして最初の大きさを使う
    words = [w for w in re.split(r"[\s/(),]+", up) if w and w not in ("J", "JP", "JPN", "JAPAN", "ASIA", "US", "USA", "EU", "UK", "IT", "FR", "INT")]
    if words and words[0] in LETTER:
        return LETTER[words[0]]
    return s


SIZE_FIX = str.maketrans({"М": "M", "Ѕ": "S", "Х": "X"})


def parse_items(page):
    out = []
    for blk in page.split('<li class="p-itemlist_item">')[1:]:
        m = re.search(r'href="https://www\.trefac\.jp/store/(\d+)/c(\d+)/" class="p-itemlist_btn"', blk)
        if not m:
            continue
        gid, cnum = m.group(1), int(m.group(2))
        img = re.search(r'/image/item/\d+/w\d+/\d+_([^"]+)"', blk)
        alt = html.unescape((re.search(r'<img [^>]*alt="([^"]*)"', blk) or [None, ""])[1])
        brand = clean((re.search(r'p-itemlist_brand">(.*?)</p>', blk, re.S) or [None, ""])[1])
        # alt は「BRANDカナ）の古着「商品名」｜色」。カナは「）」の前まで
        kana, name, color = "", alt, ""
        k = alt.find("）")
        q1, q2 = alt.find("「"), alt.rfind("」")
        if q1 >= 0 and q2 > q1:
            name = alt[q1 + 1:q2]
            tail = alt[q2 + 1:]
            if tail.startswith("｜"):
                color = tail[1:].strip()
        if 0 <= k < (q1 if q1 >= 0 else len(alt)):
            head = alt[:k]
            kana = head[len(brand):].strip() if head.startswith(brand) else ""
        size = norm_size((re.search(r'p-itemlist_size">サイズ：(.*?)</p>', blk, re.S) or [None, ""])[1])
        pm = re.search(r'p-price2_\w">￥([\d,]+)', blk)
        price = int(pm.group(1).replace(",", "")) if pm else 0
        badges = re.findall(r'<i class="p-icon_itemguide[^"]*">([^<]+)</i>', blk)
        sexes = set(re.findall(r'p-typo_body2_(mens|ladies)"', blk))
        shop = re.search(r'shop=(\d+)" class="p-button_shopname1_a"><span>(?:<img[^>]*>)?([^<]+)</span>', blk)
        flags = (1 if "NEW" in badges else 0) | (2 if "SALE" in badges else 0) | (4 if len(sexes) > 1 else 0)
        out.append({
            "id": gid, "c": cnum, "brand": brand, "kana": kana, "name": name, "color": color, "size": size,
            "price": price, "flags": flags, "shop": clean(shop.group(2)) if shop else "",
            "img": img.group(1) if img else "",
        })
    return out


def list_url(gcateg, kind, cond, page, order=""):
    """cond が None なら状態で分けない（カテゴリの全部）"""
    q = f"kind={kind}" + (f"&gcondition={cond}" if cond is not None else "") + f"&step=1&disp_num={PER_PAGE}"
    if order:
        q += f"&order={order}"
    if page > 1:
        q += f"&key={page}"
    return f"/store/t1c{gcateg}psb/?{q}"


# ---------- 読み書き ----------
def today():
    return int(dt.datetime.now(JST).strftime("%Y%m%d"))


def days_between(a, b):
    f = lambda n: dt.date(n // 10000, n // 100 % 100, n % 100)
    return (f(b) - f(a)).days


FIELDS = ["id", "c", "brand", "name", "color", "size", "price", "prev", "kind", "cond", "flags", "shop", "first", "seen", "img"]
# 表にしてから番号で持つ欄（同じ値が何度も出てくるもの）
TABLES = {"brand": "brands", "color": "colors", "size": "sizes", "shop": "shops"}
IMG_RE = re.compile(r"^01_(\d+)w\.jpeg$")


def load():
    items = {}
    path = os.path.join(OUT_DIR, "catalog.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        F = {k: i for i, k in enumerate(data["fields"])}
        day = int(str(data["updated"])[:10].replace("-", ""))
        kinds = data["kinds"]
        for r in data["items"]:
            it = {k: r[F[k]] for k in FIELDS}
            for col, table in TABLES.items():
                it[col] = data[table][it[col]]
            it["brand"], it["kana"] = it["brand"]
            it["kind"] = kinds[it["kind"]][2]
            # 見かけた日は YYYYMMDD。初回だけ「更新日の何日前」で書いていたので、それも読めるようにしておく
            if it["seen"] < 19000000:
                d = dt.date(day // 10000, day // 100 % 100, day % 100) - dt.timedelta(days=it["seen"])
                it["seen"] = int(d.strftime("%Y%m%d"))
            if isinstance(it["img"], int):
                it["img"] = f"01_{it['img']}w.jpeg"
            items[it["id"]] = it
    state = {}
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            state = json.load(f)
    return items, state


def pack(rows_in, kind_idx, day):
    """商品の並びを、表＋番号の形にする"""
    tables = {t: [] for t in TABLES.values()}
    index = {t: {} for t in TABLES.values()}

    def ref(table, value):
        key = json.dumps(value, ensure_ascii=False)
        if key not in index[table]:
            index[table][key] = len(tables[table])
            tables[table].append(value)
        return index[table][key]

    rows = []
    for it in rows_in:
        r = dict(it)
        r["brand"] = ref("brands", [it["brand"], it["kana"]])
        for col in ("color", "size", "shop"):
            r[col] = ref(TABLES[col], it[col])
        r["kind"] = kind_idx[it["kind"]]
        m = IMG_RE.match(it["img"] or "")
        r["img"] = int(m.group(1)) if m else it["img"]
        rows.append([r[k] for k in FIELDS])
    return dict(tables, items=rows)


def write(items, kinds, state, stamp, day):
    os.makedirs(OUT_DIR, exist_ok=True)
    kind_rows = [[g, gname, k, kname] for g, gname, k, kname in kinds]
    kind_idx = {r[2]: i for i, r in enumerate(kind_rows)}
    # 並び：新しく見つけた日 → トレファクの登録番号の新しい順。消えたカテゴリの商品は外す
    ordered = sorted((it for it in items.values() if it["kind"] in kind_idx), key=lambda x: (-x["first"], -x["c"]))
    colors = sorted({it["color"] for it in ordered if it["color"]})
    meta = {"updated": stamp, "base": BASE, "fields": FIELDS, "conds": CONDITIONS, "kinds": kind_rows,
            "colorClass": {c: color_class(c) for c in colors}, "total": len(ordered)}
    for name, part in (("catalog.json", ordered), ("recent.json", ordered[:RECENT_N])):
        body = dict(meta, **pack(part, kind_idx, day))
        if part is not ordered:
            body["partial"] = True
            body["colorClass"] = {c: meta["colorClass"][c] for c in body["colors"] if c in meta["colorClass"]}
        with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False, separators=(",", ":"))
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=0, sort_keys=True)


# ---------- 本体 ----------
def main():
    limit = None
    if "--limit-combos" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit-combos") + 1])
    items, state = load()
    first_run = not items
    day = today()
    stamp = dt.datetime.now(JST).strftime("%Y-%m-%d %H:%M")
    print(f"前回の商品 {len(items):,}件{'（初回）' if first_run else ''}")

    top = fetch("/store/t1cpsb/?step=1&disp_num=30")
    if not top:
        sys.exit("トレファクのページを開けませんでした")
    kinds = parse_kinds(top)
    print(f"メンズ {parse_total(top):,}件、カテゴリ {len(kinds)}個")
    if not kinds:
        sys.exit("カテゴリが読めませんでした（ページの作りが変わったかもしれません）")
    combos = [(g, k, c) for g, _, k, _ in kinds for c in CONDITIONS]
    if limit:
        combos = combos[:limit]
    by_combo = {}
    for it in items.values():
        by_combo.setdefault(f"{it['kind']}-{it['cond']}", []).append(it)

    stats = {"new": 0, "changed": 0, "gone": 0, "pages": 0}
    # 前回までにいちばん新しかった登録番号。これより大きい番号の商品が「今日入荷した商品」
    max_c = max((it["c"] for it in items.values()), default=0)

    def take(found, kind, cond):
        """ページで見つけた商品を取り込む。cond が None（状態で分けていない一覧）なら状態は前のまま（初めてなら 0＝不明）。
        今日入荷した商品か、値段の変わった商品があれば True"""
        event = False
        for x in found:
            old = items.get(x["id"])
            if old is None:
                fresh = not first_run and x["c"] > max_c
                x.update(kind=kind, cond=cond or 0, first=day if fresh else 0, seen=day, prev=0)
                items[x["id"]] = x
                stats["new"] += 1
                event = event or fresh
                continue
            if old["price"] != x["price"]:
                stats["changed"] += 1
                event = True
                # 値下げ前の値段を覚えておく（いちばん高かったとき）
                if x["price"] < old["price"]:
                    old["prev"] = max(old.get("prev") or 0, old["price"])
                elif x["price"] >= (old.get("prev") or 0):
                    old["prev"] = 0
            for k in ("price", "flags", "brand", "kana", "name", "color", "size", "shop", "img", "c"):
                old[k] = x[k]
            old.update(kind=kind, seen=day)
            if cond is not None:
                old["cond"] = cond
        return event

    def sweep(g, k, c):
        """組（カテゴリ×状態）を全部めくる。見終えたら、見つからなかった商品（売れた商品）を消す"""
        key = f"{k}-{c}"
        seen, total, page, walked = set(), None, 1, False
        orders = [""]
        while True:
            if out_of_time():
                break
            p = fetch(list_url(g, k, c, page, orders[0]))
            stats["pages"] += 1
            if p is None:
                break
            if total is None:
                total = parse_total(p)
                state.setdefault(key, {})["n"] = total
                # 9,990 件を超える組は、安い順・高い順でも全部めくって取りこぼしを減らす
                if total > PER_PAGE * MAX_PAGE:
                    orders = ["", "pdown", "phigh"]
            found = parse_items(p)
            seen.update(x["id"] for x in found)
            take(found, k, c)
            if page >= min(MAX_PAGE, (total + PER_PAGE - 1) // PER_PAGE) or not found:
                if len(orders) > 1:
                    orders.pop(0)
                    page = 1
                    continue
                walked = True
                break
            page += 1
        if walked:
            state.setdefault(key, {})["full"] = day
        # 全部見たのに見つからなかった商品は売れた（9,990 件を超える組は見落としがありうるので消さない）
        if walked and total <= PER_PAGE * MAX_PAGE:
            for it in by_combo.get(key, []):
                if it["id"] not in seen and it["id"] in items and items[it["id"]]["seen"] < day:
                    del items[it["id"]]
                    stats["gone"] += 1
        return walked

    def stopped():
        if out_of_time():
            print("時間切れ。取れた分で書き出します")
            return True
        if _fails >= 10 or _blocked:
            print("断られたので、取れた分で書き出します")
            return True
        return False

    if first_run:
        # 初回：全部の組を全部めくる
        for i, (g, k, c) in enumerate(combos):
            if stopped():
                break
            sweep(g, k, c)
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(combos)}組  {stats['new']:,}件  {stats['pages']:,}ページ", flush=True)
    else:
        # 1. 新着と値下げ：カテゴリごとに新着順（入荷と値下げが混ざった順）でめくり、
        #    今日入荷した商品も値段の変化もないページで止める
        for g, _, k, _ in kinds:
            if stopped():
                break
            for page in range(1, NEW_PAGES + 1):
                p = fetch(list_url(g, k, None, page))
                stats["pages"] += 1
                if p is None:
                    break
                found = parse_items(p)
                if not take(found, k, None) or len(found) < PER_PAGE:
                    break
        print(f"  新着と値下げ：新しい商品 {stats['new']:,}  値段の変化 {stats['changed']:,}  {stats['pages']:,}ページ", flush=True)

        # 2. 見直し：最後に全部めくった日が古い組（まだ一度もめくっていない組が先）から、ROTATE_PAGES ページぶん
        budget = ROTATE_PAGES
        order = sorted(combos, key=lambda x: state.get(f"{x[1]}-{x[2]}", {}).get("full", 0))
        for g, k, c in order:
            if budget <= 0 or stopped():
                break
            before = stats["pages"]
            sweep(g, k, c)
            budget -= stats["pages"] - before
        print(f"  見直し：{ROTATE_PAGES - budget}ページ", flush=True)

    # 3. 長く見かけない商品を消す
    for gid in [g for g, it in items.items() if days_between(it["seen"], day) >= STALE_DAYS]:
        del items[gid]
        stats["gone"] += 1

    stamp = dt.datetime.now(JST).strftime("%Y-%m-%d %H:%M")
    write(items, kinds, state, stamp, day)
    print(f"書き出し：{len(items):,}件（新しい商品 {stats['new']:,}、値段の変化 {stats['changed']:,}、"
          f"売れた・消えた {stats['gone']:,}、{stats['pages']:,}ページ、{(time.time() - _started) / 60:.0f}分）")


if __name__ == "__main__":
    main()
