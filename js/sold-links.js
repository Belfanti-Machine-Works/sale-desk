// Sold-filtered search links for an item (eBay, Poshmark, Mercari), built on the phone so they work for every
// item, researched or not. Same rules as backend/Pricing.js aiSearchQuery_ / aiSoldSearchUrls_: keep in step.
//   soldQuery(item) -> 'Nike SKIMS Ribbed Tank FB1234'   brand, collab, title, style code; never the size
//   soldSearchLinks(item) -> [{site, label, url}]          [] when there are no search words
// Depop has no public sold filter, so it has no button.

export function soldQuery(item) {
  item = item || {};
  let brand = item.brand, collab = item.collab;
  if (!brand && !collab && item.brand_display) brand = item.brand_display; // "Nike × Off-White" (× is dropped below)
  const words = [brand, collab, item.title, item.style_code]
    .map((v) => String(v === undefined || v === null ? '' : v))
    .join(' ').replace(/["“”×]/g, ' ').split(/\s+/);
  const seen = new Set(), out = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (!w || seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out.join(' ').slice(0, 120).trim();
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function soldSearchLinks(item) {
  const q = soldQuery(item);
  if (!q) return [];
  const e = enc(q);
  return [
    { site: 'ebay', label: 'eBay sold', url: 'https://www.ebay.com/sch/i.html?_nkw=' + e + '&LH_Sold=1&LH_Complete=1' },
    { site: 'poshmark', label: 'Poshmark sold', url: 'https://poshmark.com/search?query=' + e + '&availability=sold_out' },
    { site: 'mercari', label: 'Mercari sold', url: 'https://www.mercari.com/search/?keyword=' + e + '&itemStatuses=2-3' },
  ];
}
