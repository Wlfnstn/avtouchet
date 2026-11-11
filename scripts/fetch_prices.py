#!/usr/bin/env python3
"""Собирает актуальные цены на топливо в Казахстане с creditbureau.kz и пишет prices.json.

Запускается раз в день в GitHub Actions (.github/workflows/pages.yml).
Только стандартная библиотека Python. Если разбор не удался — старый prices.json не трогаем.
"""
import html
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = "https://creditbureau.kz/gas-stations/"
UA = "Mozilla/5.0 (compatible; AvtoUchetPriceBot/1.0; +https://wlfnstn.github.io/avtouchet/)"
OUT = Path(__file__).resolve().parent.parent / "prices.json"

CITIES = {  # slug на сайте -> название
    "almaty": "Алматы", "astana": "Астана", "shymkent": "Шымкент", "karaganda": "Караганда",
    "aktobe": "Актобе", "atyrau": "Атырау", "ust-kamenogorsk": "Усть-Каменогорск",
    "pavlodar": "Павлодар", "petropavlovsk": "Петропавловск", "kyzylorda": "Кызылорда",
    "uralsk": "Уральск", "kostanaj": "Костанай", "taldykorgan": "Талдыкорган", "taraz": "Тараз",
}
FUEL_KEYS = {"АИ-92": "ai92", "АИ-95": "ai95", "АИ-98": "ai98", "ДТ": "dt", "Газ": "gas"}
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
          "сентября", "октября", "ноября", "декабря"]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def flat(s):
    """HTML -> текст, где границы тегов заменены на '|'."""
    s = re.sub(r"<(script|style)\b.*?</\1>", "", s, flags=re.S | re.I)
    s = re.sub(r"<[^>]+>", "|", s)
    s = html.unescape(s).replace("\xa0", " ")
    s = re.sub(r"\s*\|\s*", "|", s)
    return re.sub(r"\|+", "|", s)


def price(cell):
    m = re.search(r"(\d{2,4})\s*₸", cell)
    return int(m.group(1)) if m else None


def parse(page):
    t = flat(page)
    out = {}
    m = re.search(r"Средние цены за литр на (\d{1,2}) ([а-я]+) (\d{4})", t)
    if m and m.group(2) in MONTHS:
        out["date"] = f"{m.group(3)}-{MONTHS.index(m.group(2)) + 1:02d}-{int(m.group(1)):02d}"

    # Средние цены: «Средние цены на топливо|АИ-92|234 ₸|Prime 248 ₸|АИ-95|287 ₸|…|Цены по сетям»
    i, j = t.find("Средние цены на топливо|"), t.find("|Цены по сетям")
    avg = {}
    if i >= 0 and j > i:
        for label, val in re.findall(r"(АИ-92|АИ-95|АИ-98|ДТ|Газ)\|(\d{2,4}) ₸", t[i:j]):
            avg.setdefault(FUEL_KEYS[label], int(val))
    out["avg"] = avg

    # Таблица сетей — первая <table> с заголовком «Сеть»
    nets = []
    for tm in re.finditer(r"<table\b.*?</table>", page, re.S):
        tbl = tm.group(0)
        rows = re.findall(r"<tr\b.*?</tr>", tbl, re.S)
        if not rows:
            continue
        head = [flat(c).strip("|") for c in re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", rows[0], re.S)]
        if not head or head[0] != "Сеть":
            continue
        cols = [FUEL_KEYS.get(h) for h in head]
        for r in rows[1:]:
            cells = [flat(c).strip("|") for c in re.findall(r"<t[hd]\b[^>]*>(.*?)</t[hd]>", r, re.S)]
            if len(cells) < 6:
                continue
            parts = cells[0].split("|")
            name = parts[0].strip()
            st = re.search(r"(\d+)\s+заправ", cells[0])
            prices = {cols[k]: price(c) for k, c in enumerate(cells) if k < len(cols) and cols[k] and price(c)}
            if name and prices:
                nets.append({"name": name, "stations": int(st.group(1)) if st else None, "prices": prices})
        break
    out["networks"] = nets
    return out


def main():
    try:
        main_page = get(BASE)
    except Exception as e:  # сеть недоступна — оставляем старые данные
        print("fetch failed:", e, file=sys.stderr)
        return 0
    data = parse(main_page)
    if len(data.get("avg", {})) < 3 or not data.get("networks"):
        print("parse failed: averages or networks missing", file=sys.stderr)
        return 0

    cities = {}
    for slug, name in CITIES.items():
        time.sleep(2)  # бережно к сайту
        try:
            c = parse(get(BASE + slug + "/"))
        except Exception as e:
            print(f"{slug}: {e}", file=sys.stderr)
            continue
        if c.get("avg"):
            cities[slug] = {"name": name, "date": c.get("date"), "avg": c["avg"], "networks": c["networks"]}

    kz_now = datetime.now(timezone(timedelta(hours=5)))
    result = {
        "date": data.get("date") or kz_now.strftime("%Y-%m-%d"),
        "fetched": kz_now.isoformat(timespec="minutes"),
        "source": "creditbureau.kz",
        "sourceUrl": BASE,
        "avg": data["avg"],
        "networks": data["networks"],
        "cities": cities,
    }
    old = json.loads(OUT.read_text("utf-8")) if OUT.exists() else {}
    same = {k: v for k, v in old.items() if k != "fetched"} == {k: v for k, v in result.items() if k != "fetched"}
    if same:
        print("no changes")
        return 0
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", "utf-8")
    print(f"updated {result['date']}: avg {result['avg']}, cities {len(cities)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
