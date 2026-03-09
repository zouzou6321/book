/* =================== State =================== */
const state = {
  catalog: [],
  catalogChannel: 'all',  // 'all' | 'male' | 'female'
  currentBook: null,
  currentChapterList: [],
  currentChapterIdx: 0,
  fontSize: 1.05,
  previousView: 'catalog',
  currentPage: 0,
  totalPages: 1,
};

/* =================== Router =================== */
const router = {
  go(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    if (view !== 'reader') window.scrollTo(0, 0);
    if (view === 'catalog') state.previousView = 'catalog';
    if (view === 'create' && typeof creator !== 'undefined') creator.init();
    if (view === 'feedback') feedback.load();
  },
  goBack() {
    if (state.previousView === 'detail' && state.currentBook) {
      router.go('detail');
      renderBookDetail(state.currentBook);
    } else {
      router.go('catalog');
    }
  },
};

/* =================== Data Loading =================== */
async function loadCatalog() {
  const res = await fetch('data/catalog.json?t=' + Date.now());
  state.catalog = await res.json();

  const ratingPromises = state.catalog.map(async (book) => {
    try {
      const r = await fetch(`/api/comments/book/${book.id}?t=${Date.now()}`);
      const reviews = await r.json();
      if (reviews.length) {
        const sum = reviews.reduce((a, rv) => a + (rv.rating || 10), 0);
        book._avgRating = parseFloat((sum / reviews.length).toFixed(1));
        book._reviewCount = reviews.length;
      } else {
        book._avgRating = 10;
        book._reviewCount = 0;
      }
    } catch {
      book._avgRating = 10;
      book._reviewCount = 0;
    }
  });
  await Promise.all(ratingPromises);

  const filtered = filterCatalogByChannel(state.catalog, state.catalogChannel);
  renderCatalog(filtered);
  setCatalogChannel(state.catalogChannel);
  document.getElementById('loading-indicator').style.display = 'none';
}

async function loadBookDetail(bookId) {
  const res = await fetch(`data/${bookId}/index.json?t=${Date.now()}`);
  const book = await res.json();
  state.currentBook = book;
  buildChapterList(book);
  renderBookDetail(book);
  state.previousView = 'catalog';
  router.go('detail');
}

async function loadChapter(bookId, chapterId) {
  const res = await fetch(`data/${bookId}/${chapterId}.json?t=${Date.now()}`);
  return res.json();
}

function buildChapterList(book) {
  state.currentChapterList = [];
  for (const vol of book.volumes) {
    for (const ch of vol.chapters) {
      state.currentChapterList.push({ ...ch, volumeName: vol.name });
    }
  }
}

function setCatalogChannel(channel) {
  state.catalogChannel = channel;
  document.querySelectorAll('.catalog-filters .filter-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.channel === channel);
  });
  const filtered = filterCatalogByChannel(state.catalog, state.catalogChannel);
  const query = (document.getElementById('search-input') || {}).value || '';
  const forRender = query ? filtered.filter(b =>
    (b.title && b.title.includes(query)) ||
    (b.author && b.author.includes(query)) ||
    ((b.tags || []).some(t => t && t.includes(query)))
  ) : filtered;
  renderCatalog(forRender);
}

function filterCatalogByChannel(books, channel) {
  if (!channel || channel === 'all') return books;
  return books.filter(b => (b.channel || '') === channel);
}

