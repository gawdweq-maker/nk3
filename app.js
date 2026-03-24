import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://juqibbkgfcefroggwbjb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_gOmRcvLoj3VBaraUnRcBhw_frmRiGl6';

const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const FAVORITES_STORAGE_KEY = 'marketplace_menu_favorites';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  activeTab: 'favorites',
  search: '',
  items: [],
  favorites: new Set(loadFavorites()),
  parseRunning: false,
  categoryByItemId: {},
  logs: []
};

const els = {
  tabs: Array.from(document.querySelectorAll('.tab')),
  searchInput: document.getElementById('searchInput'),
  refreshButton: document.getElementById('refreshButton'),
  clearLogsButton: document.getElementById('clearLogsButton'),
  statusBar: document.getElementById('statusBar'),
  favoritesView: document.getElementById('favoritesView'),
  libraryView: document.getElementById('libraryView'),
  favoritesGrid: document.getElementById('favoritesGrid'),
  libraryGrid: document.getElementById('libraryGrid'),
  favoritesEmpty: document.getElementById('favoritesEmpty'),
  libraryEmpty: document.getElementById('libraryEmpty'),
  logsPanel: document.getElementById('logsPanel')
};

init();

async function init() {
  bindEvents();
  await fullRestart();
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });

  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      state.search = e.target.value.trim().toLowerCase();
      render();
    });
  }

  if (els.refreshButton) {
    els.refreshButton.addEventListener('click', async () => {
      await fullRestart();
    });
  }

  if (els.clearLogsButton) {
    els.clearLogsButton.addEventListener('click', () => {
      state.logs = [];
      renderLogs();
      log('UI', 'Логи очищены');
    });
  }
}

async function fullRestart() {
  state.items = [];
  state.categoryByItemId = {};
  setStatus('Старт...');
  render();

  log('BOOT', 'Начало полной перезагрузки');

  await testSupabaseRead();
  await progressiveBuildFromGlist();
}

async function testSupabaseRead() {
  try {
    log('DB', 'Проверка доступа к таблице items_catalog');

    const { data, error } = await supabase
      .from('items_catalog')
      .select('item_id, category, name, price, updated_at')
      .limit(1);

    if (error) {
      logError('DB', 'Ошибка тестового чтения Supabase', error);
      return;
    }

    log('DB', 'Тестовое чтение Supabase успешно', {
      rows: data?.length || 0,
      data
    });
  } catch (error) {
    logError('DB', 'Критическая ошибка тестового чтения Supabase', error);
  }
}

async function progressiveBuildFromGlist() {
  if (state.parseRunning) {
    log('BOOT', 'Парсинг уже запущен, пропуск');
    return;
  }

  state.parseRunning = true;

  try {
    setStatus('Загрузка glist...');
    log('GLIST', 'Запрос glist', { url: GLIST_URL });

    const response = await fetch(GLIST_URL);
    log('GLIST', 'Ответ glist', { status: response.status, ok: response.ok });

    if (!response.ok) {
      throw new Error(`glist HTTP ${response.status}`);
    }

    const raw = await response.json();
    const queue = normalizeGlistToQueue(raw);

    log('GLIST', 'glist разобран', { total: queue.length });
    setStatus(`glist загружен. Элементов: ${queue.length}. Начинаю поэтапное создание...`);

    for (let i = 0; i < queue.length; i++) {
      const baseItem = queue[i];

      createOrReplaceLocalItem(baseItem);
      render();

      log('ITEM', 'Создан базовый блок', {
        itemId: baseItem.itemId,
        category: baseItem.category,
        index: i + 1,
        total: queue.length
      });

      await enrichSingleItem(baseItem.itemId, i + 1, queue.length);

      if ((i + 1) % 5 === 0 || i === queue.length - 1) {
        setStatus(`Обработка: ${i + 1}/${queue.length}`);
        render();
      }

      await delay(40);
    }

    setStatus(`Готово. Создано предметов: ${state.items.length}`);
    log('BOOT', 'Полная обработка завершена', { total: state.items.length });
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
    logError('BOOT', 'Сбой полной перезагрузки', error);
  } finally {
    state.parseRunning = false;
    render();
  }
}

function normalizeGlistToQueue(raw) {
  const map = new Map();

  Object.keys(raw || {}).forEach((groupName) => {
    const ids = Array.isArray(raw[groupName]) ? raw[groupName] : [];

    ids.forEach((itemId) => {
      const id = Number(itemId);
      if (Number.isNaN(id)) return;

      state.categoryByItemId[id] = groupName;

      if (!map.has(id)) {
        map.set(id, {
          itemId: id,
          category: groupName,
          name: '',
          price: 1,
          image: buildDefaultImage(id),
          updatedAt: 0,
          statusText: 'Создан базовый блок',
          parseError: ''
        });
      }
    });
  });

  return Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
}

