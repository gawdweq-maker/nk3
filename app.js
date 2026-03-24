import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://juqibbkgfcefroggwbjb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_gOmRcvLoj3VBaraUnRcBhw_frmRiGl6';
const GLIST_URL = 'https://gist.githubusercontent.com/revo12/2a9c956f1d3ff3c9af769dc5d532e339/raw/8dd5c3ef679092216bb3b9ddfab2926dc6bd2e85/itemid';
const CDN_TEMPLATE = 'https://cdn-eu.majestic-files.net/public/master/static/img/inventory/items';
const FAVORITES_STORAGE_KEY = 'nk3_marketplace_favorites';
const SYNC_INTERVAL_MS = 15000;
const LOTS_LIMIT = 5;
const NAME_RESOLVE_CONCURRENCY = 2;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const state = {
  mode: hasBridge() ? 'ALT:V' : 'WEB',
  activeTab: 'items',
  selectedCategory: 'all',
  sortMode: 'cheap',
  search: '',
  items: [],
  itemsById: new Map(),
  categories: [],
  favorites: new Set(loadFavorites()),
  selectedItemId: null,
  pendingLotsItemId: null,
  lotsByItemId: new Map(),
  descriptionsByItemId: new Map(),
  loadingDescriptionFor: null,
  bridgeConnected: false,
  debugLogs: [],
  lastInitRaw: '',
  lastLotsRaw: '',
  lastStatus: 'Инициализация...',
  syncTimerId: null,
  hydrateQueue: [],
  hydrateInFlight: 0,
  hydrationStarted: false,
  disabled: false
};

const els = {
  searchInput: document.getElementById('searchInput'),
  sortButton: document.getElementById('sortButton'),
  sortMenu: document.getElementById('sortMenu'),
  sortItems: Array.from(document.querySelectorAll('[data-sort]')),
  refreshButton: document.getElementById('refreshButton'),
  tabs: Array.from(document.querySelectorAll('[data-tab]')),
  categoryBar: document.getElementById('categoryBar'),
  statusBar: document.getElementById('statusBar'),
  modeBadge: document.getElementById('modeBadge'),
  itemsGrid: document.getElementById('itemsGrid'),
  emptyState: document.getElementById('emptyState'),
  drawer: document.getElementById('drawer'),
  drawerContent: document.getElementById('drawerContent'),
  drawerCategory: document.getElementById('drawerCategory'),
  drawerTitle: document.getElementById('drawerTitle'),
  drawerMeta: document.getElementById('drawerMeta'),
  drawerImage: document.getElementById('drawerImage'),
  drawerMinPrice: document.getElementById('drawerMinPrice'),
  drawerMaxPrice: document.getElementById('drawerMaxPrice'),
  drawerLotsCount: document.getElementById('drawerLotsCount'),
  drawerDescription: document.getElementById('drawerDescription'),
  drawerLots: document.getElementById('drawerLots'),
  debugMetrics: document.getElementById('debugMetrics'),
  debugLogs: document.getElementById('debugLogs'),
  clearDebugButton: document.getElementById('clearDebugButton')
};

