/* ──────────────────────────────────────────────────────────────
   PodPrompt documentation — shared behaviour

   Two things only: copy buttons on code blocks, and highlighting
   the in-page table of contents as you scroll. Which page you are
   on is marked in the markup with aria-current="page", not here.
   ────────────────────────────────────────────────────────────── */

/* Copy a code block to the clipboard. Wired up as onclick="copyCode(this)". */
function copyCode(btn) {
  const pre = btn.closest('.code-block').querySelector('pre');
  navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1800);
  }).catch(() => {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
  });
}

/* Highlight the table-of-contents entry for whichever section is in view.
   Only touches in-page anchors (.nav-link.sub), so the cross-page
   aria-current marker is left alone. */
(function highlightTableOfContents() {
  const tocLinks = Array.from(document.querySelectorAll('.nav-link.sub'));
  if (!tocLinks.length || !('IntersectionObserver' in window)) return;

  const targets = tocLinks
    .map(link => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  if (!targets.length) return;

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      tocLinks.forEach(l => l.classList.remove('active'));
      const active = tocLinks.find(
        l => l.getAttribute('href') === '#' + entry.target.id
      );
      if (active) active.classList.add('active');
    });
  }, { rootMargin: '-20% 0px -70% 0px' });

  targets.forEach(t => observer.observe(t));
})();
