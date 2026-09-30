(() => {
  const frame = document.getElementById("spaces-tenant-frame");
  if (!frame) return;

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type !== "spaces-tenant-height") return;
    const height = event.data.height === 12 ? 12 : 44;
    document.documentElement.style.setProperty("--spaces-tenant-height", `${height}px`);
  });
})();
