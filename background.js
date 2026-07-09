const STORAGE_DEFAULTS = {
  fsDomain: '',
  fsApiKey: '',
};

const TASK_STATUS = {
  OPEN: 1,
  COMPLETED: 3,
};

const AGENT_CACHE_TTL_MS = 10 * 60 * 1000;
const BULK_UPDATE_MAX_TASKS = 50;
const BULK_UPDATE_DELAY_MS = 150;
let agentCache = { domain: '', at: 0, agents: [] };

const TASK_SCENARIO_TEMPLATES = [
  {
    id: 'asset-replacement',
    title: 'OA 장비 교체',
    short_title: '장비 교체',
    description: '기존 OA 장비를 반납받고 새 장비를 지급하는 흐름입니다.',
    tasks: [
      { code: 'assign-new-asset', title: 'FreshService 자산할당', description: '지급 장비를 사용자에게 할당합니다.' },
      { code: 'setup-new-asset', title: '자산 Setting', description: '계정, 보안 정책, 기본 프로그램을 세팅합니다.' },
      { code: 'register-wifi-mac', title: 'Wifi Mac 등록', description: '무선 네트워크 사용이 필요한 장비의 MAC 주소를 등록합니다.' },
      { code: 'inspect-returned-asset', title: '반납 자산 검수', description: '기존 장비의 외관, 구성품, 고장 여부를 확인합니다.' },
      { code: 'unassign-returned-asset', title: 'FreshService 자산할당해제', description: '반납 장비의 사용자 할당을 해제합니다.' },
      { code: 'remove-wifi-mac', title: 'Wifi Mac 해제', description: '반납 장비의 무선 MAC 주소를 해제합니다.' },
      { code: 'wipe-returned-asset', title: '자산 Wiping', description: '반납 장비의 사용자 데이터를 삭제하고 초기화합니다.' },
      { code: 'share-user-info', title: '사용자정보(암호) 확인 및 전달', description: '사용자에게 장비 전달 정보와 임시 암호를 안내합니다.' },
    ],
  },
  {
    id: 'asset-provision',
    title: '노트북 지급',
    short_title: '장비 지급',
    description: '신규 또는 추가 지급 장비를 사용자에게 세팅해 전달하는 흐름입니다.',
    tasks: [
      { code: 'assign-asset', title: 'FreshService 자산할당', description: '지급 장비를 사용자에게 할당합니다.' },
      { code: 'setup-asset', title: '자산 Setting', description: '계정, 보안 정책, 기본 프로그램을 세팅합니다.' },
      { code: 'register-wifi-mac', title: 'Wifi Mac 등록', description: '무선 네트워크 사용이 필요한 장비의 MAC 주소를 등록합니다.' },
      { code: 'share-user-info', title: '사용자정보(암호) 확인 및 전달', description: '사용자에게 장비 전달 정보와 임시 암호를 안내합니다.' },
    ],
  },
  {
    id: 'asset-return',
    title: 'PC/노트북 반납',
    short_title: 'MAC 해제 반납',
    description: 'PC, 노트북처럼 MAC 해제와 데이터 삭제가 필요한 자산 반납 흐름입니다.',
    tasks: [
      { code: 'confirm-return-reason', title: '반납 사유/사용자 유형 확인', description: '퇴사, 전환, 교체 등 반납 사유와 사용자 유형을 확인합니다.' },
      { code: 'send-return-guide', title: '반납 안내 메일 전송', description: '반납 방법, 일정, 구성품 안내를 사용자에게 전달합니다.' },
      { code: 'inspect-returned-asset', title: '반납 자산 검수', description: '반납 장비의 외관, 구성품, 고장 여부를 확인합니다.' },
      { code: 'unassign-returned-asset', title: 'FreshService 자산할당해제', description: '반납 장비의 사용자 할당을 해제합니다.' },
      { code: 'remove-wifi-mac', title: 'Wifi Mac 해제', description: '반납 장비의 무선 MAC 주소를 해제합니다.' },
      { code: 'wipe-returned-asset', title: '자산 Wiping', description: '반납 장비의 사용자 데이터를 삭제하고 초기화합니다.' },
      { code: 'close-return-request', title: '사용자 처리 완료 안내', description: '처리 완료 사실을 사용자 또는 요청자에게 안내합니다.' },
    ],
  },
  {
    id: 'asset-return-basic',
    title: '모니터/주변기기 반납',
    short_title: '일반 반납',
    description: 'MAC 주소 삭제가 필요 없는 모니터, 키보드, 마우스, 어댑터 등 주변기기 반납 흐름입니다.',
    tasks: [
      { code: 'identify-returned-asset', title: '반납 자산 식별', description: '반납 대상 자산 태그와 구성품을 확인합니다.' },
      { code: 'inspect-returned-asset', title: '반납 자산 검수', description: '외관, 구성품, 고장 여부를 확인합니다.' },
      { code: 'unassign-returned-asset', title: 'FreshService 자산할당해제', description: '반납 자산의 사용자 할당을 해제합니다.' },
      { code: 'update-stock-status', title: '자산 상태/보관 위치 최신화', description: '재고, 수리, 폐기 등 후속 상태와 위치를 업데이트합니다.' },
      { code: 'close-return-request', title: '사용자 처리 완료 안내', description: '처리 완료 사실을 사용자 또는 요청자에게 안내합니다.' },
    ],
  },
];

