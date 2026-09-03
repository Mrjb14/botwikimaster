// ==UserScript==
// @name         WikiMaster Pack Opener
// @namespace    botwikimaster
// @version      1.0.0
// @description  Ouvre automatiquement des packs de cartes sur wiki-masters.com, en respectant le cooldown du compte.
// @author       jeanbapt.bayle2
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const OPEN_PACK_URL = 'https://www.wiki-masters.com/api/packs/open';
    const STORAGE_PREFIX = 'wmpo_';
    const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

    // ───────────────────────── Réglages persistés ─────────────────────────

    function getSetting(key, fallback) {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        if (raw === null) return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }
    function setSetting(key, value) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }

    // Cooldown entre packs quand le compte n'a plus de pack disponible.
    // 180s pour un compte abonné, 600s pour un compte gratuit — ajustable dans l'UI.
    let cooldownSeconds = getSetting('cooldown', 600);

    // ───────────────────────── État de session ─────────────────────────

    let running = false;
    let loopEpoch = 0; // invalide toute boucle précédente après un stop/restart
    const stats = { packsOpened: 0, cardsOpened: 0, rarities: {} };
    const logLines = [];

    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        logLines.push(`[${ts}] ${msg}`);
        if (logLines.length > 50) logLines.shift();
        renderLog();
    }

    // ───────────────────────── Appel réseau ─────────────────────────

    // Tourne dans l'onglet connecté au site : credentials:'include' réutilise
    // le cookie de session du navigateur, pas de gestion d'identifiants ici.
    async function openPack() {
        const res = await fetch(OPEN_PACK_URL, { method: 'POST', credentials: 'include' });
        if (res.status === 403) {
            const err = new Error('forbidden');
            err.status = 403;
            throw err;
        }
        if (res.status === 429) {
            const err = new Error('rate_limited');
            err.status = 429;
            throw err;
        }
        if (!res.ok) {
            const err = new Error(`http_${res.status}`);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }

    function cardTitle(c) {
        return c.wikipedia_title || c.title || c.name || (c.card && (c.card.wikipedia_title || c.card.title)) || '?';
    }
    function cardRarity(c) {
        return (c.rarity || (c.card && c.card.rarity) || '?').toUpperCase();
    }

    function handlePackResult(data) {
        const cards = (data && data.cards) || (data && data.pack && data.pack.cards) || [];
        if (!cards.length) return { cards, exhausted: true };

        stats.packsOpened++;
        for (const c of cards) {
            stats.cardsOpened++;
            const rarity = cardRarity(c);
            stats.rarities[rarity] = (stats.rarities[rarity] || 0) + 1;
            log(`🃏 ${cardTitle(c)} <span class="wmpo-rarity">${rarity}</span>`);
        }
        renderStats();

        const remaining = data.packs_remaining ?? data.remaining ?? null;
        return { cards, exhausted: remaining === 0 };
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ───────────────────────── Boucle principale ─────────────────────────

    async function loop(epoch) {
        const isCurrent = () => running && epoch === loopEpoch;

        while (isCurrent()) {
            try {
                if (!navigator.onLine) {
                    await sleep(5000);
                    continue;
                }

                const data = await openPack();
                if (!isCurrent()) break;

                const { exhausted } = handlePackResult(data);

                if (exhausted) {
                    setStatus(`⏳ Cooldown : ${cooldownSeconds}s`);
                    const endAt = Date.now() + cooldownSeconds * 1000;
                    while (isCurrent() && Date.now() < endAt) {
                        const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000));
                        setStatus(`⏳ Prochain pack dans ${remaining}s`);
                        await sleep(1000);
                    }
                    continue;
                }

                // Petit délai humanisé entre deux ouvertures pour ne pas spammer l'API.
                setStatus('📦 Ouverture...');
                await sleep(1200 + Math.random() * 1800);

            } catch (err) {
                if (err.status === 403) {
                    log('⛔ 403 — pause 60s (compte non identifié ou action refusée)');
                    setStatus('⛔ 403 — pause 60s');
                    await sleep(60000);
                } else if (err.status === 429) {
                    log('⚠️ 429 — rate limit, pause 30s');
                    setStatus('⚠️ Rate limit — pause 30s');
                    await sleep(30000);
                } else {
                    log(`⚠️ Erreur réseau (${err.message}) — nouvelle tentative dans 5s`);
                    setStatus('⚠️ Erreur — retry 5s');
                    await sleep(5000);
                }
            }
        }
        setStatus(running ? '' : '⏹ Arrêté');
    }

    function start() {
        if (running) return;
        running = true;
        const epoch = ++loopEpoch;
        log('▶️ Démarrage du Pack Opener');
        loop(epoch);
        renderControls();
    }

    function stop() {
        if (!running) return;
        running = false;
        log('⏸ Arrêt du Pack Opener');
        renderControls();
    }

    async function openOnce() {
        try {
            setStatus('📦 Ouverture...');
            const data = await openPack();
            handlePackResult(data);
            setStatus('');
        } catch (err) {
            log(`⚠️ Ouverture manuelle échouée (${err.message})`);
            setStatus('');
        }
    }

    // ───────────────────────── UI flottante ─────────────────────────

    let els = {};

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #wmpo-toggle {
                position: fixed; bottom: 20px; right: 20px; z-index: 999999;
                width: 44px; height: 44px; border-radius: 50%; border: none;
                background: #6d28d9; color: #fff; font-size: 20px; cursor: pointer;
                box-shadow: 0 2px 8px rgba(0,0,0,.3);
            }
            #wmpo-panel {
                position: fixed; bottom: 74px; right: 20px; z-index: 999999;
                width: 320px; max-height: 70vh; overflow-y: auto;
                background: #1e1b2e; color: #eee; font: 12px/1.4 system-ui, sans-serif;
                border-radius: 10px; padding: 14px; box-shadow: 0 4px 20px rgba(0,0,0,.4);
                display: none;
            }
            #wmpo-panel.open { display: block; }
            #wmpo-panel h3 { margin: 0 0 10px; font-size: 14px; }
            #wmpo-panel .wmpo-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; }
            #wmpo-panel button { cursor: pointer; border: none; border-radius: 6px; padding: 6px 10px; font-size: 12px; }
            #wmpo-start { background: #16a34a; color: #fff; flex: 1; }
            #wmpo-start.running { background: #dc2626; }
            #wmpo-once { background: #4b5563; color: #fff; }
            #wmpo-panel input[type=number] { width: 70px; background: #2a2640; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 6px; }
            #wmpo-status { color: #a78bfa; min-height: 16px; }
            #wmpo-stats { margin: 8px 0; padding: 8px; background: #2a2640; border-radius: 6px; }
            #wmpo-log { max-height: 200px; overflow-y: auto; font-size: 11px; color: #ccc; border-top: 1px solid #333; padding-top: 6px; margin-top: 8px; }
            #wmpo-log div { padding: 1px 0; }
            .wmpo-rarity { color: #fbbf24; font-weight: bold; }
        `;
        document.head.appendChild(style);
    }

    function buildUI() {
        const toggle = document.createElement('button');
        toggle.id = 'wmpo-toggle';
        toggle.textContent = '📦';
        toggle.title = 'WikiMaster Pack Opener';
        document.body.appendChild(toggle);

        const panel = document.createElement('div');
        panel.id = 'wmpo-panel';
        panel.innerHTML = `
            <h3>📦 Pack Opener</h3>
            <div class="wmpo-row">
                <button id="wmpo-start">▶️ Démarrer</button>
                <button id="wmpo-once">Ouvrir 1 pack</button>
            </div>
            <div class="wmpo-row">
                <label for="wmpo-cooldown">Cooldown (s)</label>
                <input type="number" id="wmpo-cooldown" min="1" value="${cooldownSeconds}">
            </div>
            <div id="wmpo-status"></div>
            <div id="wmpo-stats"></div>
            <div id="wmpo-log"></div>
        `;
        document.body.appendChild(panel);

        els = {
            toggle, panel,
            start: panel.querySelector('#wmpo-start'),
            once: panel.querySelector('#wmpo-once'),
            cooldown: panel.querySelector('#wmpo-cooldown'),
            status: panel.querySelector('#wmpo-status'),
            stats: panel.querySelector('#wmpo-stats'),
            log: panel.querySelector('#wmpo-log'),
        };

        toggle.onclick = () => panel.classList.toggle('open');
        els.start.onclick = () => (running ? stop() : start());
        els.once.onclick = () => openOnce();
        els.cooldown.onchange = () => {
            const v = Math.max(1, parseInt(els.cooldown.value, 10) || cooldownSeconds);
            cooldownSeconds = v;
            setSetting('cooldown', v);
        };

        renderControls();
        renderStats();
        renderLog();
    }

    function renderControls() {
        if (!els.start) return;
        els.start.textContent = running ? '⏹ Arrêter' : '▶️ Démarrer';
        els.start.classList.toggle('running', running);
    }

    function setStatus(text) {
        if (els.status) els.status.textContent = text;
    }

    function renderStats() {
        if (!els.stats) return;
        const rarityLine = RARITY_ORDER
            .filter((r) => stats.rarities[r])
            .map((r) => `${r}: ${stats.rarities[r]}`)
            .join(' · ') || '—';
        els.stats.innerHTML = `
            Packs ouverts : <b>${stats.packsOpened}</b><br>
            Cartes obtenues : <b>${stats.cardsOpened}</b><br>
            Raretés : ${rarityLine}
        `;
    }

    function renderLog() {
        if (!els.log) return;
        els.log.innerHTML = [...logLines].reverse().map((l) => `<div>${l}</div>`).join('');
    }

    // ───────────────────────── Init ─────────────────────────

    function init() {
        injectStyles();
        buildUI();
        log('🤖 WikiMaster Pack Opener chargé. Reste sur cet onglet pendant les ouvertures.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