init().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Ошибка инициализации: ${message}`);
  debug('BOOT', 'Критическая ошибка init()', { error: message });
});

async function init() {
  bindUi();
  bindBridge();
  renderMode();
  setStatus('Загружаю glist и сохраненные данные...');

  await bootstrapCatalog();
  startPeriodicSync();

  if (hasBridge()) {
    requestInitFromGame('Первичная синхронизация из alt:V...');
  } else {
    setStatus('Автономный режим: каталог загружен из glist и Supabase');
  }
}

function bindUi() {
  els.searchInput?.addEventListener('input', (event) => {
    state.search = String(event.target.value || '').trim().toLowerCase();
    render();
  });

  els.sortButton?.addEventListener('click', () => {
    els.sortMenu?.classList.toggle('hidden');
  });

  els.sortItems.forEach((button) => {
    button.addEventListener('click', () => {
      state.sortMode = button.dataset.sort || 'cheap';
      els.sortMenu?.classList.add('hidden');
      debug('UI', `Сортировка: ${state.sortMode}`);
      render();
    });
  });

  document.addEventListener('click', (event) => {
    if (!els.sortMenu || !els.sortButton) return;
    if (els.sortMenu.contains(event.target) || els.sortButton.contains(event.target)) return;
    els.sortMenu.classList.add('hidden');
  });

  els.refreshButton?.addEventListener('click', async () => {
    if (state.disabled) return;

    if (hasBridge()) {
      requestInitFromGame('Запросил обновление цен через marketplace.init');
      return;
    }

    setStatus('Обновляю данные из Supabase...');
    await syncCatalogFromSupabase();
    render();
  });

  els.tabs.forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab || 'items';
      render();
    });
  });

  els.clearDebugButton?.addEventListener('click', () => {
    state.debugLogs = [];
    renderDebug();
  });
}

function bindBridge() {
  const bridge = getBridge();
  if (!bridge?.on) {
    debug('BRIDGE', 'Bridge недоступен, работаю автономно');
    return;
  }

  state.bridgeConnected = true;
  renderMode();
  debug('BRIDGE', 'Bridge alt:V подключен');

  bridge.on('ui:marketplace:status', (text) => {
    setStatus(String(text || ''));
    debug('STATUS', String(text || ''));
  });

  bridge.on('ui:marketplace:initResult', (...args) => {
    state.lastInitRaw = safeStringify(args);
    const updatedCount = applyInitResultPayload(args);
    const text = `Сработал подпись такая: marketplace.client.initResult | обновлено предметов: ${updatedCount}`;
    setStatus(text);
    debug('INIT', text, { rawArgs: args });
    render();
  });

  bridge.on('ui:marketplace:pushLots', (lots) => {
    state.lastLotsRaw = safeStringify(lots);
    const count = applyLotsPayload(lots);
    const text = `Сработал подпись такая: marketplace.client.trading.pushLots | лотов: ${count}`;
    setStatus(text);
    debug('LOTS', text, { rawLots: lots });
    renderDrawer();
  });

  bridge.on('ui:marketplace:scriptDisabled', () => {
    state.disabled = true;
    setStatus('Скрипт отключен до перезапуска ресурса');
    debug('BRIDGE', 'Получено событие ui:marketplace:scriptDisabled');
    renderMode();
  });
}

async function bootstrapCatalog() {
  const [glistData, dbRows] = await Promise.all([
    loadGlist(),
    loadCatalogRowsFromSupabase()
  ]);

  state.categories = glistData.categories;
  mergeCatalog(glistData.items, dbRows);
  queueHydrationForMissingNames();
  render();

  debug('BOOT', 'Каталог собран', {
    glistItems: glistData.items.length,
    dbRows: dbRows.length,
    categories: glistData.categories.length
  });
}

async function loadGlist() {
  const response = await fetch(GLIST_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`glist HTTP ${response.status}`);
  }

  const raw = await response.json();
  const map = new Map();

  Object.entries(raw || {}).forEach(([category, ids]) => {
    if (!Array.isArray(ids)) return;

    ids.forEach((value) => {
      const itemId = Number(value);
      if (!Number.isFinite(itemId) || itemId <= 0 || map.has(itemId)) return;

      map.set(itemId, {
        itemId,
        category,
        image: buildImageUrl(itemId),
        name: '',
        description: '',
        price: 1,
        totalQuantity: 0,
        updatedAt: '',
        minPrice: null,
        maxPrice: null
      });
    });
  });

  const items = Array.from(map.values()).sort((a, b) => a.itemId - b.itemId);
  const categories = Array.from(new Set(items.map((item) => item.category))).sort();

  debug('GLIST', 'glist загружен', {
    total: items.length,
    categories: categories.length
  });

  return { items, categories };
}

async function loadCatalogRowsFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('items_catalog')
      .select('item_id, category, name, price, updated_at')
      .limit(5000);

    if (error) {
      debug('DB', `Ошибка чтения Supabase: ${error.message}`);
      return [];
    }

    debug('DB', 'Supabase rows loaded', { rows: data?.length || 0 });
    return Array.isArray(data) ? data : [];
  } catch (error) {
    debug('DB', 'Критическая ошибка чтения Supabase', { error: String(error) });
    return [];
  }
}

function mergeCatalog(glistItems, dbRows) {
  const dbById = new Map(
    dbRows.map((row) => [
      Number(row.item_id),
      row
    ])
  );

  state.items = glistItems.map((item) => {
    const row = dbById.get(item.itemId);
    return {
      ...item,
      name: row?.name || item.name,
      price: normalizePrice(row?.price, item.price),
      updatedAt: row?.updated_at || item.updatedAt,
      category: row?.category || item.category
    };
  });

  state.itemsById = new Map(state.items.map((item) => [item.itemId, item]));

  if (!state.selectedItemId && state.items.length) {
    state.selectedItemId = state.items[0].itemId;
  }
}

function queueHydrationForMissingNames() {
  if (state.hydrationStarted) return;

  state.hydrationStarted = true;
  state.hydrateQueue = state.items
    .filter((item) => !item.name)
    .map((item) => item.itemId);

  if (!state.hydrateQueue.length) {
    debug('PARSE', 'Все названия уже есть в базе');
    return;
  }

  debug('PARSE', 'Запущена фоновая догрузка названий', {
    queue: state.hydrateQueue.length
  });

  pumpHydrationQueue();
}

function pumpHydrationQueue() {
  while (state.hydrateInFlight < NAME_RESOLVE_CONCURRENCY && state.hydrateQueue.length) {
    const itemId = state.hydrateQueue.shift();
    state.hydrateInFlight += 1;

    hydrateSingleItem(itemId)
      .catch((error) => {
        debug('PARSE', `Не удалось обогатить itemId=${itemId}`, { error: String(error) });
      })
      .finally(() => {
        state.hydrateInFlight -= 1;
        render();
        pumpHydrationQueue();
      });
  }
}

async function hydrateSingleItem(itemId) {
  const item = state.itemsById.get(itemId);
  if (!item || item.name) return;

  const payload = await resolveItemMeta(itemId, item.category);
  if (!payload?.name) return;

  item.name = payload.name;
  if (payload.description) {
    state.descriptionsByItemId.set(itemId, payload.description);
  }

  await saveCatalogRow(item);
}

async function resolveItemMeta(itemId, category) {
  try {
    const { data, error } = await supabase.functions.invoke('rapid-function', {
      body: {
        itemId,
        category
      }
    });

    if (error) {
      debug('PARSE', 'Ошибка Edge Function', { itemId, error: error.message });
      return null;
    }

    debug('PARSE', 'Ответ rapid-function', {
      itemId,
      ok: data?.ok,
      name: data?.name || '',
      hasDescription: Boolean(data?.description)
    });

    return data?.ok ? data : null;
  } catch (error) {
    debug('PARSE', 'Сбой вызова rapid-function', { itemId, error: String(error) });
    return null;
  }
}

async function saveCatalogRow(item) {
  try {
    const payload = {
      item_id: item.itemId,
      category: item.category,
      name: item.name,
      price: normalizePrice(item.price, 1),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('items_catalog')
      .upsert([payload], { onConflict: 'item_id' });

    if (error) {
      debug('DB', 'Ошибка upsert в Supabase', { itemId: item.itemId, error: error.message });
      return;
    }

    item.updatedAt = payload.updated_at;
  } catch (error) {
    debug('DB', 'Критическая ошибка записи в Supabase', { itemId: item.itemId, error: String(error) });
  }
}

async function syncCatalogFromSupabase() {
  const rows = await loadCatalogRowsFromSupabase();
  if (!rows.length) return;

  rows.forEach((row) => {
    const itemId = Number(row.item_id);
    const item = state.itemsById.get(itemId);
    if (!item) return;

    item.category = row.category || item.category;
    item.name = row.name || item.name;
    item.price = normalizePrice(row.price, item.price);
    item.updatedAt = row.updated_at || item.updatedAt;
  });

  debug('DB', 'Каталог синхронизирован из Supabase', { rows: rows.length });
}

function startPeriodicSync() {
  if (state.syncTimerId) {
    clearInterval(state.syncTimerId);
  }

  state.syncTimerId = setInterval(async () => {
    if (state.disabled) return;
    await syncCatalogFromSupabase();
    render();
  }, SYNC_INTERVAL_MS);
}

function requestInitFromGame(statusText) {
  const bridge = getBridge();
  if (!bridge?.emit) {
    setStatus('Bridge недоступен, обновление из alt:V не отправлено');
    return;
  }

  setStatus(statusText);
  debug('BRIDGE', 'emit ui:marketplace:requestInit');
  bridge.emit('ui:marketplace:requestInit');
}

function applyInitResultPayload(args) {
  const payload = findItemsArray(args);
  if (!payload.length) {
    debug('INIT', 'В initResult не найден массив предметов', { args });
    return 0;
  }

  let updatedCount = 0;

  payload.forEach((entry) => {
    const itemId = Number(entry?.itemId);
    const item = state.itemsById.get(itemId);
    if (!item) return;

    item.price = normalizePrice(entry?.startingBet, item.price);
    item.totalQuantity = Number(entry?.totalQuantity) || 0;
    item.minPrice = item.price;
    item.maxPrice = Math.max(item.maxPrice || 0, item.price);
    item.updatedAt = new Date().toISOString();
    updatedCount += 1;
  });

  syncUpdatedItemsToSupabase(payload).catch((error) => {
    debug('DB', 'Не удалось синхронизировать цены после initResult', { error: String(error) });
  });

  return updatedCount;
}

async function syncUpdatedItemsToSupabase(entries) {
  const payload = entries
    .map((entry) => {
      const itemId = Number(entry?.itemId);
      const item = state.itemsById.get(itemId);
      if (!item) return null;

      return {
        item_id: item.itemId,
        category: item.category,
        name: item.name || null,
        price: normalizePrice(entry?.startingBet, item.price),
        updated_at: new Date().toISOString()
      };
    })
    .filter(Boolean);

  if (!payload.length) return;

  const { error } = await supabase
    .from('items_catalog')
    .upsert(payload, { onConflict: 'item_id' });

  if (error) {
    debug('DB', 'Ошибка записи цен после initResult', { error: error.message });
    return;
  }

  debug('DB', 'Цены после initResult сохранены в Supabase', { rows: payload.length });
}

function findItemsArray(value) {
  if (Array.isArray(value)) {
    if (value.some(isInitItem)) {
      return value;
    }

    for (const part of value) {
      const nested = findItemsArray(part);
      if (nested.length) return nested;
    }
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const found = findItemsArray(nested);
      if (found.length) return found;
    }
  }

  return [];
}

function isInitItem(value) {
  return value && typeof value === 'object' && 'itemId' in value && 'startingBet' in value;
}

function applyLotsPayload(rawLots) {
  const targetItemId = state.pendingLotsItemId ?? state.selectedItemId;
  const selectedItem = state.itemsById.get(targetItemId);
  const normalized = normalizeLots(rawLots).slice(0, LOTS_LIMIT);

  if (!selectedItem) return normalized.length;

  state.lotsByItemId.set(selectedItem.itemId, normalized);
  selectedItem.minPrice = normalized.length
    ? Math.min(...normalized.map((lot) => normalizePrice(lot.price, selectedItem.price)))
    : normalizePrice(selectedItem.price, 1);
  selectedItem.maxPrice = normalized.length
    ? Math.max(...normalized.map((lot) => normalizePrice(lot.price, selectedItem.price)))
    : normalizePrice(selectedItem.price, 1);
  state.pendingLotsItemId = null;

  return normalized.length;
}

function normalizeLots(rawLots) {
  const source = Array.isArray(rawLots)
    ? rawLots
    : Array.isArray(rawLots?.lots)
      ? rawLots.lots
      : [];

  return source
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: entry.id ?? '-',
      accountId: entry.accountId ?? '-',
      amount: entry.amount ?? '-',
      price: entry.price ?? '-'
    }));
}

function render() {
  renderMode();
  renderTabs();
  renderCategories();

  const visibleItems = getVisibleItems();
  renderGrid(visibleItems);
  renderDrawer();
  renderDebug(visibleItems.length);
}

function renderMode() {
  if (!els.modeBadge) return;

  const parts = [state.mode];
  if (state.bridgeConnected) parts.push('BRIDGE');
  if (state.disabled) parts.push('DISABLED');

  els.modeBadge.textContent = parts.join(' · ');
}

function renderTabs() {
  els.tabs.forEach((button) => {
    button.classList.toggle('main-tab--active', button.dataset.tab === state.activeTab);
  });
}

function renderCategories() {
  if (!els.categoryBar) return;

  const buttons = [
    { key: 'all', label: 'Все' },
    ...state.categories.map((category) => ({
      key: category,
      label: category
    }))
  ];

  els.categoryBar.innerHTML = buttons.map((button) => `
    <button
      class="category-chip ${button.key === state.selectedCategory ? 'category-chip--active' : ''}"
      type="button"
      data-category="${escapeHtml(button.key)}"
    >
      ${escapeHtml(button.label)}
    </button>
  `).join('');

  els.categoryBar.querySelectorAll('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCategory = button.dataset.category || 'all';
      render();
    });
  });

  els.categoryBar.classList.toggle('category-bar--dimmed', state.activeTab === 'favorites');
}

function getVisibleItems() {
  let items = [...state.items];

  if (state.activeTab === 'favorites') {
    items = items.filter((item) => state.favorites.has(item.itemId));
  }

  if (state.selectedCategory !== 'all' && state.activeTab === 'items') {
    items = items.filter((item) => item.category === state.selectedCategory);
  }

  if (state.search) {
    items = items.filter((item) => {
      const name = String(item.name || '').toLowerCase();
      return name.includes(state.search) || String(item.itemId).includes(state.search);
    });
  }

  items.sort((a, b) => {
    if (state.sortMode === 'expensive') {
      return normalizePrice(b.price, 0) - normalizePrice(a.price, 0) || a.itemId - b.itemId;
    }

    return normalizePrice(a.price, 0) - normalizePrice(b.price, 0) || a.itemId - b.itemId;
  });

  return items;
}

function renderGrid(items) {
  if (!els.itemsGrid || !els.emptyState) return;

  els.emptyState.classList.toggle('hidden', items.length > 0);

  els.itemsGrid.innerHTML = items.map((item) => {
    const isFavorite = state.favorites.has(item.itemId);
    const isSelected = state.selectedItemId === item.itemId;
    const itemName = item.name || `Предмет #${item.itemId}`;

    return `
      <article
        class="item-card ${isFavorite ? 'item-card--favorite' : ''} ${isSelected ? 'item-card--selected' : ''}"
        data-item-id="${item.itemId}"
      >
        <button
          class="item-card__favorite ${isFavorite ? 'item-card__favorite--active' : ''}"
          type="button"
          data-favorite-id="${item.itemId}"
          title="Добавить в избранное"
        >★</button>

        <div class="item-card__price">${escapeHtml(formatPrice(item.price))}</div>

        <div class="item-card__image-box">
          <img
            class="item-card__image"
            src="${escapeHtml(item.image)}"
            alt="${escapeHtml(itemName)}"
            loading="lazy"
          />
        </div>

        <div class="item-card__name">${escapeHtml(itemName)}</div>
        <div class="item-card__footer">
          <span class="item-card__id">#${item.itemId}</span>
          <span class="item-card__qty">${item.totalQuantity || 0} шт.</span>
        </div>
      </article>
    `;
  }).join('');

  els.itemsGrid.querySelectorAll('[data-favorite-id]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFavorite(Number(button.dataset.favoriteId));
    });
  });

  els.itemsGrid.querySelectorAll('[data-item-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const itemId = Number(card.dataset.itemId);
      openItemDrawer(itemId);
    });
  });
}

