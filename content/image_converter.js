/**
 * 小红书批量下载助手 - 格式转换引擎
 * 职责：在真实 DOM 环境中将图片通过 Canvas 转码为纯正标准的 JPG (image/jpeg)
 */

class XhsImageConverter {
  /**
   * 将图片转换为真实的 JPG Data URL
   * @param {string} rawUrl - 图片链接
   * @param {number} quality - 导出质量 (0.95)
   * @returns {Promise<string>} 返回标准的 data:image/jpeg;base64,...
   */
  static async convertToJpegDataUrl(rawUrl, quality = 0.95) {
    if (!rawUrl) throw new Error('图片链接为空');

    // 1. 优先通过后台 Service Worker 获取二进制 base64（彻底规避浏览器的 Canvas 跨域污染 Tainted Canvas）
    let sourceDataUrl = '';
    try {
      sourceDataUrl = await this.fetchViaBackground(rawUrl);
    } catch (bgErr) {
      console.warn('[XHS_CONVERT] 后台代理拉取失败，尝试直连:', bgErr);
      sourceDataUrl = rawUrl;
    }

    // 2. 将图片载入 DOM Image 元素（带 2 秒超时保护）
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      let timer = setTimeout(() => reject(new Error('图片加载超时')), 15000);
      if (!sourceDataUrl.startsWith('data:')) {
        image.crossOrigin = 'anonymous';
      }
      image.onload = () => {
        clearTimeout(timer);
        resolve(image);
      };
      image.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('图片载入解码失败'));
      };
      image.src = sourceDataUrl;
    });

    const width = img.naturalWidth || img.width || 800;
    const height = img.naturalHeight || img.height || 600;

    // 3. 在 Canvas 上绘制并转码
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // 白色背景填充（避免透明底变黑）
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    // 4. 导出为标准 JPEG DataURL
    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    return jpegDataUrl;
  }

  // 通过 background 请求绕过跨域（带 1.5 秒快速熔断）
  static fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台代理请求超时')), 15000);
      chrome.runtime.sendMessage(
        {
          action: 'FETCH_IMAGE_DATA_URL',
          payload: { url }
        },
        (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (res && res.success && res.dataUrl) {
            resolve(res.dataUrl);
          } else {
            reject(new Error((res && res.error) || '拉取数据为空'));
          }
        }
      );
    });
  }
}

window.XhsImageConverter = XhsImageConverter;
