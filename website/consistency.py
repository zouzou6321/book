"""
Local consistency checker for AI-generated novels.
Compares structured facts extracted from each chapter to detect contradictions.
No AI needed — pure Python rule-based comparison on pre-extracted JSON data.
"""

import json
from pathlib import Path
from collections import defaultdict


def load_all_facts(novel_dir: Path) -> dict:
    consistency_dir = novel_dir / "consistency"
    if not consistency_dir.exists():
        return {}
    facts = {}
    for f in sorted(consistency_dir.glob("chapter_*_facts.json")):
        ch_id = f.stem.replace("_facts", "")
        try:
            facts[ch_id] = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
    return facts


def check_character_descriptions(all_facts: dict) -> list:
    """Flag characters whose age/role/description conflicts across chapters."""
    issues = []
    char_data = defaultdict(list)

    for ch_id, facts in all_facts.items():
        for c in facts.get("characters_present", []):
            char_data[c["name"]].append({"chapter": ch_id, **c})

    for name, appearances in char_data.items():
        # Age conflicts
        ages = [(a["chapter"], a.get("age", "")) for a in appearances if a.get("age")]
        unique_ages = set(v for _, v in ages)
        if len(unique_ages) > 1:
            detail_parts = [f"{ch}中为{age}" for ch, age in ages]
            issues.append({
                "type": "character_age",
                "severity": "high",
                "character": name,
                "detail": f"角色「{name}」年龄不一致：{'; '.join(detail_parts)}",
                "chapters": [ch for ch, _ in ages],
            })

        # Role conflicts (ignore if it looks like a promotion/change sequence)
        roles = [(a["chapter"], a.get("role", "")) for a in appearances if a.get("role")]
        unique_roles = set(v for _, v in roles)
        if len(unique_roles) > 2:
            detail_parts = [f"{ch}中为「{role}」" for ch, role in roles]
            issues.append({
                "type": "character_role",
                "severity": "medium",
                "character": name,
                "detail": f"角色「{name}」身份描述出现3种以上变体：{'; '.join(detail_parts)}",
                "chapters": [ch for ch, _ in roles],
            })

    return issues


def check_ghost_characters(all_facts: dict) -> list:
    """Flag characters who reappear after explicitly departing/dying."""
    issues = []
    char_timeline = defaultdict(list)

    for ch_id, facts in all_facts.items():
        for c in facts.get("characters_present", []):
            char_timeline[c["name"]].append({
                "chapter": ch_id,
                "status": c.get("status", "active"),
            })
        for ex in facts.get("character_exits", []):
            char_timeline[ex["name"]].append({
                "chapter": ch_id,
                "status": "exited",
                "reason": ex.get("reason", ""),
            })

    for name, timeline in char_timeline.items():
        timeline.sort(key=lambda x: x["chapter"])
        exited_at = None
        exit_reason = ""
        for entry in timeline:
            if entry["status"] in ("departed", "deceased", "exited"):
                exited_at = entry["chapter"]
                exit_reason = entry.get("reason", entry["status"])
            elif exited_at and entry["status"] == "active" and entry["chapter"] > exited_at:
                reason_text = {"departed": "离开", "deceased": "死亡", "exited": "退场"}.get(exit_reason, exit_reason)
                issues.append({
                    "type": "ghost_character",
                    "severity": "high",
                    "character": name,
                    "detail": f"角色「{name}」在{exited_at}中已{reason_text}，但在{entry['chapter']}中再次活跃出场",
                    "chapters": [exited_at, entry["chapter"]],
                })
                break

    return issues


def check_duplicate_introductions(all_facts: dict) -> list:
    """Flag characters introduced as 'new' in multiple chapters."""
    issues = []
    intro_map = defaultdict(list)

    for ch_id, facts in all_facts.items():
        for name in facts.get("new_characters_introduced", []):
            intro_map[name].append(ch_id)

    for name, chapters in intro_map.items():
        if len(chapters) > 1:
            issues.append({
                "type": "duplicate_intro",
                "severity": "high",
                "character": name,
                "detail": f"角色「{name}」在多个章节被作为新角色引入：{', '.join(chapters)}",
                "chapters": chapters,
            })

    return issues


