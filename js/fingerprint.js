(function () {
  'use strict';

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 50;
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069';
      ctx.fillText('棋·密·指纹', 10, 10);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('Fingerprint', 10, 30);
      return canvas.toDataURL();
    } catch (e) {
      return 'canvas-error';
    }
  }

  function getWebglFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return 'no-webgl';
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        return gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) + '|' +
               gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      }
      return gl.getParameter(gl.VENDOR) + '|' + gl.getParameter(gl.RENDERER);
    } catch (e) {
      return 'webgl-error';
    }
  }

  async function generate() {
    const nav = navigator;
    const sc = window.screen;
    const basic = [
      nav.userAgent,
      nav.language,
      nav.languages ? nav.languages.join(',') : '',
      nav.platform || '',
      nav.hardwareConcurrency || '',
      nav.deviceMemory || '',
      sc.width, sc.height, sc.colorDepth, sc.pixelDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      new Date().getTimezoneOffset()
    ].join('|');

    const raw = basic + '|' + getCanvasFingerprint() + '|' + getWebglFingerprint();
    const hash = await sha256Hex(raw);
    return hash.slice(0, 16);
  }

  window.Fingerprint = { generate, sha256Hex };
})();