function createOrReplaceLocalItem(baseItem) {
  const existingIndex = state.items.findIndex((x) => x.itemId === baseItem.itemId);

  if (existingIndex === -1) {
    state.items.push(baseItem);
  } else {
    state.items[existingIndex] = {
      ...state.items[existingIndex],
      ...baseItem
    };
  }

  state.items.sort((a, b) => a.itemId - b.itemId);
}

async function enrichSingleItem(itemId, current, total) {
  const item = state.items.find((x) => x.itemId === itemId);
  if (!item) return;

  try {
    item.statusText = 'Проверка базы...';
    item.parseError = '';
    render();

    log('DB', 'Проверка записи в Supabase', { itemId });

    const dbRow = await loadSingleItemFromSupabase(itemId);

    if (dbRow) {
      log('DB', 'Запись найдена в Supabase', { itemId, row: dbRow });

      item.category = dbRow.category || item.category;
      item.name = dbRow.name || item.name;
      item.price = normalizePrice(dbRow.price, 1);
      item.updatedAt = dbRow.updated_at ? new Date(dbRow.updated_at).getTime() : item.updatedAt;
      item.statusText = 'Загружено из базы';
      item.parseError = '';

      render();
      return;
    }

    log('DB', 'Запись не найдена в Supabase', { itemId });

    item.statusText = 'Вызов Edge Function...';
    render();

    const resolvedName = await resolveNameForItem(item);

    if (!resolvedName) {
      item.name = '';
      item.statusText = 'Имя не найдено';
      item.parseError = item.parseError || 'Edge Function не вернула название';
      log('PARSE', 'Название не найдено', {
        itemId,
        category: item.category,
        current,
        total,
        reason: item.parseError
      });
      render();
      return;
    }

    item.name = resolvedName;
    item.price = normalizePrice(item.price, 1);
    item.updatedAt = Date.now();
    item.statusText = 'Имя найдено, сохранение...';
    item.parseError = '';
    render();

    log('PARSE', 'Название получено', {
      itemId,
      name: resolvedName,
      category: item.category
    });

    await saveItemToSupabase(item);

    item.statusText = 'Сохранено в базе';
    render();

    log('DB', 'Запись сохранена в Supabase', {
      itemId,
      name: item.name,
      category: item.category
    });
  } catch (error) {
    item.statusText = 'Ошибка';
    item.parseError = error.message;
    render();
    logError('ITEM', `Ошибка обработки itemId=${itemId}`, error);
  }
}

async function loadSingleItemFromSupabase(itemId) {
  const { data, error } = await supabase
    .from('items_catalog')
    .select('item_id, category, name, price, updated_at')
    .eq('item_id', itemId)
    .maybeSingle();

  if (error) {
    throw new Error(formatSupabaseError('Supabase read error', error));
  }

  return data;
}

async function resolveNameForItem(item) {
  log('PARSE', 'Вызов Edge Function rapid-function', {
    itemId: item.itemId,
    category: item.category
  });

  const { data, error } = await supabase.functions.invoke('rapid-function', {
    body: {
      itemId: item.itemId,
      category: item.category
    }
  });

  if (error) {
    throw new Error(`Edge Function invoke error: ${error.message}`);
  }

  log('PARSE', 'Ответ Edge Function', data);

  if (data?.ok && data?.name) {
    return data.name;
  }

  item.parseError = data?.reason || 'Edge Function returned no name';
  return '';
}

async function saveItemToSupabase(item) {
  const payload = {
    item_id: item.itemId,
    category: item.category,
    name: item.name,
    price: normalizePrice(item.price, 1),
    updated_at: new Date().toISOString()
  };

  log('DB', 'Upsert в Supabase', { payload });

  const { data, error } = await supabase
    .from('items_catalog')
    .upsert([payload], { onConflict: 'item_id' })
    .select();

  if (error) {
    throw new Error(formatSupabaseError('Supabase write error', error));
  }

  log('DB', 'Ответ Supabase после upsert', { data });
  return data;
}

function formatSupabaseError(prefix, error) {
  const parts = [
    prefix,
    error?.message ? `message=${error.message}` : '',
    error?.details ? `details=${error.details}` : '',
    error?.hint ? `hint=${error.hint}` : '',
    error?.code ? `code=${error.code}` : ''
  ].filter(Boolean);

  return parts.join(' | ');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

function normalizePrice(price, fallback = 1) {
  if (price === '' || price === null || price === undefined) {
    return fallback;
  }

  const num = Number(price);
  return Number.isNaN(num) ? fallback : num;
}

function buildDefaultImage(itemId) {
  return `https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items/${itemId}.webp`;
}

function buildPlaceholderImage(itemId) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
      <rect width="100%" height="100%" rx="12" ry="12" fill="#1d2430"/>
      <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle" fill="#8fa3c7" font-family="Arial" font-size="13">Нет фото</text>
      <text x="50%" y="66%" text-anchor="middle" dominant-baseline="middle" fill="#6e7f9f" font-family="Arial" font-size="12">#${itemId}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function setStatus(text) {
  if (els.statusBar) {
    els.statusBar.textContent = text;
  }
}

