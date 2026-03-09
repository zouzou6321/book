#!/usr/bin/env python3
"""
Scans book directories for meta.json and generates JSON data files for the reading website.
Each book directory must contain a meta.json with:
  { title, subtitle, author, description, tags, volumes: { dir_name: "中文卷名" } }
"""

import os
import re
import json
import hashlib
import shutil
from pathlib import Path

BOOKS_ROOT = Path(__file__).parent.parent
WEBSITE_DIR = Path(__file__).parent
DATA_DIR = WEBSITE_DIR / "data"

SKIP_DIRS = {"website", "novel-website", ".cursor", ".git", "node_modules"}


def generate_color_from_string(s: str):
    h = int(hashlib.md5(s.encode()).hexdigest()[:8], 16)
    hue = h % 360
    return hue


def extract_chapter_title(content: str) -> str:
    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def extract_chapter_meta(content: str):
    title = extract_chapter_title(content)
    time_match = re.search(r"\*\*时间\*\*[：:]\s*(.+)", content)
    location_match = re.search(r"\*\*地点\*\*[：:]\s*(.+)", content)
    return {
        "title": title,
        "time": time_match.group(1).strip() if time_match else "",
        "location": location_match.group(1).strip() if location_match else "",
    }


def discover_books():
    """Auto-discover all books by scanning for directories with meta.json."""
    books = []
    for d in sorted(BOOKS_ROOT.iterdir()):
        if not d.is_dir() or d.name in SKIP_DIRS or d.name.startswith("."):
            continue
        meta_file = d / "meta.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            if meta.get("published") is False:
                continue
            books.append({
                "dir": d.name,
                "title": meta["title"],
                "subtitle": meta.get("subtitle", ""),
                "author": meta.get("author", ""),
                "description": meta.get("description", ""),
                "tags": meta.get("tags", []),
                "volumes": meta.get("volumes", {}),
                "channel": meta.get("channel", ""),
            })
    return books


def build_book_data(config: dict) -> dict:
    book_dir = BOOKS_ROOT / config["dir"]
    if not book_dir.exists():
        return None

    def _vol_sort_key(d):
        m = re.match(r"volume_(\d+)", d.name)
        return int(m.group(1)) if m else 0

    def _ch_sort_key(cf):
        m = re.match(r"chapter_(\d+)", cf.stem)
        return int(m.group(1)) if m else 0

    volume_names = config.get("volumes", {})
    volumes = []
    vol_dirs = sorted(
        [d for d in book_dir.iterdir() if d.is_dir() and d.name.startswith("volume_")],
        key=_vol_sort_key,
    )

    total_chapters = 0
    total_chars = 0

    for vol_dir in vol_dirs:
        chapter_files = sorted(vol_dir.glob("chapter_*.md"), key=_ch_sort_key)
        chapters = []
        for cf in chapter_files:
            content = cf.read_text(encoding="utf-8")
            meta = extract_chapter_meta(content)
            chapters.append(
                {
                    "id": cf.stem,
                    "file": str(cf.relative_to(BOOKS_ROOT)),
                    **meta,
                    "char_count": len(content),
                }
            )
            total_chars += len(content)
            total_chapters += 1

        volumes.append(
            {
                "id": vol_dir.name,
                "name": volume_names.get(vol_dir.name, vol_dir.name),
                "chapters": chapters,
            }
        )

    hue = generate_color_from_string(config["title"])
    cover_exists = (BOOKS_ROOT / config["dir"] / "cover.jpg").exists()

    return {
        "id": config["dir"],
        "title": config["title"],
        "subtitle": config.get("subtitle", ""),
        "author": config["author"],
        "description": config["description"],
        "tags": config.get("tags", []),
        "cover_hue": hue,
        "cover_image": cover_exists,
        "total_chapters": total_chapters,
        "total_chars": total_chars,
        "volumes": volumes,
        "channel": config.get("channel", ""),
    }


def build_chapter_content(book_id: str, chapter_file: str):
    filepath = BOOKS_ROOT / chapter_file
    if not filepath.exists():
        return ""
    return filepath.read_text(encoding="utf-8")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    book_configs = discover_books()
    catalog = []
    for config in book_configs:
        book = build_book_data(config)
        if book is None:
            continue

        book_data_dir = DATA_DIR / book["id"]
        book_data_dir.mkdir(parents=True, exist_ok=True)

        book_index = {k: v for k, v in book.items()}
        with open(book_data_dir / "index.json", "w", encoding="utf-8") as f:
            json.dump(book_index, f, ensure_ascii=False, indent=2)

        for vol in book["volumes"]:
            for ch in vol["chapters"]:
                content = build_chapter_content(book["id"], ch["file"])
                ch_data = {"content": content, **ch}
                with open(
                    book_data_dir / f"{ch['id']}.json", "w", encoding="utf-8"
                ) as f:
                    json.dump(ch_data, f, ensure_ascii=False)

        # Copy cover image if it exists
        cover_src = BOOKS_ROOT / book["id"] / "cover.jpg"
        if cover_src.exists():
            shutil.copy2(str(cover_src), str(book_data_dir / "cover.jpg"))

        catalog.append(
            {
                "id": book["id"],
                "title": book["title"],
                "subtitle": book["subtitle"],
                "author": book["author"],
                "description": book["description"][:120] + "…"
                if len(book["description"]) > 120
                else book["description"],
                "tags": book["tags"],
                "cover_hue": book["cover_hue"],
                "cover_image": book["cover_image"],
                "total_chapters": book["total_chapters"],
                "total_chars": book["total_chars"],
                "channel": book.get("channel", ""),
            }
        )

    with open(DATA_DIR / "catalog.json", "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"Built {len(catalog)} book(s), data written to {DATA_DIR}")
    for b in catalog:
        print(f"  [{b['title']}] {b['total_chapters']} chapters, ~{b['total_chars']} chars")


if __name__ == "__main__":
    main()