/* =================== Rendering: Catalog =================== */
function renderCatalog(books) {
  const grid = document.getElementById('book-grid');
  grid.innerHTML = '';
  if (books.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#999;padding:40px;">没有找到匹配的书籍</p>';
    return;
  }
  books.forEach(book => {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.onclick = () => loadBookDetail(book.id);

    const hue = book.cover_hue || 220;
    const wordCount = book.total_chars > 10000
      ? (book.total_chars / 10000).toFixed(1) + '万字'
      : book.total_chars + '字';
    const channelTag = book.channel === 'male' ? '<span class="card-channel male">男频</span>' : book.channel === 'female' ? '<span class="card-channel female">女频</span>' : '';

    const coverStyle = book.cover_image
      ? `background-image: url('data/${book.id}/cover.jpg?t=${Date.now()}'); background-size: cover; background-position: center;`
      : `background: linear-gradient(135deg, hsl(${hue},65%,45%), hsl(${(hue + 40) % 360},55%,35%));`;

    card.innerHTML = `
      <div class="book-cover" style="${coverStyle}">
        ${book.cover_image ? '' : `<div class="cover-decoration"></div>
        <div class="cover-title">${book.title}</div>
        <div class="cover-subtitle">${book.subtitle || ''}</div>
        <div class="cover-author">${book.author}</div>`}
      </div>
      <div class="book-card-meta">
        <div class="card-title">${book.title} <span class="card-rating">${book._avgRating || 10}</span> ${channelTag}</div>
        <div class="card-info">${book.author} · ${book.total_chapters}章 · ${wordCount}</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

/* =================== Rendering: Detail =================== */
function renderBookDetail(book) {
  const container = document.getElementById('book-detail');
  const hue = book.cover_hue || 220;
  const wordCount = book.total_chars > 10000
    ? (book.total_chars / 10000).toFixed(1) + '万字'
    : book.total_chars + '字';

  const detailCoverStyle = book.cover_image
    ? `background-image: url('data/${book.id}/cover.jpg?t=${Date.now()}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(135deg, hsl(${hue},65%,45%), hsl(${(hue + 40) % 360},55%,35%));`;

  let tocHTML = '';
  book.volumes.forEach(vol => {
    let chHTML = '';
    vol.chapters.forEach(ch => {
      chHTML += `<li onclick="openChapter('${book.id}','${ch.id}')">
        <span>${ch.title || ch.id}</span>
        <span class="ch-meta">${ch.time || ''}</span>
      </li>`;
    });
    tocHTML += `
      <div class="toc-volume">
        <div class="toc-volume-title">${vol.name}（${vol.chapters.length}章）</div>
        <ul class="toc-chapters">${chHTML}</ul>
      </div>`;
  });

  const tagsHTML = (book.tags || []).map(t => `<span class="tag">${t}</span>`).join('');

  container.innerHTML = `
    <div class="detail-hero">
      <div class="detail-cover" style="${detailCoverStyle}">
        ${book.cover_image ? '' : `<div class="cover-title">${book.title}</div>
        <div class="cover-author">${book.author}</div>`}
      </div>
      <div class="detail-info">
        <h2>${book.title}</h2>
        <div class="detail-subtitle">${book.subtitle || ''}</div>
        <div class="detail-author">作者：${book.author}</div>
        <div class="detail-stats">
          <span>${book.total_chapters} 章</span>
          <span>${wordCount}</span>
          <span>${book.volumes.length} 卷</span>
          <span class="detail-rating-badge" id="detail-rating">评分 ${book._avgRating || 10}</span>
        </div>
        <div class="detail-tags">${tagsHTML}</div>
        <p class="detail-desc">${book.description}</p>
        <button class="btn-start-read" onclick="openChapter('${book.id}','${book.volumes[0]?.chapters[0]?.id}')">开始阅读</button>
      </div>
    </div>
    <div class="book-reviews-section">
      <h3>读者点评 <span id="review-avg" class="review-avg"></span></h3>
      <div class="review-form">
        <div class="review-form-top">
          <input type="text" id="review-author" placeholder="你的名字（选填）" maxlength="20">
          <div class="review-score-picker">
            <label>评分</label>
            <select id="review-score" class="review-score-select">
              ${Array.from({length:10},(_,i)=>`<option value="${10-i}"${i===0?' selected':''}>${10-i} 分</option>`).join('')}
            </select>
          </div>
        </div>
        <textarea id="review-text" placeholder="说说你对这部小说的看法…" rows="3"></textarea>
        <button class="btn-primary btn-sm" onclick="bookReviews.submit()">发布点评</button>
      </div>
      <div id="review-list" class="review-list"></div>
    </div>
    <div class="toc">
      <h3>目录</h3>
      ${tocHTML}
    </div>
  `;
  bookReviews.init(book.id);
}

/* =================== Book Reviews =================== */
const bookReviews = {
  _bookId: '',
  _reviews: [],

  init(bookId) {
    this._bookId = bookId;
    this._load();
  },

  async _load() {
    try {
      const res = await fetch(`/api/comments/book/${this._bookId}?t=${Date.now()}`);
      this._reviews = await res.json();
    } catch { this._reviews = []; }
    this._render();
  },

  _render() {
    const list = document.getElementById('review-list');
    const avg = document.getElementById('review-avg');
    if (!list) return;

    const detailBadge = document.getElementById('detail-rating');
    if (this._reviews.length) {
      const sum = this._reviews.reduce((a, r) => a + (r.rating || 10), 0);
      const mean = (sum / this._reviews.length).toFixed(1);
      if (avg) avg.textContent = `${mean} 分 · ${this._reviews.length} 条`;
      if (detailBadge) detailBadge.textContent = `评分 ${mean}`;
    } else {
      if (avg) avg.textContent = '';
      if (detailBadge) detailBadge.textContent = '评分 10';
    }

    if (!this._reviews.length) {
      list.innerHTML = '<div class="comments-empty">暂无点评，来留下第一条吧</div>';
      return;
    }
    list.innerHTML = this._reviews.slice().reverse().map(r => `
      <div class="review-item">
        <div class="review-item-header">
          <span class="review-item-author">${this._esc(r.author)}</span>
          <span class="review-item-score">${r.rating || 10}<small>/10</small></span>
          <span class="review-item-time">${this._fmtTime(r.created_at)}</span>
          <button class="comment-delete" onclick="bookReviews.remove('${r.id}')" title="删除">✕</button>
        </div>
        <div class="review-item-body">${this._esc(r.text)}</div>
      </div>
    `).join('');
  },

  async submit() {
    const text = document.getElementById('review-text').value.trim();
    if (!text) return;
    const author = document.getElementById('review-author').value.trim();
    try {
      const rating = parseInt(document.getElementById('review-score').value) || 10;
      await fetch('/api/comments/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: this._bookId, author, text, rating }),
      });
      document.getElementById('review-text').value = '';
      await this._load();
    } catch (err) { alert('提交失败: ' + err.message); }
  },

  async remove(reviewId) {
    try {
      await fetch(`/api/comments/book/${this._bookId}/${reviewId}`, { method: 'DELETE' });
      await this._load();
    } catch {}
  },

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; },
  _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  },
};