function updateTabs() {
  els.tabs.forEach((tab) => {
    tab.classList.toggle('tab--active', tab.dataset.tab === state.activeTab);
  });

  if (els.favoritesView) {
    els.favoritesView.classList.toggle('view--active', state.activeTab === 'favorites');
  }

  if (els.libraryView) {
    els.libraryView.classList.toggle('view--active', state.activeTab === 'library');
  }
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem(
    FAVORITES_STORAGE_KEY,
    JSON.stringify(Array.from(state.favorites))
  );
}

function toggleFavorite(itemId) {
  if (state.favorites.has(itemId)) {
    state.favorites.delete(itemId);
  } else {
    state.favorites.add(itemId);
  }

  saveFavorites();
  render();
}

function getFilteredItems() {
  const searchValue = state.search || '';

  const bySearch = state.items.filter((item) => {
    const itemName = (item.name || '').toLowerCase();
    return itemName.includes(searchValue) || String(item.itemId).includes(searchValue);
  });

  if (state.activeTab === 'favorites') {
    return bySearch.filter((item) => state.favorites.has(item.itemId));
  }

  return bySearch;
}

function render() {
  updateTabs();

  const items = getFilteredItems();

  if (state.activeTab === 'favorites') {
    renderGrid(els.favoritesGrid, items);
    if (els.favoritesEmpty) {
      els.favoritesEmpty.style.display = items.length ? 'none' : 'block';
    }
  } else {
    renderGrid(els.libraryGrid, items);
    if (els.libraryEmpty) {
      els.libraryEmpty.style.display = items.length ? 'none' : 'block';
    }
  }

  renderLogs();
}

function renderGrid(container, items) {
  if (!container) return;

  container.innerHTML = items.map((item) => {
    const active = state.favorites.has(item.itemId);
    const itemName = item.name || `Предмет #${item.itemId}`;
    const fallbackImage = buildPlaceholderImage(item.itemId);
    const priceText = formatPrice(item.price);
    const titleText = item.parseError ? `${itemName} — ${item.parseError}` : itemName;
    const errorText = item.parseError ? item.parseError : '';

    return `
      <div class="item-card" title="${escapeHtml(titleText)}">
        <div class="item-card__price">${escapeHtml(priceText)}</div>

        <button
          class="item-card__favorite ${active ? 'item-card__favorite--active' : ''}"
          data-favorite-id="${item.itemId}"
          title="Добавить в избраное"
        >★</button>

        <div class="item-card__image-wrap">
          <img
            class="item-card__image"
            src="${escapeHtml(item.image)}"
            alt="${escapeHtml(itemName)}"
            loading="lazy"
            onerror="this.onerror=null;this.src='${escapeHtml(fallbackImage)}';"
          />
        </div>

        <div class="item-card__body">
          <div class="item-card__name">${escapeHtml(itemName)}</div>
          ${errorText ? `<div class="item-card__error">${escapeHtml(errorText)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const itemId = Number(button.dataset.favoriteId);
      toggleFavorite(itemId);
    });
  });
}

function renderLogs() {
  if (!els.logsPanel) return;

  const logs = state.logs.slice(-250).reverse();

  els.logsPanel.innerHTML = logs.map((entry) => {
    return `
      <div class="log-entry ${entry.error ? 'log-entry--error' : ''}">
        <div class="log-entry__top">
          <div class="log-entry__stage">${escapeHtml(entry.stage)}</div>
          <div class="log-entry__time">${escapeHtml(formatLogTime(entry.time))}</div>
        </div>
        <div class="log-entry__message">${escapeHtml(entry.message)}</div>
        ${entry.data ? `<div class="log-entry__data">${escapeHtml(stringifyLogData(entry.data))}</div>` : ''}
        ${entry.error ? `<div class="log-entry__error">${escapeHtml(entry.error)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function stringifyLogData(data) {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function formatLogTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ru-RU');
  } catch {
    return iso;
  }
}

function formatPrice(price) {
  const num = Number(price);
  if (Number.isNaN(num)) return '1$';
  return `${num.toLocaleString('ru-RU')}$`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function log(stage, message, data = null) {
  const entry = {
    time: new Date().toISOString(),
    stage,
    message,
    data
  };

  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.shift();
  }

  console.log(`[${stage}] ${message}`, data ?? '');
  renderLogs();
}

function logError(stage, message, error, data = null) {
  const entry = {
    time: new Date().toISOString(),
    stage,
    message,
    error: error?.message || String(error),
    data
  };

  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.shift();
  }

  console.error(`[${stage}] ${message}`, error, data ?? '');
  renderLogs();
}