class FreshserviceError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'FreshserviceError';
    this.status = status;
    this.data = data;
  }
}

function readStorage(defaults = STORAGE_DEFAULTS) {
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

function writeStorage(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function removeStorage(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/g, '')
    .replace(/\.freshservice\.com$/i, '')
    .toLowerCase();
}

function configured(settings) {
  return Boolean(settings.fsDomain && settings.fsApiKey);
}

async function getSettings({ requireConfigured = false } = {}) {
  const raw = await readStorage();
  const settings = {
    fsDomain: normalizeDomain(raw.fsDomain),
    fsApiKey: String(raw.fsApiKey || '').trim(),
  };

  if (requireConfigured && !configured(settings)) {
    throw new FreshserviceError('확장 설정에서 FS_DOMAIN, FS_API_KEY를 저장해주세요.', 412, {
      code: 'SETTINGS_REQUIRED',
    });
  }

  return settings;
}

function safeSettings(settings) {
  return {
    fsDomain: settings.fsDomain || '',
    hasApiKey: Boolean(settings.fsApiKey),
    configured: configured(settings),
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function statusLabel(status) {
  const numeric = Number(status);
  if (numeric === TASK_STATUS.COMPLETED) return '완료';
  if (numeric === 2) return '진행 중';
  if (numeric === TASK_STATUS.OPEN) return '대기';
  return status ? String(status) : '알 수 없음';
}

function isCompletedTask(task) {
  const status = Number(task?.status);
  if (status === TASK_STATUS.COMPLETED) return true;
  return /completed|complete|closed|done|완료/i.test(String(task?.status || task?.status_name || ''));
}

function normalizeFreshserviceTask(task) {
  const status = Number(task?.status || task?.task_status || 0) || task?.status || '';
  const description = task?.description || '';
  return {
    id: task?.id,
    title: task?.title || task?.name || '',
    description,
    description_text: stripHtml(description),
    status,
    status_label: statusLabel(status),
    completed: isCompletedTask(task),
    due_date: task?.due_date || null,
    agent_id: task?.agent_id || null,
    group_id: task?.group_id || null,
    created_at: task?.created_at || null,
    updated_at: task?.updated_at || null,
  };
}

function isActiveFreshserviceAgent(agent) {
  if (!agent) return false;
  if (agent.active === false) return false;
  if (agent.deleted === true) return false;
  if (agent.deactivated === true) return false;
  if (agent.disabled === true) return false;

  const status = String(agent.status || agent.state || '').toLowerCase();
  if (status && /inactive|disabled|deleted|deactivated|archived/.test(status)) return false;

  return true;
}

function normalizeAgent(agent) {
  if (!isActiveFreshserviceAgent(agent)) return null;

  return {
    id: agent?.id,
    name: agent?.name || agent?.first_name || agent?.email || `Agent ${agent?.id || ''}`.trim(),
    email: agent?.email || '',
  };
}

function progressFor(tasks) {
  const total = tasks.length;
  const completed = tasks.filter(task => task.completed).length;
  return {
    total,
    completed,
    pending: Math.max(total - completed, 0),
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

function serializeTemplate(template) {
  return {
    id: template.id,
    title: template.title,
    short_title: template.short_title,
    description: template.description,
    tasks: template.tasks.map(task => ({
      code: task.code,
      title: task.title,
      description: task.description,
    })),
  };
}

function serializeTemplates() {
  return TASK_SCENARIO_TEMPLATES.map(serializeTemplate);
}

function findTaskTemplate(templateId) {
  return TASK_SCENARIO_TEMPLATES.find(template => template.id === templateId) || null;
}

function inferTaskScenario(ticket) {
  const text = [
    ticket?.subject,
    ticket?.description,
    ticket?.description_text,
    ticket?.custom_fields ? Object.values(ticket.custom_fields).join(' ') : '',
  ].filter(Boolean).join(' ');
  if (!text) return null;

  const hasReturn = /반납|회수|퇴사|퇴직|비활성|할당\s*해제/i.test(text);
  const hasBasicReturnAsset = /모니터|키보드|마우스|어댑터|충전기|도킹|허브|dock|adapter|monitor|keyboard|mouse/i.test(text);
  const hasDataAsset = /노트북|랩탑|pc|컴퓨터|맥북|desktop|laptop|macbook/i.test(text);
  const hasReplacement = /교체|변경|대체|장비\s*교환/i.test(text);
  const hasProvision = /지급|신규|입사|추가|세팅|setting|setup/i.test(text);

  if (hasReturn && hasBasicReturnAsset && !hasDataAsset) return findTaskTemplate('asset-return-basic');
  if (hasReturn) return findTaskTemplate('asset-return');
  if (hasReplacement) return findTaskTemplate('asset-replacement');
  if (hasProvision) return findTaskTemplate('asset-provision');
  return null;
}

function normalizeTicket(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    subject: ticket.subject || '',
    description_text: stripHtml(ticket.description || ''),
    status: ticket.status || null,
    requester_id: ticket.requester_id || null,
    created_at: ticket.created_at || null,
    updated_at: ticket.updated_at || null,
  };
}

function taskPayloadFromTemplate(templateTask) {
  return {
    parent_type: 'Ticket',
    status: TASK_STATUS.OPEN,
    title: templateTask.title,
    description: `<p>${escapeHtml(templateTask.description || '')}</p>`,
  };
}

function freshserviceBaseUrl(settings) {
  return `https://${settings.fsDomain}.freshservice.com/api/v2`;
}

function ticketWebUrl(settings, ticketId) {
  return `https://${settings.fsDomain}.freshservice.com/a/tickets/${ticketId}`;
}

function parseResponseText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { message: text }; }
}

function extractErrorMessage(status, data) {
  if (Array.isArray(data?.errors) && data.errors.length) {
    const details = data.errors.map(item => {
      const field = item.field ? `${item.field}: ` : '';
      const code = item.code ? ` (${item.code})` : '';
      return `${field}${item.message || JSON.stringify(item)}${code}`;
    }).join(', ');
    return data?.description ? `${data.description}: ${details}` : details;
  }
  if (typeof data === 'string') return data;
  if (data?.description) return data.description;
  if (data?.message) return data.message;
  return `Freshservice 요청 실패 (${status})`;
}

function base64Encode(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function freshserviceFetch(settings, path, options = {}) {
  const response = await fetch(`${freshserviceBaseUrl(settings)}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Basic ${base64Encode(`${settings.fsApiKey}:X`)}`,
      'Content-Type': 'application/json',
    },
    body: options.body == null ? undefined : JSON.stringify(options.body),
  });
  const data = parseResponseText(await response.text());
  if (!response.ok) throw new FreshserviceError(extractErrorMessage(response.status, data), response.status, data);
  return data;
}

function shouldRetryWithTaskWrapper(error) {
  return [400, 415, 422].includes(Number(error?.status));
}

async function fetchTicket(settings, ticketId) {
  const data = await freshserviceFetch(settings, `/tickets/${ticketId}`);
  return data?.ticket || data || null;
}

async function fetchTicketTask(settings, ticketId, taskId) {
  const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks/${taskId}`);
  return data?.task || data || null;
}

async function fetchTicketTasks(settings, ticketId) {
  const all = [];
  let page = 1;

  while (page <= 20) {
    const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks?page=${page}&per_page=100`);
    const raw = data?.tasks || data?.ticket_tasks || data || [];
    const batch = Array.isArray(raw) ? raw : [];
    all.push(...batch.map(normalizeFreshserviceTask));
    if (batch.length < 100) break;
    page += 1;
  }

  return all;
}