/* =================== Rendering: Reader =================== */
async function openChapter(bookId, chapterId) {
  if (!state.currentBook || state.currentBook.id !== bookId) {
    await loadBookDetail(bookId);
  }

  const idx = state.currentChapterList.findIndex(c => c.id === chapterId);
  if (idx === -1) return;
  state.currentChapterIdx = idx;
  state.previousView = 'detail';

  const ch = await loadChapter(bookId, chapterId);
  renderReader(ch);
  await comments.highlightInContent();
  router.go('reader');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => reader.paginate());
  });
}

function renderReader(chapter) {
  const content = markdownToHTML(chapter.content);
  const container = document.getElementById('reader-content');

  const chIdx = state.currentChapterIdx;
  const total = state.currentChapterList.length;
  const isLast = chIdx >= total - 1;
  const nextHint = isLast
    ? '<div class="chapter-end">— 全书完 —</div>'
    : `<div class="chapter-end">— 本章完 · 点击右侧翻至下一章 —</div>`;

  const commentBar = `<div class="chapter-comment-bar" onclick="comments.openChapter()">
    <span class="chapter-comment-icon">💬</span>
    <span id="chapter-comment-count">加载评论中…</span>
  </div>`;

  container.innerHTML = content + commentBar + nextHint;
  state._baseReaderHTML = container.innerHTML;
  comments.close();
  container.style.fontSize = state.fontSize + 'rem';

  const titleEl = document.getElementById('reader-title');
  const chInfo = state.currentChapterList[chIdx];
  titleEl.textContent = chInfo ? chInfo.volumeName + ' · ' + (chInfo.title || chInfo.id) : '';

  document.getElementById('chapter-progress').textContent =
    `第 ${chIdx + 1} / ${total} 章`;

  state.currentPage = 0;
}