async function openItemDrawer(itemId) {
  state.selectedItemId = itemId;
  render();

  const item = state.itemsById.get(itemId);
  if (!item || state.disabled) {
    return;
  }

  if (!state.descriptionsByItemId.has(itemId)) {
    state.loadingDescriptionFor = itemId;
    renderDrawer();

    const payload = await resolveItemMeta(itemId, item.category);
    if (payload?.description) {
      state.descriptionsByItemId.set(itemId, payload.description);
    } else if (!state.descriptionsByItemId.has(itemId)) {
      state.descriptionsByItemId.set(itemId, 'Описание пока не найдено');
    }

    if (payload?.name && !item.name) {
      item.name = payload.name;
      saveCatalogRow(item).catch(() => {});
    }

    state.loadingDescriptionFor = null;
    render();
  }

  requestLotsFromGame(itemId);
}

function requestLotsFromGame(itemId) {
  const bridge = getBridge();
  if (!bridge?.emit) {
    debug('LOTS', 'Bridge недоступен, запрос лотов пропущен', { itemId });
    return;
  }

  const sortJson = JSON.stringify({ sort: 'priceUp' });
  state.pendingLotsItemId = itemId;
  debug('BRIDGE', 'emit ui:marketplace:requestLots', { itemId, sortJson });
  bridge.emit('ui:marketplace:requestLots', itemId, 0, sortJson);
}

