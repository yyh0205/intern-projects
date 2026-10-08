// ==UserScript==
// @name         脉脉一键沟通
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  自动点击脉脉人才页面的沟通按钮并发送话术
// @author       Nia
// @match        https://maimai.cn/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 修改下面这行话术即可
    const TALK_TEXT = '您好呀，我是小红书HR Nia，我对您的过往经历很感兴趣，我们目前有个岗位很契合，方便open聊聊吗～';

    const DELAY = 2000;

    function init() {
        const targets = [...document.querySelectorAll('div.mui-btn-primary')].filter(b =>
            b.innerText.trim() === '立即沟通'
        );

        if (targets.length === 0) {
            setTimeout(init, 1000);
            return;
        }

        const old = document.getElementById('nia-maimai-btn');
        if (old) old.remove();

        const btn = document.createElement('button');
        btn.id = 'nia-maimai-btn';
        btn.innerText = '🚀 一键沟通(' + targets.length + ')';
        btn.style.cssText = 'position:fixed;bottom:40px;right:40px;z-index:99999;background:#FF2442;color:white;border:none;border-radius:24px;padding:12px 24px;font-size:15px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2)';
        document.body.appendChild(btn);

        btn.addEventListener('click', async () => {
            btn.innerText = '⏳ 进行中...';
            btn.disabled = true;
            let count = 0;

            for (const target of targets) {
                target.click();
                await new Promise(r => setTimeout(r, DELAY));

                const input = document.querySelector('textarea');
                if (input) {
                    input.focus();
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                    setter.set.call(input, TALK_TEXT);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 800));

                    const sendBtn = document.querySelector('button[class*="mbutton_m_fixed_blue450"]');
                    if (sendBtn) {
                        sendBtn.click();
                        count++;
                    }
                    await new Promise(r => setTimeout(r, DELAY));

                    const closeBtn = document.querySelector('.modal-close, [aria-label="关闭"], .icon-close, .close');
                    if (closeBtn) closeBtn.click();
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            btn.innerText = '✅ 已发送 ' + count + ' 条';
        });
    }

    setTimeout(init, 2000);
})();
