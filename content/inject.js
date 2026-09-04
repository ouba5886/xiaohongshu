/**
 * 小红书批量下载助手 - 页面主环境注入脚本 (Main World)
 * 职责：
 * 1. 拦截 window.fetch 和 XMLHttpRequest，嗅探笔记列表和详情数据
 * 2. 提取 window.__INITIAL_STATE__ 中的博主和笔记信息
 * 3. 响应来自 Content Script 的指令（例如扫描初始数据、触发 API 采集）
 */

(function () {
  if (window.__XHS_INJECT_SCRIPT_LOADED__) return;
  window.__XHS_INJECT_SCRIPT_LOADED__ = true;

  console.log('[XHS_DOWNLOAD] 页面注入脚本初始化成功');

  // 缓存最新打开的笔记详情
  let latestActiveNote = null;

  // 向 Content Script 发送数据
  function sendToContentScript(action, data) {
    window.postMessage(
      {
        source: 'XHS_INJECT_SCRIPT',
        action: action,
        payload: data
      },
      '*'
    );
  }

  // 1. 拦截 window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      
      // 捕获笔记列表和笔记详情的 API
      if (
        url.includes('/api/sns/web/v1/user_posted') ||
        url.includes('/api/sns/web/v1/feed') ||
        url.includes('/api/sns/web/v1/homefeed') ||
        url.includes('/api/sns/web/v2/note/collect/page')
      ) {
        const cloned = response.clone();
        cloned.json().then(json => {
          if (json && json.success !== false) {
            const data = json.data || json;
            // 记录单篇详情
            if (url.includes('/api/sns/web/v1/feed')) {
              const items = data.items || [];
              if (items[0] && items[0].note_card) {
                latestActiveNote = items[0].note_card;
              }
            }
            sendToContentScript('API_INTERCEPTED', {
              url: url,
              data: data
            });
          }
        }).catch(() => {});
      }
    } catch (e) {
      // 忽略解析错误，避免影响原站
    }
    return response;
  };

  // 2. 拦截 XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._requestUrl = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...rest) {
    this.addEventListener('load', function () {
      try {
        const url = this._requestUrl || '';
        if (
          url.includes('/api/sns/web/v1/user_posted') ||
          url.includes('/api/sns/web/v1/feed') ||
          url.includes('/api/sns/web/v1/homefeed')
        ) {
          const json = JSON.parse(this.responseText);
          if (json && json.success !== false) {
            sendToContentScript('API_INTERCEPTED', {
              url: url,
              data: json.data || json
            });
          }
        }
      } catch (e) {}
    });
    return originalSend.apply(this, rest);
  };

  // 3. 读取 window.__INITIAL_STATE__
  function extractInitialState() {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return null;

      const result = {
        user: null,
        notes: [],
        noteDetailMap: {}
      };

      // 提取用户信息
      if (state.user && state.user.userPageData) {
        const u = state.user.userPageData.basicInfo || state.user.userPageData;
        result.user = {
          userId: u.redId || u.userId || '',
          nickname: u.nickname || u.name || '小红书博主',
          avatar: u.imageb || u.avatar || '',
          desc: u.desc || ''
        };
      }

      // 提取用户主页笔记列表
      if (state.user) {
        let rawNotes = state.user.notes || (state.user.userPageData && state.user.userPageData.notes);
        if (rawNotes) {
          const notesArr = Array.isArray(rawNotes[0]) ? rawNotes.flat() : (Array.isArray(rawNotes) ? rawNotes : Object.values(rawNotes));
          result.notes = notesArr.map(n => n.noteItem || n.noteCard || n.note_card || n);
        }
      }

      // 提取打开的笔记详情
      if (state.note && state.note.noteDetailMap) {
        result.noteDetailMap = state.note.noteDetailMap;
      }

      return result;
    } catch (e) {
      console.warn('[XHS_DOWNLOAD] 提取 INITIAL_STATE 失败:', e);
      return null;
    }
  }

  // 4. 监听来自 Content Script 的消息
  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.source !== 'XHS_CONTENT_SCRIPT') {
      return;
    }

    const { action, payload } = event.data;

    if (action === 'GET_INITIAL_DATA') {
      const stateData = extractInitialState();
      sendToContentScript('INITIAL_DATA_RESPONSE', stateData);
    } else if (action === 'GET_CURRENT_ACTIVE_NOTE') {
      const activeNote = extractCurrentActiveNote();
      sendToContentScript('CURRENT_ACTIVE_NOTE_RESPONSE', activeNote);
    } else if (action === 'GET_NOTE_DETAIL_BY_ID') {
      const { noteId } = payload || {};
      const note = findNoteInPage(noteId);
      sendToContentScript('NOTE_DETAIL_BY_ID_RESPONSE', { noteId, note });
    } else if (action === 'TRIGGER_FETCH_USER_POSTED') {
      // 尝试在页面环境调用用户笔记接口
      fetchUserPosted(payload);
    }
  });

  // 根据 noteId 在页面内存中快速查找详情
  function findNoteInPage(noteId) {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return null;
      if (state.note && state.note.noteDetailMap && state.note.noteDetailMap[noteId]) {
        return state.note.noteDetailMap[noteId].note || state.note.noteDetailMap[noteId];
      }
      if (latestActiveNote && (latestActiveNote.id === noteId || latestActiveNote.noteId === noteId)) {
        return latestActiveNote;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // 提取当前正在浏览的单篇笔记
  function extractCurrentActiveNote() {
    try {
      if (latestActiveNote) return latestActiveNote;

      const state = window.__INITIAL_STATE__;
      if (!state) return null;

      const noteState = state.note;
      if (noteState) {
        const firstId = noteState.firstNoteId || noteState.currentNoteId;
        if (firstId && noteState.noteDetailMap && noteState.noteDetailMap[firstId]) {
          return noteState.noteDetailMap[firstId].note || noteState.noteDetailMap[firstId];
        }
        if (noteState.noteDetailMap) {
          const vals = Object.values(noteState.noteDetailMap);
          if (vals.length > 0) {
            const last = vals[vals.length - 1];
            return last.note || last;
          }
        }
        if (noteState.note) return noteState.note;
      }

      if (state.noteData) return state.noteData.note || state.noteData;
      return null;
    } catch (e) {
      return null;
    }
  }

  // 主动请求用户笔记（使用页面同源环境与携带的登录 Cookie）
  async function fetchUserPosted({ userId, cursor, num = 30 }) {
    try {
      const url = `/api/sns/web/v1/user_posted?num=${num}&cursor=${cursor || ''}&user_id=${userId}&image_formats=jpg,webp,avif`;
      const res = await originalFetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        },
        credentials: 'include'
      });
      const json = await res.json();
      sendToContentScript('FETCH_USER_POSTED_RESPONSE', {
        userId,
        cursor,
        response: json
      });
    } catch (err) {
      sendToContentScript('FETCH_USER_POSTED_ERROR', {
        error: err.message
      });
    }
  }

  // 初始页面完成后尝试派发一次
  setTimeout(() => {
    const initialData = extractInitialState();
    if (initialData) {
      sendToContentScript('INITIAL_DATA_READY', initialData);
    }
  }, 1000);
})();
