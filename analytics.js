(() => {
  const measurementId = "G-3RGE2JL7JY";

  if (!measurementId || measurementId === "G-XXXXXXXXXX") {
    console.warn("[analytics] Set your GA4 measurement ID in analytics.js");
    return;
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }

  window.gtag = gtag;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);

  gtag("js", new Date());
  gtag("config", measurementId, {
    page_path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  });
})();
