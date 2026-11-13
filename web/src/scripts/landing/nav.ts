const sectionIds = ["home", "about", "platform", "assets", "network"];

const navigation = document.querySelector(".navigation")!;
const menu = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const links = document.querySelectorAll<HTMLAnchorElement>(".nav-links a");

function setMenu(open: boolean) {
  navigation.classList.toggle("menu-open", open);
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

menu.addEventListener("click", () => setMenu(!navigation.classList.contains("menu-open")));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && navigation.classList.contains("menu-open")) {
    setMenu(false);
    menu.focus();
  }
});
links.forEach((link) => link.addEventListener("click", () => setMenu(false)));

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((link) => {
        const current = link.hash === `#${entry.target.id}`;
        link.classList.toggle("active", current);
        if (current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }
  },
  { rootMargin: "-20% 0px -50% 0px" },
);
sectionIds.forEach((id) => {
  const section = document.getElementById(id);
  if (section) observer.observe(section);
});
