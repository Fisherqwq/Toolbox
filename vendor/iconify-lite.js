/**
 * iconify-lite —— <iconify-icon icon="mdi:xxx"> 的本地实现。
 *
 * 为什么自己写：原先页面从 code.iconify.design 加载 iconify-icon 脚本，
 * 断网时图标全部消失（按钮上会出现空白块）。这里只做本站用到的 13 个图标，
 * 用内联 sprite + <use> 渲染，零网络请求。
 *
 * 用法与原来完全一致： <iconify-icon icon="mdi:storefront-outline" class="logo-mark"></iconify-icon>
 * 尺寸：跟随 font-size（1em），颜色：跟随 currentColor，与 Iconify 默认行为一致。
 */
(function () {
  'use strict';
  var SPRITE = 'vendor/icons/mdi-sprite.svg';
  var loaded = null;

  function iconId(name) {
    return 'mdi-' + String(name || '').replace(/^mdi:/, '');
  }

  function ensureSprite() {
    if (loaded) return loaded;
    loaded = fetch(SPRITE, { cache: 'force-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var box = document.createElement('div');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        box.innerHTML = text;
        document.body.appendChild(box);
        return true;
      })
      .catch(function (err) {
        console.warn('[iconify-lite] 图标精灵图加载失败:', err.message);
        loaded = null;
        return false;
      });
    return loaded;
  }

  var IconLite = function () {
    var self = Reflect.construct(HTMLElement, [], IconLite);
    return self;
  };
  IconLite.prototype = Object.create(HTMLElement.prototype);
  IconLite.prototype.constructor = IconLite;
  Object.setPrototypeOf(IconLite, HTMLElement);

  function render(el) {
    var name = el.getAttribute('icon');
    if (!name) return;
    var id = iconId(name);
    ensureSprite().then(function (ok) {
      if (!ok) return;
      if (!document.getElementById(id)) {
        console.warn('[iconify-lite] sprite 里没有这个图标:', name);
        return;
      }
      el.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" ' +
        'style="display:inline-block;vertical-align:-0.125em"><use href="#' + id + '"></use></svg>';
    });
  }

  IconLite.prototype.connectedCallback = function () { render(this); };
  IconLite.prototype.attributeChangedCallback = function () { render(this); };
  IconLite.observedAttributes = ['icon'];

  if (!customElements.get('iconify-icon')) {
    customElements.define('iconify-icon', IconLite);
  }
})();