/* =================== Pagination Engine =================== */
const reader = {
  paginate() {
    const content = document.getElementById('reader-content');
    const viewport = document.getElementById('reader-viewport');
    const pageWidth = viewport.clientWidth;

    content.style.columnWidth = pageWidth + 'px';
    content.style.width = pageWidth + 'px';
    content.style.transform = 'translateX(0)';

    requestAnimationFrame(() => {
      const scrollW = content.scrollWidth;
      state.totalPages = Math.max(1, Math.round(scrollW / pageWidth));
      state.currentPage = 0;
      this.updatePageUI();
    });
  },

  goToPage(page) {
    if (page < 0 || page >= state.totalPages) return;
    state.currentPage = page;

    const viewport = document.getElementById('reader-viewport');
    const content = document.getElementById('reader-content');
    const pageWidth = viewport.clientWidth;
    const offset = -page * pageWidth;
    content.style.transform = `translateX(${offset}px)`;

    this.updatePageUI();
  },

  prevPage() {
    if (state.currentPage > 0) {
      this.goToPage(state.currentPage - 1);
      this.enterImmersive();
    } else {
      this.switchChapter(-1);
    }
  },

  nextPage() {
    if (state.currentPage < state.totalPages - 1) {
      this.goToPage(state.currentPage + 1);
      this.enterImmersive();
    } else {
      this.switchChapter(1);
    }
  },

  updatePageUI() {
    document.getElementById('page-indicator').textContent =
      `${state.currentPage + 1} / ${state.totalPages}`;
  },

  async switchChapter(direction) {
    const newIdx = state.currentChapterIdx + direction;
    if (newIdx < 0 || newIdx >= state.currentChapterList.length) return;

    state.currentChapterIdx = newIdx;
    const ch = state.currentChapterList[newIdx];
    const data = await loadChapter(state.currentBook.id, ch.id);

    const content = document.getElementById('reader-content');
    const viewport = document.getElementById('reader-viewport');
    const pageWidth = viewport.clientWidth;
    const wasImmersive = state.immersive;

    content.style.transition = 'none';
    renderReader(data);
    await comments.highlightInContent();

    content.style.columnWidth = pageWidth + 'px';
    content.style.width = pageWidth + 'px';
    content.style.transform = `translateX(${direction * pageWidth}px)`;
    content.offsetHeight;

    const scrollW = content.scrollWidth;
    state.totalPages = Math.max(1, Math.round(scrollW / pageWidth));

    const targetPage = direction === -1 ? state.totalPages - 1 : 0;
    state.currentPage = targetPage;
    this.updatePageUI();

    if (wasImmersive) this.enterImmersive();

    requestAnimationFrame(() => {
      content.style.transition = '';
      const offset = -targetPage * pageWidth;
      content.style.transform = `translateX(${offset}px)`;
    });
  },

  async prevChapter() {
    this.switchChapter(-1);
  },

  async nextChapter() {
    this.switchChapter(1);
  },

  async copyChapter() {
    const el = document.getElementById('reader-content');
    const statusEl = document.getElementById('reader-copy-status');
    const btn = document.getElementById('btn-copy-chapter');
    function showStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.classList.toggle('error', !!isError);
      statusEl.classList.remove('hidden');
      clearTimeout(statusEl._hideTimer);
      statusEl._hideTimer = setTimeout(() => {
        statusEl.textContent = '';
        statusEl.classList.add('hidden');
        statusEl.classList.remove('error');
      }, 2200);
    }
    if (!el) return;
    const text = el.innerText || el.textContent || '';
    if (!text.trim()) {
      showStatus('暂无内容', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text.trim());
      if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1500); }
      showStatus('已复制到剪贴板', false);
    } catch (e) {
      if (btn) { const o = btn.textContent; btn.textContent = '📋 复制'; }
      showStatus('复制失败，请检查浏览器权限或使用 HTTPS', true);
    }
  },

  changeFontSize(delta) {
    state.fontSize = Math.max(0.8, Math.min(1.6, state.fontSize + delta * 0.1));
    const content = document.getElementById('reader-content');
    content.style.fontSize = state.fontSize + 'rem';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const savedRatio = state.currentPage / Math.max(1, state.totalPages - 1);
        this.paginate();
        const newPage = Math.round(savedRatio * (state.totalPages - 1));
        this.goToPage(Math.max(0, newPage));
      });
    });
  },

  toggleDark() {
    const view = document.getElementById('view-reader');
    const isDark = view.classList.toggle('dark');
    state.darkMode = isDark;
    document.getElementById('btn-dark').textContent = isDark ? '日间' : '夜间';
    localStorage.setItem('reader-dark', isDark ? '1' : '0');
  },

  initDark() {
    const saved = localStorage.getItem('reader-dark');
    const view = document.getElementById('view-reader');
    if (saved === '1') {
      view.classList.add('dark');
      state.darkMode = true;
      document.getElementById('btn-dark').textContent = '日间';
    }
  },

  enterImmersive() {
    document.getElementById('view-reader').classList.add('immersive');
    state.immersive = true;
  },

  exitImmersive() {
    document.getElementById('view-reader').classList.remove('immersive');
    state.immersive = false;
  },

  toggleImmersive() {
    if (state.immersive) this.exitImmersive();
    else this.enterImmersive();
  },
};