function renderDrawer() {
  const item = state.itemsById.get(state.selectedItemId);
  if (!item || !els.drawerContent || !els.drawer) return;

  els.drawerContent.classList.remove('hidden');
  els.drawer.querySelector('.drawer__empty')?.classList.add('hidden');

  const lots = state.lotsByItemId.get(item.itemId) || [];
  const description = state.loadingDescriptionFor === item.itemId
    ? 'Описание загружается...'
    : state.descriptionsByItemId.get(item.itemId) || 'Описание пока не найдено';
  const minPrice = lots.length
    ? Math.min(...lots.map((lot) => normalizePrice(lot.price, item.price)))
    : normalizePrice(item.minPrice, item.price);
  const maxPrice = lots.length
    ? Math.max(...lots.map((lot) => normalizePrice(lot.price, item.price)))
    : normalizePrice(item.maxPrice, item.price);

  els.drawerCategory.textContent = item.category || 'misc';
  els.drawerTitle.textContent = item.name || `Предмет #${item.itemId}`;
  els.drawerMeta.textContent = `itemId: ${item.itemId} · сохранено: ${formatUpdatedAt(item.updatedAt)}`;
  els.drawerImage.src = item.image;
  els.drawerImage.alt = item.name || `Предмет #${item.itemId}`;
  els.drawerMinPrice.textContent = formatPrice(minPrice);
  els.drawerMaxPrice.textContent = formatPrice(maxPrice);
  els.drawerLotsCount.textContent = String(item.totalQuantity || lots.length || 0);
  els.drawerDescription.textContent = description;
  els.drawerLots.innerHTML = lots.length
    ? lots.map((lot) => `
        <div class="lot-row">${escapeHtml(`${lot.id} | ${lot.accountId} ${lot.amount} ${formatPrice(lot.price)}`)}</div>
      `).join('')
    : '<div class="lot-row lot-row--empty">Нет загруженных предложений</div>';
}

