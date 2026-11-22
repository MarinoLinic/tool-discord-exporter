(async () => {
  const find = selector => document.querySelector(selector);
  async function until(predicate, label) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    throw new Error('Timed out at ' + label + ': ' + find('#notice').textContent + ' ' + find('#job').textContent);
  }
  await until(() => document.querySelectorAll('.message').length === 4, 'sample preview');
  find('#channel-search').value = 'reading-room';
  find('#channel-search').dispatchEvent(new Event('input'));
  const choice = find('#channel-list input');
  if (!choice || choice.getAttribute('aria-label') !== 'reading-room') throw new Error('Channel search failed.');
  choice.click();
  await until(() => find('#selection-count').textContent === '2 selected' && document.querySelectorAll('.message').length === 2, 'multi-channel selection');
  find('#channel-search').value = '';
  find('#channel-search').dispatchEvent(new Event('input'));
  find('#formats input[value=jsonl]').click();
  find('#submit-export').click();
  await until(() => find('#job').textContent.includes('Saved 6 messages'), 'desktop export');
  find('#tab-history').click();
  await until(() => find('#history-list').textContent.includes('field-notes, #reading-room'), 'shared history');
  find('#tab-automation').click();
  if (!find('#command').textContent.includes('--format=jsonl') || !find('#command').textContent.includes('--print-json')) throw new Error('CLI command failed.');
  find('#tab-settings').click();
  find('#default-limit').value = '42';
  find('#settings-form button[type=submit]').click();
  await until(() => find('#notice').textContent === 'Export defaults saved.', 'settings save');
  if (find('#limit').value !== '42') throw new Error('Settings did not apply.');
  find('#default-limit').value = '';
  find('#settings-form button[type=submit]').click();
  await until(() => find('#limit').value === '', 'restore settings');
  find('#tab-export').click();
  find('#live-mode').click();
  await until(() => find('#notice').textContent.includes('Add a Discord bot token'), 'missing credential guidance');
  find('#demo-mode').click();
  await until(() => document.querySelectorAll('.message').length === 4, 'return to sample');
  find('#tab-settings').click();
  find('#default-output').value = 'C:' + String.fromCharCode(92) + 'Discord Archives';
  find('#settings-form button[type=submit]').click();
  await until(() => find('#notice').textContent === 'Export defaults saved.', 'sample display folder');
  find('#tab-export').click();
  return { preview: 4, exported: 6, tested: ['channel search', 'multi-select', 'JSONL export', 'history', 'CLI command', 'settings persistence', 'missing credential and sample recovery'] };
})()