/* =================== Simple Markdown -> HTML =================== */
function markdownToHTML(md) {
  if (!md) return '';
  let html = md
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^---$/gm, '<hr>')
    .replace(/^[-*] (.+)$/gm, '<p style="text-indent:0">• $1</p>');

  const lines = html.split('\n');
  let result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('<h') || trimmed.startsWith('<hr') || trimmed.startsWith('<p style')) {
      result.push(trimmed);
    } else {
      result.push(`<p>${trimmed}</p>`);
    }
  }

  const chapterMeta = [];
  const finalResult = [];
  let pastTitle = false;
  for (const line of result) {
    if (!pastTitle && line.startsWith('<h1>')) { finalResult.push(line); pastTitle = true; continue; }
    if (pastTitle && !chapterMeta.length && line.includes('<strong>时间</strong>')) {
      chapterMeta.push(line.replace(/<\/?p>/g, ''));
      continue;
    }
    if (pastTitle && chapterMeta.length === 1 && line.includes('<strong>地点</strong>')) {
      chapterMeta.push(line.replace(/<\/?p>/g, ''));
      finalResult.push(`<div class="chapter-meta">${chapterMeta.join('<br>')}</div>`);
      continue;
    }
    finalResult.push(line);
  }

  return finalResult.join('\n');
}

/* =================== Search =================== */
document.getElementById('search-input').addEventListener('input', (e) => {
  const query = e.target.value.trim().toLowerCase();
  const byChannel = filterCatalogByChannel(state.catalog, state.catalogChannel);
  if (!query) { renderCatalog(byChannel); return; }
  const filtered = byChannel.filter(b =>
    (b.title || '').toLowerCase().includes(query) ||
    (b.author || '').toLowerCase().includes(query) ||
    (b.subtitle || '').toLowerCase().includes(query) ||
    (b.tags || []).some(t => t && t.toLowerCase().includes(query))
  );
  renderCatalog(filtered);
});

/* =================== Keyboard & Touch =================== */
document.addEventListener('keydown', (e) => {
  const readerView = document.getElementById('view-reader');
  if (!readerView.classList.contains('active')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); reader.prevPage(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); reader.nextPage(); }
  if (e.key === 'Escape') {
    reader.exitImmersive();
    comments.close();
    document.getElementById('comment-tooltip').classList.add('hidden');
  }
});

let touchStartX = 0;
let touchStartY = 0;
let touchMoved = false;
document.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchMoved = false;
}, { passive: true });

document.addEventListener('touchmove', () => { touchMoved = true; }, { passive: true });

document.addEventListener('touchend', (e) => {
  const readerView = document.getElementById('view-reader');
  if (!readerView.classList.contains('active')) return;

  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) reader.nextPage();
    else reader.prevPage();
  }
}, { passive: true });