function renderDebug(renderedCount = getVisibleItems().length) {
  if (els.debugMetrics) {
    const metrics = [
      `mode: ${state.mode}`,
      `bridge: ${state.bridgeConnected}`,
      `activeTab: ${state.activeTab}`,
      `category: ${state.selectedCategory}`,
      `items: ${state.items.length}`,
      `rendered: ${renderedCount}`,
      `selected: ${state.selectedItemId ?? '-'}`,
      `lastInitRaw: ${truncate(state.lastInitRaw, 220)}`,
      `lastLotsRaw: ${truncate(state.lastLotsRaw, 220)}`
    ];

    els.debugMetrics.innerHTML = metrics
      .map((metric) => `<div class="debug-metric">${escapeHtml(metric)}</div>`)
      .join('');
  }

  if (els.debugLogs) {
    els.debugLogs.innerHTML = state.debugLogs
      .slice(-40)
      .reverse()
      .map((entry) => `
        <div class="debug-log">
          <div class="debug-log__top">
            <span>${escapeHtml(entry.stage)}</span>
            <span>${escapeHtml(entry.time)}</span>
          </div>
          <div class="debug-log__message">${escapeHtml(entry.message)}</div>
          ${entry.data ? `<div class="debug-log__data">${escapeHtml(safeStringify(entry.data))}</div>` : ''}
        </div>
      `)
      .join('');
  }
}

function toggleFavorite(itemId) {
  if (state.favorites.has(itemId)) {
    state.favorites.delete(itemId);
  } else {
    state.favorites.add(itemId);
  }

  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...state.favorites]));
  render();
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setStatus(text) {
  state.lastStatus = text;
  if (els.statusBar) {
    els.statusBar.textContent = text;
  }
}

function debug(stage, message, data = null) {
  state.debugLogs.push({
    stage,
    message,
    data,
    time: new Date().toLocaleTimeString('ru-RU')
  });

  if (state.debugLogs.length > 200) {
    state.debugLogs.shift();
  }

  renderDebug();
}

function getBridge() {
  return window.alt || window.altv || null;
}

function hasBridge() {
  const bridge = getBridge();
  return Boolean(bridge && typeof bridge.emit === 'function');
}

function buildImageUrl(itemId) {
  return `${CDN_TEMPLATE}/${itemId}.webp`;
}

function normalizePrice(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `${numeric.toLocaleString('ru-RU')}$`;
}

function formatUpdatedAt(value) {
  if (!value) return 'нет';

  try {
    return new Date(value).toLocaleString('ru-RU');
  } catch {
    return String(value);
  }
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