async function fetchAgents(settings, { force = false } = {}) {
  if (
    !force &&
    agentCache.domain === settings.fsDomain &&
    agentCache.agents.length &&
    Date.now() - agentCache.at < AGENT_CACHE_TTL_MS
  ) {
    return agentCache.agents;
  }

  const all = [];
  let page = 1;
  while (page <= 20) {
    const data = await freshserviceFetch(settings, `/agents?page=${page}&per_page=100`);
    const batch = Array.isArray(data?.agents) ? data.agents : [];
    all.push(...batch.map(normalizeAgent).filter(agent => agent?.id));
    if (batch.length < 100) break;
    page += 1;
  }

  agentCache = {
    domain: settings.fsDomain,
    at: Date.now(),
    agents: all.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')),
  };
  return agentCache.agents;
}

async function createTicketTask(settings, ticketId, payload) {
  try {
    const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks`, {
      method: 'POST',
      body: payload,
    });
    return data?.task || data;
  } catch (error) {
    if (!shouldRetryWithTaskWrapper(error)) throw error;
    const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks`, {
      method: 'POST',
      body: { task: payload },
    });
    return data?.task || data;
  }
}

async function updateTicketTask(settings, ticketId, taskId, payload) {
  try {
    const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks/${taskId}`, {
      method: 'PUT',
      body: payload,
    });
    return data?.task || data;
  } catch (error) {
    if (!shouldRetryWithTaskWrapper(error)) throw error;
    const data = await freshserviceFetch(settings, `/tickets/${ticketId}/tasks/${taskId}`, {
      method: 'PUT',
      body: { task: payload },
    });
    return data?.task || data;
  }
}

async function updateTicketTaskWithCandidates(settings, ticketId, taskId, candidates) {
  let lastError = null;

  for (const payload of candidates) {
    try {
      return await updateTicketTask(settings, ticketId, taskId, payload);
    } catch (error) {
      lastError = error;
      if (!shouldRetryWithTaskWrapper(error)) throw error;
    }
  }

  throw lastError || new FreshserviceError('작업 업데이트에 실패했습니다.', 400);
}

async function buildTasksPayload(ticketId) {
  const settings = await getSettings({ requireConfigured: true });
  const [ticket, tasks, agents] = await Promise.all([
    fetchTicket(settings, ticketId),
    fetchTicketTasks(settings, ticketId),
    fetchAgents(settings).catch(() => []),
  ]);
  const suggested = inferTaskScenario(ticket);

  return {
    agents,
    settings: safeSettings(settings),
    ticket: normalizeTicket(ticket),
    ticket_url: ticketWebUrl(settings, ticketId),
    tasks,
    progress: progressFor(tasks),
    scenarios: serializeTemplates(),
    suggested_scenario_id: suggested?.id || null,
    suggested_scenario: suggested ? serializeTemplate(suggested) : null,
  };
}

async function applyScenario(ticketId, scenarioId) {
  const settings = await getSettings({ requireConfigured: true });
  const [ticket, tasks] = await Promise.all([
    fetchTicket(settings, ticketId),
    fetchTicketTasks(settings, ticketId),
  ]);
  const template = findTaskTemplate(scenarioId) || inferTaskScenario(ticket);
  if (!template) throw new FreshserviceError('적용할 작업 시나리오를 선택해주세요.', 400);

  const existingTitles = new Set(tasks.map(task => normalizeTaskTitle(task.title)));
  let createdCount = 0;
  let skippedCount = 0;

  for (const templateTask of template.tasks) {
    if (existingTitles.has(normalizeTaskTitle(templateTask.title))) {
      skippedCount += 1;
      continue;
    }
    await createTicketTask(settings, ticketId, taskPayloadFromTemplate(templateTask));
    createdCount += 1;
  }

  return {
    ...(await buildTasksPayload(ticketId)),
    applied_scenario: serializeTemplate(template),
    created_count: createdCount,
    skipped_count: skippedCount,
  };
}

async function updateTaskStatus(ticketId, taskId, status) {
  return updateTask(ticketId, taskId, { status });
}

async function updateTaskAgent(ticketId, taskId, agentId) {
  return updateTask(ticketId, taskId, { agentId });
}

function assertValidUpdates(updates) {
  if (updates.status == null && updates.agentId == null) {
    throw new FreshserviceError('변경할 내용이 없습니다.', 400);
  }
  if (updates.agentId != null) {
    const agentId = Number(updates.agentId);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      throw new FreshserviceError('할당할 에이전트를 선택해주세요.', 400);
    }
  }
}

function buildUpdateCandidates(existing, updates) {
  const candidates = [];

  if (updates.status != null) {
    const status = Number(updates.status);
    candidates.push(
      { status },
      { title: existing.title, status },
      { title: existing.title, description: existing.description || '', status }
    );
  }

  if (updates.agentId != null) {
    const agentId = Number(updates.agentId);
    candidates.push(
      { agent_id: agentId },
      { title: existing.title, agent_id: agentId },
      { title: existing.title, description: existing.description || '', agent_id: agentId }
    );
  }

  return candidates;
}

async function updateTask(ticketId, taskId, updates) {
  assertValidUpdates(updates);
  const settings = await getSettings({ requireConfigured: true });
  const existing = normalizeFreshserviceTask(await fetchTicketTask(settings, ticketId, taskId));

  await updateTicketTaskWithCandidates(settings, ticketId, taskId, buildUpdateCandidates(existing, updates));

  return {
    ...(await buildTasksPayload(ticketId)),
    updated_task_id: taskId,
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function bulkUpdateTasks(ticketId, taskIds, updates) {
  assertValidUpdates(updates);
  const settings = await getSettings({ requireConfigured: true });

  const ids = [...new Set((taskIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new FreshserviceError('일괄 처리할 작업을 선택해주세요.', 400);
  if (ids.length > BULK_UPDATE_MAX_TASKS) {
    throw new FreshserviceError(`한 번에 최대 ${BULK_UPDATE_MAX_TASKS}건까지 처리할 수 있습니다.`, 400);
  }

  const tasks = await fetchTicketTasks(settings, ticketId);
  const taskMap = new Map(tasks.map(task => [Number(task.id), task]));
  const failures = [];
  let succeeded = 0;

  for (let i = 0; i < ids.length; i += 1) {
    const taskId = ids[i];
    const existing = taskMap.get(taskId);
    try {
      if (!existing) throw new FreshserviceError('작업을 찾을 수 없습니다.', 404);
      await updateTicketTaskWithCandidates(settings, ticketId, taskId, buildUpdateCandidates(existing, updates));
      succeeded += 1;
    } catch (error) {
      failures.push({
        task_id: taskId,
        title: existing?.title || `작업 #${taskId}`,
        message: error?.message || '알 수 없는 오류',
      });
    }
    if (i < ids.length - 1) await wait(BULK_UPDATE_DELAY_MS);
  }

  return {
    ...(await buildTasksPayload(ticketId)),
    bulk: {
      requested: ids.length,
      succeeded,
      failed: failures.length,
      failures,
    },
  };
}