/* ---- Click-based page turning (replaces page-tap overlays) ---- */
let mouseDownX = 0, mouseDownY = 0, mouseDownTime = 0;

const readerStage = document.getElementById('reader-stage');

readerStage.addEventListener('mousedown', (e) => {
  mouseDownX = e.clientX;
  mouseDownY = e.clientY;
  mouseDownTime = Date.now();
});

readerStage.addEventListener('click', (e) => {
  if (e.target.closest('.comment-tooltip') || e.target.closest('.comments-panel')) return;

  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return;

  const elapsed = Date.now() - mouseDownTime;
  const dx = Math.abs(e.clientX - mouseDownX);
  const dy = Math.abs(e.clientY - mouseDownY);
  if (elapsed > 400 || dx > 10 || dy > 10) return;

  const rect = readerStage.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / rect.width;
  if (xRatio < 0.3) { reader.prevPage(); reader.enterImmersive(); }
  else if (xRatio > 0.7) { reader.nextPage(); reader.enterImmersive(); }
});

/* ---- Double-click / double-tap to toggle immersive ---- */
readerStage.addEventListener('dblclick', (e) => {
  e.preventDefault();
  reader.toggleImmersive();
});

let lastTapTime = 0;
readerStage.addEventListener('touchend', (e) => {
  if (touchMoved) return;
  const now = Date.now();
  if (now - lastTapTime < 350) {
    e.preventDefault();
    reader.toggleImmersive();
    lastTapTime = 0;
  } else {
    lastTapTime = now;
  }
}, { passive: false });

/* =================== Resize =================== */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const readerView = document.getElementById('view-reader');
    if (readerView.classList.contains('active')) {
      const savedRatio = state.currentPage / Math.max(1, state.totalPages - 1);
      reader.paginate();
      const newPage = Math.round(savedRatio * (state.totalPages - 1));
      reader.goToPage(Math.max(0, newPage));
    }
  }, 200);
});

