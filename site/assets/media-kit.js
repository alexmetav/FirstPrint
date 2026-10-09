// Media kit: copy colours, descriptions and the page link.
(() => {
  const toast = document.querySelector('.kit-toast');
  let timer;
  function show(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => (toast.hidden = true), 1800);
  }
  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      show(done);
    } catch {
      show('Copy failed. Select the text and copy it.');
    }
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-copy], [data-copy-from], [data-copy-link]');
    if (!el) return;
    if (el.dataset.copy) copy(el.dataset.copy, `Copied ${el.dataset.copy}`);
    else if (el.dataset.copyFrom) copy(document.getElementById(el.dataset.copyFrom).textContent.trim(), 'Description copied');
    else copy('https://firstprint.fun/media-kit', 'Link copied');
  });
})();
