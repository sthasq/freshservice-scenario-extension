const fsDomainInput = document.getElementById('fsDomain');
const fsApiKeyInput = document.getElementById('fsApiKey');
const saveButton = document.getElementById('save');
const testButton = document.getElementById('test');
const statusEl = document.getElementById('status');
const versionEl = document.getElementById('version');

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/g, '')
    .replace(/\.freshservice\.com$/i, '')
    .toLowerCase();
}

function setStatus(message, type = '') {
  statusEl.textContent = message || '';
  statusEl.className = type;
}

function setBusy(busy) {
  saveButton.disabled = busy;
  testButton.disabled = busy;
}

function formSettings() {
  return {
    fsDomain: normalizeDomain(fsDomainInput.value),
    fsApiKey: String(fsApiKeyInput.value || '').trim(),
  };
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

chrome.storage.local.get({ fsDomain: '', fsApiKey: '' }, settings => {
  fsDomainInput.value = normalizeDomain(settings.fsDomain);
  fsApiKeyInput.value = settings.fsApiKey || '';
});

async function runConnectionTest(settings, { prefix = '' } = {}) {
  setStatus(`${prefix}Freshservice 연결 확인 중...`, 'loading');
  const response = await sendMessage('TEST_SETTINGS', { settings });
  if (!response.ok) {
    setStatus(`${prefix}${response.message || '연결에 실패했습니다. 값을 확인해주세요.'}`, 'error');
    return false;
  }
  setStatus(`${prefix}${response.data?.message || 'Freshservice 연결 확인 완료'}`, 'success');
  return true;
}

saveButton.addEventListener('click', async () => {
  const settings = formSettings();
  if (!settings.fsDomain || !settings.fsApiKey) {
    setStatus('FS_DOMAIN, FS_API_KEY를 모두 입력해주세요.', 'error');
    return;
  }

  setBusy(true);
  setStatus('저장하는 중...', 'loading');
  try {
    const response = await sendMessage('SAVE_SETTINGS', { settings });
    if (!response.ok) {
      setStatus(response.message || '저장하지 못했습니다.', 'error');
      return;
    }

    fsDomainInput.value = settings.fsDomain;
    await runConnectionTest(settings, { prefix: '저장했습니다. ' });
  } finally {
    setBusy(false);
  }
});

testButton.addEventListener('click', async () => {
  const settings = formSettings();
  if (!settings.fsDomain || !settings.fsApiKey) {
    setStatus('FS_DOMAIN, FS_API_KEY를 모두 입력해주세요.', 'error');
    return;
  }

  setBusy(true);
  try {
    await runConnectionTest(settings);
  } finally {
    setBusy(false);
  }
});
