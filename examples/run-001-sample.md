# Run 001 — the frozen sample

Protocol step 1. Pulled 2026-09-14 from x402 Trust (x402-trust.com), which lists 12,644 grade A
endpoints. Recorded here before any payment; the list does not change once the run starts.

Selection rule: grade A, sampled across **distinct providers**, filtered to the categories the
method can check. Candidates were found by keyword search over the catalog, then each candidate's
endpoint page was read for grade, score, 30-day uptime, advertised price and network.

## The sample

**34 calls across 11 distinct providers.**

### geocode_forward — 8 calls / 4 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `geo-f-01` | `2s.io/api/geocode/address` | 2s.io | $0.0025 | 84.7 | 94.3% | `eip155:8453` |
| `geo-f-02` | `2s.io/api/geocode/address` | 2s.io | $0.0025 | 84.7 | 94.3% | `eip155:8453` |
| `geo-f-03` | `agent402.tools/api/geocode` | agent402.tools | $0.0010 | 84.7 | 97.0% | `eip155:43114` |
| `geo-f-04` | `agent402.tools/api/geocode` | agent402.tools | $0.0010 | 84.7 | 97.0% | `eip155:43114` |
| `geo-f-05` | `api.agentstools.dev/geocode` | api.agentstools.dev | $0.0020 | 83.7 | 94.7% | `eip155:8453` |
| `geo-f-06` | `api.agentstools.dev/geocode` | api.agentstools.dev | $0.0020 | 83.7 | 94.7% | `eip155:8453` |
| `geo-f-07` | `sat.ipintel.ai/address-to-coordinates` | sat.ipintel.ai | $0.0020 | 80.1 | 93.0% | `eip155:8453` |
| `geo-f-08` | `sat.ipintel.ai/address-to-coordinates` | sat.ipintel.ai | $0.0020 | 80.1 | 93.0% | `eip155:8453` |

### geocode_reverse — 8 calls / 4 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `geo-r-01` | `api.relaystation.ai/v1/location/reverse-geocode` | api.relaystation.ai | $0.0100 | 80.2 | 94.2% | `eip155:8453` |
| `geo-r-02` | `api.relaystation.ai/v1/location/reverse-geocode` | api.relaystation.ai | $0.0100 | 80.2 | 94.2% | `eip155:8453` |
| `geo-r-03` | `api.kadec0.xyz/v1/geocode` | api.kadec0.xyz | $0.0100 | 84.4 | 94.7% | `eip155:8453` |
| `geo-r-04` | `api.kadec0.xyz/v1/geocode` | api.kadec0.xyz | $0.0100 | 84.4 | 94.7% | `eip155:8453` |
| `geo-r-05` | `2s.io/api/geocode/reverse` | 2s.io | $0.0025 | 83.9 | 94.3% | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `geo-r-06` | `2s.io/api/geocode/reverse` | 2s.io | $0.0025 | 83.9 | 94.3% | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `geo-r-07` | `agent402.tools/api/reverse-geocode` | agent402.tools | $0.0010 | 82.5 | 93.8% | `eip155:42161` |
| `geo-r-08` | `agent402.tools/api/reverse-geocode` | agent402.tools | $0.0010 | 82.5 | 93.8% | `eip155:42161` |

### search_known — 8 calls / 4 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `sk-01` | `websearch.use.x402atlas.com/search` | websearch.use.x402atlas.com | $0.0100 | 82.9 | 93.5% | `eip155:8453` |
| `sk-02` | `websearch.use.x402atlas.com/search` | websearch.use.x402atlas.com | $0.0100 | 82.9 | 93.5% | `eip155:8453` |
| `sk-03` | `agent402.tools/api/search` | agent402.tools | $0.0200 | 82.6 | 91.2% | `eip155:8453` |
| `sk-04` | `agent402.tools/api/search` | agent402.tools | $0.0200 | 82.6 | 91.2% | `eip155:8453` |
| `sk-05` | `api.x402node.dev/serp/web` | api.x402node.dev | $0.0200 | 84.4 | 97.3% | `eip155:8453` |
| `sk-06` | `api.x402node.dev/serp/web` | api.x402node.dev | $0.0200 | 84.4 | 97.3% | `eip155:8453` |
| `sk-07` | `api.kadec0.xyz/v1/serp` | api.kadec0.xyz | $0.0500 | 83.6 | 94.7% | `eip155:8453` |
| `sk-08` | `api.kadec0.xyz/v1/serp` | api.kadec0.xyz | $0.0500 | 83.6 | 94.7% | `eip155:8453` |

