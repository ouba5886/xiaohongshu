/**
 * 小红书批量下载助手 - Background Service Worker
 * 核心职责：
 * 1. 设置 Referer 防盗链规则
 * 2. 提供高权限 fetch 代理，彻底解决 Content Script 中图片 Canvas 跨域污染
 * 3. 执行 chrome.downloads.download，按博主文件夹保存文件
 */

// 动态设置小红书防盗链规则
async function setupRefererRules() {
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.xiaohongshu.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.xiaohongshu.com' }
          ]
        },
        condition: {
          urlFilter: '||xhscdn.com',
          resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame', 'other', 'media', 'image']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.xiaohongshu.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.xiaohongshu.com' }
          ]
        },
        condition: {
          urlFilter: '||ci.xiaohongshu.com',
          resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame', 'other', 'media', 'image']
        }
      },
      {
        id: 3,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: 'https://www.xiaohongshu.com/' },
            { header: 'Origin', operation: 'set', value: 'https://www.xiaohongshu.com' }
          ]
        },
        condition: {
          urlFilter: '||xiaohongshu.com',
          resourceTypes: ['xmlhttprequest', 'sub_frame', 'main_frame', 'other']
        }
      }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1, 2, 3],
      addRules: rules
    });
    console.log('[XHS_BG] Referer 动态规则注入成功');
  } catch (err) {
    console.warn('[XHS_BG] 注入规则警告:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => setupRefererRules());
chrome.runtime.onStartup.addListener(() => setupRefererRules());
setupRefererRules();

// 监听来自 Content Script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action, payload } = request;

  // 1. 高权限拉取图片为 Base64（解决网页 Canvas 跨域污染）
  if (action === 'FETCH_IMAGE_DATA_URL') {
    fetchImageDataUrl(payload.url)
      .then((dataUrl) => sendResponse({ success: true, dataUrl }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // 异步
  }

  // 2. 执行下载并按文件夹保存
  if (action === 'DOWNLOAD_ITEM') {
    handleDownloadItem(payload)
      .then((downloadId) => sendResponse({ success: true, downloadId }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // 异步
  }

  // 3. 高权限获取笔记完整详情（突破列表API只返回缩略图的限制）
  if (action === 'FETCH_NOTE_DETAIL') {
    fetchNoteDetailFromWeb(payload.noteId)
      .then((note) => sendResponse({ success: true, note }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // 异步
  }

  if (action === 'PING') {
    sendResponse({ pong: true });
    return false;
  }
});

/**
 * 在后台高权限上下文中拉取图片并转为 DataURL
 */
async function fetchImageDataUrl(url) {
  if (!url) throw new Error('URL 为空');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      cache: 'force-cache'
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throw new Error(`拉取失败 HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  // 将二进制转为 base64
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  const base64 = btoa(binary);
  const mime = blob.type || 'image/jpeg';
  return `data:${mime};base64,${base64}`;
}

// 清洗文件名与路径，避免操作系统非法字符
function sanitizeFilename(name, fallback = 'xhs') {
  if (!name || typeof name !== 'string') return fallback;
  let clean = name
    .replace(/[\\/:*?"<>|~\r\n\t]/g, '_')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/_+/g, '_')
    .trim();
  if (clean.length > 35) clean = clean.substring(0, 35).trim();
  return clean || fallback;
}

/**
 * 触发 Chrome 下载
 */
async function handleDownloadItem(payload) {
  const {
    url,
    authorName = '小红书博主',
    title = '笔记',
    index = 1,
    ext = 'jpg',
    subFolder = '小红书下载'
  } = payload;

  if (!url) throw new Error('下载 URL 为空');

  const cleanRoot = sanitizeFilename(subFolder, '小红书下载');
  const cleanAuthor = sanitizeFilename(authorName, '小红书博主');
  const cleanTitle = sanitizeFilename(title, '笔记');
  const indexStr = String(index).padStart(2, '0');

  // 构建独立博主文件夹路径: 小红书下载/{博主昵称}/{标题}_{序号}.{jpg|mp4}
  const relativePath = `${cleanRoot}/${cleanAuthor}/${cleanTitle}_${indexStr}.${ext}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: relativePath,
        conflictAction: 'uniquify',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[XHS_BG] 下载错误:', chrome.runtime.lastError.message, relativePath);
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!downloadId) {
          reject(new Error('未分配 downloadId'));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

/**
 * 后台高权限拉取笔记完整网页，并解析出 __INITIAL_STATE__ 中的完整图集与高清视频
 */
async function fetchNoteDetailFromWeb(noteId) {
  if (!noteId) throw new Error('noteId 为空');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const url = `https://www.xiaohongshu.com/explore/${noteId}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache'
      },
      credentials: 'include'
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    // 匹配 window.__INITIAL_STATE__
    let state = null;
    const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})<\/script>/);
    if (stateMatch && stateMatch[1]) {
      try {
        const clean = stateMatch[1].replace(/:\s*undefined([,\}])/g, ':null$1');
        state = JSON.parse(clean);
      } catch (e) {
        console.warn('[XHS_BG] 解析 __INITIAL_STATE__ 出错:', e);
      }
    }

    if (!state) {
      const dataMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]+?\})<\/script>/);
      if (dataMatch && dataMatch[1]) {
        try {
          const clean = dataMatch[1].replace(/:\s*undefined([,\}])/g, ':null$1');
          state = JSON.parse(clean);
        } catch (e) {}
      }
    }

    if (state) {
      if (state.note) {
        if (state.note.noteDetailMap && state.note.noteDetailMap[noteId]) {
          return state.note.noteDetailMap[noteId].note || state.note.noteDetailMap[noteId];
        }
        if (state.note.noteDetailMap) {
          const keys = Object.keys(state.note.noteDetailMap);
          if (keys.length > 0) {
            const first = state.note.noteDetailMap[keys[0]];
            return first.note || first;
          }
        }
        if (state.note.note) return state.note.note;
        if (state.note.firstNoteId && state.note.noteDetailMap && state.note.noteDetailMap[state.note.firstNoteId]) {
          const fn = state.note.noteDetailMap[state.note.firstNoteId];
          return fn.note || fn;
        }
      }
      if (state.noteData) {
        return state.noteData.note || state.noteData;
      }
    }

    throw new Error('未在页面中解析到笔记数据');
  } finally {
    clearTimeout(timer);
  }
}
