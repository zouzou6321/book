/* =================================================================
   AI Creation Center – create.js
   Provides project list, novel setup, and workspace with background
   task-based AI generation (all AI work runs on the backend).
   ================================================================= */

const creator = {
  // ─── State ───
  mode: 'projects',    // projects | setup | workspace
  novels: [],
  novel: null,         // current novel structure
  activeItem: null,    // { type, volIdx?, chIdx?, path }
  editingTitle: false, // 侧栏书名编辑态
  isGenerating: false,
  _pollTimer: null,
  _logSince: 0,

  // ─── Settings ───
  getSettings() {
    const api_key = localStorage.getItem('ai_api_key') || '';
    const base_url = localStorage.getItem('ai_base_url') || '';
    const model = localStorage.getItem('ai_model') || '';
    return { api_key, base_url, model };
  },

  isUsingBuiltin() {
    return !this.getSettings().api_key;
  },

  saveSettings() {
    localStorage.setItem('ai_api_key', document.getElementById('cfg-api-key').value.trim());
    localStorage.setItem('ai_base_url', document.getElementById('cfg-base-url').value.trim());
    localStorage.setItem('ai_model', document.getElementById('cfg-model').value.trim());
    this.toggleSettings();
    this.updateAIBadge();
  },

  clearSettings() {
    localStorage.removeItem('ai_api_key');
    localStorage.removeItem('ai_base_url');
    localStorage.removeItem('ai_model');
    document.getElementById('cfg-api-key').value = '';
    document.getElementById('cfg-base-url').value = '';
    document.getElementById('cfg-model').value = '';
    this.toggleSettings();
    this.updateAIBadge();
  },

  toggleSettings() {
    const modal = document.getElementById('settings-modal');
    const hidden = modal.classList.toggle('hidden');
    if (!hidden) {
      const s = this.getSettings();
      document.getElementById('cfg-api-key').value = s.api_key;
      document.getElementById('cfg-base-url').value = s.base_url;
      document.getElementById('cfg-model').value = s.model;
      const notice = document.getElementById('builtin-ai-notice');
      if (notice) notice.style.display = s.api_key ? 'none' : 'block';
    }
  },

  // ─── Initialization ───
  init() {
    if (this.mode === 'workspace' && this.novel) return;
    this.showProjects();
  },

  goBack() {
    if (this.mode === 'workspace') {
      this._stopPolling();
      this.mode = 'projects';
      this.novel = null;
      this.showProjects();
    } else if (this.mode === 'setup') {
      this.mode = 'projects';
      this.showProjects();
    } else {
      router.go('catalog');
    }
  },

  updateBackBtn() {
    const btn = document.getElementById('create-back-btn');
    const title = document.getElementById('create-title');
    if (this.mode === 'projects') {
      btn.textContent = '← 返回书架';
      title.textContent = 'AI 创作中心';
    } else if (this.mode === 'setup') {
      btn.textContent = '← 返回项目';
      title.textContent = '创建新小说';
    } else {
      btn.textContent = '← 返回项目';
      title.textContent = this.novel?.meta?.title ? `《${this.novel.meta.title}》创作空间` : '创作空间';
    }
  },

  // ─── Project List ───
  async showProjects() {
    this.mode = 'projects';
    this.updateBackBtn();
    const container = document.getElementById('create-content');
    container.innerHTML = '<div class="loading">加载中…</div>';

    try {
      const res = await fetch('/api/novel/list');
      this.novels = await res.json();
    } catch {
      this.novels = [];
    }

    document.getElementById('create-content').classList.remove('create-content-workspace');
    let cards = `<div class="create-card create-new-card" onclick="creator.showSetup()">
      <div class="new-card-icon">+</div>
      <div class="new-card-label">创建新小说</div>
    </div>`;

    for (const n of this.novels) {
      const chars = n.total_chars > 10000
        ? (n.total_chars / 10000).toFixed(1) + '万字'
        : n.total_chars + '字';
      const hasCover = n.cover_image || n.meta.cover_image;
      const coverStyle = hasCover
        ? `background-image: url('/api/novel/cover/${n.id}?t=${Date.now()}'); background-size: cover; background-position: center;`
        : `background: linear-gradient(135deg, hsl(${(n.id.length * 37) % 360}, 55%, 42%), hsl(${(n.id.length * 37 + 40) % 360}, 45%, 32%);`;
      const coverContent = hasCover ? '' : '<div class="project-card-cover-placeholder">📖</div>';
      cards += `<div class="create-card create-project-card" onclick="creator.openWorkspace('${n.id}')">
        <div class="project-card-cover" style="${coverStyle}">${coverContent}</div>
        <div class="project-card-meta">
          <div class="project-card-title">${n.meta.title}</div>
          <div class="project-card-sub">${n.meta.subtitle || ''}</div>
          <div class="project-card-stats">${n.chapter_count} 章 · ${chars}</div>
          <div class="project-card-tags">${(n.meta.tags || []).map(t => `<span>${t}</span>`).join('')}</div>
        </div>
      </div>`;
    }

    container.innerHTML = `<div class="create-projects">${cards}</div>`;
  },

  // ─── Setup Form ───
  showSetup() {
    this.mode = 'setup';
    this.updateBackBtn();
    const container = document.getElementById('create-content');
    container.classList.remove('create-content-workspace');
    container.innerHTML = `
    <div class="create-setup">
      <div class="setup-auto-section">
        <div class="setup-auto-title">自动生产（无需提供构思）</div>
        <p class="setup-auto-desc">由 AI 根据流行趋势生成核心构思与配置，直接开始创作。</p>
        <div class="setup-auto-actions">
          <button type="button" class="btn-auto-seed btn-secondary" onclick="creator.autoSeedThenCreate('male')">生成一部 · 男频</button>
          <button type="button" class="btn-auto-seed btn-secondary" onclick="creator.autoSeedThenCreate('female')">生成一部 · 女频</button>
          <button type="button" class="btn-pipeline btn-secondary" onclick="creator.togglePipeline()">连续自动生产（男频/女频轮流）</button>
        </div>
        <div id="pipeline-status" class="pipeline-status hidden"></div>
      </div>
      <hr class="setup-divider">
      <form id="setup-form" onsubmit="creator.handleSetupSubmit(event)">
        <div class="form-group">
          <label>核心构思 <span class="required">*</span></label>
          <textarea id="sf-premise" rows="5" required placeholder="用几句话描述故事的核心概念、主角设定和故事走向…&#10;例：现代女博士穿越到架空古代，以谋士身份辅佐最弱势力的王爷争霸天下…"></textarea>
        </div>
        <div class="form-group">
          <label>作者</label>
          <input type="text" id="sf-author" value="AI & Thomas">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>卷数</label>
            <input type="number" id="sf-volumes" value="3" min="1" max="10">
          </div>
          <div class="form-group">
            <label>总章数</label>
            <input type="number" id="sf-chapters" value="50" min="5" max="500">
          </div>
        </div>
        <div class="setup-advanced-toggle" id="setup-advanced-toggle" onclick="creator.toggleSetupAdvanced()">
          <span class="setup-advanced-toggle-icon" id="setup-advanced-icon">▼</span> 高级设定
        </div>
        <div class="setup-advanced" id="setup-advanced">
          <div class="form-group">
            <label>小说标题 <span class="optional-tag">（选填，留空自动生成）</span></label>
            <input type="text" id="sf-title" placeholder="根据构思自动生成">
          </div>
          <div class="form-group">
            <label>英文副标题 <span class="optional-tag">（选填）</span></label>
            <input type="text" id="sf-subtitle" placeholder="根据标题自动生成">
          </div>
          <div class="form-group">
            <label>类型标签 <span class="optional-tag">（选填，留空自动生成）</span></label>
            <input type="text" id="sf-tags" placeholder="根据构思自动判断，逗号分隔">
          </div>
          <div class="form-group">
            <label>写作风格 <span class="optional-tag">（选填）</span></label>
            <div class="style-options" id="sf-style-options">
              <label class="style-chip"><input type="radio" name="sf-style" value=""> 不指定</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="金庸"> 金庸</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="古龙"> 古龙</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="天蚕土豆"> 天蚕土豆</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="猫腻"> 猫腻</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="烽火戏诸侯"> 烽火戏诸侯</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="刘慈欣"> 刘慈欣</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="鲁迅"> 鲁迅</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="余华"> 余华</label>
              <label class="style-chip"><input type="radio" name="sf-style" value="莫言"> 莫言</label>
            </div>
            <input type="text" id="sf-style-custom" placeholder="或自定义风格描述，例：轻松幽默、对话多、节奏快">
          </div>
        </div>
        <button type="submit" class="btn-primary btn-lg">开始创作</button>
      </form>
    </div>`;
  },

  toggleSetupAdvanced() {
    const block = document.getElementById('setup-advanced');
    const icon = document.getElementById('setup-advanced-icon');
    if (!block || !icon) return;
    block.classList.toggle('setup-advanced--open');
    icon.textContent = block.classList.contains('setup-advanced--open') ? '▲' : '▼';
  },

  async autoSeedThenCreate(channel) {
    const btn = document.querySelector(`.btn-auto-seed[onclick="creator.autoSeedThenCreate('${channel}')"]`);
    if (btn) { btn.disabled = true; btn.textContent = '正在生成构思…'; }
    const settings = this.getSettings();
    try {
      const seedRes = await fetch('/api/novel/auto-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ...(settings.api_key && { api_key: settings.api_key, base_url: settings.base_url, model: settings.model }) }),
      });
      const seedData = await seedRes.json();
      if (!seedData.ok || !seedData.seed) throw new Error(seedData.error || '生成构思失败');
      const seed = seedData.seed;
      const initRes = await fetch('/api/novel/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meta: {
            title: seed.title,
            subtitle: seed.subtitle || '',
            author: 'AI & Thomas',
            premise: seed.premise,
            description: '',
            tags: seed.tags || [],
            writing_style: seed.writing_style || '',
            channel: seed.channel || channel,
          },
          volume_count: seed.volume_count || 3,
          total_chapters: seed.total_chapters || 50,
        }),
      });
      const initResult = await initRes.json();
      if (initResult.error || !initResult.id) throw new Error(initResult.error || '创建失败');
      await this.openWorkspace(initResult.id);
      if (confirm('是否立即一键生成全书？（含大纲、人物、章节、介绍与封面）')) this.autoGenerate();
    } catch (err) {
      alert('自动生产失败：' + (err.message || err));
    }
    if (btn) { btn.disabled = false; btn.textContent = channel === 'male' ? '生成一部 · 男频' : '生成一部 · 女频'; }
  },

  _pipelinePollTimer: null,
  togglePipeline() {
    const statusEl = document.getElementById('pipeline-status');
    const btnEl = document.querySelector('.btn-pipeline');
    if (!statusEl) return;
    if (this._pipelinePollTimer) {
      clearInterval(this._pipelinePollTimer);
      this._pipelinePollTimer = null;
      fetch('/api/novel/auto-pipeline/stop', { method: 'POST' }).catch(() => {});
      statusEl.classList.add('hidden');
      statusEl.innerHTML = '';
      if (btnEl) btnEl.textContent = '连续自动生产（男频/女频轮流）';
      return;
    }
    // 立即展示状态区，避免“点了没反应”
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = '<p><strong>正在启动连续生产…</strong></p>';
    if (btnEl) btnEl.textContent = '停止连续生产';

    const settings = this.getSettings();
    fetch('/api/novel/auto-pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alternate_channels: true, auto_publish: false, ...(settings.api_key && { api_key: settings.api_key, base_url: settings.base_url, model: settings.model }) }),
    }).then(r => r.json()).then(data => {
      if (!data.ok) {
        statusEl.innerHTML = '<p class="pipeline-err">启动失败：' + (data.error || '未知错误') + '</p>';
        if (btnEl) btnEl.textContent = '连续自动生产（男频/女频轮流）';
        return;
      }
      statusEl.innerHTML = '<p>已启动，男频/女频轮流生成。</p><p><strong>当前：</strong><span id="pipeline-current">正在生成构思…</span></p><p class="pipeline-hint">生成完一部会自动开始下一部。点击「停止连续生产」结束。</p>';
      const update = () => {
        fetch('/api/novel/auto-pipeline/status').then(r => r.json()).then(s => {
          const cur = document.getElementById('pipeline-current');
          if (cur) {
            if (s.running) {
              cur.textContent = s.novel_id ? ('正在生成 ' + s.novel_id + '…') : '正在生成构思…';
            } else {
              cur.textContent = s.error ? ('已停止：' + s.error) : '已停止';
            }
          }
          if (!s.running) {
            clearInterval(this._pipelinePollTimer);
            this._pipelinePollTimer = null;
            if (btnEl) btnEl.textContent = '连续自动生产（男频/女频轮流）';
          }
        }).catch(() => {});
      };
      update();
      this._pipelinePollTimer = setInterval(update, 5000);
    }).catch(err => {
      statusEl.innerHTML = '<p class="pipeline-err">启动失败：' + (err.message || err) + '</p>';
      if (btnEl) btnEl.textContent = '连续自动生产（男频/女频轮流）';
    });
  },

  async handleSetupSubmit(e) {
    e.preventDefault();
    let title = document.getElementById('sf-title').value.trim();
    let subtitle = document.getElementById('sf-subtitle').value.trim();
    const author = document.getElementById('sf-author').value.trim();
    let tags = document.getElementById('sf-tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
    const premise = document.getElementById('sf-premise').value.trim();
    const styleRadio = document.querySelector('input[name="sf-style"]:checked');
    const styleCustom = document.getElementById('sf-style-custom').value.trim();
    const writingStyle = styleCustom || (styleRadio ? styleRadio.value : '');
    const volumeCount = parseInt(document.getElementById('sf-volumes').value);
    const totalChapters = parseInt(document.getElementById('sf-chapters').value);

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = '正在构思…';

    try {
      const needTitle = !title;
      const needTags = tags.length === 0;
      const needSubtitle = !subtitle;

      if (needTitle || needTags || needSubtitle) {
        btn.textContent = 'AI 正在构思标题和标签…';
        const parts = [];
        if (needTitle) parts.push('"title": "生成的中文标题"');
        if (needSubtitle) parts.push('"subtitle": "English Subtitle"');
        if (needTags) parts.push('"tags": ["标签1", "标签2", "标签3"]');

        const aiRes = await this.callAI([
          { role: 'system', content: '你是一位中文小说命名专家。根据用户提供的故事构思，生成合适的信息。只输出 JSON，不要其他内容。' },
          { role: 'user', content: `故事构思：${premise}\n\n请生成以下内容的 JSON：\n{${parts.join(', ')}}\n\n要求：\n- 标题要简洁有力（2-5个字），适合网络小说\n- 英文副标题是标题的翻译\n- 标签要准确反映题材类型（3-5个）` },
        ]);

        const generated = this.parseJSON(aiRes);
        if (generated) {
          if (needTitle && generated.title) title = generated.title;
          if (needSubtitle && generated.subtitle) subtitle = generated.subtitle;
          if (needTags && generated.tags) tags = generated.tags;
        }

        if (!title) {
          alert('AI 未能生成标题，请手动输入');
          btn.disabled = false;
          btn.textContent = '开始创作';
          return;
        }
      }

      btn.textContent = '创建中…';

      const res = await fetch('/api/novel/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meta: { title, subtitle, author, premise, description: '', tags, writing_style: writingStyle || undefined },
          volume_count: volumeCount,
          total_chapters: totalChapters,
        }),
      });
      const result = await res.json();
      if (result.error) {
        alert(result.error);
        btn.disabled = false;
        btn.textContent = '开始创作';
        return;
      }

      this._setupConfig = { premise, totalChapters, volumeCount, writingStyle };
      await this.openWorkspace(result.id);
    } catch (err) {
      alert('创建失败: ' + err.message);
      btn.disabled = false;
      btn.textContent = '开始创作';
    }
  },

  // ─── Workspace ───
  async openWorkspace(novelId) {
    this.mode = 'workspace';
    const container = document.getElementById('create-content');
    container.innerHTML = '<div class="loading">加载中…</div>';

    const res = await fetch('/api/novel/structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ novel_id: novelId }),
    });
    this.novel = await res.json();
    this.updateBackBtn();

    this.activeItem = null;
    this.editingTitle = false;
    this.renderWorkspace();
    this.updateAIBadge();
  },

  updateAIBadge() {
    const titleEl = document.getElementById('create-title');
    if (!titleEl) return;
    const label = this.isUsingBuiltin() ? '内置 AI' : '自定义 AI';
    const color = this.isUsingBuiltin() ? '#43a047' : '#1976d2';
    titleEl.innerHTML = `AI 创作中心 <span style="font-size:.7rem;background:${color};color:#fff;padding:2px 8px;border-radius:4px;margin-left:6px;vertical-align:middle">${label}</span>`;
  },

  renderWorkspace() {
    const container = document.getElementById('create-content');
    container.classList.add('create-content-workspace');
    container.innerHTML = `
      <div class="workspace-topbar">
        <button class="btn-auto-gen btn-topbar" onclick="creator.autoGenerate()">⚡ 一键生成全书</button>
        <button class="btn-publish btn-topbar" onclick="creator.publish()">📖 发布 / 更新书架</button>
        <button class="btn-unpublish btn-topbar" onclick="creator.unpublish()">🗑 从书架下架</button>
        <div class="export-wrap">
          <button type="button" class="btn-export btn-topbar" onclick="creator.toggleExportMenu()">📤 导出</button>
          <div id="export-menu" class="export-menu hidden">
            <button type="button" onclick="creator.exportNovel('txt'); creator.closeExportMenu();">导出为 TXT</button>
            <button type="button" onclick="creator.exportNovel('docx'); creator.closeExportMenu();">导出为 Word</button>
          </div>
        </div>
      </div>
      <div class="workspace">
        <aside class="workspace-sidebar" id="ws-sidebar"></aside>
        <main class="workspace-main" id="ws-main"></main>
      </div>
      <div id="task-panel" class="task-panel hidden"></div>`;
    this.renderSidebar();
    this.renderEditor();
    this._checkRunningTask();
  },

  renderSidebar() {
    const sidebar = document.getElementById('ws-sidebar');
    if (!sidebar) return;
    const n = this.novel;
    const active = this.activeItem;

    const isActive = (type, vi, ci) => {
      if (!active) return '';
      if (active.type !== type) return '';
      if (vi !== undefined && active.volIdx !== vi) return '';
      if (ci !== undefined && active.chIdx !== ci) return '';
      return 'active';
    };

    const outlineStatus = n.has_outline ? '✓' : '○';
    const charsStatus = n.has_characters ? '✓' : '○';

    let outlineItems = '';
    n.volumes.forEach((vol, vi) => {
      const volOutlineStatus = vol.has_outline ? '✓' : '○';
      outlineItems += `
        <div class="sidebar-item ${isActive('vol_outline', vi)}"
             onclick="creator.selectItem('vol_outline', ${vi})">
          <span>📝 ${vol.name} 大纲</span><span class="sb-status ${vol.has_outline ? 'done' : ''}">${volOutlineStatus}</span>
        </div>`;
    });

    const hasCover = n.meta.cover_image;
    const hasPremise = !!((n.meta.premise || n.meta.description) && (n.meta.premise || n.meta.description).trim());
    const titleEsc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const headerHtml = this.editingTitle
      ? `<div class="sidebar-header sidebar-header-edit">
          <input type="text" id="sidebar-title-input" class="sidebar-title-input" value="${titleEsc(n.meta.title)}" placeholder="小说名称" maxlength="100" />
          <div class="sidebar-header-actions">
            <button type="button" class="btn-sidebar-save" onclick="creator.saveTitle()">保存</button>
            <button type="button" class="btn-sidebar-cancel" onclick="creator.cancelEditTitle()">取消</button>
          </div>
        </div>`
      : `<div class="sidebar-header">
          <span class="sidebar-title-text">${titleEsc(n.meta.title) || '（未命名）'}</span>
          <button type="button" class="btn-edit-title" onclick="creator.startEditTitle()" title="修改书名">✎</button>
        </div>`;
    let html = headerHtml + `
      <div class="sidebar-section">
        <div class="sidebar-phase">创作设定</div>
        <div class="sidebar-item ${isActive('premise')}" onclick="creator.selectItem('premise')">
          <span>📌 核心构思</span><span class="sb-status ${hasPremise ? 'done' : ''}">${hasPremise ? '✓' : '○'}</span>
        </div>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-phase">封面设计</div>
        <div class="sidebar-item ${isActive('cover')}" onclick="creator.selectItem('cover')">
          <span>🎨 封面图片</span><span class="sb-status ${hasCover ? 'done' : ''}">${hasCover ? '✓' : '○'}</span>
        </div>
      </div>
      <div class="sidebar-section">
        <div class="sidebar-phase">一、大纲规划</div>
        <div class="sidebar-item ${isActive('outline')}" onclick="creator.selectItem('outline')">
          <span>📋 整体大纲</span><span class="sb-status ${n.has_outline ? 'done' : ''}">${outlineStatus}</span>
        </div>
        ${outlineItems}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-phase">二、人物设计</div>
        <div class="sidebar-item ${isActive('characters')}" onclick="creator.selectItem('characters')">
          <span>👥 人物设定</span><span class="sb-status ${n.has_characters ? 'done' : ''}">${charsStatus}</span>
        </div>
      </div>`;

    html += `<div class="sidebar-section"><div class="sidebar-phase">三、章节创作</div>`;
    n.volumes.forEach((vol, vi) => {
      let chaptersHtml = '';
      vol.chapters.forEach((ch, ci) => {
        const done = ch.char_count > 200;
        chaptersHtml += `
          <div class="sidebar-item sidebar-chapter ${isActive('chapter', vi, ci)}"
               onclick="creator.selectItem('chapter', ${vi}, ${ci})">
            <span>${ch.title || ch.id}</span>
            <span class="sb-status ${done ? 'done' : ''}">${done ? '✓' : '○'}</span>
          </div>`;
      });
      html += `
        <div class="sidebar-vol-title">${vol.name}</div>
        ${chaptersHtml}`;
    });
    html += `</div>`;

    sidebar.innerHTML = html;
    if (this.editingTitle) {
      const input = document.getElementById('sidebar-title-input');
      if (input) {
        setTimeout(() => { input.focus(); input.select(); }, 0);
      }
    }
  },

  startEditTitle() {
    this.editingTitle = true;
    this.renderSidebar();
  },

  cancelEditTitle() {
    this.editingTitle = false;
    this.renderSidebar();
  },

  async saveTitle() {
    const input = document.getElementById('sidebar-title-input');
    if (!input || !this.novel) return;
    const raw = input.value.trim();
    if (!raw) {
      input.focus();
      return;
    }
    if (raw === (this.novel.meta.title || '')) {
      this.editingTitle = false;
      this.renderSidebar();
      return;
    }
    const statusEl = document.getElementById('editor-status');
    try {
      const res = await fetch('/api/novel/update-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id, updates: { title: raw } }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      this.novel.meta.title = raw;
      this.editingTitle = false;
      this.renderSidebar();
      this.updateBackBtn();
      if (this.novel.meta.published === true) {
        if (statusEl) statusEl.textContent = '正在更新书架…';
        const rebuildRes = await fetch('/api/rebuild', { method: 'POST' });
        const result = await rebuildRes.json();
        if (statusEl) statusEl.textContent = result.ok ? '书名已保存，书架已更新' : '书名已保存，书架更新失败';
        if (result.ok && typeof loadCatalog !== 'undefined') loadCatalog();
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = '保存失败: ' + (err.message || err);
    }
  },

  selectItem(type, volIdx, chIdx) {
    const cur = this.activeItem;
    const isSame = cur && cur.type === type &&
      (volIdx === undefined && chIdx === undefined ? (cur.volIdx === undefined && cur.chIdx === undefined) : (cur.volIdx === volIdx && cur.chIdx === chIdx));
    if (isSame) {
      this.activeItem = null;
      this.renderSidebar();
      this.renderEditor();
      return;
    }

    const n = this.novel;
    let path = '';
    if (type === 'premise') path = '';
    else if (type === 'cover') path = '';
    else if (type === 'outline') path = 'global_outline.md';
    else if (type === 'characters') path = 'characters.md';
    else if (type === 'vol_outline') path = `${n.volumes[volIdx].dir}/outline_detailed.md`;
    else if (type === 'chapter') {
      const ch = n.volumes[volIdx].chapters[chIdx];
      path = `${n.volumes[volIdx].dir}/${ch.filename}`;
    }
    this.activeItem = { type, volIdx, chIdx, path };
    this.editorMode = type === 'cover' ? 'edit' : 'view';
    this.renderSidebar();
    if (type === 'cover') this.renderCoverEditor();
    else this.renderEditor();
  },

  async renderEditor() {
    const main = document.getElementById('ws-main');
    if (!main) return;
    const workspaceEl = document.querySelector('.workspace');
    if (!this.activeItem) {
      main.innerHTML = '<div class="editor-empty">← 从左侧选择要编辑的内容</div>';
      if (workspaceEl) workspaceEl.classList.add('workspace-list-only');
      return;
    }
    if (workspaceEl) workspaceEl.classList.remove('workspace-list-only');

    const item = this.activeItem;
    let title = '';
    if (item.type === 'premise') title = '核心构思';
    else if (item.type === 'outline') title = '全局大纲';
    else if (item.type === 'characters') title = '人物设定';
    else if (item.type === 'vol_outline') title = this.novel.volumes[item.volIdx].name + ' · 卷大纲';
    else if (item.type === 'chapter') {
      const ch = this.novel.volumes[item.volIdx].chapters[item.chIdx];
      title = ch.title || ch.id;
    }

    if (this.editorMode === 'view') {
      const premiseHint = item.type === 'premise'
        ? '<p class="editor-premise-hint">修改后将与现有大纲、人物与章节不一致，需重新生成全书。</p>'
        : '';
      main.innerHTML = `
        <div class="editor-view">
          <div class="editor-view-header">
            <span class="editor-title">${title}</span>
            <button type="button" class="btn-edit-inline" onclick="creator.enterEditMode()">✎ 编辑</button>
          </div>
          <div class="editor-view-preview" id="editor-preview">加载中…</div>
          ${premiseHint}
        </div>`;
      this._loadEditorPreview();
      return;
    }

    // 核心构思编辑：单独布局（警告 + 文本框 + 保存），不调用 read API
    if (item.type === 'premise') {
      main.innerHTML = `
        <div class="editor">
          <div class="editor-toolbar">
            <span class="editor-title">${title}</span>
            <div class="editor-actions">
              <button class="btn-save" onclick="creator.saveContent()">💾 保存</button>
            </div>
          </div>
          <div class="editor-premise-warning" role="alert">
            <strong>⚠️ 重要提示</strong><br>
            修改核心构思后，现有大纲、人物与章节会与新构思脱节。保存后请使用「一键生成全书」重新生成全书内容。
          </div>
          <textarea class="editor-textarea" id="editor-ta" placeholder="输入本书的核心构思（主题、主线、风格等）…"></textarea>
          <div class="editor-footer">
            <span id="editor-status"></span>
            <span id="editor-count">0 字</span>
          </div>
        </div>`;
      const ta = document.getElementById('editor-ta');
      ta.value = (this.novel.meta.premise || this.novel.meta.description || '').trim();
      ta.addEventListener('input', () => this.updateWordCount());
      this.updateWordCount();
      return;
    }

    main.innerHTML = `
      <div class="editor">
        <div class="editor-toolbar">
          <span class="editor-title">${title}</span>
          <div class="editor-actions">
            <button class="btn-generate" id="btn-gen" onclick="creator.generate()">✦ AI 生成</button>
            <button class="btn-save" onclick="creator.saveContent()">💾 保存</button>
          </div>
        </div>
        <textarea class="editor-textarea" id="editor-ta" placeholder="点击「AI 生成」让 AI 创作内容，或直接输入…"></textarea>
        <div class="editor-footer">
          <span id="editor-status"></span>
          <span id="editor-count">0 字</span>
        </div>
      </div>`;

    const ta = document.getElementById('editor-ta');
    try {
      const res = await fetch('/api/novel/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id, path: item.path }),
      });
      const data = await res.json();
      if (data.exists) {
        ta.value = data.content;
        this.updateWordCount();
      }
    } catch {}

    ta.addEventListener('input', () => this.updateWordCount());
  },

  enterEditMode() {
    this.editorMode = 'edit';
    this.renderEditor();
  },

  async _loadEditorPreview() {
    const el = document.getElementById('editor-preview');
    if (!el || !this.activeItem) return;
    if (this.activeItem.type === 'premise') {
      const desc = (this.novel.meta.premise || this.novel.meta.description || '').trim();
      el.textContent = desc || '（未填写）';
      return;
    }
    try {
      const res = await fetch('/api/novel/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id, path: this.activeItem.path }),
      });
      const data = await res.json();
      if (data.exists && data.content) {
        const text = data.content.replace(/\s+/g, ' ').trim();
        const len = data.content.replace(/\s/g, '').length;
        if (text.length > 500) {
          el.textContent = text.slice(0, 500) + '…';
          const more = document.createElement('div');
          more.className = 'editor-preview-more';
          more.textContent = '（共 ' + len + ' 字，点击「编辑」查看全文）';
          el.appendChild(more);
        } else {
          el.textContent = text || '（空）';
        }
      } else {
        el.textContent = '暂无内容，点击「编辑」可 AI 生成或输入。';
      }
    } catch {
      el.textContent = '加载失败';
    }
  },

  updateWordCount() {
    const ta = document.getElementById('editor-ta');
    if (!ta) return;
    const count = ta.value.replace(/\s/g, '').length;
    const el = document.getElementById('editor-count');
    if (el) el.textContent = `${count} 字`;
  },

  // ─── Cover Editor ───
  renderCoverEditor() {
    const main = document.getElementById('ws-main');
    if (!main) return;
    const workspaceEl = document.querySelector('.workspace');
    if (workspaceEl) workspaceEl.classList.remove('workspace-list-only');
    const hasCover = this.novel.meta.cover_image;
    const coverUrl = hasCover
      ? `/api/novel/cover/${this.novel.id}?t=${Date.now()}`
      : '';

    main.innerHTML = `
      <div class="cover-editor">
        <div class="cover-editor-header">
          <span class="editor-title">封面设计</span>
        </div>
        <div class="cover-preview-area">
          ${hasCover
            ? `<img class="cover-preview-img" id="cover-img" src="${coverUrl}" alt="封面">`
            : `<div class="cover-preview-placeholder" id="cover-img">
                <div class="placeholder-icon">🎨</div>
                <div class="placeholder-text">暂无封面</div>
                <div class="placeholder-hint">点击下方按钮通过 AI 自动生成</div>
              </div>`}
        </div>
        <div class="cover-actions">
          ${hasCover ? '<button type="button" class="btn-download-cover" onclick="creator.downloadCover()">⬇ 下载封面</button>' : ''}
          <button class="btn-generate-cover" id="btn-gen-cover" onclick="creator.generateCover()">
            ✦ ${hasCover ? '重新生成封面' : 'AI 生成封面'}
          </button>
        </div>
        <div class="cover-status" id="cover-status"></div>
      </div>`;

    this._checkCoverTask();
  },

  async _checkCoverTask() {
    if (this._coverGenerating) return;
    try {
      const res = await fetch(`/api/novel/cover-status/${this.novel.id}?t=${Date.now()}`);
      const task = await res.json();
      if (task.status === 'running') {
        this._coverGenerating = true;
        const btn = document.getElementById('btn-gen-cover');
        if (btn) btn.disabled = true;
        this._pollCoverStatus();
      }
    } catch {}
  },

  async generateCover() {
    if (this._coverGenerating) return;
    this._coverGenerating = true;

    const btn = document.getElementById('btn-gen-cover');
    const statusEl = document.getElementById('cover-status');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.innerHTML = '<span class="generating">正在启动封面生成…</span>';

    try {
      const settings = this.getSettings();
      const body = { novel_id: this.novel.id };
      if (settings.apiKey) body.api_key = settings.apiKey;
      if (settings.baseUrl) body.base_url = settings.baseUrl;
      if (settings.model) body.model = settings.model;

      const res = await fetch('/api/novel/generate-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        if (statusEl) statusEl.innerHTML = `<span class="error">${data.error}</span>`;
        this._coverGenerating = false;
        if (btn) btn.disabled = false;
        return;
      }

      this._pollCoverStatus();
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<span class="error">请求失败：${e.message}</span>`;
      this._coverGenerating = false;
      if (btn) btn.disabled = false;
    }
  },

  async _pollCoverStatus() {
    const statusEl = document.getElementById('cover-status');
    const btn = document.getElementById('btn-gen-cover');

    const poll = async () => {
      try {
        const res = await fetch(`/api/novel/cover-status/${this.novel.id}?t=${Date.now()}`);
        const task = await res.json();

        if (task.status === 'running') {
          if (statusEl) statusEl.innerHTML = `<span class="generating">${task.progress || '生成中…'}</span>`;
          setTimeout(poll, 2000);
          return;
        }

        if (task.status === 'done') {
          this.novel.meta.cover_image = true;
          if (statusEl) statusEl.innerHTML = '<span class="success">封面生成成功！</span>';
          const imgArea = document.querySelector('.cover-preview-area');
          if (imgArea) {
            imgArea.innerHTML = `<img class="cover-preview-img" src="${task.cover_url}" alt="封面">`;
          }
          if (btn) btn.textContent = '✦ 重新生成封面';
          this.renderSidebar();
        } else if (task.status === 'error') {
          if (statusEl) statusEl.innerHTML = `<span class="error">${task.error}</span>`;
        } else if (task.status === 'cancelled') {
          if (statusEl) statusEl.innerHTML = '<span class="error">已取消</span>';
        }
      } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span class="error">轮询失败：${e.message}</span>`;
      }
      this._coverGenerating = false;
      if (btn) btn.disabled = false;
    };

    setTimeout(poll, 2000);
  },

  async downloadCover() {
    if (!this.novel || !this.novel.meta.cover_image) return;
    const url = `/api/novel/cover/${this.novel.id}?t=${Date.now()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = (this.novel.meta.title || this.novel.id).replace(/[/\\?*:|"]/g, '_') + '_cover.jpg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      const statusEl = document.getElementById('cover-status');
      if (statusEl) statusEl.innerHTML = '<span class="error">下载失败：' + (e.message || e) + '</span>';
    }
  },

  async _autoGenerateCover() {
    const settings = this.getSettings();
    const body = { novel_id: this.novel.id };
    if (settings.apiKey) body.api_key = settings.apiKey;
    if (settings.baseUrl) body.base_url = settings.baseUrl;
    if (settings.model) body.model = settings.model;

    try {
      await fetch('/api/novel/generate-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const logEl = document.getElementById('task-log');
      if (logEl) {
        const line = document.createElement('div');
        line.className = 'task-log-line';
        line.textContent = '⏳ 封面正在后台生成…';
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      }

      const waitDone = async () => {
        const res = await fetch(`/api/novel/cover-status/${this.novel.id}?t=${Date.now()}`);
        const task = await res.json();
        if (task.status === 'running') {
          setTimeout(waitDone, 3000);
          return;
        }
        if (task.status === 'done') {
          this.novel.meta.cover_image = true;
          this.renderSidebar();
          if (logEl) {
            const ok = document.createElement('div');
            ok.className = 'task-log-line success';
            ok.textContent = '✓ 封面生成成功';
            logEl.appendChild(ok);
            logEl.scrollTop = logEl.scrollHeight;
          }
        } else if (logEl) {
          const err = document.createElement('div');
          err.className = 'task-log-line warning';
          err.textContent = '⚠ 封面生成失败，可稍后在封面编辑器中重试';
          logEl.appendChild(err);
          logEl.scrollTop = logEl.scrollHeight;
        }
      };
      setTimeout(waitDone, 3000);
    } catch {}
  },

  // ─── AI Generation (backend tasks) ───
  async generate() {
    if (this.isGenerating) return;
    if (!this.activeItem || !this.novel) return;

    const item = this.activeItem;
    const step = {
      type: item.type,
      volIdx: item.volIdx,
      chIdx: item.chIdx,
      path: item.path,
      label: this._itemLabel(item),
      phase: item.type === 'chapter' ? '章节创作' : item.type === 'characters' ? '人物设计' : '大纲规划',
    };

    await this._submitTask('single', [step]);
  },

  async autoGenerate() {
    if (this.isGenerating) return;

    const steps = this._buildAutoSteps();
    await this._submitTask('auto', steps);
  },

  async stopGeneration() {
    if (!this.novel) return;
    try {
      await fetch(`/api/task/stop/${this.novel.id}`, { method: 'POST' });
    } catch {}
  },

  async _submitTask(taskType, items) {
    const settings = this.getSettings();
    const payload = { novel_id: this.novel.id, task_type: taskType, items };
    if (settings.api_key) {
      payload.api_key = settings.api_key;
      if (settings.base_url) payload.base_url = settings.base_url;
      if (settings.model) payload.model = settings.model;
    }

    try {
      const res = await fetch('/api/task/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (result.error) {
        alert(result.error);
        return;
      }
      this.isGenerating = true;
      this._logSince = 0;
      this._showTaskPanel(taskType, items.length);
      this._startPolling();
    } catch (err) {
      alert('启动任务失败: ' + err.message);
    }
  },

  _itemLabel(item) {
    if (item.type === 'outline') return '整体大纲';
    if (item.type === 'characters') return '人物设定';
    if (item.type === 'vol_outline') return `${this.novel.volumes[item.volIdx].name} 大纲`;
    if (item.type === 'chapter') {
      const ch = this.novel.volumes[item.volIdx].chapters[item.chIdx];
      return ch.title || ch.id;
    }
    return item.path;
  },

  _buildAutoSteps() {
    const n = this.novel;
    const steps = [];
    steps.push({ type: 'outline', path: 'global_outline.md', label: '整体大纲', phase: '大纲规划' });
    n.volumes.forEach((vol, vi) => {
      steps.push({
        type: 'vol_outline', volIdx: vi,
        path: `${vol.dir}/outline_detailed.md`,
        label: `${vol.name} 大纲`, phase: '大纲规划',
      });
    });
    steps.push({ type: 'characters', path: 'characters.md', label: '人物设定', phase: '人物设计' });
    n.volumes.forEach((vol, vi) => {
      vol.chapters.forEach((ch, ci) => {
        steps.push({
          type: 'chapter', volIdx: vi, chIdx: ci,
          path: `${vol.dir}/${ch.filename}`,
          label: ch.title || ch.id, phase: '章节创作',
        });
      });
    });
    return steps;
  },

  // ─── Task Panel UI ───
  _showTaskPanel(taskType, total) {
    const panel = document.getElementById('task-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.classList.add('task-panel-collapsed');
    const label = taskType === 'auto' ? '自动生成中' : '单项生成';
    panel.innerHTML = `
      <div class="task-panel-header">
        <span class="task-panel-title">🚀 ${label}</span>
        <span class="task-panel-summary" id="task-progress-summary">0/${total}</span>
        <div class="task-panel-actions">
          <button type="button" class="task-panel-toggle" onclick="creator._toggleTaskPanel()" title="收起/展开">▲ 展开</button>
          <button class="task-panel-stop" onclick="creator.stopGeneration()">■ 停止</button>
        </div>
      </div>
      <div class="task-panel-body">
        <div class="task-progress-bar"><div class="task-progress-fill" id="task-progress-fill" style="width:0%"></div></div>
        <div class="task-progress-text" id="task-progress-text">准备中… 0/${total}</div>
        <div class="task-log" id="task-log"></div>
      </div>`;
  },

  _toggleTaskPanel() {
    const panel = document.getElementById('task-panel');
    if (!panel) return;
    panel.classList.toggle('task-panel-collapsed');
    const btn = panel.querySelector('.task-panel-toggle');
    if (btn) btn.textContent = panel.classList.contains('task-panel-collapsed') ? '▲ 展开' : '▼ 收起';
  },

  _hideTaskPanel() {
    const panel = document.getElementById('task-panel');
    if (panel) panel.classList.add('hidden');
  },

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._poll(), 2000);
    this._poll();
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  async _poll() {
    if (!this.novel) return;
    try {
      const [statusRes, logRes] = await Promise.all([
        fetch(`/api/task/status/${this.novel.id}`),
        fetch(`/api/task/log/${this.novel.id}?since=${this._logSince}`),
      ]);
      const status = await statusRes.json();
      const logData = await logRes.json();

      const fill = document.getElementById('task-progress-fill');
      const text = document.getElementById('task-progress-text');
      const summary = document.getElementById('task-progress-summary');
      const total = status.total || 0;
      const progress = status.progress || 0;
      if (fill && total > 0) {
        const pct = Math.round((progress / total) * 100);
        fill.style.width = pct + '%';
      }
      if (text) {
        const step = status.current_step || '';
        const phase = status.phase ? `[${status.phase}] ` : '';
        text.textContent = `${phase}${step} — ${progress}/${total}`;
      }
      if (summary) summary.textContent = `${progress}/${total}`;

      const logEl = document.getElementById('task-log');
      if (logEl && logData.entries && logData.entries.length > 0) {
        for (const entry of logData.entries) {
          const line = document.createElement('div');
          line.className = 'task-log-line';
          if (entry.msg.includes('✓')) line.classList.add('success');
          else if (entry.msg.includes('✗') || entry.msg.includes('⚠')) line.classList.add('warning');
          line.textContent = entry.msg;
          logEl.appendChild(line);
        }
        logEl.scrollTop = logEl.scrollHeight;
        this._logSince = logData.next_since;
      }

      if (status.status !== 'running') {
        this._stopPolling();
        this.isGenerating = false;

        const stopBtn = document.querySelector('.task-panel-stop');
        if (stopBtn) stopBtn.style.display = 'none';

        if (status.status === 'done') {
          if (fill) fill.style.width = '100%';
          if (text) text.textContent = '全部完成!';
          const header = document.querySelector('.task-panel-title');
          if (header) header.textContent = '✅ 生成完成';

          // 先生成简练有悬念的小说介绍，再生成封面
          const needIntro = !(this.novel.meta.description && this.novel.meta.description.trim());
          if (needIntro) {
            if (text) text.textContent = '正在生成小说介绍…';
            try {
              const settings = this.getSettings();
              const introRes = await fetch('/api/novel/generate-intro', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  novel_id: this.novel.id,
                  ...(settings.api_key && { api_key: settings.api_key, base_url: settings.base_url, model: settings.model }),
                }),
              });
              const introData = await introRes.json();
              if (introData.ok && introData.description) this.novel.meta.description = introData.description;
            } catch (_) {}
          }
          if (!this.novel.meta.cover_image) {
            this._autoGenerateCover();
          }
        } else if (status.status === 'error') {
          if (text) text.textContent = '任务出错: ' + (status.error || '');
          const header = document.querySelector('.task-panel-title');
          if (header) header.textContent = '❌ 任务出错';
        } else if (status.status === 'cancelled') {
          this._hideTaskPanel();
          await this.refreshStructure();
          return;
        }

        await this.refreshStructure();
        const ta = document.getElementById('editor-ta');
        if (ta && this.activeItem) {
          const content = await this._loadFileContent(this.activeItem.path);
          if (content) {
            ta.value = content;
            this.updateWordCount();
          }
        }
      }
    } catch {}
  },

  async _checkRunningTask() {
    if (!this.novel) return;
    try {
      const res = await fetch(`/api/task/status/${this.novel.id}`);
      const status = await res.json();
      if (status.status === 'running') {
        this.isGenerating = true;
        this._logSince = 0;
        this._showTaskPanel(status.type || 'auto', status.total || 0);
        this._startPolling();
      }
    } catch {}
  },

  // ─── Utility ───
  async callAI(messages) {
    const settings = this.getSettings();
    const payload = { messages };
    if (settings.api_key) {
      payload.api_key = settings.api_key;
      if (settings.base_url) payload.base_url = settings.base_url;
      if (settings.model) payload.model = settings.model;
    }
    const res = await fetch('/api/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.content;
  },

  parseJSON(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = match ? match[1].trim() : text.trim();
    return JSON.parse(raw);
  },

  async _loadFileContent(path) {
    try {
      const res = await fetch('/api/novel/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id, path }),
      });
      const data = await res.json();
      return data.exists ? data.content : '';
    } catch { return ''; }
  },

  // ─── Save & Publish ───
  async saveContent(silent) {
    const ta = document.getElementById('editor-ta');
    if (!ta || !this.activeItem) return;

    const content = ta.value;

    // 核心构思：二次确认后走 update-meta，保存后清空已有大纲/人物/章节，便于按新构思重新生成
    if (this.activeItem.type === 'premise') {
      if (!confirm('修改核心构思后，将清空已有的大纲、人物设定与章节正文，需使用「一键生成全书」重新生成。是否确认保存？')) return;
      try {
        const res = await fetch('/api/novel/update-meta', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            novel_id: this.novel.id,
            updates: { premise: content },
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        this.novel.meta.premise = content;

        const clearRes = await fetch('/api/novel/clear-generated', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ novel_id: this.novel.id }),
        });
        const clearResult = await clearRes.json();
        if (clearResult.error) throw new Error('清空旧内容失败: ' + clearResult.error);

        await this.refreshStructure();

        const statusEl = document.getElementById('editor-status');
        if (statusEl) statusEl.textContent = '已保存，已清空旧大纲与章节。请使用「一键生成全书」重新生成。';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
      } catch (err) {
        const statusEl = document.getElementById('editor-status');
        if (statusEl) statusEl.textContent = '保存失败: ' + (err.message || err);
      }
      return;
    }

    try {
      await fetch('/api/novel/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          novel_id: this.novel.id,
          path: this.activeItem.path,
          content,
        }),
      });

      const statusEl = document.getElementById('editor-status');
      const isChapter = this.activeItem.type === 'chapter';
      const isPublished = this.novel.meta && this.novel.meta.published === true;

      if (!silent && statusEl) statusEl.textContent = '已保存';

      await this.refreshStructure();

      // 已发布的小说：保存章节后自动重建书架，使读者端即时看到更新
      if (isChapter && isPublished) {
        if (statusEl) statusEl.textContent = '已保存，正在更新书架…';
        try {
          const res = await fetch('/api/rebuild', { method: 'POST' });
          const result = await res.json();
          if (statusEl) statusEl.textContent = result.ok ? '已保存，书架已更新' : '已保存，书架更新失败';
          if (result.ok && typeof loadCatalog !== 'undefined') loadCatalog();
        } catch {
          if (statusEl) statusEl.textContent = '已保存，书架更新失败';
        }
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      } else if (!silent && statusEl) {
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
      }
    } catch (err) {
      const statusEl = document.getElementById('editor-status');
      if (statusEl) statusEl.textContent = '保存失败: ' + err.message;
    }
  },

  async refreshStructure() {
    if (!this.novel) return;
    try {
      const res = await fetch('/api/novel/structure?t=' + Date.now(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      const data = await res.json();
      if (data.volumes) {
        this.novel = data;
        this.renderSidebar();
        this._updateEditorTitle();
      }
    } catch (e) {
      console.warn('refreshStructure failed', e);
    }
  },

  _updateEditorTitle() {
    const el = document.querySelector('.editor-title');
    if (!el || !this.activeItem || !this.novel) return;
    const item = this.activeItem;
    let title = '';
    if (item.type === 'premise') title = '核心构思';
    else if (item.type === 'outline') title = '全局大纲';
    else if (item.type === 'characters') title = '人物设定';
    else if (item.type === 'vol_outline') title = this.novel.volumes[item.volIdx].name + ' · 卷大纲';
    else if (item.type === 'chapter') {
      const ch = this.novel.volumes[item.volIdx].chapters[item.chIdx];
      title = ch.title || ch.id;
    }
    if (title) el.textContent = title;
  },

  async publish() {
    if (!confirm('将重新构建网站数据，发布/更新到书架。确定？')) return;

    const statusEl = document.getElementById('editor-status');
    if (statusEl) statusEl.textContent = '正在发布…';

    try {
      // Ensure published flag is set
      await fetch('/api/novel/update-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id, updates: { published: true } }),
      });
      const res = await fetch('/api/rebuild', { method: 'POST' });
      const result = await res.json();
      if (result.ok) {
        alert('发布成功！书架已更新。\n' + result.output);
        if (typeof loadCatalog !== 'undefined') loadCatalog();
      } else {
        alert('发布失败：\n' + (result.error || result.output));
      }
    } catch (err) {
      alert('发布失败: ' + err.message);
    }
    if (statusEl) statusEl.textContent = '';
  },

  async unpublish() {
    if (!this.novel) return;
    const title = this.novel.meta?.title || this.novel.id;
    if (!confirm(`确定要将《${title}》从书架下架？\n\n注意：这只会从网站上移除展示，不会删除创作数据。`)) return;

    const statusEl = document.getElementById('editor-status');
    if (statusEl) statusEl.textContent = '正在下架…';

    try {
      const res = await fetch('/api/novel/unpublish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novel_id: this.novel.id }),
      });
      const result = await res.json();
      if (result.ok) {
        alert(`《${title}》已从书架下架。`);
        if (typeof loadCatalog !== 'undefined') loadCatalog();
      } else {
        alert('下架失败：' + (result.error || ''));
      }
    } catch (err) {
      alert('下架失败: ' + err.message);
    }
    if (statusEl) statusEl.textContent = '';
  },

  toggleExportMenu() {
    var menu = document.getElementById('export-menu');
    if (!menu) return;
    var open = menu.classList.toggle('hidden');
    if (!open) {
      var self = this;
      setTimeout(function () {
        document.addEventListener('click', function closeExport(e) {
          if (!menu.contains(e.target) && !e.target.closest('.export-wrap')) {
            self.closeExportMenu();
            document.removeEventListener('click', closeExport);
          }
        });
      }, 0);
    }
  },

  closeExportMenu() {
    var menu = document.getElementById('export-menu');
    if (menu) menu.classList.add('hidden');
  },

  exportNovel(format) {
    if (!this.novel) return;
    const statusEl = document.getElementById('editor-status');
    const url = `/api/novel/export?novel_id=${encodeURIComponent(this.novel.id)}&format=${format}`;
    if (statusEl) statusEl.textContent = '正在生成…';
    fetch(url)
      .then(function (res) {
        if (!res.ok) return res.json().then(function (d) { return Promise.reject(new Error(d.error || res.statusText)); });
        return res.blob();
      })
      .then(function (blob) {
        var ext = format === 'docx' ? 'docx' : 'txt';
        var name = (creator.novel.meta && creator.novel.meta.title ? creator.novel.meta.title : creator.novel.id).replace(/[/\\?*:|"]/g, '_').slice(0, 80) + '_全文.' + ext;
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        if (statusEl) statusEl.textContent = '已导出';
        setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 2000);
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = '导出失败';
        alert('导出失败：' + (err.message || err));
        setTimeout(function () { if (statusEl) statusEl.textContent = ''; }, 2000);
      });
  },
};
