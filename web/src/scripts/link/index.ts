import { api } from "../lib/api";
import { errorText, query, say } from "../lib/dom";

const id = new URLSearchParams(location.search).get("id") ?? "";
const form = query<HTMLFormElement>("[data-link-pay]");
const error = query("[data-link-error]");

(async () => {
  try {
    const link = await api.publicLink(id);
    query("[data-link-company]").textContent = `Pay ${link.legal_name}`;
    query("[data-link-amount]").textContent = link.amount ? `$${Number(link.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "Your amount";
    query("[data-link-title]").textContent = link.title;
    query("[data-link-description]").textContent = link.description;
    query("[data-open-amount]").hidden = link.amount !== null;
    form.hidden = false;
  } catch (cause) {
    query("[data-link-title]").textContent = errorText(cause);
  }
})();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  try {
    say(error, "Creating your invoice…");
    const { pay_url } = await api.payLink(id, { payer_name: String(data.get("payer_name")), amount: String(data.get("amount") ?? "") });
    location.href = pay_url;
  } catch (cause) {
    say(error, errorText(cause), "error");
  }
});
