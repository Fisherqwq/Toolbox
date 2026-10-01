(function () {
  'use strict';

  // ---------- 基础工具 ----------
  const textToBytes = t => new TextEncoder().encode(t);
  const bytesToHex = bytes =>
    Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

  function u8ToBase64(u8) {
    let bin = '';
    for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }
  function base64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ---------- SHA ----------
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', textToBytes(text));
    return bytesToHex(new Uint8Array(buf));
  }
  async function sha512(text) {
    const buf = await crypto.subtle.digest('SHA-512', textToBytes(text));
    return bytesToHex(new Uint8Array(buf));
  }

  // ---------- Base64（支持中文） ----------
  function base64Encode(text) {
    return u8ToBase64(textToBytes(text));
  }
  function base64Decode(b64) {
    return new TextDecoder().decode(base64ToU8(b64));
  }

  // ---------- AES-GCM 256 ----------
  const AES_SALT = textToBytes('static-site-demo-salt-v1');
  const AES_PASSWORD = 'demo-password-123'; // 演示用固定密码

  async function getAesKey() {
    const km = await crypto.subtle.importKey(
      'raw', textToBytes(AES_PASSWORD),
      { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: AES_SALT, iterations: 100000, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function aesEncrypt(plaintext) {
    const key = await getAesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, textToBytes(plaintext)
    );
    const combined = new Uint8Array(iv.length + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), iv.length);
    return u8ToBase64(combined);
  }

  async function aesDecrypt(b64) {
    const key = await getAesKey();
    const combined = base64ToU8(b64);
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  }

  window.CryptoTools = {
    sha256, sha512,
    base64Encode, base64Decode,
    aesEncrypt, aesDecrypt
  };
})();