function responseError(error) {
  return {
    ok: false,
    status: Number(error?.status) || 0,
    code: error?.data?.code || null,
    data: error?.data || null,
    message: error?.message || '요청 처리 중 오류가 발생했습니다.',
  };
}

async function handleMessage(message) {
  const type = message?.type;
  if (type === 'GET_SETTINGS_STATUS') {
    return { settings: safeSettings(await getSettings()) };
  }
  if (type === 'SAVE_SETTINGS') {
    const settings = {
      fsDomain: normalizeDomain(message.settings?.fsDomain),
      fsApiKey: String(message.settings?.fsApiKey || '').trim(),
    };
    await writeStorage(settings);
    await removeStorage('operatorName');
    return { settings: safeSettings(settings) };
  }
  if (type === 'TEST_SETTINGS') {
    const settings = {
      fsDomain: normalizeDomain(message.settings?.fsDomain),
      fsApiKey: String(message.settings?.fsApiKey || '').trim(),
    };
    if (!configured(settings)) throw new FreshserviceError('FS_DOMAIN, FS_API_KEY를 모두 입력해주세요.', 400);
    await freshserviceFetch(settings, '/tickets?per_page=1');
    return { settings: safeSettings(settings), message: 'Freshservice 연결 확인 완료' };
  }
  if (type === 'GET_SCENARIOS') {
    return { scenarios: serializeTemplates() };
  }
  if (type === 'GET_TICKET_TASKS') {
    return buildTasksPayload(Number(message.ticketId));
  }
  if (type === 'APPLY_SCENARIO') {
    return applyScenario(Number(message.ticketId), message.scenarioId);
  }
  if (type === 'UPDATE_TASK_STATUS') {
    return updateTaskStatus(Number(message.ticketId), Number(message.taskId), Number(message.status));
  }
  if (type === 'UPDATE_TASK_AGENT') {
    return updateTaskAgent(Number(message.ticketId), Number(message.taskId), Number(message.agentId));
  }
  if (type === 'BULK_UPDATE_TASKS') {
    return bulkUpdateTasks(Number(message.ticketId), message.taskIds, {
      status: message.status == null ? null : Number(message.status),
      agentId: message.agentId == null ? null : Number(message.agentId),
    });
  }
  if (type === 'OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage();
    return { opened: true };
  }
  throw new FreshserviceError('알 수 없는 확장 요청입니다.', 400);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse(responseError(error)));
  return true;
});
