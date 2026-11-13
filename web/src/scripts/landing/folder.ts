const folder = document.querySelector<HTMLElement>('.product-folder')!;
const cover = folder.querySelector<HTMLButtonElement>('.folder-cover')!;
const toggle = folder.querySelector<HTMLButtonElement>('.folder-toggle')!;
const content = folder.querySelector<HTMLElement>('.folder-sheet')!;
const pages = [...folder.querySelectorAll<HTMLElement>('.folder-page')];
const previous = folder.querySelector<HTMLButtonElement>('.folder-prev')!;
const next = folder.querySelector<HTMLButtonElement>('.folder-next')!;
const closeButton = folder.querySelector<HTMLButtonElement>('.folder-close')!;
let pageIndex = 0;
let pageTurn: Animation | null = null;

async function turnPage(index: number) {
  if (pageTurn) return;
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const direction = index > pageIndex ? -1 : 1;
    pageTurn = content.animate([
      { transform: 'translateY(0) rotate(0)', opacity: 1 },
      { transform: `translate(${direction * 40}px, -24px) rotate(${direction * 5}deg)`, opacity: 0 },
    ], { duration: 300, easing: 'cubic-bezier(.4,0,.7,.3)', fill: 'forwards' });
    try {
      await pageTurn.finished;
    } catch {
      return;
    }
    pageTurn.cancel();
    pageTurn = null;
  }
  showPage(index);
}

function showPage(index: number) {
  pageIndex = index;
  pages.forEach((page, i) => { page.hidden = i !== index; });
  content.dataset.page = String(index);
  previous.disabled = index === 0;
  next.textContent = index === pages.length - 1 ? 'Close folder ×' : 'Next page →';
  folder.querySelector('.folder-page-count')!.textContent = `0${index + 1} / 03`;
}

function setOpen(open: boolean) {
  pageTurn?.cancel();
  pageTurn = null;
  if (open) showPage(0);
  folder.dataset.open = String(open);
  cover.setAttribute('aria-expanded', String(open));
  cover.tabIndex = open ? -1 : 0;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.querySelector('span')!.textContent = open ? 'Close folder' : 'Open to explore';
  toggle.querySelector('.folder-toggle-icon')!.textContent = open ? '×' : '↗';
  content.inert = !open;
  content.setAttribute('aria-hidden', String(!open));
  if (!open) toggle.focus({ preventScroll: true });
}

previous.addEventListener('click', () => {
  void turnPage(Math.max(0, pageIndex - 1)).then(() => {
    if (previous.disabled && folder.dataset.open === 'true') next.focus({ preventScroll: true });
  });
});
function advancePage() {
  if (pageIndex === pages.length - 1) setOpen(false);
  else void turnPage(pageIndex + 1);
}

next.addEventListener('click', advancePage);
content.addEventListener('click', event => {
  if ((event.target as Element).closest('a, button')) return;
  advancePage();
});
closeButton.addEventListener('click', () => setOpen(false));

cover.addEventListener('click', () => {
  setOpen(true);
  toggle.focus({ preventScroll: true });
});
toggle.addEventListener('click', () => setOpen(folder.dataset.open !== 'true'));
folder.addEventListener('keydown', event => {
  if (event.key === 'Escape' && folder.dataset.open === 'true') {
    setOpen(false);
    toggle.focus({ preventScroll: true });
  }
});
