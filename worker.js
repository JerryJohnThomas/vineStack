/**
 * vinestack.app edge worker. Serves the static site (env.ASSETS) unchanged,
 * except the HTML page, which is sent with ONE price list:
 *   - region = ?region=in|us, else the visitor's country (India → in, else us)
 *   - #vs-prices keeps only that region's prices
 *   - the visible prices are filled in server-side (no flash, nothing else in the source)
 *   - the JSON-LD offer matches the region
 * Non-HTML assets pass straight through.
 */

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const type = res.headers.get('content-type') || '';
    if (request.method !== 'GET' || !type.includes('text/html')) return res;

    const html = await res.text();
    const m = html.match(/<script type="application\/json" id="vs-prices">([\s\S]*?)<\/script>/);
    if (!m) return new Response(html, res);

    let all;
    try { all = JSON.parse(m[1]); } catch { return new Response(html, res); }
    const region = pickRegion(request, all);
    const P = all[region];

    const plain = (v) => String(v).replace(/,/g, '');
    const monthly = Object.values(P.plans).map((p) => Number(plain(p.monthly)));
    const offer = {
      '@type': 'AggregateOffer',
      lowPrice: String(Math.min(...monthly)),
      highPrice: String(Math.max(...monthly)),
      priceCurrency: P.currency,
    };

    const out = new Response(html, res);
    const rewritten = new HTMLRewriter()
      .on('script#vs-prices', { element: (el) => el.setInnerContent(JSON.stringify({ [region]: P })) })
      .on('script[type="application/ld+json"]', replaceText((txt) => {
        try {
          const ld = JSON.parse(txt);
          if (ld.offers) ld.offers = offer;
          return JSON.stringify(ld, null, 2);
        } catch { return txt; }
      }))
      .on('.price-amt[data-plan]', {
        element: (el) => { const p = P.plans[el.getAttribute('data-plan')]; if (p) el.setInnerContent(p.monthly); },
      })
      .on('.price-annual-note[data-plan]', {
        element: (el) => { const p = P.plans[el.getAttribute('data-plan')]; if (p) el.setInnerContent(`${P.cur}${p.yearly} billed yearly`); },
      })
      .on('[data-k]', {
        element: (el) => {
          const k = el.getAttribute('data-k');
          const v = k === 'cur' ? P.cur : k === 'save' ? P.save : P.k[k];
          if (v != null) el.setInnerContent(v);
        },
      })
      .transform(out);

    const headers = new Headers(rewritten.headers);
    headers.set('cache-control', 'no-store'); // the page differs by visitor
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(rewritten.body, { status: rewritten.status, headers });
  },
};

function pickRegion(request, all) {
  const q = (new URL(request.url).searchParams.get('region') || '').toLowerCase();
  if (all[q]) return q;
  const country = request.cf && request.cf.country;
  const r = country === 'IN' ? 'in' : 'us';
  return all[r] ? r : Object.keys(all)[0];
}

/** Buffer an element's text (it may arrive in chunks) and replace it whole. */
function replaceText(fn) {
  let buf = '';
  return {
    text(chunk) {
      buf += chunk.text;
      if (chunk.lastInTextNode) {
        chunk.replace(fn(buf));
        buf = '';
      } else {
        chunk.remove();
      }
    },
  };
}