def check_event_time_conflicts(all_facts: dict) -> list:
    """Flag events that are described with conflicting timestamps."""
    issues = []
    events_by_id = defaultdict(list)

    for ch_id, facts in all_facts.items():
        for ev in facts.get("major_events", []):
            eid = ev.get("id", "")
            if eid:
                events_by_id[eid].append({
                    "chapter": ch_id,
                    "description": ev.get("description", ""),
                    "time": ev.get("time", ""),
                })

    for eid, mentions in events_by_id.items():
        times = [(m["chapter"], m["time"]) for m in mentions if m["time"]]
        unique_times = set(t for _, t in times)
        if len(unique_times) > 1:
            detail_parts = [f"{ch}中为「{t}」" for ch, t in times]
            issues.append({
                "type": "event_time_conflict",
                "severity": "high",
                "detail": f"事件「{eid}」的时间在不同章节不一致：{'; '.join(detail_parts)}",
                "chapters": [ch for ch, _ in times],
            })

        descs = [(m["chapter"], m["description"]) for m in mentions if m["description"]]
        unique_descs = set(d for _, d in descs)
        if len(unique_descs) > 1 and len(unique_descs) <= 4:
            detail_parts = [f"{ch}: 「{d[:60]}」" for ch, d in descs]
            issues.append({
                "type": "event_description_conflict",
                "severity": "medium",
                "detail": f"事件「{eid}」的描述在不同章节不一致：\n" + "\n".join(detail_parts),
                "chapters": [ch for ch, _ in descs],
            })

    return issues


def check_within_chapter_name_conflicts(all_facts: dict) -> list:
    """章内人名一致性：同一章内同一身份/职位被不同人名指代时标出。"""
    issues = []
    for ch_id, facts in all_facts.items():
        conflicts = facts.get("within_chapter_name_conflicts") or []
        for item in conflicts:
            if not isinstance(item, dict):
                continue
            names = item.get("names") or []
            role = item.get("role_or_identity") or "某角色"
            if len(names) < 2:
                continue
            names_str = "、".join(names)
            issues.append({
                "type": "within_chapter_name_conflict",
                "severity": "high",
                "character": names_str,
                "detail": f"本章内「{role}」先后被指代为不同人名：{names_str}，需统一为同一人。",
                "chapters": [ch_id],
            })
    return issues


def check_key_fact_conflicts(all_facts: dict) -> list:
    """Flag key facts that appear in multiple chapters with differences."""
    issues = []
    fact_map = defaultdict(list)

    for ch_id, facts in all_facts.items():
        for kf in facts.get("key_facts", []):
            if isinstance(kf, dict):
                fid = kf.get("id", "")
                if fid:
                    fact_map[fid].append({"chapter": ch_id, "content": kf.get("content", "")})
            elif isinstance(kf, str) and len(kf) > 5:
                # Group by first 10 chars as rough key
                key = kf[:10]
                fact_map[key].append({"chapter": ch_id, "content": kf})

    for fid, mentions in fact_map.items():
        if len(mentions) > 1:
            unique = set(m["content"] for m in mentions)
            if len(unique) > 1:
                issues.append({
                    "type": "fact_conflict",
                    "severity": "medium",
                    "detail": f"关键事实冲突：" + "; ".join(f'{m["chapter"]}:「{m["content"][:80]}」' for m in mentions),
                    "chapters": [m["chapter"] for m in mentions],
                })

    return issues


def run_check(novel_dir) -> dict:
    """Run all consistency checks. Returns a report dict."""
    novel_dir = Path(novel_dir)
    all_facts = load_all_facts(novel_dir)

    if not all_facts:
        return {"ok": True, "issues": [], "checked_chapters": 0}

    issues = []
    issues.extend(check_character_descriptions(all_facts))
    issues.extend(check_ghost_characters(all_facts))
    issues.extend(check_duplicate_introductions(all_facts))
    issues.extend(check_within_chapter_name_conflicts(all_facts))
    issues.extend(check_event_time_conflicts(all_facts))
    issues.extend(check_key_fact_conflicts(all_facts))

    # Sort by severity
    severity_order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda x: severity_order.get(x.get("severity", "low"), 2))

    report = {
        "ok": len(issues) == 0,
        "issues": issues,
        "checked_chapters": len(all_facts),
        "high_count": sum(1 for i in issues if i.get("severity") == "high"),
        "medium_count": sum(1 for i in issues if i.get("severity") == "medium"),
    }

    # Save report
    consistency_dir = novel_dir / "consistency"
    consistency_dir.mkdir(exist_ok=True)
    (consistency_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return report