/* =================== Chapter Comments =================== */
const comments = {
  _open: false,
  _quote: '',       // current context: '' = chapter comments, 'some text' = that quote's comments
  _all: [],

  _contextItems() {
    return this._quote
      ? this._all.filter(c => c.quote === this._quote)
      : this._all.filter(c => !c.quote);
  },

  openChapter() {
    this._quote = '';
    this._show();
  },

  showForQuote(quote) {
    this._quote = quote;
    this._show();
  },

  openWithQuote() {
    const sel = window.getSelection();
    this._quote = sel ? sel.toString().trim() : '';
    document.getElementById('comment-tooltip').classList.add('hidden');
    this._show();
    document.getElementById('comment-text').focus();
  },

  toggle() {
    if (this._open) { this.close(); return; }
    this._quote = '';
    this._show();
  },

  _show() {
    this._open = true;
    document.getElementById('comments-panel').classList.remove('hidden');
    this._updateHeader();
    if (this._all.length) { this._updateHeader(); this.render(); }
    else { this.load(); }
  },

  close() {
    this._open = false;
    document.getElementById('comments-panel').classList.add('hidden');
  },

  _updateHeader() {
    const ctx = document.getElementById('comments-context');
    const banner = document.getElementById('comments-quote-banner');
    const textarea = document.getElementById('comment-text');

    if (this._quote) {
      ctx.textContent = '划词评论';
      banner.textContent = `"${this._quote}"`;
      banner.classList.remove('hidden');
      textarea.placeholder = '写下你对这段文字的想法…';
    } else {
      ctx.textContent = '章节评论';
      banner.classList.add('hidden');
      textarea.placeholder = '写下你对本章的想法…';
    }
  },

  async load() {
    if (!state.currentBook) return;
    const ch = state.currentChapterList[state.currentChapterIdx];
    if (!ch) return;
    try {
      const res = await fetch(`/api/comments/chapter/${state.currentBook.id}/${ch.id}?t=${Date.now()}`);
      this._all = await res.json();
    } catch { this._all = []; }
    this._updateCounts();
    this.render();
  },

  _updateCounts() {
    const nCh = this._all.filter(c => !c.quote).length;

    const btn = document.getElementById('btn-comments');
    if (btn) btn.textContent = nCh > 0 ? `💬${nCh}` : '💬';

    const chBar = document.getElementById('chapter-comment-count');
    if (chBar) {
      chBar.textContent = nCh > 0 ? `本章共 ${nCh} 条评论，点击查看` : '暂无评论，点击留下你的想法';
    }
  },

  render() {
    const list = document.getElementById('comments-list');
    const items = this._contextItems();

    if (!items.length) {
      list.innerHTML = this._quote
        ? '<div class="comments-empty">暂无评论，来留下第一条吧</div>'
        : '<div class="comments-empty">暂无章节评论，来留下第一条吧</div>';
      return;
    }
    list.innerHTML = items.map(c => `
      <div class="comment-item" data-id="${c.id}">
        <div class="comment-body">${this._esc(c.text)}</div>
        <div class="comment-footer">
          <span class="comment-author">${this._esc(c.author)}</span>
          <span class="comment-time">${this._fmtTime(c.created_at)}</span>
          <button class="comment-delete" onclick="comments.remove('${c.id}')" title="删除">✕</button>
        </div>
      </div>
    `).join('');
  },

  async submit() {
    const text = document.getElementById('comment-text').value.trim();
    if (!text) return;
    const author = document.getElementById('comment-author').value.trim();
    const ch = state.currentChapterList[state.currentChapterIdx];
    if (!ch || !state.currentBook) return;

    try {
      await fetch('/api/comments/chapter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: state.currentBook.id,
          chapter_id: ch.id,
          author,
          text,
          quote: this._quote,
        }),
      });
      document.getElementById('comment-text').value = '';
      await this.load();
      await this._refreshHighlights();
    } catch (err) { alert('评论失败: ' + err.message); }
  },

  async remove(commentId) {
    if (!state.currentBook) return;
    const ch = state.currentChapterList[state.currentChapterIdx];
    if (!ch) return;
    try {
      await fetch(`/api/comments/chapter/${state.currentBook.id}/${ch.id}/${commentId}`, { method: 'DELETE' });
      await this.load();
      await this._refreshHighlights();
    } catch {}
  },

  /* ---- Inline highlighting ---- */

  async highlightInContent() {
    if (!state.currentBook) return;
    const ch = state.currentChapterList[state.currentChapterIdx];
    if (!ch) return;

    try {
      const res = await fetch(`/api/comments/chapter/${state.currentBook.id}/${ch.id}?t=${Date.now()}`);
      this._all = await res.json();
    } catch { this._all = []; }
    this._updateCounts();

    const quoteMap = {};
    for (const c of this._all) {
      if (!c.quote) continue;
      if (!quoteMap[c.quote]) quoteMap[c.quote] = 0;
      quoteMap[c.quote]++;
    }

    const content = document.getElementById('reader-content');
    for (const [quote, count] of Object.entries(quoteMap)) {
      this._markQuote(content, quote, count);
    }
  },

  _markQuote(root, text, count) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement && node.parentElement.classList.contains('comment-highlight')) continue;
      const idx = node.textContent.indexOf(text);
      if (idx === -1) continue;

      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);

      const mark = document.createElement('mark');
      mark.className = 'comment-highlight';
      mark.dataset.quote = text;
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        comments.showForQuote(text);
      });

      try { range.surroundContents(mark); } catch { continue; }

      const badge = document.createElement('sup');
      badge.className = 'comment-badge';
      badge.textContent = count;
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        comments.showForQuote(text);
      });
      mark.after(badge);
      return;
    }
  },

  async _refreshHighlights() {
    const container = document.getElementById('reader-content');
    if (!container || !state._baseReaderHTML) return;

    const savedPage = state.currentPage;
    const pageRatio = state.totalPages > 1 ? savedPage / (state.totalPages - 1) : 0;

    container.innerHTML = state._baseReaderHTML;
    await this.highlightInContent();

    requestAnimationFrame(() => {
      reader.paginate();
      requestAnimationFrame(() => {
        const newPage = Math.round(pageRatio * (state.totalPages - 1));
        reader.goToPage(Math.max(0, newPage));
      });
    });
  },

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; },

  _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  },
};

