"""
Background task manager for AI novel generation.
Runs generation jobs in daemon threads; the frontend polls for progress.
"""

import json
import re
import threading
import time
from pathlib import Path

import requests as http_requests

from consistency import run_check as run_consistency_check

# ────────────────────────── Globals ──────────────────────────

_tasks: dict = {}            # novel_id → task state
_lock = threading.Lock()


# ────────────────────────── Public API ──────────────────────────

def start_task(novel_id: str, task_type: str, items: list,
               books_root: Path, ai_cfg: dict) -> dict:
    """
    Start a background generation task.

    task_type: 'single' | 'auto'
    items:     list of step dicts (type, volIdx, chIdx, path, label)
    ai_cfg:    dict with api_key, base_url, model
    """
    with _lock:
        existing = _tasks.get(novel_id)
        if existing and existing["status"] == "running":
            return {"error": "该小说已有任务在运行中"}

        task = {
            "status": "running",
            "type": task_type,
            "progress": 0,
            "total": len(items),
            "current_step": "",
            "phase": "",
            "log": [],
            "started_at": time.time(),
            "error": None,
        }
        _tasks[novel_id] = task

    t = threading.Thread(
        target=_run_task,
        args=(novel_id, items, books_root, ai_cfg),
        daemon=True,
    )
    t.start()
    return {"ok": True, "total": len(items)}


def get_status(novel_id: str) -> dict:
    with _lock:
        task = _tasks.get(novel_id)
    if not task:
        return {"status": "idle"}
    return {k: v for k, v in task.items() if k != "log_full"}


def get_log(novel_id: str, since: int = 0) -> list:
    with _lock:
        task = _tasks.get(novel_id)
    if not task:
        return []
    return task["log"][since:]


def stop_task(novel_id: str) -> dict:
    with _lock:
        task = _tasks.get(novel_id)
        if task and task["status"] == "running":
            task["status"] = "cancelling"
            return {"ok": True}
    return {"error": "没有运行中的任务"}


# ────────────────────────── Task Runner ──────────────────────────

def _log(task: dict, msg: str):
    entry = {"time": time.time(), "msg": msg}
    with _lock:
        task["log"].append(entry)
        # Keep only last 200 entries in memory
        if len(task["log"]) > 200:
            task["log"] = task["log"][-200:]


def _update(task: dict, **kw):
    with _lock:
        task.update(kw)


def _is_cancelled(task: dict) -> bool:
    with _lock:
        return task["status"] in ("cancelling", "cancelled")


