/**
 * 小红书批量下载助手 - Popup 脚本
 */

document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const statusTitle = document.getElementById('status-title');
  const statusDesc = document.getElementById('status-desc');
  const btnOpenXhs = document.getElementById('btn-open-xhs');
  const btnOpenDownloads = document.getElementById('btn-open-downloads');

  // 获取当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab && tab.url && tab.url.includes('xiaohongshu.com')) {
    statusDot.className = 'status-indicator ready';
    statusTitle.textContent = '当前位于小红书网页端';
    statusDesc.textContent = '右下角悬浮窗已就绪，可随时使用';
    btnOpenXhs.textContent = '刷新当前页面';
    btnOpenXhs.onclick = () => {
      chrome.tabs.reload(tab.id);
      window.close();
    };
  } else {
    statusDot.className = 'status-indicator warn';
    statusTitle.textContent = '尚未处于小红书页面';
    statusDesc.textContent = '请打开小红书后使用批量下载功能';
    btnOpenXhs.textContent = '前往小红书官网 (xiaohongshu.com)';
    btnOpenXhs.onclick = () => {
      chrome.tabs.create({ url: 'https://www.xiaohongshu.com' });
      window.close();
    };
  }

  btnOpenDownloads.onclick = () => {
    chrome.tabs.create({ url: 'chrome://downloads' });
    window.close();
  };
});
