# Book · AI 小说创作与书架

用 AI 写小说、读小说：支持一键生成全书（大纲 / 人物 / 章节）、自动生产男频 / 女频、简练有悬念的小说介绍与封面，并带书架阅读与导出。

## 功能

- **创作中心**：填写核心构思（或交给 AI 自动生成），一键生成全局大纲、卷大纲、人物设定与全部章节
- **小说介绍**：核心构思仅作创作依据；面向读者的「小说介绍」由 AI 根据大纲生成，简练有悬念、不剧透
- **自动生产**：无需提供构思——选择男频 / 女频，由 AI 根据流行趋势生成构思与配置（卷数 / 章数 20～500 由主题决定），可单本生成或连续自动生产（男频女频轮流）
- **书架**：男频 / 女频分类、搜索、阅读、评论、导出 TXT/Word
- **封面**：根据书名与介绍生成封面图（需配置 NVIDIA FLUX 或兼容接口）

## 运行

```bash
cd website
pip install -r requirements.txt
python server.py
```

浏览器打开 **http://localhost:8080**。

- 默认使用内置 AI（若已配置）；也可在「AI 创作 → 设置」中填写自己的 API Key、Base URL、模型。
- 封面生成依赖 NVIDIA FLUX 或可替换的图生接口（见 `server.py` 中 `FLUX_IMAGE_URL` 与相关逻辑）。

## 项目结构

```
book/
├── website/           # 主应用
│   ├── server.py      # Flask 服务：API、任务、封面、自动生产流水线
│   ├── tasks.py       # 后台生成任务（大纲、人物、章节）
│   ├── consistency.py # 章节事实抽取与一致性检查
│   ├── build_site.py  # 构建书架静态数据
│   ├── js/            # 前端（书架、阅读器、创作中心）
│   ├── css/
│   └── requirements.txt
├── *_novel/            # 各小说目录（meta.json、卷、章节、封面等）
└── novel-website/      # 可选：Next 等其它站点
```

## 开源协议

MIT
