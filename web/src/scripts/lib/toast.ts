export function showToast(text: string, ms = 2600) {
  const toast = document.createElement("div");
  toast.textContent = text;
  toast.setAttribute("role", "status");
  toast.style.cssText =
    "position:fixed;left:50%;bottom:32px;transform:translate(-50%,12px);z-index:10000;max-width:calc(100vw - 32px);padding:14px 20px;border-radius:999px;background:#c4f299;color:#10210a;font:600 15px/1.3 'DM Sans',system-ui,sans-serif;opacity:0;transition:opacity 260ms ease,transform 260ms ease;box-shadow:0 8px 30px rgba(0,0,0,0.4)";
  document.body.append(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translate(-50%,0)";
  });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, ms);
}