/* ---- Text-selection tooltip for chapter comments ---- */
let _selChangeTimer = null;

document.addEventListener('selectionchange', () => {
  clearTimeout(_selChangeTimer);
  _selChangeTimer = setTimeout(_checkSelectionTooltip, 300);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#comment-tooltip')) {
    document.getElementById('comment-tooltip').classList.add('hidden');
  }
});

/* Suppress browser native context menu on reader content so our tooltip stays visible */
document.addEventListener('contextmenu', (e) => {
  const readerContent = document.getElementById('reader-content');
  if (readerContent && readerContent.contains(e.target)) {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      e.preventDefault();
    }
  }
});

function _checkSelectionTooltip() {
  const readerView = document.getElementById('view-reader');
  if (!readerView || !readerView.classList.contains('active')) return;

  const tooltip = document.getElementById('comment-tooltip');
  if (!tooltip) return;

  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    tooltip.classList.add('hidden');
    return;
  }

  const text = sel.toString().trim();
  if (text.length < 3) {
    tooltip.classList.add('hidden');
    return;
  }

  const range = sel.getRangeAt(0);
  const readerContent = document.getElementById('reader-content');
  if (!readerContent || !readerContent.contains(range.commonAncestorContainer)) {
    tooltip.classList.add('hidden');
    return;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    tooltip.classList.add('hidden');
    return;
  }

  const top = Math.max(8, rect.top - 48);
  const left = Math.max(60, Math.min(window.innerWidth - 60, rect.left + rect.width / 2));
  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.classList.remove('hidden');
}

/* =================== Product Feedback =================== */
const feedback = {
  _rating: 5,
  _comments: [],

  load() {
    this._initRating();
    this._fetch();
  },

  _initRating() {
    const container = document.getElementById('fb-rating');
    if (!container) return;
    this._rating = 5;
    container.querySelectorAll('.star').forEach(s => {
      s.onclick = () => {
        this._rating = parseInt(s.dataset.val);
        this._highlightStars();
      };
    });
    this._highlightStars();
  },

  _highlightStars() {
    const container = document.getElementById('fb-rating');
    if (!container) return;
    container.querySelectorAll('.star').forEach(s => {
      s.classList.toggle('active', parseInt(s.dataset.val) <= this._rating);
    });
  },

  async _fetch() {
    try {
      const res = await fetch('/api/comments/product?t=' + Date.now());
      this._comments = await res.json();
    } catch { this._comments = []; }
    this.render();
  },

  render() {
    const list = document.getElementById('feedback-list');
    if (!list) return;
    if (!this._comments.length) {
      list.innerHTML = '<div class="comments-empty">还没有留言，来说点什么吧</div>';
      return;
    }
    list.innerHTML = this._comments.slice().reverse().map(c => `
      <div class="feedback-item">
        <div class="feedback-item-header">
          <span class="feedback-author">${this._esc(c.author)}</span>
          <span class="feedback-stars">${'★'.repeat(c.rating || 5)}${'☆'.repeat(5 - (c.rating || 5))}</span>
          <span class="feedback-time">${this._fmtTime(c.created_at)}</span>
          <button class="comment-delete" onclick="feedback.remove('${c.id}')" title="删除">✕</button>
        </div>
        <div class="feedback-body">${this._esc(c.text)}</div>
      </div>
    `).join('');
  },

  async submit() {
    const text = document.getElementById('fb-text').value.trim();
    if (!text) return;
    const author = document.getElementById('fb-author').value.trim();
    try {
      await fetch('/api/comments/product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, text, rating: this._rating }),
      });
      document.getElementById('fb-text').value = '';
      await this._fetch();
    } catch (err) { alert('提交失败: ' + err.message); }
  },

  async remove(commentId) {
    try {
      await fetch(`/api/comments/product/${commentId}`, { method: 'DELETE' });
      await this._fetch();
    } catch {}
  },

  _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; },

  _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  },
};

/* =================== Init =================== */
document.getElementById('loading-indicator').style.display = 'block';
loadCatalog();
reader.initDark();
