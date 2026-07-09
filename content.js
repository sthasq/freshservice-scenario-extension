(function () {
  const TASK_STATUS = {
    OPEN: 1,
    COMPLETED: 3,
  };

  const state = {
    agents: [],
    bulkBusy: false,
    busyTaskIds: new Set(),
    error: '',
    loadedTicketId: null,
    message: '',
    selectedTaskIds: new Set(),
    settings: { configured: false, fsDomain: '', hasApiKey: false },
    tasks: [],
    ticketId: null,
  };

  const BULK_CONFIRM_THRESHOLD = 5;
  const DRAG_SELECT_THRESHOLD_PX = 6;

  let contextLoadPromise = null;
  let dragSelect = null;
  let suppressClickUntil = 0;
  let toastTimer = null;

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

  function sendMessage(type, payload = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: chrome.runtime.lastError.message, status: 0 });
          return;
        }
        resolve(response || { ok: false, message: '확장 응답이 없습니다.', status: 0 });
      });
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

  function syncThemeClass() {
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

  function applyContext(data) {
    state.agents = data?.agents || state.agents || [];
    state.settings = data?.settings || state.settings;
    state.tasks = data?.tasks || state.tasks || [];
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

  async function loadSettings() {
    const response = await sendMessage('GET_SETTINGS_STATUS');
    if (!response.ok) throw new Error(response.message || '설정을 불러오지 못했습니다.');
    state.settings = response.data?.settings || state.settings;
    return state.settings;
  }

  async function loadContext({ force = false } = {}) {
    syncThemeClass();
    state.ticketId = extractTicketId();
    if (!state.ticketId) return;
    if (!force && state.loadedTicketId === state.ticketId && state.tasks.length) {
      injectInlineControls();
      return;
    }
    if (contextLoadPromise) return contextLoadPromise;

    contextLoadPromise = (async () => {
      try {
        await loadSettings();
        if (!state.settings.configured) {
          showToast('확장 설정에서 FS_DOMAIN, FS_API_KEY를 저장해주세요.', 'warning');
          return;
        }
        const response = await sendMessage('GET_TICKET_TASKS', { ticketId: state.ticketId });
        if (!response.ok) throw new Error(response.message || '작업 목록을 불러오지 못했습니다.');
        applyContext(response.data);
        injectInlineControls();
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
    for (let depth = 0; el && depth < 9; depth += 1, el = el.parentElement) {
      if (el.closest('.fsx-inline-controls')) return null;
      const text = el.textContent || '';
      if (!/#?TSK-\d+/i.test(text)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 360 && rect.height >= 38 && rect.height <= 150) return el;
    }
    return null;
  }

  function findTaskRows() {
    const rows = new Map();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!/#?TSK-\d+/i.test(node.nodeValue || '')) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('.fsx-inline-controls,.fsx-inline-toast')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    while (walker.nextNode()) {
      const row = findTaskRowFromTextNode(walker.currentNode);
      if (!row) continue;
      const task = findMatchingTask(row);
      if (!task?.id) continue;
      rows.set(Number(task.id), { row, task });
    }

    return Array.from(rows.values());
  }

  function agentOptions(task) {
    const selectedId = Number(task.agent_id || 0);
    const options = ['<option value="">에이전트 할당</option>'];
    let hasSelected = !selectedId;

    state.agents.forEach(agent => {
      const selected = Number(agent.id) === selectedId ? 'selected' : '';
      if (selected) hasSelected = true;
      const label = agent.email ? `${agent.name} (${agent.email})` : agent.name;
      options.push(`<option value="${agent.id}" ${selected}>${escapeHtml(label)}</option>`);
    });

    if (selectedId && !hasSelected) {
      options.push(`<option value="${selectedId}" selected>현재 담당자 #${selectedId}</option>`);
    }
    return options.join('');
  }

  function renderControls(task) {
    const busy = state.busyTaskIds.has(String(task.id)) || state.bulkBusy;
    const checked = task.completed ? 'checked' : '';
    const selected = state.selectedTaskIds.has(Number(task.id)) ? 'checked' : '';
    const disabled = busy ? 'disabled' : '';
    const selectedLabel = selected ? '선택됨' : '선택';
    const selectedClass = selected ? ' fsx-inline-pick-selected' : '';
    const doneLabel = task.completed ? '완료됨' : '완료';

    return `
      <label class="fsx-inline-check fsx-inline-pick${selectedClass}" title="일괄 처리 대상으로 선택">
        <input type="checkbox" class="fsx-inline-select" data-task-id="${task.id}" aria-label="작업 ${task.id} 선택" ${selected} ${state.bulkBusy ? 'disabled' : ''}>
        <span>${selectedLabel}</span>
      </label>
      <label class="fsx-inline-check" title="완료 상태로 변경">
        <input type="checkbox" class="fsx-inline-done" data-task-id="${task.id}" aria-label="작업 ${task.id} 완료 상태" ${checked} ${disabled}>
        <span>${doneLabel}</span>
      </label>
      <select class="fsx-inline-agent" data-task-id="${task.id}" ${disabled} title="에이전트 할당" aria-label="작업 ${task.id} 담당자 할당">
        ${agentOptions(task)}
      </select>
      ${busy ? '<span class="fsx-inline-spinner">처리중</span>' : ''}`;
  }

  function renderKeyFor(task) {
    return [
      task.id,
      task.completed ? 'done' : 'open',
      task.agent_id || '',
      state.agents.map(agent => `${agent.id}:${agent.name}:${agent.email}`).join('|'),
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
      injectInlineControls();
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
    document.querySelector('.fsx-bulk-bar')?.remove();
  }

  function renderBulkBar(rows) {
    if (!rows.length) {
      removeBulkBar();
      return;
    }

    const anchor = rows[0].row;
    let bar = document.querySelector('.fsx-bulk-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'fsx-bulk-bar';
    }
    if (bar.parentElement !== anchor.parentElement || bar.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(bar, anchor);
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
      state.agents.map(agent => `${agent.id}:${agent.name}`).join('|'),
    ].join('::');
    if (bar.dataset.renderKey === renderKey) return;

    const prevAgentValue = bar.querySelector('.fsx-bulk-agent')?.value || '';
    bar.dataset.renderKey = renderKey;
    bar.classList.toggle('fsx-bulk-bar-active', count > 0);
    bar.classList.toggle('fsx-bulk-bar-busy', state.bulkBusy);

    const disabled = state.bulkBusy ? 'disabled' : '';
    const selectedDisabled = count && !state.bulkBusy ? '' : 'disabled';
    const allSelected = total > 0 && count >= total;
    const clearDisabled = count && !state.bulkBusy ? '' : 'disabled';
    const openSelectDisabled = stats.open && !state.bulkBusy ? '' : 'disabled';
    const unassignedSelectDisabled = stats.unassigned && !state.bulkBusy ? '' : 'disabled';
    const assignUnassignedDisabled = stats.unassigned && !state.bulkBusy ? '' : 'disabled';
    const countLabel = count ? `${count}/${total} 선택` : `작업 ${total}개`;
    const detailLabel = count
      ? `선택: 대기 ${stats.selectedOpen} · 완료 ${stats.selectedCompleted} · 미할당 ${stats.selectedUnassigned}`
      : `대기 ${stats.open} · 완료 ${stats.completed} · 미할당 ${stats.unassigned}`;
    const agentOptionsHtml = ['<option value="">에이전트 선택</option>']
      .concat(state.agents.map(agent => {
        const label = agent.email ? `${agent.name} (${agent.email})` : agent.name;
        return `<option value="${agent.id}">${escapeHtml(label)}</option>`;
      }))
      .join('');

    bar.innerHTML = `
      <div class="fsx-bulk-summary">
        <span class="fsx-bulk-title">작업 컨트롤</span>
        <span class="fsx-bulk-count ${count ? 'active' : ''}">${countLabel}</span>
        <span class="fsx-bulk-meta">${detailLabel}</span>
      </div>
      <div class="fsx-bulk-actions fsx-bulk-pick-actions" aria-label="작업 선택">
        <button type="button" class="fsx-bulk-btn ghost" data-action="${allSelected ? 'clear-selection' : 'select-all'}" ${disabled}>
          ${allSelected ? '전체 해제' : '전체 선택'}
        </button>
        <button type="button" class="fsx-bulk-btn ghost" data-action="select-open" ${openSelectDisabled}>대기만 선택</button>
        <button type="button" class="fsx-bulk-btn ghost" data-action="select-unassigned" ${unassignedSelectDisabled}>미할당 선택</button>
        <button type="button" class="fsx-bulk-btn ghost muted" data-action="clear-selection" ${clearDisabled}>선택 비우기</button>
      </div>
      <div class="fsx-bulk-actions fsx-bulk-run-actions" aria-label="선택 작업 실행">
        <button type="button" class="fsx-bulk-btn primary" data-action="bulk-complete" ${selectedDisabled}>완료 처리</button>
        <button type="button" class="fsx-bulk-btn" data-action="bulk-open" ${selectedDisabled}>대기 전환</button>
        <span class="fsx-bulk-divider"></span>
        <select class="fsx-bulk-agent" ${disabled} title="일괄 할당할 에이전트" aria-label="일괄 할당할 에이전트">${agentOptionsHtml}</select>
        <button type="button" class="fsx-bulk-btn" data-action="bulk-assign" ${selectedDisabled}>담당자 적용</button>
        <button type="button" class="fsx-bulk-btn" data-action="bulk-assign-unassigned" ${assignUnassignedDisabled}
          title="담당 에이전트가 없는 작업에만 할당합니다">미할당만 적용${unassigned ? ` (${unassigned})` : ''}</button>
        ${state.bulkBusy ? '<span class="fsx-inline-spinner">처리중…</span>' : ''}
      </div>`;

    const agentSelect = bar.querySelector('.fsx-bulk-agent');
    if (agentSelect && prevAgentValue) agentSelect.value = prevAgentValue;
  }

  function injectInlineControls() {
    syncThemeClass();
    if (!state.ticketId || !state.settings.configured || !state.tasks.length) {
      removeBulkBar();
      return;
    }

    const rows = findTaskRows();
    renderBulkBar(rows);

    rows.forEach(({ row, task }) => {
      const selected = state.selectedTaskIds.has(Number(task.id));
      row.classList.add('fsx-inline-row');
      row.classList.toggle('fsx-inline-selected', selected);
      row.dataset.fsxTaskId = String(task.id);
      row.title = row.title || '드래그하면 여러 작업을 선택/해제할 수 있습니다';
      let controls = row.querySelector(':scope > .fsx-inline-controls');
      if (!controls) {
        controls = document.createElement('div');
        controls.className = 'fsx-inline-controls';
        row.appendChild(controls);
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

  async function updateTaskStatus(taskId, checked) {
    const key = String(taskId);
    state.busyTaskIds.add(key);
    injectInlineControls();
    try {
      const response = await sendMessage('UPDATE_TASK_STATUS', {
        ticketId: state.ticketId,
        taskId: Number(taskId),
        status: checked ? TASK_STATUS.COMPLETED : TASK_STATUS.OPEN,
      });
      if (!response.ok) throw new Error(response.message || '작업 상태 변경에 실패했습니다.');
      applyContext(response.data);
      showToast(checked ? '완료 처리했습니다.' : '대기 상태로 변경했습니다.');
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
    if (action === 'bulk-complete') {
      runBulkUpdate(sortedSelectedTaskIds(), { status: TASK_STATUS.COMPLETED }, '완료 처리했습니다.');
      return;
    }
    if (action === 'bulk-open') {
      runBulkUpdate(sortedSelectedTaskIds(), { status: TASK_STATUS.OPEN }, '대기 상태로 변경했습니다.');
      return;
    }
    if (action === 'bulk-assign' || action === 'bulk-assign-unassigned') {
      const select = document.querySelector('.fsx-bulk-agent');
      const agentId = Number(select?.value || 0);
      if (!agentId) {
        showToast('일괄 할당할 에이전트를 먼저 선택해주세요.', 'warning');
        return;
      }
      const agent = state.agents.find(item => Number(item.id) === agentId);

      if (action === 'bulk-assign-unassigned') {
        const targets = unassignedTasks().map(task => Number(task.id));
        if (!targets.length) {
          showToast('담당 에이전트가 없는 작업이 없습니다.', 'warning');
          return;
        }
        runBulkUpdate(targets, { agentId }, `${agent?.name || '에이전트'} 할당 완료 (미할당 작업)`);
        return;
      }

      runBulkUpdate(sortedSelectedTaskIds(), { agentId }, `${agent?.name || '에이전트'} 할당 완료`);
    }
  }

  function handleChange(event) {
    const selectInput = event.target.closest('.fsx-inline-select');
    if (selectInput) {
      const taskId = Number(selectInput.dataset.taskId);
      if (selectInput.checked) state.selectedTaskIds.add(taskId);
      else state.selectedTaskIds.delete(taskId);
      injectInlineControls();
      return;
    }

    const statusInput = event.target.closest('.fsx-inline-done');
    if (statusInput) {
      updateTaskStatus(statusInput.dataset.taskId, statusInput.checked);
      return;
    }

    const agentSelect = event.target.closest('.fsx-inline-agent');
    if (agentSelect) {
      updateTaskAgent(agentSelect.dataset.taskId, agentSelect.value);
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
    }

    event.preventDefault();
    const row = taskRowFromTarget(document.elementFromPoint(event.clientX, event.clientY));
    applyDragSelection(row);
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

    const bulkButton = event.target.closest('.fsx-bulk-bar [data-action]');
    if (bulkButton) {
      event.stopPropagation();
      event.preventDefault();
      handleBulkAction(bulkButton.dataset.action);
      return;
    }

    if (!event.target.closest('.fsx-inline-controls,.fsx-bulk-bar')) return;
    event.stopPropagation();
  }

  function watchPage() {
    let lastUrl = location.href;
    setInterval(() => {
      syncThemeClass();
      const nextTicketId = extractTicketId();
      if (location.href !== lastUrl || nextTicketId !== state.ticketId) {
        lastUrl = location.href;
        state.ticketId = nextTicketId;
        state.loadedTicketId = null;
        state.tasks = [];
        state.agents = [];
        clearSelection();
        loadContext({ force: true });
      } else {
        injectInlineControls();
      }
    }, 1200);

    const observer = new MutationObserver(() => {
      syncThemeClass();
      injectInlineControls();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('change', handleChange, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerEnd, true);
  document.addEventListener('pointercancel', handlePointerEnd, true);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.fsDomain && !changes.fsApiKey) return;
    state.loadedTicketId = null;
    state.tasks = [];
    state.agents = [];
    clearSelection();
    loadContext({ force: true });
  });
  loadContext({ force: true });
  watchPage();
})();
