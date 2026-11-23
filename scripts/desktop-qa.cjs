(async () => {
  const find = selector => document.querySelector(selector);
  async function until(predicate, label) {
    for (let i = 0; i < 140; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 65));
    }
    throw new Error('Timed out at ' + label + ': ' + find('#notice').textContent + ' ' + find('#job').textContent);
  }
  await until(() => find('.channel input'), 'channel catalog');
  if (document.body.innerText.includes('Sample archive') || find('#selection-count').textContent !== '0 selected')
    throw new Error('Startup should open the Discord workspace with nothing selected.');
  find('.channel input[aria-label="field-notes"]').click();
  find('#show-message-preview').click();
  await until(() => find('#preview-panel').open && document.querySelectorAll('.message').length === 4, 'on-demand preview');
  find('#preview-panel button').click();
  const research = () => find('.category-select input[aria-label="Select Research category"]');
  if (!research().indeterminate) throw new Error('Category must show a partial selection.');
  research().click();
  if (find('#selection-count').textContent !== '4 selected') throw new Error('Category selection failed.');
  find('#select-all').click();
  if (find('#selection-count').textContent !== '5 selected') throw new Error('Select all failed.');
  find('#channel-scope').value = 'threads';
  find('#channel-scope').dispatchEvent(new Event('change'));
  if (document.querySelectorAll('.channel.thread').length !== 1 || document.querySelectorAll('.channel').length !== 1)
    throw new Error('Thread filter failed.');
  find('#channel-scope').value = 'all';
  find('#channel-scope').dispatchEvent(new Event('change'));
  find('#clear-selection').click();
  for (const name of ['field-notes', 'reading-room']) {
    find('#channel-search').value = name;
    find('#channel-search').dispatchEvent(new Event('input'));
    find('.channel input').click();
  }
  find('#channel-search').value = '';
  find('#channel-search').dispatchEvent(new Event('input'));
  if (find('#selection-count').textContent !== '2 selected') throw new Error('Filtered selection failed.');
  if (!find('#formats input[value=html]').checked || !find('#formats input[value=json]').checked)
    throw new Error('Default dual formats are missing.');
  find('#archive-name').value = 'Field Archive Sample';
  find('#submit-export').click();
  await until(() => find('#job').textContent.includes('Saved 6 messages'), 'background dual-format export');
  find('#tab-history').click();
  await until(() => find('#history-list').textContent.includes('HTML + JSON'), 'shared history');
  find('#tab-automation').click();
  for (const flag of ['--format=html', '--format=json', '--background', '--print-json']) {
    if (!find('#command').textContent.includes(flag)) throw new Error('CLI command missing ' + flag);
  }
  if (find('#command').textContent.includes('--demo')) throw new Error('Desktop command must target Discord.');
  find('#tab-settings').click();
  find('#default-limit').value = '42';
  find('#settings-form button[type=submit]').click();
  await until(() => find('#notice').textContent === 'Export defaults saved.', 'settings save');
  if (find('#limit').value !== '42') throw new Error('Settings did not apply.');
  find('#default-limit').value = '';
  find('#default-output').value = 'C:' + String.fromCharCode(92) + 'Discord Archives';
  find('#settings-form button[type=submit]').click();
  await until(() => find('#limit').value === '' && find('#output').value.includes('Discord Archives'), 'restore settings and short display path');
  find('#tab-export').click();

  find('.json-details').open = true;
  return { preview: 4, exported: 6, checked: ['category checkboxes', 'Select All', 'filtered channels', 'archived thread filter', 'on-demand preview', 'background HTML and JSON', 'history', 'automation flags', 'startup and settings'] };
})()
