/**
 * 小红书批量下载助手 - Content Script
 * 核心功能：
 * 1. 注入 inject.js 拦截器
 * 2. 构建悬浮控制台 UI
 * 3. 收集并解析博主笔记（100%无水印原图与视频）
 * 4. 转码为真实 JPG 并按博主归档下载
 */

(function () {
  console.log('[XHS_DOWNLOAD] 插件 Content Script 初始化');

  // 全局状态
  const state = {
    user: {
      userId: '',
      nickname: '小红书博主',
      avatar: ''
    },
    notes: new Map(), // key: noteId, value: parsedNote
    selectedIds: new Set(),
    isScanning: false,
    isDownloading: false,
    scanTimer: null,
    settings: {
      convertToJpg: true,
      groupByUser: true,
      downloadLiveVideo: true
    }
  };

  // 1. 注入 Main World 拦截脚本
  function injectMainWorldScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/inject.js');
      script.onload = function () {
        this.remove();
        window.postMessage({ source: 'XHS_CONTENT_SCRIPT', action: 'GET_INITIAL_DATA' }, '*');
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error('[XHS_DOWNLOAD] 注入脚本失败:', e);
    }
  }

  // 2. 接收来自 inject.js 的消息
  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.source !== 'XHS_INJECT_SCRIPT') {
      return;
    }

    const { action, payload } = event.data;

    if (action === 'INITIAL_DATA_READY' || action === 'INITIAL_DATA_RESPONSE') {
      handleInitialState(payload);
    } else if (action === 'API_INTERCEPTED') {
      handleInterceptedApi(payload);
    } else if (action === 'CURRENT_ACTIVE_NOTE_RESPONSE') {
      if (payload) {
        addRawNote(payload);
        renderList();
      }
    }
  });

  // 处理初始 State 数据
  function handleInitialState(data) {
    if (!data) return;

    if (data.user) {
      updateUserInfo(data.user);
    }

    if (Array.isArray(data.notes) && data.notes.length > 0) {
      data.notes.forEach(note => addRawNote(note));
    }

    if (data.noteDetailMap) {
      Object.values(data.noteDetailMap).forEach(detail => {
        if (detail && detail.note) {
          addRawNote(detail.note);
        }
      });
    }

    renderList();
  }

  // 处理拦截到的 API 响应
  function handleInterceptedApi({ url, data }) {
    if (!data) return;

    if (url.includes('/api/sns/web/v1/user_posted')) {
      const notes = data.notes || data.items || [];
      notes.forEach(note => addRawNote(note));
      renderList();
    } else if (url.includes('/api/sns/web/v1/feed') || url.includes('/api/sns/web/v1/homefeed')) {
      const items = data.items || data.notes || [];
      items.forEach(item => {
        if (item.note_card) {
          addRawNote(item.note_card);
        } else if (item.note) {
          addRawNote(item.note);
        } else {
          addRawNote(item);
        }
      });
      renderList();
    }
  }

  // 更新博主信息
  function updateUserInfo(user) {
    if (!user) return;
    if (user.nickname && user.nickname !== '小红书博主') {
      state.user.nickname = user.nickname;
    }
    if (user.userId) state.user.userId = user.userId;
    if (user.avatar) state.user.avatar = user.avatar;

    const avatarEl = document.querySelector('.xhs-dl-author-avatar');
    const nameEl = document.querySelector('.xhs-dl-author-name');
    if (avatarEl && state.user.avatar) avatarEl.src = state.user.avatar;
    if (nameEl) nameEl.textContent = state.user.nickname;
  }

  // 尝试从当前页面 DOM 获取博主信息
  function detectAuthorFromPage() {
    const nameEl = document.querySelector('.user-name, .user-nickname, .info-name, [class*="userName"]');
    if (nameEl && nameEl.textContent.trim()) {
      state.user.nickname = nameEl.textContent.trim();
    }

    const avatarImg = document.querySelector('.user-image img, .avatar-image, [class*="userAvatar"] img');
    if (avatarImg && avatarImg.src) {
      state.user.avatar = avatarImg.src;
    }

    const match = window.location.pathname.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      state.user.userId = match[1];
    }
  }

  /**
   * 提取图片原始 URL，覆盖所有驼峰和下划线命名
   */
  function extractRawUrl(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (obj.urlDefault) return obj.urlDefault;
    if (obj.url_default) return obj.url_default;
    if (obj.urlPre) return obj.urlPre;
    if (obj.url_pre) return obj.url_pre;
    if (obj.url) return obj.url;
    if (Array.isArray(obj.infoList) && obj.infoList[0] && obj.infoList[0].url) return obj.infoList[0].url;
    if (Array.isArray(obj.info_list) && obj.info_list[0] && (obj.info_list[0].url || obj.info_list[0].url_default)) {
      return obj.info_list[0].url || obj.info_list[0].url_default;
    }
    return '';
  }

  /**
   * 提取图片唯一 ID (fileId / traceId)
   */
  function extractFileId(imgItem) {
    if (!imgItem) return '';
    if (imgItem.fileId) return imgItem.fileId;
    if (imgItem.file_id) return imgItem.file_id;
    if (imgItem.traceId) return imgItem.traceId;
    if (imgItem.trace_id) return imgItem.trace_id;

    const rawUrl = extractRawUrl(imgItem);
    const match = rawUrl.match(/\/([0-9a-zA-Z_]{20,40})(!|\?|$)/);
    if (match && match[1]) {
      return match[1];
    }
    return '';
  }

  /**
   * 为单张图片构建候选 URL 列表（严格剔除平台水印）
   */
  function buildCandidateUrls(imgItem) {
    if (!imgItem) return [];
    const list = [];
    const infoList = Array.isArray(imgItem.infoList)
      ? imgItem.infoList
      : (Array.isArray(imgItem.info_list) ? imgItem.info_list : []);
    const fileId = extractFileId(imgItem);

    const rawCandidates = [
      extractRawUrl(imgItem),
      imgItem.urlDefault,
      imgItem.url_default,
      imgItem.urlPre,
      imgItem.url_pre,
      imgItem.url,
      ...infoList.map(i => i.url || i.url_default)
    ].filter(Boolean);

    // 1. 核心优先级一：直接去除 _wl_ 水印参数（高可靠同源 CDN 直链）
    rawCandidates.forEach(raw => {
      if (typeof raw !== 'string') return;
      if (raw.includes('_wl_')) {
        list.push(raw.replace(/_wl_/g, '_'));
      }
      if (raw.includes('!nd_dft_wl_')) {
        list.push(raw.replace('!nd_dft_wl_', '!nd_dft_'));
      }
      // 去除裁剪参数如 !nd_dft_prv_webp_3，直接获取源站原图
      if (raw.includes('!')) {
        const noParam = raw.split('!')[0];
        if (noParam && noParam.startsWith('http')) {
          list.push(noParam);
        }
      }
    });

    // 2. 核心优先级二：从 infoList 中匹配无水印预览场景
    const cleanScenes = infoList.filter(item => {
      const scene = (item.imageScene || item.image_scene || '').toUpperCase();
      const url = item.url || item.url_default || '';
      if (!url) return false;
      if (scene.includes('WM') || scene.includes('WB') || scene.includes('WL')) {
        return false;
      }
      if (url.includes('_wl_') || url.includes('_wm_')) {
        return false;
      }
      return true;
    });

    cleanScenes.sort((a, b) => {
      const sa = (a.imageScene || a.image_scene || '').toUpperCase();
      const sb = (b.imageScene || b.image_scene || '').toUpperCase();
      if (sa.includes('PRV') && !sb.includes('PRV')) return -1;
      if (!sa.includes('PRV') && sb.includes('PRV')) return 1;
      return 0;
    });

    cleanScenes.forEach(item => {
      const u = item.url || item.url_default;
      if (u) list.push(u);
    });

    // 3. 核心优先级三：小红书官方原图网关
    if (fileId) {
      list.push(`https://sns-img-bd.xhscdn.com/${fileId}`);
      list.push(`https://ci.xiaohongshu.com/${fileId}`);
    }

    // 4. 原始链接兜底
    rawCandidates.forEach(raw => {
      if (typeof raw === 'string' && !list.includes(raw)) list.push(raw);
    });

    // 规范化 https 并去重
    const result = [];
    list.forEach(u => {
      if (!u || typeof u !== 'string') return;
      let s = u.trim();
      if (s.startsWith('http://')) s = s.replace('http://', 'https://');
      if (!result.includes(s)) result.push(s);
    });

    return result;
  }

  // 添加原始笔记并解析为媒体对象
  function addRawNote(raw) {
    if (!raw) return;
    const noteId = raw.id || raw.note_id || raw.noteId || raw.source_note_id || (raw.target && raw.target.id);
    if (!noteId) return;

    // 解析作者
    const authorObj = raw.user || raw.author;
    let authorName = state.user.nickname;
    if (authorObj && (authorObj.nickname || authorObj.name)) {
      authorName = authorObj.nickname || authorObj.name;
      if (state.user.nickname === '小红书博主' || !state.user.nickname) {
        updateUserInfo(authorObj);
      }
    }

    const title = raw.display_title || raw.displayTitle || raw.title || raw.desc || '无标题笔记';
    const isVideo = raw.type === 'video' || raw.model_type === 'note_video' || !!raw.video;

    // 1. 提取并解析封面
    const coverObj = raw.cover || raw.imageCover || raw.firstImage || raw.image || (raw.images && raw.images[0]);
    let coverCandidates = [];
    let coverUrl = '';
    if (coverObj) {
      coverCandidates = buildCandidateUrls(coverObj);
      coverUrl = coverCandidates[0] || extractRawUrl(coverObj);
    }

    // 2. 解析多图图集
    const images = [];
    const imageList = raw.image_list || raw.imageList || raw.images_list || [];

    imageList.forEach((imgItem, idx) => {
      const candidates = buildCandidateUrls(imgItem);
      if (candidates.length > 0) {
        images.push({
          index: idx + 1,
          candidateUrls: candidates,
          coverUrl: candidates[0] || extractRawUrl(imgItem),
          isLivePhoto: !!imgItem.livePhoto || !!imgItem.live_photo,
          liveVideoUrl: (imgItem.livePhotoVideo || imgItem.live_photo_video)
            ? extractVideoUrl(imgItem.livePhotoVideo || imgItem.live_photo_video)
            : null,
          isCoverPlaceholder: false
        });
      }
    });

    // 针对列表页（imageList 为空）的处理：将封面作为首张图片纳入图集，杜绝 0 张图！
    if (images.length === 0 && coverObj) {
      if (coverCandidates.length > 0) {
        images.push({
          index: 1,
          candidateUrls: coverCandidates,
          coverUrl: coverUrl,
          isLivePhoto: false,
          liveVideoUrl: null,
          isCoverPlaceholder: true
        });
      }
    }

    // 3. 解析无水印视频
    let videoUrl = null;
    if (isVideo && raw.video) {
      videoUrl = extractVideoUrl(raw.video);
    }

    if (images.length > 0 && images[0].coverUrl) {
      coverUrl = images[0].coverUrl;
    }

    // 防逆向降级：如果已有完整详情，不要被列表简易卡片覆盖掉完整的 images
    const existing = state.notes.get(noteId);
    if (existing && !existing.isCoverPlaceholder && images.length === 1 && images[0].isCoverPlaceholder) {
      return;
    }

    const parsed = {
      noteId,
      title: title.slice(0, 50).trim(),
      authorName,
      isVideo,
      images,
      videoUrl,
      coverUrl,
      isCoverPlaceholder: images.length > 0 ? !!images[0].isCoverPlaceholder : true
    };

    state.notes.set(noteId, parsed);
    state.selectedIds.add(noteId); // 默认勾选
  }

  /**
   * 主动获取单篇笔记完整详情（多图和高清视频流）
   */
  async function fetchFullNoteDetail(noteId) {
    if (!noteId) return null;

    // 1. 尝试从 background.js 获取服务端渲染数据
    try {
      const bgNote = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'FETCH_NOTE_DETAIL',
            payload: { noteId }
          },
          (res) => {
            if (chrome.runtime.lastError || !res || !res.success || !res.note) {
              resolve(null);
            } else {
              resolve(res.note);
            }
          }
        );
      });
      if (bgNote) return bgNote;
    } catch (e) {}

    // 2. 尝试从 inject.js 查询内存数据
    try {
      const injectNote = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 500);

        function handler(event) {
          if (event.source !== window || !event.data || event.data.source !== 'XHS_INJECT_SCRIPT') return;
          if (event.data.action === 'NOTE_DETAIL_BY_ID_RESPONSE' && event.data.payload) {
            if (event.data.payload.noteId === noteId) {
              clearTimeout(timer);
              window.removeEventListener('message', handler);
              resolve(event.data.payload.note);
            }
          }
        }

        window.addEventListener('message', handler);
        window.postMessage({ source: 'XHS_CONTENT_SCRIPT', action: 'GET_NOTE_DETAIL_BY_ID', payload: { noteId } }, '*');
      });
      if (injectNote) return injectNote;
    } catch (e) {}

    return null;
  }

  // 提取无水印视频直链
  function extractVideoUrl(videoObj) {
    if (!videoObj) return null;
    const media = videoObj.media || videoObj;
    const stream = media.stream || videoObj.stream;

    if (stream) {
      if (Array.isArray(stream.h264) && stream.h264.length > 0) {
        const sorted = [...stream.h264].sort((a, b) => (b.videoBitrate || 0) - (a.videoBitrate || 0));
        let u = sorted[0].masterUrl || sorted[0].mainUrl;
        if (u && u.startsWith('http://')) u = u.replace('http://', 'https://');
        return u;
      }
      if (Array.isArray(stream.h265) && stream.h265.length > 0) {
        const sorted = [...stream.h265].sort((a, b) => (b.videoBitrate || 0) - (a.videoBitrate || 0));
        let u = sorted[0].masterUrl || sorted[0].mainUrl;
        if (u && u.startsWith('http://')) u = u.replace('http://', 'https://');
        return u;
      }
    }

    if (videoObj.consumer && videoObj.consumer.originVideoKey) {
      return `https://sns-video-qc.xhscdn.com/${videoObj.consumer.originVideoKey}`;
    }

    return null;
  }

  // 3. 构建悬浮控制面板 DOM
  function createUI() {
    if (document.getElementById('xhs-dl-fab')) return;

    // 悬浮按钮
    const fab = document.createElement('div');
    fab.id = 'xhs-dl-fab';
    fab.innerHTML = `
      <img class="xhs-dl-fab-icon" src="${chrome.runtime.getURL('icons/icon48.png')}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;" alt="icon" />
      <span>小鸡发财 v1.0.2</span>
      <span class="xhs-dl-badge">0</span>
    `;

    // 遮罩
    const mask = document.createElement('div');
    mask.id = 'xhs-dl-mask';

    // 抽屉面板
    const panel = document.createElement('div');
    panel.id = 'xhs-dl-panel';
    panel.innerHTML = `
      <!-- Header -->
      <div class="xhs-dl-header">
        <div class="xhs-dl-title-group">
          <div class="xhs-dl-logo"><img src="${chrome.runtime.getURL('icons/icon48.png')}" style="width:28px;height:28px;border-radius:6px;vertical-align:middle;object-fit:cover;" alt="logo" /></div>
          <div class="xhs-dl-title">小鸡发财去水印批量下载助手</div>
          <span style="font-size:10px; background:rgba(255,36,66,0.1); color:#ff2442; padding:1px 6px; border-radius:4px; font-weight:600;">v1.0.2</span>
        </div>
        <button class="xhs-dl-close-btn" title="关闭面板">&times;</button>
      </div>

      <!-- Author Card -->
      <div class="xhs-dl-author-card">
        <img class="xhs-dl-author-avatar" src="https://ci.xiaohongshu.com/spectrum/user_avatar_default.png" alt="avatar" />
        <div class="xhs-dl-author-meta">
          <div class="xhs-dl-author-name">正在识别博主...</div>
          <div class="xhs-dl-author-tip">已采集 <span id="xhs-dl-count-notes">0</span> 篇笔记（<span id="xhs-dl-count-imgs">0</span> 张图 / <span id="xhs-dl-count-videos">0</span> 个视频）</div>
        </div>
      </div>

      <!-- Core Actions -->
      <div class="xhs-dl-actions">
        <button id="xhs-dl-btn-scan" class="xhs-dl-btn xhs-dl-btn-secondary">
          <span>🚀 自动扫描当前博主</span>
        </button>
        <button id="xhs-dl-btn-clear" class="xhs-dl-btn xhs-dl-btn-danger">
          <span>🗑️ 清空列表</span>
        </button>
        <button id="xhs-dl-btn-download" class="xhs-dl-btn xhs-dl-btn-primary">
          <span>⬇️ 批量下载选中项 (JPG无水印)</span>
        </button>
      </div>

      <!-- Config -->
      <div class="xhs-dl-config">
        <div class="xhs-dl-config-item">
          <label>
            <input type="checkbox" id="xhs-cfg-jpg" checked />
            <strong>照片强制转为 JPG</strong>
          </label>
          <span class="xhs-dl-config-tag">Canvas JPEG 0.95</span>
        </div>
        <div class="xhs-dl-config-item">
          <label>
            <input type="checkbox" id="xhs-cfg-group" checked />
            <strong>按博主保存为独立文件夹</strong>
          </label>
          <span class="xhs-dl-config-tag">小红书下载/{博主}</span>
        </div>
        <div class="xhs-dl-config-item">
          <label>
            <input type="checkbox" id="xhs-cfg-live" checked />
            <span>包含 LivePhoto 实况短视频</span>
          </label>
          <span class="xhs-dl-config-tag">MP4</span>
        </div>
      </div>

      <!-- Progress Box -->
      <div class="xhs-dl-progress-box" id="xhs-dl-progress">
        <div class="xhs-dl-progress-info">
          <span id="xhs-dl-progress-text">准备下载...</span>
          <span id="xhs-dl-progress-percent">0%</span>
        </div>
        <div class="xhs-dl-progress-bar-bg">
          <div class="xhs-dl-progress-bar-inner" id="xhs-dl-progress-bar"></div>
        </div>
        <div class="xhs-dl-progress-log" id="xhs-dl-progress-log">等待任务开始</div>
      </div>

      <!-- Filter Toolbar -->
      <div class="xhs-dl-filter-bar">
        <div class="xhs-dl-filter-links">
          <span class="xhs-dl-filter-link" id="xhs-select-all">全选</span>
          <span class="xhs-dl-filter-link" id="xhs-select-none">反选</span>
          <span class="xhs-dl-filter-link" id="xhs-select-images">仅选图文</span>
          <span class="xhs-dl-filter-link" id="xhs-select-videos">仅选视频</span>
        </div>
        <span style="color: #999; font-size: 11px;">已选: <span id="xhs-selected-count" style="color:#ff2442; font-weight:600;">0</span> 项</span>
      </div>

      <!-- Notes List -->
      <div class="xhs-dl-list-wrap" id="xhs-dl-list">
        <div class="xhs-dl-empty">
          <div class="xhs-dl-empty-icon">📂</div>
          <div>暂未采集到笔记数据</div>
          <div style="font-size: 11px; margin-top: 6px; color: #aaa;">请在博主主页上下滑动，或点击上方「自动扫描」</div>
        </div>
      </div>

      <!-- Copyright Footer -->
      <div class="xhs-dl-panel-footer">
        <span>小鸡发财去水印批量下载助手 v1.0.2</span>
        <span class="xhs-dl-copyright-sep">·</span>
        <span>版权所有 微信：<strong style="color: #ff2442;">-4555-</strong></span>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(mask);
    document.body.appendChild(panel);

    bindUIEvents();
    detectAuthorFromPage();
  }

  // 绑定界面事件
  function bindUIEvents() {
    const fab = document.getElementById('xhs-dl-fab');
    const mask = document.getElementById('xhs-dl-mask');
    const panel = document.getElementById('xhs-dl-panel');
    const closeBtn = panel.querySelector('.xhs-dl-close-btn');

    const togglePanel = (open) => {
      if (open) {
        panel.classList.add('open');
        mask.classList.add('open');
      } else {
        panel.classList.remove('open');
        mask.classList.remove('open');
      }
    };

    fab.addEventListener('click', () => togglePanel(true));
    mask.addEventListener('click', () => togglePanel(false));
    closeBtn.addEventListener('click', () => togglePanel(false));

    // 自动扫描
    const scanBtn = document.getElementById('xhs-dl-btn-scan');
    scanBtn.addEventListener('click', () => {
      if (state.isScanning) stopAutoScan();
      else startAutoScan();
    });

    // 清空列表
    const clearBtn = document.getElementById('xhs-dl-btn-clear');
    clearBtn.addEventListener('click', () => {
      if (state.isDownloading) return;
      state.notes.clear();
      state.selectedIds.clear();
      renderList();
    });

    // 批量下载
    const downloadBtn = document.getElementById('xhs-dl-btn-download');
    downloadBtn.addEventListener('click', () => {
      if (state.isDownloading) return;
      startBatchDownload();
    });

    // 过滤选项
    document.getElementById('xhs-select-all').addEventListener('click', () => {
      state.notes.forEach((_, id) => state.selectedIds.add(id));
      renderList();
    });

    document.getElementById('xhs-select-none').addEventListener('click', () => {
      state.notes.forEach((_, id) => {
        if (state.selectedIds.has(id)) state.selectedIds.delete(id);
        else state.selectedIds.add(id);
      });
      renderList();
    });

    document.getElementById('xhs-select-images').addEventListener('click', () => {
      state.selectedIds.clear();
      state.notes.forEach((note, id) => {
        if (!note.isVideo && note.images.length > 0) state.selectedIds.add(id);
      });
      renderList();
    });

    document.getElementById('xhs-select-videos').addEventListener('click', () => {
      state.selectedIds.clear();
      state.notes.forEach((note, id) => {
        if (note.isVideo) state.selectedIds.add(id);
      });
      renderList();
    });

    // 配置更新
    document.getElementById('xhs-cfg-jpg').addEventListener('change', (e) => {
      state.settings.convertToJpg = e.target.checked;
    });
    document.getElementById('xhs-cfg-group').addEventListener('change', (e) => {
      state.settings.groupByUser = e.target.checked;
    });
    document.getElementById('xhs-cfg-live').addEventListener('change', (e) => {
      state.settings.downloadLiveVideo = e.target.checked;
    });
  }

  // 渲染笔记列表
  function renderList() {
    enrichNotesFromPageDOM();

    const listWrap = document.getElementById('xhs-dl-list');
    const badge = document.querySelector('.xhs-dl-badge');
    const countNotes = document.getElementById('xhs-dl-count-notes');
    const countImgs = document.getElementById('xhs-dl-count-imgs');
    const countVideos = document.getElementById('xhs-dl-count-videos');
    const countSelected = document.getElementById('xhs-selected-count');

    if (!listWrap) return;

    let totalImages = 0;
    let totalVideos = 0;
    state.notes.forEach(note => {
      totalImages += (note.images.length || (note.isVideo ? 0 : 1));
      if (note.isVideo) totalVideos += 1;
    });

    if (badge) badge.textContent = state.notes.size;
    if (countNotes) countNotes.textContent = state.notes.size;
    if (countImgs) countImgs.textContent = totalImages;
    if (countVideos) countVideos.textContent = totalVideos;
    if (countSelected) countSelected.textContent = state.selectedIds.size;

    if (state.notes.size === 0) {
      listWrap.innerHTML = `
        <div class="xhs-dl-empty">
          <div class="xhs-dl-empty-icon">📂</div>
          <div>暂未采集到笔记数据</div>
          <div style="font-size: 11px; margin-top: 6px; color: #aaa;">请在博主主页上下滑动，或点击上方「自动扫描」</div>
        </div>
      `;
      return;
    }

    const defaultCoverIcon = chrome.runtime.getURL('icons/icon48.png');

    let html = '';
    state.notes.forEach((note) => {
      const isChecked = state.selectedIds.has(note.noteId);
      const countLabel = note.images.length > 0
        ? (note.isCoverPlaceholder ? '图文' : `${note.images.length} 张图`)
        : (note.isVideo ? '视频' : '1 张图');
      const mediaBadge = note.isVideo
        ? `<span class="xhs-dl-item-badge xhs-dl-badge-video">视频</span>`
        : `<span class="xhs-dl-item-badge xhs-dl-badge-image">${countLabel}</span>`;

      const safeCoverUrl = note.coverUrl || defaultCoverIcon;

      html += `
        <div class="xhs-dl-item" data-id="${note.noteId}">
          <input type="checkbox" class="xhs-dl-checkbox" ${isChecked ? 'checked' : ''} />
          <img class="xhs-dl-cover" src="${safeCoverUrl}" onerror="this.onerror=null;this.src='${defaultCoverIcon}';" loading="lazy" />
          <div class="xhs-dl-item-content">
            <div class="xhs-dl-item-title" title="${note.title}">${note.title || '无标题'}</div>
            <div class="xhs-dl-item-desc">
              ${mediaBadge}
              <span>${note.authorName}</span>
            </div>
          </div>
          <button class="xhs-dl-item-single-btn" data-download-id="${note.noteId}">单篇下载</button>
        </div>
      `;
    });

    listWrap.innerHTML = html;

    listWrap.querySelectorAll('.xhs-dl-item').forEach(itemEl => {
      const id = itemEl.getAttribute('data-id');
      const cb = itemEl.querySelector('.xhs-dl-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
        if (countSelected) countSelected.textContent = state.selectedIds.size;
      });

      const singleBtn = itemEl.querySelector('[data-download-id]');
      singleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSingleNote(state.notes.get(id));
      });
    });
  }

  // 4. 自动平滑滚动扫描
  function startAutoScan() {
    state.isScanning = true;
    const scanBtn = document.getElementById('xhs-dl-btn-scan');
    if (scanBtn) scanBtn.innerHTML = '<span>⏸️ 停止自动扫描</span>';

    let lastScrollHeight = 0;
    let noChangeCount = 0;

    state.scanTimer = setInterval(() => {
      window.scrollBy({ top: 900, behavior: 'smooth' });

      const currentHeight = document.documentElement.scrollHeight;
      if (currentHeight === lastScrollHeight) {
        noChangeCount++;
        if (noChangeCount > 8) {
          console.log('[XHS_DOWNLOAD] 已扫描到页面底部');
          stopAutoScan();
        }
      } else {
        noChangeCount = 0;
        lastScrollHeight = currentHeight;
      }
    }, 1200);
  }

  function stopAutoScan() {
    state.isScanning = false;
    if (state.scanTimer) {
      clearInterval(state.scanTimer);
      state.scanTimer = null;
    }
    const scanBtn = document.getElementById('xhs-dl-btn-scan');
    if (scanBtn) scanBtn.innerHTML = '<span>🚀 自动扫描当前博主</span>';
  }

  // 5. 单篇笔记即时下载
  async function downloadSingleNote(note, onProgress) {
    if (!note) return;
    showProgress(true);
    try {
      await processAndDownloadNote(note, (log) => {
        updateProgressLog(log);
        onProgress && onProgress(log);
      });
      updateProgressLog(`✅ 笔记「${note.title}」下载完成`);
    } catch (err) {
      updateProgressLog(`❌ 下载出错: ${err.message}`);
      throw err;
    } finally {
      setTimeout(() => showProgress(false), 3000);
    }
  }

  // 6. 批量下载
  async function startBatchDownload() {
    const selectedNotes = [];
    state.selectedIds.forEach(id => {
      if (state.notes.has(id)) selectedNotes.push(state.notes.get(id));
    });

    if (selectedNotes.length === 0) {
      alert('请先勾选需要下载的笔记！');
      return;
    }

    state.isDownloading = true;
    showProgress(true);

    const downloadBtn = document.getElementById('xhs-dl-btn-download');
    if (downloadBtn) {
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<span>⏳ 正在处理下载...</span>';
    }

    const totalNotes = selectedNotes.length;
    let totalSuccessFiles = 0;

    for (let i = 0; i < totalNotes; i++) {
      const note = selectedNotes[i];
      const progressPercent = Math.round((i / totalNotes) * 100);
      updateProgressBar(progressPercent, `处理中 (${i + 1}/${totalNotes}): ${note.title}`);

      try {
        const fileCount = await processAndDownloadNote(note, (msg) => {
          updateProgressLog(`[${i + 1}/${totalNotes}] ${msg}`);
        });
        totalSuccessFiles += fileCount;
      } catch (e) {
        console.error('[XHS_DOWNLOAD] 笔记下载失败:', note.noteId, e);
        updateProgressLog(`⚠️ 笔记「${note.title}」处理失败: ${e.message}`);
      }

      await sleep(200);
    }

    updateProgressBar(100, `🎉 全部完成！已保存 ${totalSuccessFiles} 个文件`);
    updateProgressLog(`已按博主归档保存在「小红书下载/${state.user.nickname}/」目录`);

    state.isDownloading = false;
    if (downloadBtn) {
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = '<span>⬇️ 批量下载选中项 (JPG无水印)</span>';
    }
  }

  // 从当前小红书主页 DOM 中补充封面和信息
  function enrichNotesFromPageDOM() {
    try {
      const cards = document.querySelectorAll('section.note-item, .feeds-container a, [class*="note-item"], [class*="feed-card"], .cover-inner');
      cards.forEach(card => {
        let noteId = '';
        const link = card.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]') || (card.tagName === 'A' ? card : null);
        if (link && link.href) {
          const m = link.href.match(/\/(explore|discovery\/item)\/([a-zA-Z0-9_-]+)/);
          if (m) noteId = m[2];
        }
        if (!noteId && card.getAttribute('data-id')) {
          noteId = card.getAttribute('data-id');
        }

        if (noteId) {
          const imgEl = card.querySelector('img');
          const titleEl = card.querySelector('.title, .footer .name, [class*="title"]');
          const title = titleEl ? titleEl.textContent.trim() : '';
          const imgSrc = imgEl ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src')) : '';

          if (imgSrc && imgSrc.startsWith('http')) {
            if (!state.notes.has(noteId)) {
              addRawNote({
                id: noteId,
                title: title || '小红书笔记',
                cover: { url: imgSrc }
              });
            } else {
              const n = state.notes.get(noteId);
              if (!n.coverUrl || n.coverUrl.includes('spectrum')) {
                n.coverUrl = imgSrc;
                if (n.images.length === 0 || n.images[0].isCoverPlaceholder) {
                  n.images = [{
                    index: 1,
                    candidateUrls: buildCandidateUrls({ url: imgSrc }),
                    coverUrl: imgSrc,
                    isCoverPlaceholder: true
                  }];
                }
              }
            }
          }
        }
      });
    } catch (e) {}
  }

  /**
   * 处理单篇笔记下载
   */
  async function processAndDownloadNote(note, onLog) {
    let filesCount = 0;
    const authorName = state.settings.groupByUser
      ? (note.authorName || state.user.nickname || '小红书博主')
      : '小红书下载';

    // 核心步骤：如果当前是列表卡片占位，或者没有详情，主动拉取完整多图图集与视频流！
    if (note.isCoverPlaceholder || (note.isVideo && !note.videoUrl) || note.images.length <= 1) {
      onLog && onLog(`正在拉取「${note.title}」完整图集与媒体数据...`);
      try {
        const fullDetail = await fetchFullNoteDetail(note.noteId);
        if (fullDetail) {
          addRawNote(fullDetail);
          const updated = state.notes.get(note.noteId);
          if (updated && updated.images && updated.images.length > 0) {
            note.images = updated.images;
            note.videoUrl = updated.videoUrl;
            note.isVideo = updated.isVideo;
            note.isCoverPlaceholder = false;
          }
        }
      } catch (e) {
        console.warn('[XHS_DOWNLOAD] 拉取详情异常，保底使用封面:', e);
      }
    }

    // 确保 images 至少有 1 个可下载项
    if ((!note.images || note.images.length === 0) && note.coverUrl) {
      note.images = [{
        index: 1,
        candidateUrls: buildCandidateUrls({ url: note.coverUrl }),
        coverUrl: note.coverUrl,
        isLivePhoto: false,
        liveVideoUrl: null
      }];
    }

    // 1. 处理视频
    if (note.isVideo && note.videoUrl) {
      onLog && onLog(`正在下载无水印视频 (MP4)...`);
      try {
        await executeDownload({
          url: note.videoUrl,
          authorName: authorName,
          title: note.title,
          index: 1,
          ext: 'mp4'
        });
        filesCount++;
      } catch (e) {
        console.error('[XHS_DOWNLOAD] 视频下载异常:', e);
      }
    }

    // 2. 处理图片
    if (note.images && note.images.length > 0) {
      for (let j = 0; j < note.images.length; j++) {
        const img = note.images[j];
        onLog && onLog(`正在转码并保存第 ${j + 1}/${note.images.length} 张图片 (JPG)...`);

        let finalUrlOrData = '';
        let targetCandidate = img.candidateUrls[0] || '';

        // 尝试从候选 URL 转为真实的 JPG
        for (const candidate of img.candidateUrls) {
          try {
            if (state.settings.convertToJpg) {
              finalUrlOrData = await window.XhsImageConverter.convertToJpegDataUrl(candidate, 0.95);
            } else {
              finalUrlOrData = candidate;
            }
            if (finalUrlOrData) {
              targetCandidate = candidate;
              break;
            }
          } catch (convErr) {
            console.warn('[XHS_DOWNLOAD] 候选转码未成功，尝试下一个:', candidate, convErr);
          }
        }

        // 如果全部转码失败，降级为直链
        if (!finalUrlOrData) {
          finalUrlOrData = targetCandidate;
        }

        try {
          await executeDownload({
            url: finalUrlOrData,
            authorName: authorName,
            title: note.title,
            index: j + 1,
            ext: 'jpg'
          });
          filesCount++;
        } catch (downloadErr) {
          console.error('[XHS_DOWNLOAD] 下载保存失败:', downloadErr);
        }

        // 处理实况短视频 (Live Photo)
        if (state.settings.downloadLiveVideo && img.isLivePhoto && img.liveVideoUrl) {
          onLog && onLog(`正在保存第 ${j + 1} 张实况短视频...`);
          try {
            await executeDownload({
              url: img.liveVideoUrl,
              authorName: authorName,
              title: `${note.title}_live_${j + 1}`,
              index: 1,
              ext: 'mp4'
            });
            filesCount++;
          } catch (liveErr) {
            console.warn('[XHS_DOWNLOAD] 实况视频保存失败:', liveErr);
          }
        }

        await sleep(150);
      }
    }

    return filesCount;
  }

  /**
   * 执行下载，带双保险保底机制
   */
  async function executeDownload(payload) {
    // 方案一：优先通过后台 chrome.downloads.download 保存到独立文件夹
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: 'DOWNLOAD_ITEM',
            payload
          },
          (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (res && res.success) resolve(res.downloadId);
            else reject(new Error((res && res.error) || '后台下载拒绝'));
          }
        );
      });
      return;
    } catch (bgErr) {
      console.warn('[XHS_DOWNLOAD] 后台下载失败，触发保底原生下载:', bgErr);
    }

    // 方案二：保底原生 <a> 标签下载（确保文件 100% 成功保存）
    const a = document.createElement('a');
    a.href = payload.url;
    const cleanAuthor = (payload.authorName || 'xhs').replace(/[\\/:*?"<>|~]/g, '_');
    const cleanTitle = (payload.title || 'file').replace(/[\\/:*?"<>|~]/g, '_');
    a.download = `[${cleanAuthor}]_${cleanTitle}_${String(payload.index).padStart(2, '0')}.${payload.ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
    }, 1000);
  }

  // 进度控制辅助
  function showProgress(visible) {
    const box = document.getElementById('xhs-dl-progress');
    if (box) {
      if (visible) box.classList.add('active');
      else box.classList.remove('active');
    }
  }

  function updateProgressBar(percent, text) {
    const bar = document.getElementById('xhs-dl-progress-bar');
    const percentEl = document.getElementById('xhs-dl-progress-percent');
    const textEl = document.getElementById('xhs-dl-progress-text');
    if (bar) bar.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (textEl && text) textEl.textContent = text;
  }

  function updateProgressLog(msg) {
    const logEl = document.getElementById('xhs-dl-progress-log');
    if (logEl) logEl.textContent = msg;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // 7. 页面详情弹窗内快捷下载按钮注入
  function injectDetailQuickDownload() {
    const observer = new MutationObserver(() => {
      // 匹配小红书详情弹窗容器（覆盖各种页面和组件样式）
      const noteContainer = document.querySelector('.note-container, .interaction-container, [class*="noteDetail"], [class*="noteContainer"], .feed-card, .note-detail-mask');
      if (noteContainer && !noteContainer.querySelector('.xhs-detail-quick-btn')) {
        const quickBtn = document.createElement('button');
        quickBtn.className = 'xhs-detail-quick-btn';
        quickBtn.innerHTML = `<span>📥 下载本篇无水印原图(JPG)</span>`;
        quickBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          quickBtn.disabled = true;
          quickBtn.style.pointerEvents = 'none';
          quickBtn.innerHTML = `<span>⏳ 正在提取解析...</span>`;

          try {
            const targetNote = await resolveCurrentNote(noteContainer);

            if (targetNote && (targetNote.images.length > 0 || targetNote.videoUrl)) {
              const total = targetNote.images.length || (targetNote.isVideo ? 1 : 0);
              quickBtn.innerHTML = `<span>⏳ 正在下载 (共 ${total} 项)...</span>`;

              await downloadSingleNote(targetNote, (logText) => {
                quickBtn.innerHTML = `<span>⏳ ${logText.slice(0, 18)}...</span>`;
              });

              quickBtn.style.background = '#52c41a';
              quickBtn.innerHTML = `<span>✅ 成功保存 ${total} 项！</span>`;
              setTimeout(() => {
                quickBtn.style.background = '#ff2442';
                quickBtn.disabled = false;
                quickBtn.style.pointerEvents = 'auto';
                quickBtn.innerHTML = `<span>📥 下载本篇无水印原图(JPG)</span>`;
              }, 2500);
            } else {
              quickBtn.style.background = '#faad14';
              quickBtn.innerHTML = `<span>⚠️ 未能检测到图片</span>`;
              setTimeout(() => {
                quickBtn.style.background = '#ff2442';
                quickBtn.disabled = false;
                quickBtn.style.pointerEvents = 'auto';
                quickBtn.innerHTML = `<span>📥 下载本篇无水印原图(JPG)</span>`;
              }, 2000);
            }
          } catch (err) {
            console.error('[XHS_DOWNLOAD] 单篇点击下载出错:', err);
            quickBtn.style.background = '#ff4d4f';
            quickBtn.innerHTML = `<span>❌ 出错: ${err.message.slice(0, 12)}</span>`;
            setTimeout(() => {
              quickBtn.style.background = '#ff2442';
              quickBtn.disabled = false;
              quickBtn.style.pointerEvents = 'auto';
              quickBtn.innerHTML = `<span>📥 下载本篇无水印原图(JPG)</span>`;
            }, 3000);
          }
        });
        noteContainer.appendChild(quickBtn);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * 智能识别并解析当前打开的单篇笔记（多级自适应）
   */
  async function resolveCurrentNote(container) {
    // 1. 优先直接向 inject.js 索取活动笔记（100%原版，包含所有分页图和视频流）
    try {
      const activeRaw = await requestActiveNoteFromInject();
      if (activeRaw) {
        addRawNote(activeRaw);
        const activeId = activeRaw.id || activeRaw.note_id || activeRaw.noteId;
        if (activeId && state.notes.has(activeId)) {
          return state.notes.get(activeId);
        }
      }
    } catch (e) {}

    // 2. 尝试从 URL 匹配各类 noteId
    const currentUrl = window.location.href;
    let noteId = null;
    const urlMatch = currentUrl.match(/\/(explore|discovery\/item)\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) noteId = urlMatch[2];
    if (!noteId) {
      const qMatch = currentUrl.match(/[?&](note_id|noteId|currentNoteId)=([a-zA-Z0-9_-]+)/);
      if (qMatch) noteId = qMatch[2];
    }

    if (noteId && state.notes.has(noteId)) {
      return state.notes.get(noteId);
    }

    // 3. 终极自适应：全屏大图范围扫描（向上寻根到最外层弹窗，避免只在右侧互动区搜寻）
    const rootScope = (container && container.closest('.note-container, .modal-container, .note-detail-mask, .feed-card, [class*="modal"], body')) || document.body;
    const domNote = parseNoteFromDom(rootScope, noteId);
    if (domNote && (domNote.images.length > 0 || domNote.videoUrl)) {
      return domNote;
    }

    if (state.notes.size > 0) {
      return Array.from(state.notes.values()).pop();
    }

    return null;
  }

  /**
   * 主动向 inject.js 索取当前打开笔记的完整 JSON 数据
   */
  function requestActiveNoteFromInject() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 350);

      function handler(event) {
        if (event.source !== window || !event.data || event.data.source !== 'XHS_INJECT_SCRIPT') return;
        if (event.data.action === 'CURRENT_ACTIVE_NOTE_RESPONSE') {
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          resolve(event.data.payload || null);
        }
      }

      window.addEventListener('message', handler);
      window.postMessage({ source: 'XHS_CONTENT_SCRIPT', action: 'GET_CURRENT_ACTIVE_NOTE' }, '*');
    });
  }

  /**
   * 从当前弹窗 DOM 中提取媒体、标题与博主信息
   */
  function parseNoteFromDom(container, noteId) {
    // 标题
    const titleEl = container.querySelector('#detail-title, .title, [class*="title"], .note-text, [class*="desc"]');
    const title = (titleEl && titleEl.textContent.trim()) || '小红书笔记';

    // 作者
    const authorEl = container.querySelector('.name, .author-name, .username, [class*="author"] [class*="name"]');
    const authorName = (authorEl && authorEl.textContent.trim()) || state.user.nickname || '小红书博主';

    // 视频
    let videoUrl = null;
    const videoEl = container.querySelector('video, source');
    if (videoEl && videoEl.src) {
      videoUrl = videoEl.src;
    }

    // 图片提取
    const images = [];
    const seenSrcs = new Set();

    // 优先搜寻大图轮播与媒体展示区
    const mediaImgs = container.querySelectorAll('.media-container img, .swiper-slide img, [class*="slider"] img, [class*="carousel"] img, [class*="media"] img, img');
    mediaImgs.forEach((img) => {
      let src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src) return;
      if (!src.includes('xhscdn.com') && !src.includes('ci.xiaohongshu.com')) return;
      if (src.includes('avatar') || src.includes('spectrum/user')) return;

      let clean = src;
      if (clean.includes('_wl_')) clean = clean.replace(/_wl_/g, '_');
      if (clean.includes('!nd_dft_wl_')) clean = clean.replace('!nd_dft_wl_', '!nd_dft_');

      if (!seenSrcs.has(clean)) {
        seenSrcs.add(clean);
        images.push({
          index: images.length + 1,
          candidateUrls: [clean, src],
          coverUrl: clean,
          isLivePhoto: false,
          liveVideoUrl: null
        });
      }
    });

    // 背景图提取 (某些画廊组件)
    const bgEls = container.querySelectorAll('[style*="background-image"], [style*="background:url"]');
    bgEls.forEach((el) => {
      const style = el.getAttribute('style') || '';
      const bgMatch = style.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (bgMatch && bgMatch[1]) {
        let src = bgMatch[1];
        if (!src.includes('xhscdn.com') && !src.includes('ci.xiaohongshu.com')) return;
        if (src.includes('avatar')) return;

        let clean = src;
        if (clean.includes('_wl_')) clean = clean.replace(/_wl_/g, '_');
        if (clean.includes('!nd_dft_wl_')) clean = clean.replace('!nd_dft_wl_', '!nd_dft_');

        if (!seenSrcs.has(clean)) {
          seenSrcs.add(clean);
          images.push({
            index: images.length + 1,
            candidateUrls: [clean, src],
            coverUrl: clean,
            isLivePhoto: false,
            liveVideoUrl: null
          });
        }
      }
    });

    return {
      noteId: noteId || 'note_' + Date.now(),
      title: title.slice(0, 50).trim(),
      authorName: authorName,
      isVideo: !!videoUrl,
      images: images,
      videoUrl: videoUrl,
      coverUrl: images[0] ? images[0].coverUrl : ''
    };
  }

  // 初始化入口
  function init() {
    createUI();
    injectMainWorldScript();
    injectDetailQuickDownload();

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        detectAuthorFromPage();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
