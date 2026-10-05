// Pitch deck, whitepaper and tokenomics: slide controls, the contents highlight and live numbers.
// A separate file (not inline) so the Content-Security-Policy can keep forbidding inline scripts.

const deck = document.querySelector('.deck');
if (deck) {
  const slides = [...deck.querySelectorAll('.slide')];
  const counter = document.querySelector('[data-deck-count]');
  let current = 0;
  const show = (i) => {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slides[current].scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  slides.forEach((s, i) => {
    const n = document.createElement('span');
    n.className = 'slide-num';
    n.textContent = `${String(i + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}`;
    s.append(n);
  });
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          current = slides.indexOf(e.target);
          if (counter) counter.textContent = `${current + 1} / ${slides.length}`;
        }
      }
    },
    { root: deck, threshold: 0.6 },
  );
  slides.forEach((s) => seen.observe(s));
  document.querySelector('[data-deck-prev]')?.addEventListener('click', () => show(current - 1));
  document.querySelector('[data-deck-next]')?.addEventListener('click', () => show(current + 1));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (['ArrowDown', 'ArrowRight', 'PageDown', ' '].includes(e.key)) {
      e.preventDefault();
      show(current + 1);
    } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      show(current - 1);
    } else if (e.key === 'Home') {
      show(0);
    } else if (e.key === 'End') {
      show(slides.length - 1);
    }
  });
}

// Long documents: highlight the section being read in the contents list.
const toc = [...document.querySelectorAll('.toc a[href^="#"]')];
if (toc.length) {
  const byId = new Map(toc.map((a) => [a.getAttribute('href').slice(1), a]));
  const watch = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        toc.forEach((a) => a.classList.remove('on'));
        byId.get(e.target.id)?.classList.add('on');
      }
    },
    { rootMargin: '-20% 0px -70% 0px' },
  );
  byId.forEach((_a, id) => {
    const el = document.getElementById(id);
    if (el) watch.observe(el);
  });
}

// Live numbers from the running app (shown only when this page is served next to it).
const live = document.querySelector('[data-live-stats]');
if (live) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  Promise.all(['open', 'settled'].map((f) => fetch(`/api/markets?filter=${f}`).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))))
    .then(([open, settled]) => {
      const markets = [...open.markets, ...settled.markets];
      const exchanges = new Set(markets.flatMap((m) => (m.venues?.length ? m.venues.map((v) => v.name) : [m.exchange])));
      const set = (k, v) => {
        const el = live.querySelector(`[data-stat="${k}"]`);
        if (el) el.textContent = v;
      };
      set('open', fmt(open.markets.length));
      // The list endpoint returns the latest 50, so a full page means "at least 50".
      set('settled', settled.markets.length >= 50 ? '50+' : fmt(settled.markets.length));
      set('predictions', fmt(markets.reduce((s, m) => s + (m.predictors || 0), 0)));
      set('exchanges', fmt(exchanges.size));
      live.hidden = false;
    })
    .catch(() => {});
}
