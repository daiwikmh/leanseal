type DemoStep = { name: string; description: string; next: string };

const workspace = document.querySelector<HTMLElement>("[data-demo]");

if (workspace) {
  const steps = JSON.parse(workspace.dataset.demo ?? "[]") as DemoStep[];
  const rows = document.querySelectorAll<HTMLElement>("[data-demo-step]");
  const description = document.getElementById("demo-description")!;
  const advance = document.getElementById("demo-advance")!;
  const label = advance.querySelector("span")!;
  let step = 0;

  function paint() {
    rows.forEach((row, index) => {
      row.classList.toggle("current", index === step);
      row.classList.toggle("done", index < step);
      row.querySelector(".step-state")!.textContent = index < step ? "Complete" : index === step ? "Ready" : "Upcoming";
    });
    description.textContent = steps[step].description;
    label.textContent = steps[step].next;
  }

  advance.addEventListener("click", () => {
    step = (step + 1) % steps.length;
    paint();
  });
  document.getElementById("demo-reset")!.addEventListener("click", () => {
    step = 0;
    paint();
  });
}
