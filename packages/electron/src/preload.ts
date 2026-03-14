// Mark the document as running inside Electron so CSS can adapt
// (titlebar safe area, drag region)
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("electron");
});
