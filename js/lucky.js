(function () {
  'use strict';

  async function getDaily(fingerprint) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const cacheKey = `lucky_${today}`;

    const cached = localStorage.getItem(cacheKey);
    if (cached !== null) return cached;

    const seed = fingerprint + '_' + today;
    const hash = await window.Fingerprint.sha256Hex(seed);
    const num = parseInt(hash.slice(0, 8), 16);
    const value = (num % 101).toString(); // 0-100

    localStorage.setItem(cacheKey, value);
    return value;
  }

  window.Lucky = { getDaily };
})();