def _rebuild_site(books_root: Path, task: dict) -> None:
    """Run build_site.py to update bookshelf/reading site. Logs to task."""
    import subprocess
    website_dir = books_root / "website"
    if not (website_dir / "build_site.py").exists():
        _log(task, "⚠ 未找到 build_site.py，跳过更新书架")
        return
    try:
        result = subprocess.run(
            ["python3", "build_site.py"],
            cwd=str(website_dir),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode == 0:
            _log(task, "✓ 书架已更新")
        else:
            _log(task, f"⚠ 书架更新失败：{(result.stderr or result.stdout or '')[:200]}")
    except subprocess.TimeoutExpired:
        _log(task, "⚠ 书架更新超时")
    except Exception as e:
        _log(task, f"⚠ 书架更新出错：{e}")


def _run_task(novel_id: str, items: list, books_root: Path, ai_cfg: dict):
    task = _tasks[novel_id]
    novel_dir = books_root / novel_id
    meta = json.loads((novel_dir / "meta.json").read_text(encoding="utf-8"))
    title = meta.get("title", "")

    _log(task, f"开始生成任务：{title}，共 {len(items)} 步")
    skipped = 0

    try:
        for i, item in enumerate(items):
            if _is_cancelled(task):
                _update(task, status="cancelled")
                _log(task, "任务已取消")
                return

            item_path = item["path"]
            item_type = item["type"]
            label = item.get("label", item_path)
            phase = item.get("phase", "")

            # Skip if already has content
            full_path = novel_dir / item_path
            if full_path.exists():
                content = full_path.read_text(encoding="utf-8")
                if len(content) > 200:
                    skipped += 1
                    _update(task, progress=i + 1)
                    _log(task, f"跳过 [{phase}] {label}（已有内容）")
                    continue

            _update(task, progress=i + 1, current_step=label, phase=phase)
            _log(task, f"[{phase}] 生成 {label}…")

            # Build prompt
            messages = _build_prompt(novel_dir, meta, item)
            if not messages:
                _log(task, f"✗ 无法构建提示词：{label}")
                _update(task, status="error", error=f"无法构建提示词：{label}")
                return

            # Call AI with retry (unlimited for recoverable errors)
            try:
                content = _call_ai_with_retry(messages, ai_cfg, task, label)
            except _FatalAIError as e:
                _update(task, status="error", error=str(e))
                return
            if content is None:
                # Only happens on cancellation
                _update(task, status="cancelled")
                _log(task, "任务已取消")
                return

            # Save content
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            _log(task, f"✓ 已保存 {label}（{len(content)} 字）")

            # Post-generation: update volume names from outline
            if item_type == "outline":
                _update_volume_names_from_outline(novel_dir, meta, content)

            # Post-generation hooks for chapters
            if item_type == "chapter":
                _after_chapter(novel_dir, meta, item, content, ai_cfg, task)
                # 已发布的小说：每写完一章就更新书架，读者端可即时看到
                if meta.get("published") is True:
                    _log(task, "更新书架…")
                    _rebuild_site(books_root, task)

        # Final: 已发布时重建网站数据（若任务里没有章节，这里会补一次）
        if meta.get("published") is True:
            _log(task, "重建网站数据…")
            _rebuild_site(books_root, task)

        done_count = len(items) - skipped
        _update(task, status="done", progress=len(items))
        _log(task, f"全部完成！共生成 {done_count} 项，跳过 {skipped} 项")

    except Exception as e:
        _update(task, status="error", error=str(e))
        _log(task, f"✗ 任务异常终止：{e}")


# ────────────────────────── AI Calling ──────────────────────────

class _FatalAIError(Exception):
    """Unrecoverable AI error — do not retry."""
    pass


# HTTP status codes that are NOT worth retrying
_FATAL_STATUS_CODES = {
    401,  # Unauthorized — bad API key
    403,  # Forbidden
    404,  # Not found — wrong model name
    410,  # Gone — model EOL
    422,  # Unprocessable — bad request body
}

RETRY_BASE_DELAY = 15   # seconds; grows with back-off
RETRY_MAX_DELAY = 120   # cap


def _call_ai_complete(messages: list, ai_cfg: dict,
                      max_tokens: int = 16384, timeout: int = 300):
    """
    Non-streaming AI call.
    Returns content string on success.
    Raises _FatalAIError for unrecoverable errors.
    Returns None for recoverable failures (network, timeout, 5xx, rate-limit…).
    """
    api_key = ai_cfg.get("api_key", "")
    base_url = ai_cfg.get("base_url", "").rstrip("/")
    model = ai_cfg.get("model", "")

    if not api_key or not base_url:
        raise _FatalAIError("未配置 API Key 或 Base URL")

    url = f"{base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {"model": model, "messages": messages, "max_tokens": max_tokens}

    try:
        resp = http_requests.post(url, json=payload, headers=headers, timeout=timeout)
    except http_requests.exceptions.ConnectionError:
        return None  # recoverable
    except http_requests.exceptions.Timeout:
        return None  # recoverable
    except Exception:
        return None  # treat unknown transport errors as recoverable

    if resp.status_code in _FATAL_STATUS_CODES:
        try:
            detail = resp.json().get("detail", resp.text[:200])
        except Exception:
            detail = resp.text[:200]
        raise _FatalAIError(f"HTTP {resp.status_code}: {detail}")

    if resp.status_code != 200:
        return None  # 429 rate-limit, 5xx server error → recoverable

    try:
        result = resp.json()
        content = result["choices"][0]["message"].get("content") or ""
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        return content if content else None
    except (KeyError, IndexError, ValueError):
        return None  # malformed response → recoverable


def _call_ai_with_retry(messages: list, ai_cfg: dict, task: dict,
                        label: str, max_tokens: int = 16384):
    """
    Call AI with unlimited retries for recoverable errors.
    Only gives up on _FatalAIError or task cancellation.
    """
    attempt = 0
    while True:
        if _is_cancelled(task):
            return None

        try:
            content = _call_ai_complete(messages, ai_cfg, max_tokens=max_tokens)
        except _FatalAIError as e:
            _log(task, f"  ✗ 不可恢复的错误（{label}）：{e}")
            raise

        if content:
            if attempt > 0:
                _log(task, f"  ✓ 第{attempt + 1}次尝试成功（{label}）")
            return content

        attempt += 1
        delay = min(RETRY_BASE_DELAY * attempt, RETRY_MAX_DELAY)
        _log(task, f"  ⚠ AI 调用失败（{label}），{delay}秒后第{attempt + 1}次重试…")
        time.sleep(delay)


# ────────────────────────── Prompt Building ──────────────────────────

def _read_file(novel_dir: Path, path: str) -> str:
    fp = novel_dir / path
    if fp.exists():
        return fp.read_text(encoding="utf-8")
    return ""


def _vol_sort_key(d: Path) -> int:
    m = re.match(r"volume_(\d+)", d.name)
    return int(m.group(1)) if m else 0


def _ch_sort_key(cf: Path) -> int:
    m = re.match(r"chapter_(\d+)", cf.stem)
    return int(m.group(1)) if m else 0


def _get_structure(novel_dir: Path, meta: dict) -> dict:
    """Get novel structure (volumes, chapters) from filesystem."""
    volumes = []
    vol_dirs = sorted(
        [d for d in novel_dir.iterdir() if d.is_dir() and d.name.startswith("volume_")],
        key=_vol_sort_key,
    )
    for vol_dir in vol_dirs:
        vol_name = meta.get("volumes", {}).get(vol_dir.name, vol_dir.name)
        chapters = []
        for cf in sorted(vol_dir.glob("chapter_*.md"), key=_ch_sort_key):
            chapters.append({
                "id": cf.stem,
                "filename": cf.name,
            })
        volumes.append({
            "dir": vol_dir.name,
            "name": vol_name,
            "chapters": chapters,
        })
    return {"volumes": volumes}


def _build_prompt(novel_dir: Path, meta: dict, item: dict):
    title = meta.get("title", "")
    writing_style = meta.get("writing_style", "")
    style_hint = f"\n写作风格要求：模仿{writing_style}的文风" if writing_style else ""
    item_type = item["type"]

    if item_type == "outline":
        premise = meta.get("premise") or meta.get("description", "")
        structure = _get_structure(novel_dir, meta)
        vol_count = len(structure["volumes"])
        total_ch = sum(len(v["chapters"]) for v in structure["volumes"])
        return [
            {"role": "system", "content": f"你是一位资深网络小说策划人。请输出完整的 Markdown 格式大纲。{style_hint}"},
            {"role": "user", "content": f"""请为小说《{title}》构思全局大纲。

核心构思：{premise}
预计规模：{vol_count}卷，共约{total_ch}章

请按以下结构输出（Markdown格式）：
# {title} · 全局大纲

## 一、核心概念
类型、篇幅、核心卖点、一句话梗概

## 二、世界观设定
详细的世界观设定

## 三、核心矛盾
列出核心矛盾和冲突

## 四、各卷结构
### 第一卷：[卷名]（Ch 001-XXX）
时间跨度、核心主题、关键事件列表、卷末高潮
（每卷都要有具体的卷名）

## 五、核心主题与立意

## 六、写作风格建议"""},
        ]

    if item_type == "characters":
        outline = _read_file(novel_dir, "global_outline.md")
        structure = _get_structure(novel_dir, meta)
        vol_outlines = ""
        for vol in structure["volumes"]:
            vo = _read_file(novel_dir, f"{vol['dir']}/outline_detailed.md")
            if vo:
                vol_outlines += f"\n### {vol['name']}\n{vo[:3000]}\n"
        return [
            {"role": "system", "content": "你是一位资深网络小说策划人。请输出完整的 Markdown 格式人物档案。"},
            {"role": "user", "content": f"""请根据以下完整大纲体系，为小说《{title}》设计详细的人物档案。

整体大纲：
{outline}

{('各卷章节大纲：' + chr(10) + vol_outlines) if vol_outlines else ''}

请按以下格式输出每个角色：
# {title} · 人物档案

---

## 核心人物

### [角色名]（主角/配角）

- **身份**：
- **年龄**：
- **外貌**：
- **性格**：
- **核心能力**：
- **弱点**：
- **人物弧光**：

---
（列出所有主要角色和重要配角，最后附人物关系图谱）"""},
        ]

    if item_type == "vol_outline":
        outline = _read_file(novel_dir, "global_outline.md")
        characters = _read_file(novel_dir, "characters.md")
        structure = _get_structure(novel_dir, meta)
        vol_idx = item.get("volIdx", 0)
        vol = structure["volumes"][vol_idx]
        vol_num = vol_idx + 1

        ch_start = 1
        for vi in range(vol_idx):
            ch_start += len(structure["volumes"][vi]["chapters"])
        ch_end = ch_start + len(vol["chapters"]) - 1

        return [
            {"role": "system", "content": "你是一位资深网络小说策划人。请输出详细的 Markdown 格式章节大纲。"},
            {"role": "user", "content": f"""请为小说《{title}》第{vol_num}卷（{vol['name']}）规划详细的逐章大纲。

全局大纲：
{outline}

人物设定：
{characters}

本卷章节范围：第{ch_start:03d}章到第{ch_end:03d}章

请按以下格式输出每章：
# {vol['name']} · 详细大纲

### 第{ch_start:03d}章：[章节名]
**时间**：
**地点**：
- 场景1：[详细描述]
- 场景2：[详细描述]
- 本章关键转折：
- 感情线推进：

（每章都要有具体名称、时间地点和多个场景描述）"""},
        ]

    if item_type == "chapter":
        outline = _read_file(novel_dir, "global_outline.md")
        characters = _read_file(novel_dir, "characters.md")
        story_bible = _read_file(novel_dir, "story_bible.md")
        structure = _get_structure(novel_dir, meta)
        vol_idx = item.get("volIdx", 0)
        ch_idx = item.get("chIdx", 0)
        vol = structure["volumes"][vol_idx]
        vol_outline = _read_file(novel_dir, f"{vol['dir']}/outline_detailed.md")
        ch = vol["chapters"][ch_idx]
        ch_num = ch["id"].replace("chapter_", "")

        # 挖坑填坑记录（未解伏笔 + 已回收），用于保持悬念并在合适时机收束
        plot_threads = _read_file(novel_dir, "plot_threads.md")
        total_chapters = sum(len(v["chapters"]) for v in structure["volumes"])
        cur_chapter_index = sum(len(structure["volumes"][i]["chapters"]) for i in range(vol_idx)) + ch_idx
        is_near_end = total_chapters > 0 and (cur_chapter_index >= total_chapters * 0.85)

        # Load recent summaries
        recent_summaries = ""
        summaries_file = novel_dir / "consistency" / "summaries.json"
        if summaries_file.exists():
            all_summaries = json.loads(summaries_file.read_text(encoding="utf-8"))
            all_ch_ids = []
            for v in structure["volumes"]:
                for c in v["chapters"]:
                    all_ch_ids.append(c["id"])
            cur_idx = all_ch_ids.index(ch["id"]) if ch["id"] in all_ch_ids else -1
            recent_ids = all_ch_ids[max(0, cur_idx - 5):cur_idx]
            for rid in recent_ids:
                if rid in all_summaries:
                    recent_summaries += f"{rid}: {all_summaries[rid]}\n\n"

        # Load previous chapter ending
        prev_context = ""
        if ch_idx > 0:
            prev_ch = vol["chapters"][ch_idx - 1]
            prev = _read_file(novel_dir, f"{vol['dir']}/{prev_ch['filename']}")
            if prev:
                prev_context = prev[-1500:]
        elif vol_idx > 0:
            prev_vol = structure["volumes"][vol_idx - 1]
            if prev_vol["chapters"]:
                prev_ch = prev_vol["chapters"][-1]
                prev = _read_file(novel_dir, f"{prev_vol['dir']}/{prev_ch['filename']}")
                if prev:
                    prev_context = prev[-1500:]

        system_content = f"""你是一位资深中文网络小说作家。请撰写完整的小说正文，不是大纲。
{style_hint}
【核心规则】你必须严格遵守「故事圣经」中记录的所有事实（角色名称、年龄、身份、事件时间等）。不得与已有章节产生任何矛盾。
同一章节内，同一角色（不论身份、职位）自始至终必须使用同一姓名，不得中途改换为其他人名。

要求：
1. 至少2000字中文正文
2. 包含详细的场景描写、人物对话、动作描写、心理活动、环境氛围
3. 以 # 第{ch_num}章：[章节名] 开头
4. 第二行写 **时间**：xxx
5. 第三行写 **地点**：xxx
6. 然后是完整的正文内容

【悬念与收束】故事要有悬念：可适当在本章埋下新伏笔/悬念（挖坑），或在合适时机回收前文已埋的伏笔（填坑）。若提供了「挖坑填坑记录」，请参考其中未解伏笔，在自然处回收；临近结局时应有意识地收束未填的坑。"""

        user_content = f"请为小说《{title}》撰写第{ch_num}章的完整正文。\n\n"
        if story_bible and len(story_bible) > 100:
            user_content += f"══ 故事圣经（事实基准，必须严格遵守）══\n{story_bible}\n\n"
        user_content += f"══ 全局大纲 ══\n{outline[:2000]}\n\n"
        user_content += f"══ 人物设定 ══\n{characters[:2000]}\n\n"
        user_content += f"══ 本卷详细大纲 ══\n{vol_outline}\n\n"
        if recent_summaries:
            user_content += f"══ 近期章节摘要（保持连贯）══\n{recent_summaries}\n"
        if prev_context:
            user_content += f"══ 上一章结尾 ══\n{prev_context}\n\n"
        if plot_threads and len(plot_threads.strip()) > 50:
            user_content += f"══ 挖坑填坑记录（未解伏笔可在合适处回收；可继续埋新坑）══\n{plot_threads[:2500]}\n\n"
        if is_near_end:
            user_content += "【提醒】当前已临近全书尾声，请在本章中有意识地回收前文未解伏笔，避免烂尾。\n\n"
        user_content += "请直接输出完整章节正文。"

        return [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

    return None


# ────────────────────────── Post-Chapter Hooks ──────────────────────────

def _after_chapter(novel_dir: Path, meta: dict, item: dict,
                   content: str, ai_cfg: dict, task: dict):
    """Run consistency pipeline after chapter generation."""
    structure = _get_structure(novel_dir, meta)
    vol_idx = item.get("volIdx", 0)
    ch_idx = item.get("chIdx", 0)
    chapter_id = structure["volumes"][vol_idx]["chapters"][ch_idx]["id"]
    MAX_RETRIES = 2

    for attempt in range(MAX_RETRIES + 1):
        # 1. Extract facts
        _log(task, f"  提取事实信息（{chapter_id}）…")
        try:
            _extract_and_save_facts(novel_dir, chapter_id, content, ai_cfg)
        except Exception as e:
            _log(task, f"  ⚠ 事实提取失败：{e}")
            break

        # 2. Consistency check
        _log(task, f"  一致性检查…")
        try:
            report = run_consistency_check(str(novel_dir))
        except Exception as e:
            _log(task, f"  ⚠ 一致性检查失败：{e}")
            break

        issues = report.get("issues", [])
        # 重写时只修复与本章相关的问题
        chapter_issues = [i for i in issues if chapter_id in i.get("chapters", [])]
        if not issues:
            _log(task, "  ✓ 一致性检查通过")
            break

        if attempt < MAX_RETRIES:
            if not chapter_issues:
                _log(task, "  问题均不涉及本章，跳过自动修正")
                break
            _log(task, f"  发现 {len(chapter_issues)} 个与本章相关的问题，自动修正（{attempt + 1}/{MAX_RETRIES}）…")
            new_content = _rewrite_with_fixes(
                novel_dir, meta, item, content, chapter_issues, ai_cfg
            )
            if new_content:
                content = new_content
                full_path = novel_dir / item["path"]
                full_path.write_text(content, encoding="utf-8")
            else:
                _log(task, "  ⚠ 自动修正失败")
                break
        else:
            _log(task, f"  ⚠ 仍有 {len(issues)} 个一致性问题")

    # 3. Generate summary
    _log(task, f"  生成章节摘要…")
    try:
        _generate_and_save_summary(novel_dir, chapter_id, content, ai_cfg)
    except Exception as e:
        _log(task, f"  ⚠ 摘要生成失败：{e}")

    # 4. Update story bible
    _log(task, f"  更新故事圣经…")
    try:
        _update_story_bible(novel_dir, chapter_id, content, ai_cfg)
    except Exception as e:
        _log(task, f"  ⚠ 故事圣经更新失败：{e}")

    # 5. Update 挖坑填坑记录
    _log(task, f"  更新挖坑填坑记录…")
    try:
        _extract_and_update_plot_threads(novel_dir, chapter_id, content, ai_cfg)
    except Exception as e:
        _log(task, f"  ⚠ 挖坑填坑更新失败：{e}")


def _parse_facts_json(text: str) -> dict:
    """Parse JSON from AI fact-extraction output; tolerate markdown, trailing commas, truncation."""
    if not text or not text.strip():
        raise ValueError("空响应")
    # Remove reasoning blocks
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.DOTALL).strip()
    # Extract from markdown code block if present
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    raw = match.group(1).strip() if match else text.strip()
    # Find outermost { ... } in case of leading/trailing text
    start = raw.find("{")
    if start >= 0:
        depth = 0
        end = -1
        in_string = False
        escape = False
        quote = None
        i = start
        while i < len(raw):
            c = raw[i]
            if escape:
                escape = False
                i += 1
                continue
            if c == "\\" and in_string:
                escape = True
                i += 1
                continue
            if not in_string:
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
                elif c in ("'", '"'):
                    in_string = True
                    quote = c
            elif c == quote:
                in_string = False
            i += 1
        if end >= 0:
            raw = raw[start : end + 1]
    # Remove trailing commas before ] or } (common AI mistake)
    raw = re.sub(r",\s*([}\]])", r"\1", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        if getattr(e, "pos", None) is None:
            raise
        # Truncated or unterminated string: keep only up to error position
        trimmed = raw[: e.pos].rstrip()
        # If we cut in the middle of a string, we may have left an incomplete key-value
        # e.g. ..., "description": "  or  ..., "name": 
        last_comma = trimmed.rfind(",")
        if last_comma >= 0:
            suffix = trimmed[last_comma + 1 :].strip()
            if re.match(r'^"[^"]*"\s*:\s*"?\s*$', suffix):
                trimmed = trimmed[:last_comma].rstrip().rstrip(",")
        else:
            trimmed = re.sub(r'\s*"[^"]*"\s*:\s*"?\s*$', "", trimmed)
        open_brackets = trimmed.count("[") - trimmed.count("]")
        open_braces = trimmed.count("{") - trimmed.count("}")
        if open_brackets >= 0 and open_braces >= 0:
            repair = trimmed + "]" * open_brackets + "}" * open_braces
            try:
                return json.loads(repair)
            except json.JSONDecodeError:
                pass
        raise


def _extract_and_save_facts(novel_dir: Path, chapter_id: str,
                            content: str, ai_cfg: dict):
    result = _call_ai_complete([
        {"role": "system", "content": """你是一个文本分析助手。请从小说章节中提取结构化事实，输出严格的 JSON（不要输出任何其他内容）。

JSON 格式：
{
  "characters_present": [
    { "name": "全名", "age": "年龄(如提到)", "role": "身份", "description": "外貌特征", "status": "active/departed/deceased" }
  ],
  "new_characters_introduced": ["首次出场的角色名"],
  "character_exits": [
    { "name": "角色名", "reason": "退休/死亡/离开" }
  ],
  "major_events": [
    { "id": "唯一英文标识如first_launch", "description": "事件描述", "time": "发生时间" }
  ],
  "time_period": "本章时间段",
  "locations": ["地点"],
  "key_facts": [
    { "id": "唯一英文标识", "content": "需要后续保持一致的事实" }
  ],
  "within_chapter_name_conflicts": [
    { "role_or_identity": "身份或职位描述（如导演、经理、老师）", "names": ["人名A", "人名B"] }
  ]
}
说明：若本章中同一身份/职位被用不同人名指代（例如前文说「导演张艺谋」后文又说「导演张伟」），请在 within_chapter_name_conflicts 中列出，每项为同一身份对应的多个人名。无此类情况则为空数组 []。"""},
        {"role": "user", "content": f"请提取以下章节的结构化事实：\n\n{content[:8000]}"},
    ], ai_cfg, max_tokens=4096)

    if not result:
        raise RuntimeError("AI 未返回结果")

    try:
        facts = _parse_facts_json(result)
    except (ValueError, json.JSONDecodeError) as e:
        raise RuntimeError(f"JSON 解析失败: {e}") from e

    # Ensure required keys exist for consistency checks
    for key in ("characters_present", "new_characters_introduced", "character_exits",
                "major_events", "time_period", "locations", "key_facts", "within_chapter_name_conflicts"):
        if key not in facts:
            facts[key] = [] if key != "time_period" else ""

    consistency_dir = novel_dir / "consistency"
    consistency_dir.mkdir(parents=True, exist_ok=True)
    (consistency_dir / f"{chapter_id}_facts.json").write_text(
        json.dumps(facts, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _generate_and_save_summary(novel_dir: Path, chapter_id: str,
                               content: str, ai_cfg: dict):
    summary = _call_ai_complete([
        {"role": "system", "content": "请用200-300字概括章节关键情节。重点包括：主要事件和转折、角色行动和关系变化、为后续埋下的伏笔。只输出摘要，不要其他内容。"},
        {"role": "user", "content": content[:8000]},
    ], ai_cfg, max_tokens=2048)

    if not summary:
        return

    summaries_file = novel_dir / "consistency" / "summaries.json"
    all_summaries = {}
    if summaries_file.exists():
        all_summaries = json.loads(summaries_file.read_text(encoding="utf-8"))
    all_summaries[chapter_id] = summary.strip()
    summaries_file.write_text(
        json.dumps(all_summaries, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _update_story_bible(novel_dir: Path, chapter_id: str,
                        content: str, ai_cfg: dict):
    bible_path = novel_dir / "story_bible.md"
    bible = bible_path.read_text(encoding="utf-8") if bible_path.exists() else ""

    updated = _call_ai_complete([
        {"role": "system", "content": """你是故事连续性编辑。请根据新章节信息更新故事圣经。
规则：
1. 只添加新信息，不要删除或修改已有条目
2. 新角色添加到「角色登记」表格
3. 重要事件添加到「关键事件」列表
4. 角色状态变化（退休/死亡/晋升）添加到「角色状态变更」
5. 时间节点添加到「时间线」
6. 输出完整的更新后的故事圣经 Markdown"""},
        {"role": "user", "content": f"当前故事圣经：\n{bible}\n\n新章节（{chapter_id}）内容：\n{content[:6000]}"},
    ], ai_cfg, max_tokens=8192)

    if updated:
        bible_path.write_text(updated, encoding="utf-8")


def _extract_and_update_plot_threads(novel_dir: Path, chapter_id: str,
                                     content: str, ai_cfg: dict):
    """从本章提取新埋下的伏笔（挖坑）与本章回收的伏笔（填坑），合并进 plot_threads.md。"""
    threads_path = novel_dir / "plot_threads.md"
    existing = threads_path.read_text(encoding="utf-8") if threads_path.exists() else """# 挖坑填坑记录

用于记录前文埋下的伏笔与悬念（挖坑），以及在后续章节中的回收（填坑）。

## 未解伏笔（挖坑）
（暂无）

## 已回收（填坑）
（暂无）
"""

    updated = _call_ai_complete([
        {"role": "system", "content": """你是故事编辑。根据新章节内容，更新「挖坑填坑记录」。
规则：
1. **挖坑**：识别本章新埋下的伏笔、悬念、未解之谜（如神秘人身份、某物来历、角色秘密等），添加到「未解伏笔」列表，格式：- **第N章**：简短一句描述。
2. **填坑**：若本章回收/揭晓了前文某伏笔，在「已回收」中新增一条，格式：- **第N章**回收（原第M章）：简短一句。同时从「未解伏笔」中删除该条（若之前有记录）。
3. 若本章既无新挖坑也无填坑，可只做极少量文字微调或保持原样，不要编造。
4. 输出完整的更新后的 Markdown，保留「# 挖坑填坑记录」「## 未解伏笔」「## 已回收」结构。"""},
        {"role": "user", "content": f"当前挖坑填坑记录：\n{existing}\n\n新章节（{chapter_id}）内容：\n{content[:5000]}"},
    ], ai_cfg, max_tokens=4096)

    if updated and len(updated.strip()) > 100:
        threads_path.write_text(updated, encoding="utf-8")


def _rewrite_with_fixes(novel_dir: Path, meta: dict, item: dict,
                        content: str, issues: list, ai_cfg: dict):
    """Rewrite a chapter with consistency fixes."""
    messages = _build_prompt(novel_dir, meta, item)
    if not messages:
        return None

    issue_text = "\n".join(
        f"{i+1}. [{iss['severity']}] {iss['detail']}"
        for i, iss in enumerate(issues)
    )
    messages.append({
        "role": "user",
        "content": f"""⚠️ 注意：你之前写的版本存在以下一致性问题，请在重写时修复：

{issue_text}

请严格按照故事圣经中的事实重写本章，确保所有角色名称、年龄、身份、事件描述与前文完全一致。""",
    })

    return _call_ai_complete(messages, ai_cfg)


def _update_volume_names_from_outline(novel_dir: Path, meta: dict, content: str):
    """Parse volume names from global outline and update meta.json."""
    pattern = re.compile(
        r"###\s*第([一二三四五六七八九十\d]+)卷[：:]\s*(.+?)(?:\s*[（(]|$)",
        re.MULTILINE,
    )
    num_map = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
               "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

    volumes = {}
    for m in pattern.finditer(content):
        num = num_map.get(m.group(1), None)
        if num is None:
            try:
                num = int(m.group(1))
            except ValueError:
                continue
        name = m.group(2).strip()
        volumes[f"volume_{num}"] = f"第{m.group(1)}卷：{name}"

    if volumes:
        meta["volumes"] = {**meta.get("volumes", {}), **volumes}
        meta_path = novel_dir / "meta.json"
        meta_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
