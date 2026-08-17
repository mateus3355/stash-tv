import { useEffect } from "react";

// Unrelated to forceLandscape (useViewportRotate): some mobile browsers (notably iOS Safari)
// carry over a stale pinch/rotation zoom scale across a physical portrait -> landscape -> portrait
// rotation, leaving the page rendered at a fraction of the real viewport width. Forcing the
// viewport meta tag to be reapplied resets the scale back to initial-scale=1. We also nudge the
// `container: viewport / size` containment box on <html> (used by ActionButtonStack's
// @container aspect-ratio query) in case that's independently stuck at a stale size.
export function useBrowserZoomResetOnViewportChange() {
  useEffect(() => {
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const originalViewportContent = viewportMeta?.getAttribute("content") ?? null;

    const recompute = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (viewportMeta && originalViewportContent) {
            viewportMeta.setAttribute("content", `${originalViewportContent}, user-scalable=no`);
            requestAnimationFrame(() => viewportMeta.setAttribute("content", originalViewportContent));
          }
          document.documentElement.style.containerType = "normal";
          void document.documentElement.offsetWidth;
          document.documentElement.style.containerType = "";
        });
      });
    };
    window.addEventListener("resize", recompute);
    window.addEventListener("orientationchange", recompute);
    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("orientationchange", recompute);
    };
  }, []);
}
