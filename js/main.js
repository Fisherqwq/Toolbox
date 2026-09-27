(function () {
  'use strict';

  const views = {
    home:     document.getElementById('view-home'),
    crypto:   document.getElementById('view-crypto'),
    xiangqi:  document.getElementById('view-xiangqi'),
    chess:    document.getElementById('view-chess'),
    gomoku:   document.getElementById('view-gomoku')
  };

  function showView(name) {
  Object.keys(views).forEach(k => {
    if (views[k]) views[k].classList.toggle('hidden', k !== name);
  });
  if (name === 'gomoku' && window.Gomoku) {
    setTimeout(() => window.Gomoku.init(), 50);
  }
  window.scrollTo(0, 0);
}

  function handleHash() {
    const name = (location.hash.replace(/^#\/?/, '') || 'home');
    console.log('[router] hash =', location.hash, '→ view =', name);
    showView(views[name] ? name : 'home');
  }

  function bindCryptoEvents() {
    const $ = id => document.getElementById(id);

    $('aesEncryptBtn').addEventListener('click', async () => {
      const el = $('aesResult');
      try { el.textContent = await CryptoTools.aesEncrypt($('aesInput').value); }
      catch (e) { el.textContent = '加密失败: ' + e.message; }
    });
    $('aesDecryptBtn').addEventListener('click', async () => {
      const el = $('aesResult');
      try { el.textContent = await CryptoTools.aesDecrypt($('aesInput').value.trim()); }
      catch (e) { el.textContent = '解密失败: ' + e.message; }
    });

    $('base64EncodeBtn').addEventListener('click', () => {
      const el = $('base64Result');
      try { el.textContent = CryptoTools.base64Encode($('base64Input').value); }
      catch (e) { el.textContent = '编码失败: ' + e.message; }
    });
    $('base64DecodeBtn').addEventListener('click', () => {
      const el = $('base64Result');
      try { el.textContent = CryptoTools.base64Decode($('base64Input').value.trim()); }
      catch (e) { el.textContent = '解码失败: ' + e.message; }
    });

    $('sha256Btn').addEventListener('click', async () => {
      const el = $('sha256Result');
      try { el.textContent = await CryptoTools.sha256($('sha256Input').value); }
      catch (e) { el.textContent = '哈希失败: ' + e.message; }
    });
    $('sha512Btn').addEventListener('click', async () => {
      const el = $('sha512Result');
      try { el.textContent = await CryptoTools.sha512($('sha512Input').value); }
      catch (e) { el.textContent = '哈希失败: ' + e.message; }
    });
  }

  async function initFingerprint() {
    console.log('[fingerprint] 开始生成…');
    const fpEl = document.getElementById('fingerprintDisplay');
    const luckyEl = document.getElementById('luckyDisplay');
    if (!fpEl || !luckyEl) {
      console.error('[fingerprint] 找不到显示元素', { fpEl, luckyEl });
      return;
    }
    try {
      const fp = await Fingerprint.generate();
      console.log('[fingerprint] 指纹 =', fp);
      fpEl.textContent = fp;

      const lucky = await Lucky.getDaily(fp);
      console.log('[fingerprint] 幸运值 =', lucky);
      luckyEl.textContent = lucky;
    } catch (e) {
      console.error('[fingerprint] 生成失败:', e);
      fpEl.textContent = '不可用';
      luckyEl.textContent = '--';
    }
  }

  function boot() {
    console.log('[boot] 初始化开始, readyState =', document.readyState);
    handleHash();
    bindCryptoEvents();
    initFingerprint();
  }

  // 关键：根据 readyState 决定何时启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.addEventListener('hashchange', handleHash);
})();