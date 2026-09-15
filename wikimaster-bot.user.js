// ==UserScript==
// @name         WikiMaster Bot
// @namespace    botwikimaster
// @version      2.0.0
// @description  Ouvre des packs de cartes et revend automatiquement ta collection aux enchères sur wiki-masters.com.
// @author       jeanbapt.bayle2
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_PREFIX = 'wmbot_';
    const RARITY_ORDER = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
    const DURATION_LABELS = { 10: '10 min', 30: '30 min', 60: '1 h', 180: '3 h', 360: '6 h', 720: '12 h', 1440: '24 h' };

    // ───────────────────────── Réglages persistés ─────────────────────────

    function getSetting(key, fallback) {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        if (raw === null) return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }
    function setSetting(key, value) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }
    function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    // ───────────────────────── Log partagé ─────────────────────────

    const logLines = [];
    let logEl = null;
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        logLines.push(`[${ts}] ${msg}`);
        if (logLines.length > 80) logLines.shift();
        if (logEl) logEl.innerHTML = [...logLines].reverse().map((l) => `<div>${l}</div>`).join('');
    }

    // Accès défensif : les endpoints du site renvoient parfois les champs "à plat",
    // parfois nichés sous `card` — jamais de garantie fixe entre deux versions du site.
    function cardTitle(c) {
        return c.wikipedia_title || c.title || c.name || (c.card && (c.card.wikipedia_title || c.card.title || c.card.name)) || '?';
    }
    function cardRarity(c) {
        return (c.rarity || (c.card && c.card.rarity) || '?').toUpperCase();
    }
    // Texte élargi pour le matching par mot-clé (titre + catégorie + description) : une
    // exclusion comme "triathlon" doit aussi attraper une carte dont le THÈME est le
    // triathlon même si le mot n'apparaît pas dans son titre exact.
    function cardSearchText(c) {
        const keys = ['wikipedia_title', 'title', 'name', 'category', 'categories', 'description', 'desc', 'summary', 'extract', 'wikipedia_extract'];
        const parts = [];
        const collect = (o) => {
            if (!o || typeof o !== 'object') return;
            for (const k of keys) {
                const v = o[k];
                if (typeof v === 'string') parts.push(v);
                else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
            }
        };
        collect(c);
        collect(c.card);
        return parts.join(' ').toLowerCase();
    }
    function cardId(c) {
        return c.card_id || (c.card && c.card.id) || null;
    }
    function userCardId(c) {
        return c.id || c.user_card_id || null;
    }

    /* ════════════════════════ Détection passive des favoris ════════════════════════
       Le site n'expose pas (à notre connaissance) le statut "favori/wishlist" dans
       l'API de collection. On ne le devine pas : on regarde passivement les requêtes
       que LE SITE LUI-MÊME envoie dès que tu consultes ta liste de souhaits, et on en
       extrait les identifiants de carte. Tant que tu n'as pas ouvert cette page au
       moins une fois dans la session, la liste reste vide — le panneau l'indique. */
    const WISHLIST_KEY = 'wishlist_ids';
    let wishlistIds = new Set(getSetting(WISHLIST_KEY, []));
    function saveWishlist() { setSetting(WISHLIST_KEY, [...wishlistIds]); }

    function scanForCardIds(obj, out, depth) {
        if (!obj || typeof obj !== 'object' || depth > 6) return;
        if (Array.isArray(obj)) { obj.forEach((o) => scanForCardIds(o, out, depth + 1)); return; }
        const id = obj.card_id || (obj.card && obj.card.id);
        if (id) out.add(id);
        for (const k of Object.keys(obj)) {
            if (obj[k] && typeof obj[k] === 'object') scanForCardIds(obj[k], out, depth + 1);
        }
    }

    function installWishlistSniffer() {
        const nativeFetch = window.fetch;
        window.fetch = async function (input, init) {
            const res = await nativeFetch.apply(this, arguments);
            try {
                const url = typeof input === 'string' ? input : input.url;
                if (url && /wishlist/i.test(url) && res.ok) {
                    const method = (init && init.method) || 'GET';
                    const clone = res.clone();
                    clone.json().then((data) => {
                        const before = wishlistIds.size;
                        if (/^delete$/i.test(method)) {
                            // Retrait : on ne peut identifier la carte que si l'appelant l'a
                            // mise dans le corps de la requête — best effort, jamais bloquant.
                            try {
                                const body = init && init.body ? JSON.parse(init.body) : null;
                                const id = body && (body.card_id || (body.card && body.card.id));
                                if (id) { wishlistIds.delete(id); saveWishlist(); log(`⭐ Favori retiré (détecté) : ${String(id).slice(0, 8)}…`); }
                            } catch (e) {}
                            return;
                        }
                        const found = new Set();
                        scanForCardIds(data, found, 0);
                        found.forEach((id) => wishlistIds.add(id));
                        if (wishlistIds.size !== before) { saveWishlist(); renderSellerStatus(); log(`⭐ Favoris détectés : ${wishlistIds.size} carte(s) au total.`); }
                    }).catch(() => {});
                }
            } catch (e) {}
            return res;
        };
    }

    /* ════════════════════════ Module 1 : Pack Opener ════════════════════════ */

    const OPEN_PACK_URL = 'https://www.wiki-masters.com/api/packs/open';
    let cooldownSeconds = getSetting('cooldown', 600);
    let packRunning = false;
    let packLoopEpoch = 0;
    const packStats = { packsOpened: 0, cardsOpened: 0, rarities: {} };

    async function openPack() {
        const res = await fetch(OPEN_PACK_URL, { method: 'POST', credentials: 'include' });
        if (res.status === 403) { const e = new Error('forbidden'); e.status = 403; throw e; }
        if (res.status === 429) { const e = new Error('rate_limited'); e.status = 429; throw e; }
        if (!res.ok) { const e = new Error(`http_${res.status}`); e.status = res.status; throw e; }
        return res.json();
    }

    function handlePackResult(data) {
        const cards = (data && data.cards) || (data && data.pack && data.pack.cards) || [];
        if (!cards.length) return { exhausted: true };
        packStats.packsOpened++;
        for (const c of cards) {
            packStats.cardsOpened++;
            const rarity = cardRarity(c);
            packStats.rarities[rarity] = (packStats.rarities[rarity] || 0) + 1;
            log(`🃏 ${cardTitle(c)} <span class="wmbot-rarity">${rarity}</span>`);
        }
        renderPackStats();
        const remaining = data.packs_remaining ?? data.remaining ?? null;
        return { exhausted: remaining === 0 };
    }

    async function packLoop(epoch) {
        const isCurrent = () => packRunning && epoch === packLoopEpoch;
        while (isCurrent()) {
            try {
                if (!navigator.onLine) { await sleep(5000); continue; }
                const data = await openPack();
                if (!isCurrent()) break;
                const { exhausted } = handlePackResult(data);
                if (exhausted) {
                    const endAt = Date.now() + cooldownSeconds * 1000;
                    while (isCurrent() && Date.now() < endAt) {
                        setPackStatus(`⏳ Prochain pack dans ${Math.max(0, Math.round((endAt - Date.now()) / 1000))}s`);
                        await sleep(1000);
                    }
                    continue;
                }
                setPackStatus('📦 Ouverture...');
                await sleep(1200 + Math.random() * 1800);
            } catch (err) {
                if (err.status === 403) { log('⛔ 403 — pause 60s'); setPackStatus('⛔ 403 — pause 60s'); await sleep(60000); }
                else if (err.status === 429) { log('⚠️ 429 — pause 30s'); setPackStatus('⚠️ Rate limit — pause 30s'); await sleep(30000); }
                else { log(`⚠️ Erreur pack (${err.message}) — retry 5s`); setPackStatus('⚠️ Erreur — retry 5s'); await sleep(5000); }
            }
        }
        setPackStatus(packRunning ? '' : '⏹ Arrêté');
    }

    function startPacks() {
        if (packRunning) return;
        packRunning = true;
        const epoch = ++packLoopEpoch;
        log('▶️ Démarrage du Pack Opener');
        packLoop(epoch);
        renderPackControls();
    }
    function stopPacks() {
        if (!packRunning) return;
        packRunning = false;
        log('⏸ Arrêt du Pack Opener');
        renderPackControls();
    }
    async function openOnce() {
        try {
            setPackStatus('📦 Ouverture...');
            handlePackResult(await openPack());
            setPackStatus('');
        } catch (err) {
            log(`⚠️ Ouverture manuelle échouée (${err.message})`);
            setPackStatus('');
        }
    }

    /* ════════════════════════ Module 2 : Vente aux enchères ════════════════════════ */

    const MARKETPLACE_URL = 'https://www.wiki-masters.com/api/marketplace';

    let sellRunning = false;
    let sellLoopEpoch = 0;
    const sellStats = { listed: 0, failed: 0, estimatedValue: 0, discarded: 0, discardedValue: 0 };
    const sellAttempted = new Set(); // évite de retraiter la même carte dans une même passe

    let sellMarginPct = getSetting('sellMarginPct', 110);
    let sellDuration = getSetting('sellDuration', 60);
    let sellExcludeRaw = getSetting('sellExcludeRaw', 'triathlon');
    let protectLegendary = getSetting('protectLegendary', true);
    let discardThreshold = getSetting('discardThreshold', 10);
    let rarityFloors = getSetting('rarityFloors', { L: 300, UR: 80, SR: 30, R: 10, PC: 3, C: 1 });

    function excludedKeywords() {
        return sellExcludeRaw.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
    }

    // ── Collection ──

    async function fetchCollectionAll(onProgress) {
        const limit = 50;
        const items = [];
        const first = await fetch(`https://www.wiki-masters.com/api/my-collection?page=0&limit=${limit}&sort=rarity`, { credentials: 'include' });
        if (!first.ok) throw new Error(`collection_http_${first.status}`);
        const firstData = await first.json();
        const firstItems = firstData.collection || [];
        items.push(...firstItems);
        const total = parseInt(firstData.total, 10);
        const totalKnown = Number.isFinite(total) && total >= firstItems.length && total > 0;
        const totalPages = totalKnown ? Math.ceil(total / limit) : 200; // garde-fou si total absent
        if (onProgress) onProgress(items.length, totalKnown ? total : null);

        for (let page = 1; page < totalPages; page++) {
            const res = await fetch(`https://www.wiki-masters.com/api/my-collection?page=${page}&limit=${limit}&sort=rarity`, { credentials: 'include' });
            if (!res.ok) break;
            const data = await res.json();
            const pageItems = data.collection || [];
            if (pageItems.length === 0) break;
            items.push(...pageItems);
            if (onProgress) onProgress(items.length, totalKnown ? total : null);
            if (pageItems.length < limit) break;
            await sleep(150); // évite de bombarder l'API sur une grosse collection
        }
        return items;
    }

    // ── Prix ──

    async function fetchMarketAvg(id) {
        try {
            const res = await fetch(`${MARKETPLACE_URL}/cards/${id}/sales`, { credentials: 'include' });
            if (!res.ok) return null;
            const data = await res.json();
            const prices = (data.sales || []).map((s) => s.final_price).filter((p) => Number.isFinite(p));
            if (!prices.length) return null;
            return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        } catch (e) { return null; }
    }

    async function computeSellPrice(rarity, id) {
        const avg = id ? await fetchMarketAvg(id) : null;
        if (avg && avg > 0) {
            return { price: Math.max(1, Math.round(avg * (sellMarginPct / 100))), source: 'market', avg };
        }
        const floor = rarityFloors[rarity] || 1;
        return { price: floor, source: 'floor' };
    }

    // ── Vente : API en priorité, repli sur clic simulé sur /collection ──

    async function sellViaApi(id, price, duration) {
        try {
            const res = await fetch(MARKETPLACE_URL, {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ card_id: id, base_amount: price, duration_minutes: duration }),
            });
            if (!res.ok) return { ok: false };
            const data = await res.json().catch(() => ({}));
            return { ok: true, auctionId: data.auction_id || null };
        } catch (e) { return { ok: false }; }
    }

    function setReactInputValue(el, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function findLeafByExactText(text) {
        for (const el of document.querySelectorAll('*')) {
            if (el.children.length === 0 && el.textContent.trim() === text) return el;
        }
        return null;
    }
    // "includes" plutôt qu'une égalité stricte : les boutons du site combinent souvent
    // icône + texte + badge (ex: "🗑️ Défausser ⊙+1"), jamais juste le libellé seul.
    function findButtonByText(text) {
        return [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text)) || null;
    }
    async function ensureOnCollectionPage() {
        if (location.pathname.startsWith('/collection')) return true;
        const backBtn = findButtonByText('Retour au marché');
        if (backBtn) {
            backBtn.click();
            for (let i = 0; i < 20; i++) {
                await sleep(150);
                if (location.pathname.startsWith('/collection')) return true;
            }
        }
        return location.pathname.startsWith('/collection');
    }

    // Recherche une carte par titre sur /collection et ouvre sa fiche (clic sur la tuile).
    // Factorisé entre sellViaUI et discardViaUI : les deux actions partent du même écran.
    async function openCardTile(title) {
        if (!(await ensureOnCollectionPage())) return { ok: false, reason: 'wrong_page' };

        const searchInput = document.querySelector('input[placeholder="Rechercher par titre ou catégorie..."]');
        if (!searchInput) return { ok: false, reason: 'no_search_input' };
        setReactInputValue(searchInput, title);

        let tile = null;
        for (let i = 0; i < 20 && !tile; i++) {
            await sleep(250);
            const titleEl = findLeafByExactText(title);
            if (!titleEl) continue;
            let candidate = titleEl;
            while (candidate && !candidate.classList.contains('cursor-pointer')) candidate = candidate.parentElement;
            if (candidate) tile = candidate;
        }
        if (!tile) return { ok: false, reason: 'card_not_found' };
        tile.click();
        await sleep(600);
        return { ok: true };
    }

    async function discardViaUI(title) {
        const opened = await openCardTile(title);
        if (!opened.ok) return opened;

        const discardBtn = findButtonByText('Défausser');
        if (!discardBtn) return { ok: false, reason: 'no_discard_button' };
        discardBtn.click();
        await sleep(600); // immédiat, pas de pop-up de confirmation à gérer

        const nextSearch = document.querySelector('input[placeholder="Rechercher par titre ou catégorie..."]');
        if (nextSearch) setReactInputValue(nextSearch, '');
        return { ok: true };
    }

    async function sellViaUI(title, price, duration) {
        const opened = await openCardTile(title);
        if (!opened.ok) return opened;

        const sellBtn = findButtonByText('Mettre aux enchères');
        if (!sellBtn) return { ok: false, reason: 'no_sell_button' };
        sellBtn.click();
        await sleep(500);

        const priceInput = document.querySelector('input[aria-label="Mise de départ"]');
        if (priceInput) setReactInputValue(priceInput, String(Math.max(1, Math.round(price))));

        const durBtn = DURATION_LABELS[duration] && findButtonByText(DURATION_LABELS[duration]);
        if (durBtn) durBtn.click();
        await sleep(200);

        const launchBtn = findButtonByText("Lancer l'enchère");
        if (!launchBtn) return { ok: false, reason: 'no_launch_button' };
        launchBtn.click();
        await sleep(900);

        if (document.body.contains(launchBtn)) return { ok: false, reason: 'refused' };

        await ensureOnCollectionPage();
        const nextSearch = document.querySelector('input[placeholder="Rechercher par titre ou catégorie..."]');
        if (nextSearch) setReactInputValue(nextSearch, '');
        return { ok: true };
    }

    // ── Boucle principale du vendeur ──

    function buildSellQueue(items) {
        const excluded = excludedKeywords();
        return items.filter((item) => {
            const id = cardId(item);
            if (!id) return false;
            if (wishlistIds.has(id)) return false;
            if (protectLegendary && cardRarity(item) === 'L') return false;
            const text = cardSearchText(item);
            if (excluded.some((kw) => text.includes(kw))) return false;
            return true;
        });
    }

    async function sellLoop(epoch) {
        const isCurrent = () => sellRunning && epoch === sellLoopEpoch;
        const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

        while (isCurrent()) {
            try {
                setSellStatus('📚 Analyse de la collection...');
                const items = await fetchCollectionAll((loaded) => setSellStatus(`📚 Collection : ${loaded} cartes chargées...`));
                if (!isCurrent()) break;

                const queue = buildSellQueue(items).filter((item) => !sellAttempted.has(userCardId(item) || cardId(item)));
                log(`💰 ${queue.length} carte(s) à mettre en vente (favoris et exclusions écartés).`);

                for (const item of queue) {
                    if (!isCurrent()) break;
                    const id = cardId(item);
                    const title = cardTitle(item);
                    const rarity = cardRarity(item);
                    const key = userCardId(item) || id;
                    sellAttempted.add(key);

                    const priceInfo = await computeSellPrice(rarity, id);

                    // Aucune vente connue sur le marché pour cette carte + rareté C/PC :
                    // personne ne l'achète jamais à ce niveau de rareté, pas la peine
                    // d'immobiliser un slot d'enchère → défausse directe.
                    const noHistoryCommon = priceInfo.source === 'floor' && (rarity === 'C' || rarity === 'PC');

                    // Sous le seuil : l'enchère rapporterait moins que la défausse (1 💰
                    // garanti, immédiat) et risque en plus de ne trouver aucun acheteur.
                    if (priceInfo.price < discardThreshold || noHistoryCommon) {
                        setSellStatus(`🗑️ Défausse : ${title}...`);
                        const result = await discardViaUI(title);
                        if (result.ok) {
                            sellStats.discarded++;
                            sellStats.discardedValue += 1;
                            const why = noHistoryCommon
                                ? `aucune vente connue, rareté ${rarity}`
                                : `prix ${priceInfo.price} 💰 < seuil ${discardThreshold}`;
                            log(`🗑️ Défaussé (${why}) : <b>${title}</b> [${rarity}] · +1 💰`);
                        } else {
                            sellStats.failed++;
                            log(`❌ Échec défausse : <b>${title}</b> [${rarity}] · ${result.reason || '?'}`);
                            if (result.reason === 'wrong_page') {
                                log('⚠️ Reste sur la page /collection pour que la vente/défausse automatique fonctionne.');
                                break;
                            }
                        }
                        renderSellStats();
                        await sleep(1200 + Math.random() * 1800);
                        continue;
                    }

                    setSellStatus(`🏷️ Mise en vente : ${title}...`);

                    let result = await sellViaApi(id, priceInfo.price, sellDuration);
                    if (!result.ok) {
                        result = await sellViaUI(title, priceInfo.price, sellDuration);
                    }

                    if (result.ok) {
                        sellStats.listed++;
                        sellStats.estimatedValue += priceInfo.price;
                        const src = priceInfo.source === 'market' ? ` (marché ${priceInfo.avg} × ${sellMarginPct}%)` : ' (barème rareté, pas d\'historique)';
                        log(`✅ Vendu : <b>${title}</b> [${rarity}] · ${priceInfo.price} 💰${src}`);
                    } else {
                        sellStats.failed++;
                        log(`❌ Échec vente : <b>${title}</b> [${rarity}] · ${result.reason || '?'}`);
                        if (result.reason === 'wrong_page') {
                            log('⚠️ Reste sur la page /collection pour que la vente automatique fonctionne.');
                            break;
                        }
                    }
                    renderSellStats();
                    await sleep(1200 + Math.random() * 1800);
                }

                if (!isCurrent()) break;
                setSellStatus(`⏳ Prochaine analyse dans ${REFRESH_INTERVAL_MS / 60000} min...`);
                const endAt = Date.now() + REFRESH_INTERVAL_MS;
                while (isCurrent() && Date.now() < endAt) await sleep(1000);
            } catch (err) {
                log(`⚠️ Erreur vendeur (${err.message}) — retry 10s`);
                await sleep(10000);
            }
        }
        setSellStatus(sellRunning ? '' : '⏹ Arrêté');
    }

    function startSelling() {
        if (sellRunning) return;
        if (wishlistIds.size === 0) {
            log('⚠️ Aucun favori détecté pour l\'instant — ouvre ta page Liste de souhaits sur le site si tu veux protéger certaines cartes, sinon tout ce qui n\'est pas exclu manuellement sera vendable.');
        }
        sellRunning = true;
        sellAttempted.clear();
        const epoch = ++sellLoopEpoch;
        log('▶️ Démarrage de la Vente aux enchères');
        sellLoop(epoch);
        renderSellControls();
    }
    function stopSelling() {
        if (!sellRunning) return;
        sellRunning = false;
        log('⏸ Arrêt de la Vente aux enchères');
        renderSellControls();
    }

    /* ════════════════════════ UI ════════════════════════ */

    let els = {};

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #wmbot-toggle {
                position: fixed; bottom: 20px; right: 20px; z-index: 999999;
                width: 44px; height: 44px; border-radius: 50%; border: none;
                background: #6d28d9; color: #fff; font-size: 20px; cursor: pointer;
                box-shadow: 0 2px 8px rgba(0,0,0,.3);
            }
            #wmbot-panel {
                position: fixed; bottom: 74px; right: 20px; z-index: 999999;
                width: 340px; max-height: 80vh; overflow-y: auto;
                background: #1e1b2e; color: #eee; font: 12px/1.4 system-ui, sans-serif;
                border-radius: 10px; padding: 14px; box-shadow: 0 4px 20px rgba(0,0,0,.4);
                display: none;
            }
            #wmbot-panel.open { display: block; }
            .wmbot-section { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid #333; }
            .wmbot-section:last-of-type { border-bottom: none; }
            .wmbot-section h3 { margin: 0 0 10px; font-size: 14px; }
            .wmbot-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; flex-wrap: wrap; }
            .wmbot-row label { color: #bbb; }
            button.wmbot-btn { cursor: pointer; border: none; border-radius: 6px; padding: 6px 10px; font-size: 12px; }
            .wmbot-start { background: #16a34a; color: #fff; flex: 1; }
            .wmbot-start.running { background: #dc2626; }
            .wmbot-once { background: #4b5563; color: #fff; }
            #wmbot-panel input[type=number], #wmbot-panel input[type=text], #wmbot-panel select {
                background: #2a2640; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 3px 6px;
            }
            #wmbot-panel input[type=number] { width: 60px; }
            #wmbot-panel input[type=text] { width: 100%; }
            .wmbot-rarity-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
            .wmbot-rarity-grid label { font-size: 10px; color: #999; display: block; }
            .wmbot-status { color: #a78bfa; min-height: 16px; }
            .wmbot-stats { margin: 8px 0; padding: 8px; background: #2a2640; border-radius: 6px; }
            #wmbot-log { max-height: 200px; overflow-y: auto; font-size: 11px; color: #ccc; padding-top: 6px; }
            #wmbot-log div { padding: 1px 0; }
            .wmbot-rarity { color: #fbbf24; font-weight: bold; }
        `;
        document.head.appendChild(style);
    }

    function buildUI() {
        const toggle = document.createElement('button');
        toggle.id = 'wmbot-toggle';
        toggle.textContent = '📦';
        toggle.title = 'WikiMaster Bot';
        document.body.appendChild(toggle);

        const panel = document.createElement('div');
        panel.id = 'wmbot-panel';
        panel.innerHTML = `
            <div class="wmbot-section">
                <h3>📦 Pack Opener</h3>
                <div class="wmbot-row">
                    <button class="wmbot-btn wmbot-start" id="wmbot-pack-start">▶️ Démarrer</button>
                    <button class="wmbot-btn wmbot-once" id="wmbot-pack-once">Ouvrir 1 pack</button>
                </div>
                <div class="wmbot-row">
                    <label for="wmbot-cooldown">Cooldown (s)</label>
                    <input type="number" id="wmbot-cooldown" min="1" value="${cooldownSeconds}">
                </div>
                <div class="wmbot-status" id="wmbot-pack-status"></div>
                <div class="wmbot-stats" id="wmbot-pack-stats"></div>
            </div>

            <div class="wmbot-section">
                <h3>💰 Vente aux enchères</h3>
                <div class="wmbot-row">
                    <button class="wmbot-btn wmbot-start" id="wmbot-sell-start">▶️ Démarrer</button>
                </div>
                <div class="wmbot-row">
                    <label for="wmbot-margin">Marge sur prix marché (%)</label>
                    <input type="number" id="wmbot-margin" min="1" value="${sellMarginPct}">
                </div>
                <div class="wmbot-row">
                    <label for="wmbot-duration">Durée d'enchère</label>
                    <select id="wmbot-duration">
                        ${Object.entries(DURATION_LABELS).map(([v, l]) => `<option value="${v}" ${Number(v) === sellDuration ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </div>
                <div class="wmbot-row"><label>Prix plancher par rareté (si aucun historique marché)</label></div>
                <div class="wmbot-rarity-grid" id="wmbot-floors"></div>
                <div class="wmbot-row">
                    <label for="wmbot-protect-l">🛡️ Ne jamais vendre les Légendaires (L)</label>
                    <input type="checkbox" id="wmbot-protect-l" ${protectLegendary ? 'checked' : ''}>
                </div>
                <div class="wmbot-row">
                    <label for="wmbot-discard-threshold">🗑️ Défausser si prix &lt; (💰)</label>
                    <input type="number" id="wmbot-discard-threshold" min="0" value="${discardThreshold}">
                </div>
                <div class="wmbot-row" style="flex-direction: column; align-items: stretch;">
                    <label for="wmbot-exclude">Mots-clés à toujours exclure (titre, catégorie ou description — séparés par ;)</label>
                    <input type="text" id="wmbot-exclude" placeholder="Ex: triathlon;Carte A" value="${sellExcludeRaw.replace(/"/g, '&quot;')}">
                </div>
                <div class="wmbot-status" id="wmbot-sell-status"></div>
                <div class="wmbot-stats" id="wmbot-sell-stats"></div>
            </div>

            <div id="wmbot-log"></div>
        `;
        document.body.appendChild(panel);
        logEl = panel.querySelector('#wmbot-log');

        els = {
            toggle, panel,
            packStart: panel.querySelector('#wmbot-pack-start'),
            packOnce: panel.querySelector('#wmbot-pack-once'),
            cooldown: panel.querySelector('#wmbot-cooldown'),
            packStatus: panel.querySelector('#wmbot-pack-status'),
            packStats: panel.querySelector('#wmbot-pack-stats'),
            sellStart: panel.querySelector('#wmbot-sell-start'),
            margin: panel.querySelector('#wmbot-margin'),
            duration: panel.querySelector('#wmbot-duration'),
            floors: panel.querySelector('#wmbot-floors'),
            protectL: panel.querySelector('#wmbot-protect-l'),
            discardThreshold: panel.querySelector('#wmbot-discard-threshold'),
            exclude: panel.querySelector('#wmbot-exclude'),
            sellStatus: panel.querySelector('#wmbot-sell-status'),
            sellStats: panel.querySelector('#wmbot-sell-stats'),
        };

        els.floors.innerHTML = RARITY_ORDER.map((r) => `
            <label>${r}
                <input type="number" min="1" data-rarity="${r}" class="wmbot-floor-input" value="${rarityFloors[r]}">
            </label>
        `).join('');

        toggle.onclick = () => panel.classList.toggle('open');
        els.packStart.onclick = () => (packRunning ? stopPacks() : startPacks());
        els.packOnce.onclick = () => openOnce();
        els.cooldown.onchange = () => {
            cooldownSeconds = Math.max(1, parseInt(els.cooldown.value, 10) || cooldownSeconds);
            setSetting('cooldown', cooldownSeconds);
        };

        els.sellStart.onclick = () => (sellRunning ? stopSelling() : startSelling());
        els.margin.onchange = () => {
            sellMarginPct = Math.max(1, parseInt(els.margin.value, 10) || sellMarginPct);
            setSetting('sellMarginPct', sellMarginPct);
        };
        els.duration.onchange = () => {
            sellDuration = parseInt(els.duration.value, 10);
            setSetting('sellDuration', sellDuration);
        };
        els.exclude.onchange = () => {
            sellExcludeRaw = els.exclude.value;
            setSetting('sellExcludeRaw', sellExcludeRaw);
        };
        els.protectL.onchange = () => {
            protectLegendary = els.protectL.checked;
            setSetting('protectLegendary', protectLegendary);
            log(protectLegendary ? '🛡️ Protection des Légendaires activée.' : '⚠️ Protection des Légendaires désactivée.');
        };
        els.discardThreshold.onchange = () => {
            discardThreshold = Math.max(0, parseInt(els.discardThreshold.value, 10) || 0);
            setSetting('discardThreshold', discardThreshold);
        };
        panel.querySelectorAll('.wmbot-floor-input').forEach((input) => {
            input.onchange = () => {
                const r = input.dataset.rarity;
                rarityFloors[r] = Math.max(1, parseInt(input.value, 10) || rarityFloors[r]);
                setSetting('rarityFloors', rarityFloors);
            };
        });

        renderPackControls();
        renderPackStats();
        renderSellControls();
        renderSellStats();
        renderSellerStatus();
    }

    function renderPackControls() {
        if (!els.packStart) return;
        els.packStart.textContent = packRunning ? '⏹ Arrêter' : '▶️ Démarrer';
        els.packStart.classList.toggle('running', packRunning);
    }
    function setPackStatus(text) { if (els.packStatus) els.packStatus.textContent = text; }
    function renderPackStats() {
        if (!els.packStats) return;
        const rarityLine = RARITY_ORDER.filter((r) => packStats.rarities[r]).map((r) => `${r}: ${packStats.rarities[r]}`).join(' · ') || '—';
        els.packStats.innerHTML = `Packs ouverts : <b>${packStats.packsOpened}</b><br>Cartes obtenues : <b>${packStats.cardsOpened}</b><br>Raretés : ${rarityLine}`;
    }

    function renderSellControls() {
        if (!els.sellStart) return;
        els.sellStart.textContent = sellRunning ? '⏹ Arrêter' : '▶️ Démarrer';
        els.sellStart.classList.toggle('running', sellRunning);
    }
    function setSellStatus(text) { if (els.sellStatus) els.sellStatus.textContent = text; }
    function renderSellStats() {
        if (!els.sellStats) return;
        els.sellStats.innerHTML = `Cartes mises en vente : <b>${sellStats.listed}</b><br>Cartes défaussées : <b>${sellStats.discarded}</b><br>Échecs : <b>${sellStats.failed}</b><br>Valeur totale estimée : <b>${sellStats.estimatedValue + sellStats.discardedValue} 💰</b>`;
    }
    function renderSellerStatus() {
        renderSellStats();
    }

    /* ════════════════════════ Init ════════════════════════ */

    function init() {
        injectStyles();
        buildUI();
        installWishlistSniffer();
        log('🤖 WikiMaster Bot chargé. Reste sur cet onglet pendant les ouvertures et ventes.');
        if (wishlistIds.size > 0) log(`⭐ ${wishlistIds.size} favori(s) déjà connus depuis une session précédente.`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
