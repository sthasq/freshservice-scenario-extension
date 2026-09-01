(function () {
  if (globalThis.__FSX_CONTENT_INITIALIZED__) return;
  globalThis.__FSX_CONTENT_INITIALIZED__ = true;

  const TASK_STATUS = {
    OPEN: 1,
    IN_PROGRESS: 2,
    COMPLETED: 3,
  };

  const TASK_STATUS_LABELS = {
    [TASK_STATUS.OPEN]: '대기',
    [TASK_STATUS.IN_PROGRESS]: '진행중',
    [TASK_STATUS.COMPLETED]: '완료',
  };

  const state = {
    agents: [],
    bulkBusy: false,
    busyTaskIds: new Set(),
    currentAgentId: null,
    error: '',
    loadedTicketId: null,
    message: '',
    selectedTaskIds: new Set(),
    settings: { configured: false, fsDomain: '', hasApiKey: false },
    tasks: [],
    ticketId: null,
  };

  const BULK_CONFIRM_THRESHOLD = 5;
  const DOM_UPDATE_DEBOUNCE_MS = 120;
  const DRAG_SELECT_THRESHOLD_PX = 6;
  const DRAG_SAMPLE_STEP_PX = 12;
  const EXTENSION_ROOT_SELECTOR = '.fsx-inline-controls,.fsx-bulk-bar,.fsx-inline-toast,.fsx-agent-picker';
  const AGENT_RESULT_LIMIT = 8;
  const THEME_SYNC_THROTTLE_MS = 5000;
  const URL_CHECK_INTERVAL_MS = 1000;

  let agentById = new Map();
  let agentPickerIndex = 0;
  let agentPickerTarget = null;
  let agentsVersion = 0;
  let bulkAgentId = null;
  let contextLoadPromise = null;
  let contextInvalidated = false;
  let dragSelect = null;
  let forceRowScanPending = false;
  let lastThemeSyncAt = 0;
  let lastUrl = location.href;
  let renderFrameId = null;
  let renderTimerId = null;
  let suppressClickUntil = 0;
  let taskRowCache = new Map();
  let toastTimer = null;
  let watchIntervalId = null;
  let pageObserver = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeTaskTitle(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/fresh\s*service/g, 'freshservice')
      .replace(/wi[-\s]?fi/g, 'wifi')
      .replace(/mac\s*address/g, 'mac')
      .replace(/[\s._:()[\]{}\-·/\\]+/g, '')
      .trim();
  }

  const CONTEXT_INVALIDATED_MESSAGE = '확장 프로그램이 업데이트되었습니다. 페이지를 새로고침한 후 다시 이용해주세요.';

  function isContextInvalidatedError(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    if (watchIntervalId) {
      clearInterval(watchIntervalId);
      watchIntervalId = null;
    }
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    window.clearTimeout(renderTimerId);
    renderTimerId = null;
    if (renderFrameId) {
      window.cancelAnimationFrame(renderFrameId);
      renderFrameId = null;
    }
    showToast(CONTEXT_INVALIDATED_MESSAGE, 'error');
  }

  function sendMessage(type, payload = {}) {
    if (contextInvalidated) {
      return Promise.resolve({ ok: false, message: CONTEXT_INVALIDATED_MESSAGE, status: 0 });
    }
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, response => {
          if (chrome.runtime.lastError) {
            if (isContextInvalidatedError(chrome.runtime.lastError)) {
              handleContextInvalidated();
              resolve({ ok: false, message: CONTEXT_INVALIDATED_MESSAGE, status: 0 });
              return;
            }
            resolve({ ok: false, message: chrome.runtime.lastError.message, status: 0 });
            return;
          }
          resolve(response || { ok: false, message: '확장 응답이 없습니다.', status: 0 });
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          handleContextInvalidated();
          resolve({ ok: false, message: CONTEXT_INVALIDATED_MESSAGE, status: 0 });
          return;
        }
        resolve({ ok: false, message: error?.message || '확장과 통신할 수 없습니다.', status: 0 });
      }
    });
  }

  function extractTicketId() {
    const fromPath = location.pathname.match(/\/(?:a\/)?tickets\/(\d+)/i);
    if (fromPath) return Number(fromPath[1]);
    const fromUrl = location.href.match(/tickets\/(\d+)/i);
    return fromUrl ? Number(fromUrl[1]) : null;
  }

  function extractTaskDisplayId(text) {
    const match = String(text || '').match(/#?TSK-(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function parseRgbColor(value) {
    const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?\)/i);
    if (!match) return null;
    const alpha = match[4] == null ? 1 : Number(match[4]);
    if (alpha < 0.2) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
    };
  }

  function colorBrightness(color) {
    return (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
  }

  function detectDarkPage() {
    const candidates = [
      document.body,
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.documentElement,
    ].filter(Boolean);

    for (const el of candidates) {
      const color = parseRgbColor(window.getComputedStyle(el).backgroundColor);
      if (color) return colorBrightness(color) < 128;
    }

    return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  }

  function syncThemeClass({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastThemeSyncAt < THEME_SYNC_THROTTLE_MS) return;
    lastThemeSyncAt = now;
    document.documentElement.classList.toggle('fsx-dark-mode', detectDarkPage());
  }

  const TOAST_DURATION_MS = {
    success: 3200,
    warning: 4800,
    error: 6500,
  };

  function showToast(message, type = 'success') {
    let toast = document.querySelector('.fsx-inline-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'fsx-inline-toast';
      document.documentElement.appendChild(toast);
    }
    toast.className = `fsx-inline-toast ${type}`;
    toast.textContent = message;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.remove();
    }, TOAST_DURATION_MS[type] || TOAST_DURATION_MS.success);
  }

  function normalizeAgentSearch(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function agentName(agent) {
    return String(agent?.name || agent?.email || '담당자').trim();
  }

  function agentForId(agentId) {
    return agentById.get(Number(agentId || 0)) || null;
  }

  function agentInitials(agent) {
    const name = agentName(agent);
    const words = name.split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    return `${Array.from(words[0])[0] || ''}${Array.from(words.at(-1))[0] || ''}`.toUpperCase();
  }

  function rebuildAgentLookup() {
    agentById = new Map();
    state.agents.forEach(agent => {
      agentById.set(Number(agent.id), agent);
    });
    agentsVersion += 1;
  }

  function displayNameForAgentId(agentId, fallback = '담당자 선택') {
    const agent = agentForId(agentId);
    if (agent) return agentName(agent);
    return agentId ? '담당자 지정됨' : fallback;
  }

  function agentSearchScore(agent, query) {
    if (!query) {
      if (Number(agent.id) === Number(state.currentAgentId)) return -2;
      if (Number(agent.id) === Number(agentPickerTarget?.selectedAgentId)) return -1;
      return 10;
    }

    const name = normalizeAgentSearch(agent.name);
    const email = normalizeAgentSearch(agent.email);
    const haystack = `${name} ${email}`;
    const tokens = query.split(' ').filter(Boolean);
    if (!tokens.every(token => haystack.includes(token))) return null;
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (name.split(' ').some(word => word.startsWith(query))) return 2;
    if (name.includes(query)) return 3;
    if (email.startsWith(query)) return 4;
    return 5;
  }

  function matchingAgents(queryValue) {
    const query = normalizeAgentSearch(queryValue);
    return state.agents
      .map(agent => ({ agent, score: agentSearchScore(agent, query) }))
      .filter(item => item.score != null)
      .sort((a, b) => a.score - b.score || agentName(a.agent).localeCompare(agentName(b.agent), 'ko'))
      .map(item => item.agent);
  }

  function closeAgentPicker() {
    const picker = document.querySelector('.fsx-agent-picker');
    if (agentPickerTarget?.anchor) {
      agentPickerTarget.anchor.setAttribute('aria-expanded', 'false');
    }
    if (picker) picker.hidden = true;
    agentPickerTarget = null;
    agentPickerIndex = 0;
  }

  function positionAgentPicker() {
    const picker = document.querySelector('.fsx-agent-picker');
    const anchor = agentPickerTarget?.anchor;
    if (!picker || picker.hidden || !anchor?.isConnected) return;

    const rect = anchor.getBoundingClientRect();
    const width = Math.min(340, Math.max(280, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    const below = rect.bottom + 8;
    const above = rect.top - picker.offsetHeight - 8;
    const top = below + picker.offsetHeight <= window.innerHeight - 12 ? below : Math.max(12, above);
    picker.style.width = `${width}px`;
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  }

  function ensureAgentPicker() {
    let picker = document.querySelector('.fsx-agent-picker');
    if (picker) return picker;

    picker = document.createElement('div');
    picker.className = 'fsx-agent-picker';
    picker.hidden = true;
    picker.innerHTML = `
      <div class="fsx-agent-picker-head">
        <span class="fsx-agent-search-icon" aria-hidden="true"></span>
        <input type="search" class="fsx-agent-search" placeholder="이름 또는 이메일 검색"
          autocomplete="off" spellcheck="false" aria-label="담당자 검색" aria-controls="fsx-agent-results">
        <button type="button" class="fsx-agent-picker-close" aria-label="담당자 검색 닫기">×</button>
      </div>
      <div class="fsx-agent-results" id="fsx-agent-results" role="listbox"></div>
      <div class="fsx-agent-picker-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</div>`;
    document.documentElement.appendChild(picker);
    return picker;
  }

  function renderAgentPickerResults(queryValue = '') {
    const picker = ensureAgentPicker();
    const results = picker.querySelector('.fsx-agent-results');
    const matched = matchingAgents(queryValue);
    const visible = matched.slice(0, AGENT_RESULT_LIMIT);
    agentPickerIndex = Math.max(0, Math.min(agentPickerIndex, Math.max(0, visible.length - 1)));

    if (!visible.length) {
      results.innerHTML = `
        <div class="fsx-agent-empty">
          <strong>검색 결과가 없습니다</strong>
          <span>이름이나 이메일 일부를 다시 입력해보세요.</span>
        </div>`;
      return;
    }

    results.innerHTML = visible.map((agent, index) => {
      const selected = Number(agent.id) === Number(agentPickerTarget?.selectedAgentId);
      const isMe = Number(agent.id) === Number(state.currentAgentId);
      return `
        <button type="button" class="fsx-agent-result ${index === agentPickerIndex ? 'active' : ''}"
          id="fsx-agent-result-${index}" role="option" aria-selected="${selected}"
          data-agent-id="${agent.id}" data-result-index="${index}">
          <span class="fsx-agent-avatar" aria-hidden="true">${escapeHtml(agentInitials(agent))}</span>
          <span class="fsx-agent-result-copy">
            <span class="fsx-agent-result-name">${escapeHtml(agentName(agent))}${isMe ? '<em>나</em>' : ''}</span>
            ${agent.email ? `<span class="fsx-agent-result-email">${escapeHtml(agent.email)}</span>` : ''}
          </span>
          ${selected ? '<span class="fsx-agent-selected" aria-label="현재 담당자">✓</span>' : ''}
        </button>`;
    }).join('');

    if (matched.length > visible.length) {
      results.insertAdjacentHTML('beforeend', `<div class="fsx-agent-more">${matched.length - visible.length}명 더 있음 · 검색어를 더 입력하세요</div>`);
    }

    const input = picker.querySelector('.fsx-agent-search');
    input?.setAttribute('aria-activedescendant', `fsx-agent-result-${agentPickerIndex}`);
  }

  function openAgentPicker(anchor) {
    const targetType = anchor.dataset.agentTarget;
    const taskId = targetType === 'task' ? Number(anchor.dataset.taskId) : null;
    const selectedAgentId = targetType === 'task' ? taskById(taskId)?.agent_id : bulkAgentId;
    const picker = ensureAgentPicker();
    const input = picker.querySelector('.fsx-agent-search');

    if (agentPickerTarget?.anchor && agentPickerTarget.anchor !== anchor) {
      agentPickerTarget.anchor.setAttribute('aria-expanded', 'false');
    }
    agentPickerTarget = { anchor, targetType, taskId, selectedAgentId: Number(selectedAgentId || 0) || null };
    agentPickerIndex = 0;
    anchor.setAttribute('aria-expanded', 'true');
    picker.hidden = false;
    input.value = '';
    renderAgentPickerResults();
    positionAgentPicker();
    window.requestAnimationFrame(() => input.focus());
  }

  function selectAgentFromPicker(agentId) {
    const target = agentPickerTarget;
    if (!target || !agentForId(agentId)) return;
    closeAgentPicker();
    if (target.targetType === 'task') {
      if (Number(taskById(target.taskId)?.agent_id) !== Number(agentId)) {
        updateTaskAgent(target.taskId, agentId);
      }
      return;
    }
    bulkAgentId = Number(agentId);
    injectInlineControls();
  }

  function patchTasks(updatedTasks) {
    if (!Array.isArray(updatedTasks) || !updatedTasks.length) return;
    const updates = new Map(updatedTasks.map(task => [Number(task.id), task]));
    state.tasks = state.tasks.map(task => updates.get(Number(task.id)) || task);
  }

  function applyContext(data) {
    if (Array.isArray(data?.agents)) {
      state.agents = data.agents;
      rebuildAgentLookup();
    }
    if (Object.prototype.hasOwnProperty.call(data || {}, 'me')) {
      state.currentAgentId = data.me ? Number(data.me) : null;
      if (!bulkAgentId && state.currentAgentId) bulkAgentId = state.currentAgentId;
    }
    if (data?.settings) state.settings = data.settings;
    if (Array.isArray(data?.tasks)) state.tasks = data.tasks;
    if (data?.task) patchTasks([data.task]);
    if (Array.isArray(data?.updated_tasks)) patchTasks(data.updated_tasks);
    state.loadedTicketId = state.ticketId;

    const validIds = new Set(state.tasks.map(task => Number(task.id)));
    state.selectedTaskIds.forEach(id => {
      if (!validIds.has(id)) state.selectedTaskIds.delete(id);
    });
  }

  function clearSelection() {
    state.selectedTaskIds.clear();
  }

  function sortedSelectedTaskIds() {
    return Array.from(state.selectedTaskIds).sort((a, b) => a - b);
  }

  function setSelection(predicate) {
    state.selectedTaskIds.clear();
    state.tasks.forEach(task => {
      if (predicate(task)) state.selectedTaskIds.add(Number(task.id));
    });
  }

  function selectionStats() {
    const selectedTasks = state.tasks.filter(task => state.selectedTaskIds.has(Number(task.id)));
    return {
      total: state.tasks.length,
      selected: selectedTasks.length,
      selectedOpen: selectedTasks.filter(task => !task.completed).length,
      selectedCompleted: selectedTasks.filter(task => task.completed).length,
      selectedUnassigned: selectedTasks.filter(task => !task.agent_id).length,
      open: state.tasks.filter(task => !task.completed).length,
      completed: state.tasks.filter(task => task.completed).length,
      unassigned: state.tasks.filter(task => !task.agent_id).length,
    };
  }

  async function loadContext({ force = false } = {}) {
    syncThemeClass({ force });
    state.ticketId = extractTicketId();
    if (!state.ticketId) return;
    if (!force && state.loadedTicketId === state.ticketId && state.tasks.length) {
      scheduleInlineControls();
      return;
    }
    if (contextLoadPromise) return contextLoadPromise;

    contextLoadPromise = (async () => {
      try {
        const response = await sendMessage('GET_TICKET_TASKS', { ticketId: state.ticketId });
        if (!response.ok) {
          if (response.status === 412 || response.code === 'SETTINGS_REQUIRED') {
            showToast(response.message || '확장 설정에서 FS_DOMAIN, FS_API_KEY를 저장해주세요.', 'warning');
            return;
          }
          throw new Error(response.message || '작업 목록을 불러오지 못했습니다.');
        }
        applyContext(response.data);
        scheduleInlineControls({ forceScan: true, delay: 0 });
      } catch (error) {
        state.error = error.message;
        showToast(error.message, 'error');
      } finally {
        contextLoadPromise = null;
      }
    })();

    return contextLoadPromise;
  }

  function taskById(id) {
    return state.tasks.find(task => Number(task.id) === Number(id)) || null;
  }

  function findMatchingTask(row) {
    const text = row.textContent || '';
    const displayId = extractTaskDisplayId(text);
    if (displayId) {
      const exact = taskById(displayId);
      if (exact) return exact;
    }

    const normalizedRow = normalizeTaskTitle(text);
    return state.tasks.find(task => {
      const title = normalizeTaskTitle(task.title);
      return title && normalizedRow.includes(title);
    }) || null;
  }

  function findTaskRowFromTextNode(node) {
    let el = node.parentElement;
    const candidates = [];
    for (let depth = 0; el && depth < 12; depth += 1, el = el.parentElement) {
      if (el.closest('.fsx-inline-controls')) return null;
      const text = el.textContent || '';
      if (!/#?TSK-\d+/i.test(text)) continue;
      const rect = el.getBoundingClientRect();
      const ids = new Set(Array.from(text.matchAll(/#?TSK-(\d+)/gi), match => match[1]));
      if (ids.size === 1 && rect.width >= 360 && rect.height >= 38 && rect.height <= 150) {
        candidates.push({ row: el, width: rect.width });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.width - a.width);
    return { row: candidates[0].row, anchor: node.parentElement };
  }

  function resetTaskRowCache() {
    taskRowCache = new Map();
  }

  function cachedTaskRows() {
    const rows = [];
    const validIds = new Set(state.tasks.map(task => Number(task.id)));
    taskRowCache.forEach((cached, taskId) => {
      const row = cached?.row;
      const anchor = cached?.anchor;
      const task = taskById(taskId);
      if (!task || !validIds.has(taskId) || !row?.isConnected || !anchor?.isConnected) {
        taskRowCache.delete(taskId);
        return;
      }
      rows.push({ row, anchor, task });
    });
    return rows;
  }

  function findTaskRows({ force = false } = {}) {
    if (!force) {
      const cached = cachedTaskRows();
      if (cached.length) return cached;
    }

    const rows = new Map();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches?.(EXTENSION_ROOT_SELECTOR)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_SKIP;
          }
          if (!/#?TSK-\d+/i.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    while (walker.nextNode()) {
      const match = findTaskRowFromTextNode(walker.currentNode);
      if (!match) continue;
      const { row, anchor } = match;
      const task = findMatchingTask(row);
      if (!task?.id) continue;
      rows.set(Number(task.id), { row, anchor, task });
    }

    taskRowCache = new Map(Array.from(rows.entries()).map(([taskId, item]) => [taskId, {
      row: item.row,
      anchor: item.anchor,
    }]));
    return Array.from(rows.values());
  }

  function statusOptions(task) {
    const statusValue = Number(task.status) || TASK_STATUS.OPEN;
    return [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETED]
      .map(value => `<option value="${value}" ${value === statusValue ? 'selected' : ''}>${TASK_STATUS_LABELS[value]}</option>`)
      .join('');
  }

  function renderControls(task) {
    const busy = state.busyTaskIds.has(String(task.id)) || state.bulkBusy;
    const disabled = busy ? 'disabled' : '';
    const statusValue = Number(task.status) || TASK_STATUS.OPEN;
    const agent = agentForId(task.agent_id);
    const agentTitle = agent?.email ? `${agentName(agent)} · ${agent.email}` : agentName(agent);

    return `
      <select class="fsx-inline-status fsx-inline-status-${statusValue}" data-task-id="${task.id}" ${disabled} title="작업 상태 변경" aria-label="작업 ${task.id} 상태">
        ${statusOptions(task)}
      </select>
      <button type="button" class="fsx-agent-trigger fsx-inline-agent-trigger" data-agent-target="task"
        data-task-id="${task.id}" aria-haspopup="listbox" aria-expanded="false" ${disabled}
        title="${escapeHtml(agentTitle || '담당자 검색')}" aria-label="작업 ${task.id} 담당자 변경">
        <span class="fsx-agent-trigger-avatar" aria-hidden="true">${escapeHtml(agent ? agentInitials(agent) : '+')}</span>
        <span class="fsx-agent-trigger-label">${escapeHtml(displayNameForAgentId(task.agent_id))}</span>
        <span class="fsx-agent-trigger-chevron" aria-hidden="true"></span>
      </button>
      ${busy ? '<span class="fsx-inline-spinner">처리중</span>' : ''}`;
  }

  function renderKeyFor(task) {
    return [
      task.id,
      Number(task.status) || 0,
      task.agent_id || '',
      agentsVersion,
      state.busyTaskIds.has(String(task.id)) ? 'busy' : 'idle',
      state.selectedTaskIds.has(Number(task.id)) ? 'sel' : 'unsel',
      state.bulkBusy ? 'bulk' : 'ready',
    ].join('::');
  }

  function unassignedTasks() {
    return state.tasks.filter(task => !task.agent_id);
  }

  function taskRowFromTarget(target) {
    return target?.closest?.('.fsx-inline-row') || null;
  }

  function taskIdFromRow(row) {
    const taskId = Number(row?.dataset?.fsxTaskId || 0);
    return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
  }

  function isDragSelectIgnoredTarget(target) {
    return !!target?.closest?.(
      '.fsx-inline-controls,.fsx-bulk-bar,a,button,input,select,textarea,[contenteditable="true"]'
    );
  }

  function setTaskSelected(taskId, selected) {
    if (!taskId) return false;
    const had = state.selectedTaskIds.has(taskId);
    if (selected) state.selectedTaskIds.add(taskId);
    else state.selectedTaskIds.delete(taskId);
    return had !== selected;
  }

  function applyDragSelection(row) {
    if (!dragSelect?.active || !row) return;
    const taskId = taskIdFromRow(row);
    if (!taskId || dragSelect.touched.has(taskId)) return;
    dragSelect.touched.add(taskId);
    if (setTaskSelected(taskId, dragSelect.shouldSelect)) {
      dragSelect.changedCount += 1;
      scheduleInlineControls({ delay: 0 });
    }
  }

  function sampleDragSelectionLine(x0, y0, x1, y1) {
    const distance = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(distance / DRAG_SAMPLE_STEP_PX));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      applyDragSelection(taskRowFromTarget(document.elementFromPoint(x, y)));
    }
  }

  function finishDragSelection() {
    if (!dragSelect) return;
    const changed = dragSelect.active ? dragSelect.changedCount : 0;
    const label = dragSelect.shouldSelect ? '선택' : '선택 해제';
    document.documentElement.classList.remove('fsx-drag-selecting');
    dragSelect = null;
    if (changed) {
      suppressClickUntil = Date.now() + 350;
      showToast(`${changed}개 작업 ${label} 완료`);
    }
  }

  function removeBulkBar() {
    if (agentPickerTarget?.anchor?.closest?.('.fsx-bulk-bar')) closeAgentPicker();
    document.querySelector('.fsx-bulk-bar')?.remove();
  }

  function renderBulkBar(rows) {
    if (!rows.length) {
      removeBulkBar();
      return;
    }

    let bar = document.querySelector('.fsx-bulk-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'fsx-bulk-bar';
      document.documentElement.appendChild(bar);
    }

    const stats = selectionStats();
    const count = stats.selected;
    const total = stats.total;
    const completed = stats.completed;
    const unassigned = stats.unassigned;

    const selectedTaskIdsKey = sortedSelectedTaskIds().join(',');
    const renderKey = [
      count,
      total,
      completed,
      unassigned,
      state.bulkBusy ? 'busy' : 'idle',
      selectedTaskIdsKey,
      state.currentAgentId || '',
      bulkAgentId || '',
      agentsVersion,
    ].join('::');
    if (bar.dataset.renderKey === renderKey) return;

    bar.dataset.renderKey = renderKey;
    bar.classList.toggle('fsx-bulk-bar-active', count > 0);
    bar.classList.toggle('fsx-bulk-bar-busy', state.bulkBusy);

    const disabled = state.bulkBusy ? 'disabled' : '';
    const selectedDisabled = count && !state.bulkBusy ? '' : 'disabled';
    const allSelected = total > 0 && count >= total;
    const openSelectDisabled = stats.open && !state.bulkBusy ? '' : 'disabled';
    const unassignedSelectDisabled = stats.unassigned && !state.bulkBusy ? '' : 'disabled';
    const assignUnassignedDisabled = stats.unassigned && !state.bulkBusy ? '' : 'disabled';
    const countLabel = count ? `${count}개 선택` : `작업 ${total}개`;
    const detailLabel = count
      ? `선택: 대기 ${stats.selectedOpen} · 완료 ${stats.selectedCompleted} · 미할당 ${stats.selectedUnassigned}`
      : `대기 ${stats.open} · 완료 ${stats.completed} · 미할당 ${stats.unassigned}`;
    const bulkAgent = agentForId(bulkAgentId);
    const runActions = count ? `
      <div class="fsx-bulk-actions fsx-bulk-run-actions" aria-label="선택 작업 실행">
        <button type="button" class="fsx-agent-trigger fsx-bulk-agent-trigger" data-agent-target="bulk"
          aria-haspopup="listbox" aria-expanded="false" ${disabled}
          title="${escapeHtml(bulkAgent?.email ? `${agentName(bulkAgent)} · ${bulkAgent.email}` : '일괄 담당자 검색')}">
          <span class="fsx-agent-trigger-avatar" aria-hidden="true">${escapeHtml(bulkAgent ? agentInitials(bulkAgent) : '+')}</span>
          <span class="fsx-agent-trigger-label">${escapeHtml(displayNameForAgentId(bulkAgentId))}</span>
          <span class="fsx-agent-trigger-chevron" aria-hidden="true"></span>
        </button>
        <button type="button" class="fsx-bulk-btn primary" data-action="bulk-complete" ${selectedDisabled}>완료</button>
        <button type="button" class="fsx-bulk-btn" data-action="bulk-open" ${selectedDisabled}>대기</button>
        ${unassigned ? `<button type="button" class="fsx-bulk-btn" data-action="bulk-assign-unassigned" ${assignUnassignedDisabled}>미할당 ${unassigned}개</button>` : ''}
        <button type="button" class="fsx-bulk-btn ghost muted" data-action="clear-selection" ${disabled}>해제</button>
        ${state.bulkBusy ? '<span class="fsx-inline-spinner">처리중…</span>' : ''}
      </div>` : '';

    bar.innerHTML = `
      <div class="fsx-bulk-summary">
        <span class="fsx-bulk-title" aria-hidden="true">✓</span>
        <span class="fsx-bulk-count ${count ? 'active' : ''}">${countLabel}</span>
        <span class="fsx-bulk-meta">${detailLabel}</span>
      </div>
      <div class="fsx-bulk-actions fsx-bulk-pick-actions" aria-label="작업 선택">
        <button type="button" class="fsx-bulk-btn ghost" data-action="${allSelected ? 'clear-selection' : 'select-all'}" ${disabled}>
          ${allSelected ? '전체 해제' : '전체'}
        </button>
        ${stats.open ? `<button type="button" class="fsx-bulk-btn ghost" data-action="select-open" ${openSelectDisabled}>대기 ${stats.open}</button>` : ''}
        ${stats.unassigned ? `<button type="button" class="fsx-bulk-btn ghost" data-action="select-unassigned" ${unassignedSelectDisabled}>미할당 ${stats.unassigned}</button>` : ''}
      </div>
      ${runActions}`;

  }

  function scheduleInlineControls({ forceScan = false, delay = DOM_UPDATE_DEBOUNCE_MS } = {}) {
    if (contextInvalidated) return;
    forceRowScanPending = forceRowScanPending || forceScan;
    if (renderTimerId || renderFrameId) return;
    renderTimerId = window.setTimeout(() => {
      renderTimerId = null;
      if (renderFrameId) window.cancelAnimationFrame(renderFrameId);
      renderFrameId = window.requestAnimationFrame(() => {
        renderFrameId = null;
        const shouldForceScan = forceRowScanPending;
        forceRowScanPending = false;
        injectInlineControls({ forceScan: shouldForceScan });
      });
    }, Math.max(0, delay));
  }

  function injectInlineControls({ forceScan = false } = {}) {
    syncThemeClass();
    if (!state.ticketId || !state.settings.configured || !state.tasks.length) {
      removeBulkBar();
      resetTaskRowCache();
      return;
    }

    const rows = findTaskRows({ force: forceScan });
    renderBulkBar(rows);

    rows.forEach(({ row, anchor, task }) => {
      const selected = state.selectedTaskIds.has(Number(task.id));
      row.classList.add('fsx-inline-row');
      row.classList.toggle('fsx-inline-selected', selected);
      row.classList.toggle('fsx-inline-completed', !!task.completed);
      row.dataset.fsxTaskId = String(task.id);
      row.title = row.title || '클릭하거나 드래그하면 작업을 선택/해제할 수 있습니다';
      let controls = row.querySelector(`.fsx-inline-controls[data-task-id="${task.id}"]`);
      if (!controls) {
        controls = document.createElement('span');
        controls.className = 'fsx-inline-controls';
      }
      if (anchor?.parentElement && controls.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement('afterend', controls);
      }
      controls.classList.toggle('fsx-inline-controls-selected', selected);
      controls.dataset.taskId = String(task.id);
      const renderKey = renderKeyFor(task);
      if (controls.dataset.renderKey !== renderKey) {
        controls.dataset.renderKey = renderKey;
        controls.innerHTML = renderControls(task);
      }
    });
  }

  async function updateTaskStatus(taskId, status) {
    const key = String(taskId);
    const statusValue = Number(status) || TASK_STATUS.OPEN;
    state.busyTaskIds.add(key);
    injectInlineControls();
    try {
      const response = await sendMessage('UPDATE_TASK_STATUS', {
        ticketId: state.ticketId,
        taskId: Number(taskId),
        status: statusValue,
      });
      if (!response.ok) throw new Error(response.message || '작업 상태 변경에 실패했습니다.');
      applyContext(response.data);
      showToast(`${TASK_STATUS_LABELS[statusValue] || '대기'} 상태로 변경했습니다.`);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      state.busyTaskIds.delete(key);
      injectInlineControls();
    }
  }

  async function updateTaskAgent(taskId, agentId) {
    if (!agentId) return;
    const key = String(taskId);
    state.busyTaskIds.add(key);
    injectInlineControls();
    try {
      const response = await sendMessage('UPDATE_TASK_AGENT', {
        ticketId: state.ticketId,
        taskId: Number(taskId),
        agentId: Number(agentId),
      });
      if (!response.ok) throw new Error(response.message || '에이전트 할당에 실패했습니다.');
      applyContext(response.data);
      const agent = state.agents.find(item => Number(item.id) === Number(agentId));
      showToast(`${agent?.name || '에이전트'} 할당 완료`);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      state.busyTaskIds.delete(key);
      injectInlineControls();
    }
  }

  async function runBulkUpdate(taskIds, updates, successLabel) {
    if (state.bulkBusy) return;
    if (!taskIds.length) {
      showToast('처리할 작업이 없습니다. 작업 행의 "선택"을 먼저 체크해주세요.', 'warning');
      return;
    }
    if (taskIds.length > BULK_CONFIRM_THRESHOLD &&
        !window.confirm(`작업 ${taskIds.length}건을 한 번에 변경합니다. 진행할까요?`)) {
      return;
    }

    state.bulkBusy = true;
    taskIds.forEach(id => state.busyTaskIds.add(String(id)));
    injectInlineControls();

    try {
      const response = await sendMessage('BULK_UPDATE_TASKS', {
        ticketId: state.ticketId,
        taskIds,
        ...updates,
      });
      if (!response.ok) throw new Error(response.message || '일괄 처리에 실패했습니다.');
      applyContext(response.data);

      const bulk = response.data?.bulk || { succeeded: taskIds.length, failed: 0, failures: [] };
      if (bulk.failed) {
        state.selectedTaskIds = new Set(bulk.failures.map(item => Number(item.task_id)));
        const first = bulk.failures[0];
        showToast(`${bulk.succeeded}건 성공, ${bulk.failed}건 실패 — ${first.title}: ${first.message}`, 'warning');
      } else {
        taskIds.forEach(id => state.selectedTaskIds.delete(Number(id)));
        showToast(`${bulk.succeeded}건 ${successLabel}`);
      }
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      state.bulkBusy = false;
      taskIds.forEach(id => state.busyTaskIds.delete(String(id)));
      injectInlineControls();
    }
  }

  function handleBulkAction(action) {
    if (state.bulkBusy) return;

    if (action === 'select-all') {
      state.tasks.forEach(task => state.selectedTaskIds.add(Number(task.id)));
      injectInlineControls();
      return;
    }
    if (action === 'select-open') {
      setSelection(task => !task.completed);
      injectInlineControls();
      return;
    }
    if (action === 'select-unassigned') {
      setSelection(task => !task.agent_id);
      injectInlineControls();
      return;
    }
    if (action === 'clear-selection') {
      clearSelection();
      injectInlineControls();
      return;
    }
    if (action === 'bulk-complete' || action === 'bulk-open') {
      const agentId = Number(bulkAgentId || 0) || null;
      const status = action === 'bulk-complete' ? TASK_STATUS.COMPLETED : TASK_STATUS.OPEN;
      const updates = { status };
      const baseLabel = action === 'bulk-complete' ? '완료 처리' : '대기 상태로 변경';
      let successLabel = `${baseLabel}했습니다.`;
      if (agentId) {
        updates.agentId = agentId;
        const agent = state.agents.find(item => Number(item.id) === agentId);
        successLabel = `${baseLabel} · ${agent?.name || '에이전트'} 할당 완료`;
      }
      runBulkUpdate(sortedSelectedTaskIds(), updates, successLabel);
      return;
    }
    if (action === 'bulk-assign-unassigned') {
      const agentId = Number(bulkAgentId || 0) || null;
      if (!agentId) {
        showToast('먼저 일괄 할당할 담당자를 선택해주세요.', 'warning');
        return;
      }
      const agent = state.agents.find(item => Number(item.id) === agentId);
      const targets = unassignedTasks().map(task => Number(task.id));
      if (!targets.length) {
        showToast('담당 에이전트가 없는 작업이 없습니다.', 'warning');
        return;
      }
      runBulkUpdate(targets, { agentId }, `${agent?.name || '에이전트'} 할당 완료 (미할당 작업)`);
    }
  }

  function handleChange(event) {
    const statusSelect = event.target.closest('.fsx-inline-status');
    if (statusSelect) {
      updateTaskStatus(statusSelect.dataset.taskId, statusSelect.value);
    }
  }

  function handleInput(event) {
    if (!event.target.matches('.fsx-agent-search')) return;
    agentPickerIndex = 0;
    renderAgentPickerResults(event.target.value);
  }

  function handleKeyDown(event) {
    if (!event.target.matches('.fsx-agent-search')) return;
    const picker = event.target.closest('.fsx-agent-picker');
    const resultButtons = Array.from(picker?.querySelectorAll('.fsx-agent-result') || []);

    if (event.key === 'Escape') {
      event.preventDefault();
      const anchor = agentPickerTarget?.anchor;
      closeAgentPicker();
      anchor?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!resultButtons.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      agentPickerIndex = (agentPickerIndex + delta + resultButtons.length) % resultButtons.length;
      renderAgentPickerResults(event.target.value);
      picker?.querySelector('.fsx-agent-result.active')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && resultButtons.length) {
      event.preventDefault();
      const agentId = Number(resultButtons[agentPickerIndex]?.dataset.agentId || 0);
      if (agentId) selectAgentFromPicker(agentId);
    }
  }

  function handlePointerDown(event) {
    if (state.bulkBusy || event.button !== 0 || isDragSelectIgnoredTarget(event.target)) return;
    const row = taskRowFromTarget(event.target);
    const taskId = taskIdFromRow(row);
    if (!taskId) return;

    dragSelect = {
      active: false,
      pointerId: event.pointerId,
      shouldSelect: !state.selectedTaskIds.has(taskId),
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startRow: row,
      touched: new Set(),
      changedCount: 0,
    };
    try {
      row.setPointerCapture?.(event.pointerId);
    } catch (_) {
      // Pointer capture is best-effort; document listeners still handle the drag.
    }
  }

  function handlePointerMove(event) {
    if (!dragSelect || dragSelect.pointerId !== event.pointerId || state.bulkBusy) return;

    const distance = Math.hypot(event.clientX - dragSelect.startX, event.clientY - dragSelect.startY);
    if (!dragSelect.active) {
      if (distance < DRAG_SELECT_THRESHOLD_PX) return;
      dragSelect.active = true;
      document.documentElement.classList.add('fsx-drag-selecting');
      applyDragSelection(dragSelect.startRow);
      dragSelect.lastX = dragSelect.startX;
      dragSelect.lastY = dragSelect.startY;
    }

    event.preventDefault();
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const points = coalesced.length ? coalesced : [event];
    points.forEach(point => {
      sampleDragSelectionLine(dragSelect.lastX, dragSelect.lastY, point.clientX, point.clientY);
      dragSelect.lastX = point.clientX;
      dragSelect.lastY = point.clientY;
    });
  }

  function handlePointerEnd(event) {
    if (!dragSelect || dragSelect.pointerId !== event.pointerId) return;
    finishDragSelection();
  }

  function handleClick(event) {
    if (Date.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    const agentResult = event.target.closest('.fsx-agent-result');
    if (agentResult) {
      event.stopPropagation();
      event.preventDefault();
      selectAgentFromPicker(Number(agentResult.dataset.agentId));
      return;
    }

    if (event.target.closest('.fsx-agent-picker-close')) {
      event.stopPropagation();
      event.preventDefault();
      const anchor = agentPickerTarget?.anchor;
      closeAgentPicker();
      anchor?.focus();
      return;
    }

    const agentTrigger = event.target.closest('.fsx-agent-trigger');
    if (agentTrigger) {
      event.stopPropagation();
      event.preventDefault();
      if (agentPickerTarget?.anchor === agentTrigger) closeAgentPicker();
      else openAgentPicker(agentTrigger);
      return;
    }

    if (agentPickerTarget && !event.target.closest('.fsx-agent-picker')) closeAgentPicker();

    const bulkButton = event.target.closest('.fsx-bulk-bar [data-action]');
    if (bulkButton) {
      event.stopPropagation();
      event.preventDefault();
      handleBulkAction(bulkButton.dataset.action);
      return;
    }

    if (event.target.closest('.fsx-inline-controls,.fsx-bulk-bar')) {
      event.stopPropagation();
      return;
    }

    const row = taskRowFromTarget(event.target);
    const taskId = taskIdFromRow(row);
    if (!taskId || state.bulkBusy || isDragSelectIgnoredTarget(event.target)) return;

    event.stopPropagation();
    event.preventDefault();
    setTaskSelected(taskId, !state.selectedTaskIds.has(taskId));
    injectInlineControls();
  }

  function handleScroll(event) {
    if (!agentPickerTarget || event.target?.closest?.('.fsx-agent-results')) return;
    closeAgentPicker();
  }

  function clearInjectedControls() {
    closeAgentPicker();
    document.querySelectorAll('.fsx-inline-controls').forEach(controls => controls.remove());
    document.querySelectorAll('.fsx-inline-row').forEach(row => {
      row.classList.remove('fsx-inline-row', 'fsx-inline-selected', 'fsx-inline-completed');
      delete row.dataset.fsxTaskId;
    });
    removeBulkBar();
    resetTaskRowCache();
  }

  function handlePossibleNavigation() {
    const nextUrl = location.href;
    const nextTicketId = extractTicketId();
    if (nextUrl === lastUrl && nextTicketId === state.ticketId) return false;

    lastUrl = nextUrl;
    if (nextTicketId === state.ticketId) {
      if (nextTicketId) scheduleInlineControls({ forceScan: true });
      return true;
    }

    state.ticketId = nextTicketId;
    state.loadedTicketId = null;
    state.tasks = [];
    state.agents = [];
    state.currentAgentId = null;
    bulkAgentId = null;
    rebuildAgentLookup();
    clearSelection();
    clearInjectedControls();
    if (nextTicketId) loadContext({ force: true });
    return true;
  }

  function elementForNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isInsideExtensionUi(node) {
    return !!elementForNode(node)?.closest?.(EXTENSION_ROOT_SELECTOR);
  }

  function isExtensionRootNode(node) {
    const element = elementForNode(node);
    return !!element?.matches?.(EXTENSION_ROOT_SELECTOR);
  }

  function nodeContainsTaskHint(node) {
    if (!node || isInsideExtensionUi(node)) return false;
    if (node.nodeType === Node.TEXT_NODE) return /#?TSK-\d+/i.test(node.nodeValue || '');
    return /#?TSK-\d+/i.test(node.textContent || '');
  }

  function handlePageMutations(records) {
    if (contextInvalidated || handlePossibleNavigation()) return;
    if (!state.ticketId || !state.tasks.length) return;

    let forceScan = false;
    let repairControls = false;

    records.forEach(record => {
      if (isInsideExtensionUi(record.target)) return;

      const added = Array.from(record.addedNodes || []);
      const removed = Array.from(record.removedNodes || []);
      if (added.length && !removed.length && added.every(isExtensionRootNode)) return;

      if (record.type === 'characterData' && nodeContainsTaskHint(record.target)) forceScan = true;
      if (added.some(nodeContainsTaskHint) || removed.some(nodeContainsTaskHint)) forceScan = true;
      if (removed.some(isExtensionRootNode)) repairControls = true;
      if (elementForNode(record.target)?.closest?.('.fsx-inline-row')) repairControls = true;
    });

    if (!forceScan) {
      for (const [taskId, cached] of taskRowCache.entries()) {
        const row = cached?.row;
        const anchor = cached?.anchor;
        if (!row?.isConnected || !anchor?.isConnected) {
          forceScan = true;
          break;
        }
        if (!row.querySelector(`.fsx-inline-controls[data-task-id="${taskId}"]`)) repairControls = true;
      }
    }

    if (forceScan || repairControls) scheduleInlineControls({ forceScan });
  }

  function watchPage() {
    watchIntervalId = setInterval(() => {
      if (contextInvalidated) return;
      syncThemeClass();
      handlePossibleNavigation();
    }, URL_CHECK_INTERVAL_MS);

    pageObserver = new MutationObserver(handlePageMutations);
    pageObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  document.addEventListener('change', handleChange, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerEnd, true);
  document.addEventListener('pointercancel', handlePointerEnd, true);
  document.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', positionAgentPicker);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.fsDomain && !changes.fsApiKey) return;
    state.loadedTicketId = null;
    state.tasks = [];
    state.agents = [];
    state.currentAgentId = null;
    bulkAgentId = null;
    rebuildAgentLookup();
    clearSelection();
    clearInjectedControls();
    loadContext({ force: true });
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    syncThemeClass({ force: true });
  });
  loadContext({ force: true });
  watchPage();
})();
