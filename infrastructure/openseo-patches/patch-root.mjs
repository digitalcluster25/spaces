import fs from "node:fs";

const file = "/app/src/routes/__root.tsx";
let source = fs.readFileSync(file, "utf8");

if (!source.includes("function SpacesTenantFrame()")) {
  const component = `function SpacesTenantFrame() {
  const [height, setHeight] = React.useState(44);

  React.useEffect(() => {
    const receiveHeight = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "spaces-tenant-height") return;
      setHeight(event.data.height === 12 ? 12 : 44);
    };
    window.addEventListener("message", receiveHeight);
    return () => window.removeEventListener("message", receiveHeight);
  }, []);

  React.useEffect(() => {
    const previousPadding = document.body.style.paddingTop;
    const previousBoxSizing = document.body.style.boxSizing;
    document.body.style.paddingTop = \`\${height}px\`;
    document.body.style.boxSizing = "border-box";
    return () => {
      document.body.style.paddingTop = previousPadding;
      document.body.style.boxSizing = previousBoxSizing;
    };
  }, [height]);

  return (
    <iframe
      src="/spaces-panel"
      title="Spaces"
      aria-label="Spaces"
      sandbox="allow-scripts allow-same-origin allow-popups"
      style={{
        position: "fixed",
        inset: "0 0 auto",
        zIndex: 2147483647,
        width: "100%",
        height,
        border: 0,
        background: "#fff",
      }}
    />
  );
}
`;
  const rootMarker = "function RootDocument({ children }: { children: React.ReactNode }) {";
  if (!source.includes(rootMarker)) throw new Error("OpenSEO root component marker not found");
  source = source.replace(rootMarker, `${component}\n${rootMarker}`);

  const bootstrapMarker = "                <PostHogBootstrap />";
  if (!source.includes(bootstrapMarker)) throw new Error("OpenSEO bootstrap marker not found");
  source = source.replace(bootstrapMarker, "                <SpacesTenantFrame />\n                <PostHogBootstrap />");
  fs.writeFileSync(file, source);
}