### search_relevance — 4 calls / 4 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `sr-01` | `websearch.use.x402atlas.com/search` | websearch.use.x402atlas.com | $0.0100 | 82.9 | 93.5% | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `sr-02` | `agent402.tools/api/search` | agent402.tools | $0.0200 | 82.6 | 91.2% | `eip155:8453` |
| `sr-03` | `api.x402node.dev/serp/web` | api.x402node.dev | $0.0200 | 84.4 | 97.3% | `eip155:8453` |
| `sr-04` | `api.kadec0.xyz/v1/serp` | api.kadec0.xyz | $0.0500 | 83.6 | 94.7% | `eip155:8453` |

### price — 4 calls / 4 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `px-01` | `agent402.tools/api/price-coingecko` | agent402.tools | $0.0010 | 86.0 | 100.0% | `eip155:8453` |
| `px-02` | `crypto.apitoll.cloud/v1/crypto/price` | crypto.apitoll.cloud | $0.0010 | 84.5 | 93.1% | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| `px-03` | `coingecko.use.x402atlas.com/price` | coingecko.use.x402atlas.com | $0.0050 | 82.3 | 92.3% | `eip155:42161` |
| `px-04` | `keyronne.com/api/price` | keyronne.com | $0.0030 | 81.0 | 93.3% | `eip155:8453` |

### weather — 2 calls / 1 providers

| id | endpoint | provider | price | score | uptime 30d | network |
|---|---|---|---|---|---|---|
| `wx-01` | `2s.io/api/weather/current` | 2s.io | $0.0030 | 84.6 | 97.1% | `eip155:8453` |
| `wx-02` | `2s.io/api/weather/zip` | 2s.io | $0.0030 | 84.8 | 94.3% | `eip155:8453` |

## What the frame could not supply

**Weather has one grade A provider in scope.** `2s.io` is the only one; the other grade A result
for the keyword, `kihustle.tech/…/temperature-converter`, is a unit converter rather than a weather
endpoint. The method's rule for this case is to shrink the category rather than pad it with repeat
calls to the same place, and to report the endpoint count next to the call count — so weather is 2
calls on 1 provider, and no finding about weather generalizes past that provider.

**No BNB row.** Axis 1 wants one verified payment on each of the five networks. Every one of the 13
BNB Chain endpoints in the catalog belongs to a single provider, `bnb-compat.yieldagentx402.app`,
all grade B, and all of them are DeFi yield, bridge quotes and intents — the categories run 001
puts out of scope because grading them would be a guess. BNB coverage and the grade A frame cannot
both hold, so this is a decision rather than an omission: either drop BNB from Axis 1 and report
why, or buy one BNB call outside the grade A frame purely for coverage and exclude it from the
Axis 3 quality findings. Axis 1 is about whether a payment verifies, not about grade, so the second
is defensible — it just has to be said out loud in the report.

**Networks are requested, not guaranteed.** The network on each row is what the catalog observed the
endpoint quoting, and the harness asks for it explicitly. A seller that no longer quotes it settles
on whatever it does offer, and the results log records `networkAsked` on any row where the two
differed.

**Prices are as advertised at freeze time, not as quoted at call time.** Two of the selected
endpoints had already moved their advertised price once in the 30 days before the freeze. Drift
between this column and what the 402 actually asks for is an Axis 2 finding, not a harness error.

## Reproducing the freeze

The sweep is keyword search over the public catalog plus one page read per candidate — no paid
x402 Trust calls were made, so nothing here was bought. The queries were: geocode, geocoding,
reverse geocode, address lookup, coordinates; web search, search api, serp, google search; weather,
forecast, temperature, current conditions; crypto price, token price, price feed, spot price,
market price.
